import type { PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arenaBonus,
  arenaHand,
  bonusFromChain,
  dealCommitOf,
  deriveSalt,
  liquidationPrice,
  pickCommitOf,
  secretCommitOf,
  type Address,
  type Card,
  type Hex,
  type MatchView,
  type PositionState,
  type ScoreLine,
} from '../engine';
import { publicClientOf, walletClientOf, type ArenaInfo, type ArenaMarket } from './arena';
import { arenaAbi } from './arenaAbi';

export interface PlayerEvents {
  onView(view: MatchView): void;
  /** A short line about what is happening right now, or null when idle. */
  onBusy(text: string | null): void;
  onError(message: string): void;
}

const Phase = { None: 0, Open: 1, Joined: 2, Picking: 3, Live: 4, Closed: 5, Settled: 6, Cancelled: 7 } as const;
const ZERO = `0x${'00'.repeat(32)}` as Hex;

interface ChainSeat {
  player: Address;
  pickCommit: Hex;
  pick: number;
  pickRevealed: boolean;
  secretRevealed: boolean;
  bonus: number;
  isLong: boolean;
  leverage: number;
  entryPx: bigint;
  lastPx: bigint;
  roe: number;
  minRoe: number;
  maxRoe: number;
  liquidated: boolean;
}
interface ChainDuel {
  phase: number;
  duration: bigint;
  stake: bigint;
  nonceA: bigint;
  seed: Hex;
  deadline: bigint;
  startedAt: bigint;
  endAt: bigint;
  scoreA: number;
  scoreB: number;
  winner: Address;
  seats: readonly [ChainSeat, ChainSeat];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * One player's side of a DuelArena duel, with nobody in between: it reads the contract,
 * works out its own hand and hidden bonuses, and sends each transaction when its turn
 * comes. The app and the bot both run this class; neither has any special standing.
 *
 * Nothing is stored. Every salt is derived from the key and on-chain state, so a duel
 * can be picked back up after a restart.
 */
export class ArenaPlayer {
  readonly address: Address;
  private readonly client: PublicClient;
  private readonly wallet: ReturnType<typeof walletClientOf>;
  private id = 0n;
  private choice: number | null = null;
  private sending = false;
  private retryAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private finished = false;
  private clockOffsetMs = 0;
  private lastTx: Hex | null = null;

  constructor(
    private readonly info: ArenaInfo,
    private readonly key: Hex,
    private readonly markets: ArenaMarket[],
    private readonly events: PlayerEvents,
    /** Lets a bot choose a card the moment its hand is dealt. */
    private readonly autoPick?: (hand: Card[]) => number,
  ) {
    this.address = privateKeyToAccount(key).address;
    this.client = publicClientOf(info);
    this.wallet = walletClientOf(info, key);
  }

  get duelId() {
    return this.id;
  }
  get done() {
    return this.finished;
  }

  /** Pick up the duel this key is already seated in, if any. */
  async resume(): Promise<boolean> {
    this.id = (await this.read('activeOf', [this.address])) as bigint;
    return this.id !== 0n;
  }

  /** Join the duel waiting at these terms, or open one and wait. */
  async find(terms: { duration: number; stake: bigint }): Promise<void> {
    if (await this.resume()) return;
    const balance = await this.client.getBalance({ address: this.address });
    if (balance <= terms.stake) throw new Error(`This wallet needs more than the stake to cover gas. Send HYPE to ${this.address} and try again.`);

    const key = (await this.read('termsKey', [BigInt(terms.duration), terms.stake])) as Hex;
    const waiting = (await this.read('waiting', [key])) as bigint;
    if (waiting !== 0n) {
      const salt = deriveSalt(this.key, 'join', waiting);
      const secret = deriveSalt(this.key, 'secretB', waiting);
      this.events.onBusy('Taking a seat');
      try {
        await this.send('join', [waiting, salt, secretCommitOf(this.address, secret)], terms.stake);
        this.id = waiting;
        return;
      } catch {
        // Someone else took the seat first. Open a new duel instead.
      } finally {
        this.events.onBusy(null);
      }
    }
    const nonce = (await this.read('opened', [this.address])) as bigint;
    this.events.onBusy('Opening a duel');
    try {
      await this.send(
        'open',
        [BigInt(terms.duration), dealCommitOf(this.address, deriveSalt(this.key, 'deal', nonce)), secretCommitOf(this.address, deriveSalt(this.key, 'secret', nonce))],
        terms.stake,
      );
    } finally {
      this.events.onBusy(null);
    }
    this.id = (await this.read('activeOf', [this.address])) as bigint;
  }

