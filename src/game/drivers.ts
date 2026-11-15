import type { ArenaPlayer } from '../chain/arenaPlayer';
import {
  lockPick,
  newMatch,
  randomHex32,
  start,
  tick,
  viewFor,
  type Address,
  type Market,
  type Match,
  type MatchView,
} from '../engine';
import type { PriceFeed } from '../hl/feed';

export interface DuelTerms {
  duration: number;
  stake: string;
}

export interface DriverEvents {
  onView(view: MatchView): void;
  /** A short line about what is happening right now, or null when idle. */
  onBusy(text: string | null): void;
  onError(message: string): void;
}

export interface Driver {
  find(terms: DuelTerms): Promise<void>;
  pick(cardIndex: number): Promise<void>;
  /** Undo whatever can still be undone before walking away. */
  leave?(): Promise<void>;
  stop(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Practice table: the same engine the referee runs, kept on the device, against a bot.
 * Nothing is sent anywhere except the price subscription.
 */
export class LocalDriver implements Driver {
  private match: Match | null = null;
  private markets: Market[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private botPickAt = 0;
  private stopped = false;

  constructor(
    private readonly feed: PriceFeed,
    private readonly me: Address,
    private readonly events: DriverEvents,
  ) {}

  async find(terms: DuelTerms) {
    for (let i = 0; i < 40 && this.feed.markets().length < 5 && !this.stopped; i++) await sleep(250);
    if (this.stopped) return;
    this.markets = this.feed.markets();
    this.match = newMatch({
      nonce: randomHex32(),
      seed: randomHex32(),
      duration: terms.duration,
      stake: BigInt(terms.stake),
      players: [
        { address: this.me, name: 'You', isBot: false },
        { address: '0x000000000000000000000000000000000000b07a', name: 'House bot', isBot: true },
      ],
      markets: this.markets,
      onchain: false,
      now: Date.now(),
    });
    this.botPickAt = Date.now() + 1200 + Math.random() * 1800;
    this.timer = setInterval(() => this.step(), 250);
    this.push();
  }

  async pick(cardIndex: number) {
    if (!this.match) return;
    this.match = lockPick(this.match, 0, cardIndex, randomHex32());
    this.step();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private step() {
    let m = this.match;
    if (!m) return;
    const now = Date.now();
    try {
      if (m.phase === 'picking') {
        if (m.seats[1].pick === null && now >= this.botPickAt) {
          m = lockPick(m, 1, Math.floor(Math.random() * m.seats[1].hand.length), randomHex32());
        }
        if (m.seats.every((s) => s.pick !== null)) m = start(m, this.feed.mids(), this.markets, now);
      } else if (m.phase === 'live') {
        m = tick(m, this.feed.mids(), now);
      }
    } catch (e) {
      this.events.onError((e as Error).message);
    }
    this.match = m;
    this.push();
    if (m.phase === 'settled') this.stop();
  }

  private push() {
    if (this.match) this.events.onView(viewFor(this.match, 0));
  }
}

/**
 * On-chain table: stakes, dealing, scoring and payout all happen in the DuelArena
 * contract. There is no server; this device talks to the chain directly.
 */
export class ArenaDriver implements Driver {
  constructor(private readonly player: ArenaPlayer) {}

  async find(terms: DuelTerms) {
    await this.player.find({ duration: terms.duration, stake: BigInt(terms.stake) });
    this.player.start();
  }

  /** Pick up a duel this wallet is already seated in. */
  async resume(): Promise<boolean> {
    const seated = await this.player.resume();
    if (seated) this.player.start();
    return seated;
  }

  async pick(cardIndex: number) {
    this.player.choose(cardIndex);
    await this.player.tick();
  }

  /** Leaving before anyone joins takes the stake back. After that, the duel plays out. */
  async leave() {
    await this.player.leave();
  }

  stop() {
    this.player.stop();
  }
}
