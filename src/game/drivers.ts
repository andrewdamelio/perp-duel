import { balanceOf, enterDuel, type ChainInfo } from '../chain/escrow';
import {
  lockPick,
  newMatch,
  pickCommit,
  randomHex32,
  start,
  tick,
  viewFor,
  type Address,
  type Hex,
  type Market,
  type Match,
  type MatchView,
} from '../engine';
import type { PriceFeed } from '../hl/feed';

export interface DuelTerms {
  duration: number;
  stake: string;
  bot: boolean;
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
 * Referee table: matchmaking, dealing and scoring happen on the referee server. If the
 * server has an escrow configured, locking a card first stakes and commits on-chain.
 */
export class RemoteDriver implements Driver {
  private matchId: Hex | null = null;
  private ticket: string | null = null;
  private last: MatchView | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly me: Address,
    private readonly key: Hex,
    private readonly chain: ChainInfo | null,
    private readonly events: DriverEvents,
  ) {}

  async find(terms: DuelTerms) {
    const queued = await this.request<{ ticket: string; matchId: Hex | null }>('/queue', {
      address: this.me,
      duration: terms.duration,
      stake: terms.stake,
      bot: terms.bot,
    });
    this.ticket = queued.ticket;
    let id = queued.matchId;
    while (!id && !this.stopped) {
      await sleep(1500);
      id = (await this.request<{ matchId: Hex | null }>(`/ticket/${queued.ticket}`)).matchId;
    }
    if (id && !this.stopped) await this.resume(id);
  }

  /** Pick a duel back up, e.g. after reopening the app during a 12 hour duel. */
  async resume(matchId: Hex) {
    this.matchId = matchId;
    this.ticket = null;
    await this.refresh();
    void this.poll();
  }

  async pick(cardIndex: number) {
    const view = this.last;
    if (!view) return;
    const card = view.you.hand[cardIndex];
    if (!card) return;
    const salt = randomHex32();
    try {
      if (view.onchain) {
        if (!this.chain) throw new Error('This duel is escrowed on-chain but the referee did not share its chain details');
        const stake = BigInt(view.stake);
        if ((await balanceOf(this.chain, this.me)) <= stake) {
          throw new Error(`Your wallet needs more than the stake in HYPE to cover gas. Fund ${this.me} and try again.`);
        }
        this.events.onBusy('Sending your stake to the escrow');
        await enterDuel(this.chain, this.key, view, pickCommit(view.id, this.me, card, salt));
      }
      this.events.onBusy('Locking in');
      // The stake may already be on-chain, so keep trying to hand the referee the reveal.
      for (let attempt = 0; ; attempt++) {
        try {
          this.last = await this.request<MatchView>(`/match/${view.id}/pick`, { player: this.me, cardIndex, salt });
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await sleep(1500);
        }
      }
      this.events.onView(this.last);
    } finally {
      this.events.onBusy(null);
    }
  }

  stop() {
    this.stopped = true;
    if (this.ticket && !this.matchId) void this.request(`/ticket/${this.ticket}`, undefined, 'DELETE').catch(() => {});
  }

  private async poll() {
    while (!this.stopped) {
      await sleep(700);
      if (this.stopped) return;
      try {
        await this.refresh();
      } catch (e) {
        this.events.onError(`Lost contact with the referee: ${(e as Error).message}`);
      }
      const v = this.last;
      if (v?.phase === 'settled' && (!v.onchain || v.settleTx)) return;
    }
  }

  private async refresh() {
    this.last = await this.request<MatchView>(`/match/${this.matchId}?player=${this.me}`);
    this.events.onView(this.last);
  }

  private async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Referee answered ${res.status}`);
    return json;
  }
}