  choose(cardIndex: number) {
    if (this.choice === null) this.choice = cardIndex;
  }

  /** Take your stake back while nobody has joined. */
  async leave(): Promise<void> {
    if (this.id === 0n) return;
    const duel = (await this.read('getDuel', [this.id])) as ChainDuel;
    if (duel.phase === Phase.Open) await this.send('cancel', [this.id]);
  }

  start(intervalMs = 700) {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read the duel, do whatever is this player's to do, and report the view. */
  async tick(): Promise<void> {
    if (this.id === 0n || this.sending || this.finished) return;
    try {
      const duel = (await this.read('getDuel', [this.id])) as ChainDuel;
      const seat = same(duel.seats[0].player, this.address) ? 0 : 1;
      let seats = duel.seats;
      let chainNow = BigInt(Math.floor(Date.now() / 1000));
      if (duel.phase === Phase.Live) {
        const [a, b, now] = (await this.read('live', [this.id])) as [ChainSeat, ChainSeat, bigint];
        seats = [a, b];
        chainNow = now;
        this.clockOffsetMs = Number(now) * 1000 - Date.now();
      }
      // There is no table to show until an opponent has joined and the cards are dealt.
      if (duel.phase >= Phase.Picking) this.events.onView(this.view(duel, seats, seat));
      if (duel.phase === Phase.Settled || duel.phase === Phase.Cancelled) {
        this.finished = true;
        this.stop();
        return;
      }
      if (Date.now() >= this.retryAt) await this.act(duel, seats, seat, chainNow);
    } catch (e) {
      this.retryAt = Date.now() + 3000;
      this.events.onBusy(null);
      this.events.onError(readable(e));
    }
  }

  private async act(duel: ChainDuel, liveSeats: readonly [ChainSeat, ChainSeat], seat: 0 | 1, chainNow: bigint) {
    const me = duel.seats[seat];
    const opp = duel.seats[seat === 0 ? 1 : 0];
    const late = chainNow > duel.deadline;
    const secret = this.secretSalt(duel, seat);

    if (duel.phase === Phase.Joined) {
      if (seat === 0) return this.step('Dealing the cards', 'deal', [this.id, deriveSalt(this.key, 'deal', duel.nonceA)]);
      if (late) return this.step('Claiming the pot', 'timeout', [this.id]);
      return;
    }

    if (duel.phase === Phase.Picking) {
      const pickSalt = deriveSalt(this.key, 'pick', this.id);
      if (this.choice === null && me.pickCommit !== ZERO) {
        // After a restart: find which card the on-chain commitment was for.
        this.choice = [0, 1, 2, 3, 4].find((i) => pickCommitOf(this.id, this.address, i, pickSalt) === me.pickCommit) ?? null;
      }
      if (this.choice === null && this.autoPick) this.choice = this.autoPick(this.hand(duel, seat, secret));
      if (late) {
        const mine = (me.pickCommit !== ZERO ? 1 : 0) + (me.pickRevealed ? 1 : 0);
        const theirs = (opp.pickCommit !== ZERO ? 1 : 0) + (opp.pickRevealed ? 1 : 0);
        if (mine >= theirs) return this.step(mine > theirs ? 'Claiming the pot' : 'Calling the duel off', 'timeout', [this.id]);
        return;
      }
      if (this.choice === null) return;
      if (me.pickCommit === ZERO) return this.step('Locking in', 'commitPick', [this.id, pickCommitOf(this.id, this.address, this.choice, pickSalt)]);
      if (opp.pickCommit !== ZERO && !me.pickRevealed) return this.step('Showing your card', 'revealPick', [this.id, this.choice, pickSalt]);
      return;
    }

    if (duel.phase === Phase.Live) {
      if (chainNow >= duel.endAt || Date.now() + this.clockOffsetMs >= Number(duel.endAt) * 1000 + 1500) {
        return this.step('Closing the duel', 'reveal', [this.id, secret]);
      }
      if (this.worthPoking(duel, liveSeats, seat, secret)) return this.step(null, 'poke', [this.id]);
      return;
    }

    if (duel.phase === Phase.Closed) {
      if (!me.secretRevealed) return this.step('Opening your seal', 'reveal', [this.id, secret]);
      if (late) return this.step('Collecting the result', 'settle', [this.id]);
    }
  }

  /**
   * The contract only sees a price when someone pokes. Poke when it helps this player:
   * the opponent is under water, or this player's own hidden bonus just came true.
   */
  private worthPoking(duel: ChainDuel, liveSeats: readonly [ChainSeat, ChainSeat], seat: 0 | 1, secret: Hex): boolean {
    const other = seat === 0 ? 1 : 0;
    const stored = duel.seats[seat];
    const now = liveSeats[seat];
    if (liveSeats[other].liquidated && !duel.seats[other].liquidated) return true;
    const bonus = arenaBonus(secret, duel.seed, stored.pick);
    if (bonus === 'phoenix') return now.liquidated && !stored.liquidated;
    if (now.liquidated) return false;
    const low = (bps: number) => now.roe <= bps && stored.minRoe > bps;
    const high = (bps: number) => now.roe >= bps && stored.maxRoe < bps;
    if (bonus === 'closeShave') return low(-7500);
    if (bonus === 'comeback') return low(-5000);
    if (bonus === 'moonshot') return high(10000);
    if (bonus === 'whipsaw') return low(-5000) || high(5000);
    return false;
  }

  private secretSalt(duel: ChainDuel, seat: 0 | 1): Hex {
    return seat === 0 ? deriveSalt(this.key, 'secret', duel.nonceA) : deriveSalt(this.key, 'secretB', this.id);
  }

  private hand(duel: ChainDuel, seat: 0 | 1, secret: Hex): Card[] {
    return arenaHand(duel.seed, seat, this.markets.length).map((c, i) => ({
      coin: this.markets[c.market]?.coin ?? `#${c.market}`,
      side: c.side,
      leverage: c.leverage,
      secret: arenaBonus(secret, duel.seed, i),
    }));
  }

  private view(duel: ChainDuel, seats: readonly [ChainSeat, ChainSeat], seat: 0 | 1): MatchView {
    const other = seat === 0 ? 1 : 0;
    const me = seats[seat];
    const opp = seats[other];
    const dealt = duel.phase >= Phase.Picking && duel.seed !== ZERO;
    const hand = dealt ? this.hand(duel, seat, this.secretSalt(duel, seat)) : [];
    const oppHand = dealt ? arenaHand(duel.seed, other, this.markets.length) : [];
    const started = duel.startedAt !== 0n;
    const settled = duel.phase === Phase.Settled || duel.phase === Phase.Cancelled;

    const position = (s: ChainSeat, coin: string): PositionState => {
      const scale = this.markets.find((m) => m.coin === coin)?.scale ?? 1;
      const entry = Number(s.entryPx) * scale;
      return {
        entry,
        liq: liquidationPrice(entry, s.isLong ? 'long' : 'short', s.leverage),
        last: Number(s.lastPx) * scale,
        roe: s.roe / 100,
        minRoe: s.minRoe / 100,
        maxRoe: s.maxRoe / 100,
        maxLiqProgress: Math.max(0, Math.min(1, -s.minRoe / 10000)),
        liquidated: s.liquidated,
        liquidatedAt: null,
        ticks: 0,
      };
    };
    const myPick = me.pickRevealed ? me.pick : this.choice;
    const myCard = myPick === null ? null : (hand[myPick] ?? null);
    const oppFace = opp.pickRevealed && oppHand[opp.pick] ? oppHand[opp.pick]! : null;
    const oppCoin = oppFace ? (this.markets[oppFace.market]?.coin ?? `#${oppFace.market}`) : null;

    const line = (s: ChainSeat, score: number): ScoreLine => {
      const base = Math.trunc(s.roe / 10) / 10;
      const bonus = (score - Math.trunc(s.roe / 10)) / 10;
      return { base, bonus, total: score / 10, secret: bonusFromChain(s.bonus), secretHit: bonus > 0 };
    };
    const scores = seat === 0 ? [duel.scoreA, duel.scoreB] : [duel.scoreB, duel.scoreA];
    const none = /^0x0+$/.test(duel.winner);
    const forfeit = duel.phase === Phase.Cancelled;

    return {
      id: `0x${this.id.toString(16)}` as Hex,
      nonce: ZERO,
      duration: Number(duel.duration),
      stake: duel.stake.toString(),
      phase: settled ? 'settled' : started ? 'live' : 'picking',
      startAt: started ? Number(duel.startedAt) * 1000 - this.clockOffsetMs : null,
      endAt: started ? Number(duel.endAt) * 1000 - this.clockOffsetMs : null,
      seat,
      onchain: true,
      settleTx: settled ? this.lastTx : null,
      note: forfeit
        ? none
          ? 'Neither player finished the set-up in time, so both stakes went back.'
          : same(duel.winner, this.address)
            ? 'Your opponent missed a deadline and forfeited.'
            : 'You missed a deadline and forfeited.'
        : duel.phase === Phase.Closed
          ? 'Time. Both seals are being opened on-chain.'
          : null,
      you: { address: me.player, name: 'You', hand, pick: myPick, card: myCard, pos: started && myCard ? position(me, myCard.coin) : null },
      opp: {
        address: opp.player,
        name: /^0x0+$/.test(opp.player) ? 'Opponent' : short(opp.player),
        isBot: false,
        locked: opp.pickCommit !== ZERO,
        face: started && oppFace && oppCoin ? { coin: oppCoin, side: oppFace.side, leverage: oppFace.leverage } : null,
        card: settled && oppFace && oppCoin ? { coin: oppCoin, side: oppFace.side, leverage: oppFace.leverage, secret: bonusFromChain(opp.bonus) } : null,
        salt: null,
        pos: started && oppCoin ? position(opp, oppCoin) : null,
      },
      yourSalt: null,
      result: settled
        ? {
            you: forfeit ? emptyLine : line(me, scores[0] as number),
            opp: forfeit ? emptyLine : line(opp, scores[1] as number),
            outcome: none ? 'draw' : same(duel.winner, this.address) ? 'win' : 'loss',
          }
        : null,
    } as MatchView;
  }

  private async step(label: string | null, functionName: string, args: unknown[]) {
    if (label) this.events.onBusy(label);
    try {
      await this.send(functionName, args);
    } finally {
      if (label) this.events.onBusy(null);
    }
  }

  private read(functionName: string, args: unknown[] = []): Promise<unknown> {
    return this.client.readContract({ address: this.info.address, abi: arenaAbi, functionName: functionName as never, args: args as never });
  }

  /** Simulate first so a revert costs nothing, then send and wait for the receipt. */
  private async send(functionName: string, args: unknown[], value?: bigint): Promise<Hex> {
    this.sending = true;
    try {
      const { request } = await this.client.simulateContract({
        address: this.info.address,
        abi: arenaAbi,
        functionName: functionName as never,
        args: args as never,
        value: value as never,
        account: this.wallet.account,
      });
      const hash = await this.wallet.writeContract(request as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${functionName} was rejected by the contract`);
      this.lastTx = hash;
      return hash;
    } finally {
      this.sending = false;
    }
  }
}

const emptyLine: ScoreLine = { base: 0, bonus: 0, total: 0, secret: null, secretHit: false };

function readable(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? 'Something went wrong talking to the chain').split('\n')[0] as string;
}
