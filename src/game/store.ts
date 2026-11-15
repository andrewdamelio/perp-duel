import { create } from 'zustand';
import { balanceOf, loadArenaMarkets, type ArenaInfo, type ArenaMarket } from '../chain/arena';
import { ArenaPlayer } from '../chain/arenaPlayer';
import { accountOf, loadBurnerKey } from '../chain/wallet';
import { config, DURATIONS, STAKES } from '../config';
import { DEFAULT_MARKETS, type Address, type Hex, type Market, type MatchView, type Mids } from '../engine';
import { createLiveFeed, type FeedStatus, type PriceFeed } from '../hl/feed';
import { ArenaDriver, LocalDriver, type Driver, type DriverEvents } from './drivers';

export type Screen = 'lobby' | 'matching' | 'table';

interface GameState {
  ready: boolean;
  feedStatus: FeedStatus;
  mids: Mids;
  markets: Market[];
  /** The on-chain arena, once its contract has answered. Null on the practice table. */
  arena: ArenaInfo | null;
  arenaError: string | null;
  address: Address | null;
  balance: bigint | null;
  screen: Screen;
  view: MatchView | null;
  busy: string | null;
  error: string | null;
  duration: number;
  stake: string;

  init(): Promise<void>;
  setTerms(terms: Partial<Pick<GameState, 'duration' | 'stake'>>): void;
  findDuel(): Promise<void>;
  pick(cardIndex: number): Promise<void>;
  leave(): void;
  dismissError(): void;
  refreshBalance(): Promise<void>;
  key(): Hex | null;
}

let feed: PriceFeed | null = null;
let driver: Driver | null = null;
let burnerKey: Hex | null = null;
let arenaMarkets: ArenaMarket[] = [];

export const useGame = create<GameState>((set, get) => {
  const events: DriverEvents = {
    onView: (view) => set({ view, screen: 'table' }),
    onBusy: (busy) => set({ busy }),
    onError: (error) => set({ error }),
  };
  const arenaDriver = (arena: ArenaInfo, key: Hex) => new ArenaDriver(new ArenaPlayer(arena, key, arenaMarkets, events));

  return {
    ready: false,
    feedStatus: 'connecting',
    mids: {},
    markets: [],
    arena: null,
    arenaError: null,
    address: null,
    balance: null,
    screen: 'lobby',
    view: null,
    busy: null,
    error: null,
    duration: DURATIONS[1].seconds,
    stake: STAKES[2],

    async init() {
      if (feed) return;
      feed = createLiveFeed({ markets: DEFAULT_MARKETS, fallbackAfterMs: 6000, simSpeed: 1 });
      let last = 0;
      feed.onUpdate(() => {
        const now = Date.now();
        if (now - last < 200) return;
        last = now;
        set({ mids: feed!.mids(), feedStatus: feed!.status(), markets: feed!.markets() });
      });
      try {
        feed.start();
      } catch {
        // Prices failing to start must never block the table from opening.
      }

      burnerKey = await loadBurnerKey();
      const address = accountOf(burnerKey).address;
      set({ address, ready: true });

      if (!config.arena) return;
      try {
        arenaMarkets = await loadArenaMarkets(config.arena);
        set({ arena: config.arena, arenaError: null });
        void get().refreshBalance();
        // A duel in progress survives a restart: everything needed is on-chain or derived from the key.
        const resumed = arenaDriver(config.arena, burnerKey);
        if (await resumed.resume()) {
          driver = resumed;
          set({ screen: 'matching' });
        }
      } catch {
        set({ arenaError: 'Could not reach the arena contract, so this is the practice table for now.' });
      }
    },

    setTerms(terms) {
      set(terms);
    },

    async findDuel() {
      const { address, arena, duration, stake } = get();
      if (!address || !feed || !burnerKey) return;
      driver?.stop();
      set({ screen: 'matching', view: null, error: null, busy: null });
      driver = arena ? arenaDriver(arena, burnerKey) : new LocalDriver(feed, address, events);
      try {
        await driver.find({ duration, stake });
      } catch (e) {
        set({ screen: 'lobby', error: (e as Error).message, busy: null });
      }
    },

    async pick(cardIndex) {
      try {
        await driver?.pick(cardIndex);
      } catch (e) {
        set({ error: (e as Error).message, busy: null });
      }
    },

    leave() {
      const leaving = driver;
      driver = null;
      set({ screen: 'lobby', view: null, busy: null, error: null });
      void (async () => {
        try {
          await leaving?.leave?.();
        } catch {
          // Nothing to take back.
        }
        leaving?.stop();
        void get().refreshBalance();
      })();
    },

    dismissError() {
      set({ error: null });
    },

    async refreshBalance() {
      const { arena, address } = get();
      if (!arena || !address) return;
      try {
        set({ balance: await balanceOf(arena, address) });
      } catch {
        set({ balance: null });
      }
    },

    key: () => burnerKey,
  };
});
