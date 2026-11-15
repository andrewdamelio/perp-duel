import { create } from 'zustand';
import { balanceOf, type ChainInfo } from '../chain/escrow';
import { accountOf, loadBurnerKey } from '../chain/wallet';
import { config, DURATIONS, STAKES } from '../config';
import { DEFAULT_MARKETS, type Address, type Hex, type Market, type MatchView, type Mids } from '../engine';
import { createLiveFeed, type FeedStatus, type PriceFeed } from '../hl/feed';
import { LocalDriver, RemoteDriver, type Driver, type DriverEvents } from './drivers';

export type Screen = 'lobby' | 'matching' | 'table';

interface RefereeInfo {
  feed: FeedStatus;
  chain: ChainInfo | null;
}

interface GameState {
  ready: boolean;
  feedStatus: FeedStatus;
  mids: Mids;
  markets: Market[];
  /** Null on the practice table, or when the referee cannot be reached. */
  referee: RefereeInfo | null;
  refereeError: string | null;
  address: Address | null;
  balance: bigint | null;
  screen: Screen;
  view: MatchView | null;
  busy: string | null;
  error: string | null;
  duration: number;
  stake: string;
  bot: boolean;

  init(): Promise<void>;
  setTerms(terms: Partial<Pick<GameState, 'duration' | 'stake' | 'bot'>>): void;
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

export const useGame = create<GameState>((set, get) => {
  const events: DriverEvents = {
    onView: (view) => set({ view, screen: 'table' }),
    onBusy: (busy) => set({ busy }),
    onError: (error) => set({ error }),
  };

  return {
    ready: false,
    feedStatus: 'connecting',
    mids: {},
    markets: [],
    referee: null,
    refereeError: null,
    address: null,
    balance: null,
    screen: 'lobby',
    view: null,
    busy: null,
    error: null,
    duration: DURATIONS[1].seconds,
    stake: STAKES[2],
    bot: true,

    async init() {
      if (feed) return;
      // A fast-forwarded tape if Hyperliquid cannot be reached, so a demo still has movement.
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

      if (!config.refereeUrl) return;
      try {
        const res = await fetch(`${config.refereeUrl}/health`);
        const referee = (await res.json()) as RefereeInfo;
        set({ referee, refereeError: null });
        void get().refreshBalance();
        const active = (await (await fetch(`${config.refereeUrl}/active?player=${address}`)).json()) as { matchId: Hex | null };
        if (active.matchId) {
          const remote = new RemoteDriver(config.refereeUrl, address, burnerKey, referee.chain, events);
          driver = remote;
          await remote.resume(active.matchId);
        }
      } catch (e) {
        set({ refereeError: `Could not reach the referee at ${config.refereeUrl}. Playing on the practice table instead.` });
      }
    },

    setTerms(terms) {
      set(terms);
    },

    async findDuel() {
      const { address, referee, duration, stake, bot } = get();
      if (!address || !feed || !burnerKey) return;
      driver?.stop();
      set({ screen: 'matching', view: null, error: null, busy: null });
      driver =
        config.refereeUrl && referee
          ? new RemoteDriver(config.refereeUrl, address, burnerKey, referee.chain, events)
          : new LocalDriver(feed, address, events);
      try {
        await driver.find({ duration, stake, bot: referee ? bot : true });
      } catch (e) {
        set({ screen: 'lobby', error: (e as Error).message });
      }
    },

    async pick(cardIndex) {
      try {
        await driver?.pick(cardIndex);
      } catch (e) {
        set({ error: (e as Error).message, busy: null });
      }
      void get().refreshBalance();
    },

    leave() {
      driver?.stop();
      driver = null;
      set({ screen: 'lobby', view: null, busy: null, error: null });
      void get().refreshBalance();
    },

    dismissError() {
      set({ error: null });
    },

    async refreshBalance() {
      const { referee, address } = get();
      if (!referee?.chain || !address) return;
      try {
        set({ balance: await balanceOf(referee.chain, address) });
      } catch {
        set({ balance: null });
      }
    },

    key: () => burnerKey,
  };
});
