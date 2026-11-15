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
} from '../src/engine';
import type { PriceFeed } from '../src/hl/feed';
import { DuelStatus, type EscrowChain } from './chain';

export interface RefereeDeps {
  feed: PriceFeed;
  /** Present when stakes are escrowed on-chain. Without it the referee runs play-money duels. */
  chain?: EscrowChain;
  now?: () => number;
  /** How long the house bot "thinks" before locking a card. */
  botDelayMs?: number;
  random?: () => number;
  log?: (line: string) => void;
}

export interface QueueRequest {
  address: Address;
  name?: string;
  duration: number;
  stake: string;
  /** Skip the queue and play the house bot. */
  bot?: boolean;
}

export class RefereeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PRACTICE_BOT = '0x000000000000000000000000000000000000b07a' as Address;
const PICK_TIMEOUT_MS = 20 * 60_000;
const SETTLE_RETRY_MS = 10_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Matchmaker, dealer and scorekeeper. Holds state in memory, which is enough for a demo:
 * if it restarts mid-duel, players get their stakes back through DuelEscrow.refund.
 */
export class Referee {
  private matches = new Map<Hex, Match>();
  private dealtFrom = new Map<Hex, Market[]>();
  private waiting = new Map<string, { ticket: string; request: QueueRequest }>();
  private tickets = new Map<string, Hex | null>();
  private botPickAt = new Map<Hex, number>();
  private settleAfter = new Map<Hex, number>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RefereeDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
  }

  info() {
    const { chain, feed } = this.deps;
    return {
      feed: feed.status(),
      markets: feed.markets().length,
      chain: chain ? { chainId: chain.chainId, rpcUrl: chain.rpcUrl, escrow: chain.escrow, referee: chain.refereeAddress } : null,
    };
  }

  queue(request: QueueRequest): { ticket: string; matchId: Hex | null } {
    if (!Number.isInteger(request.duration) || request.duration < 30) throw new RefereeError('Duration must be at least 30 seconds');
    if (!/^[1-9]\d*$/.test(request.stake)) throw new RefereeError('Stake must be a positive amount in wei');
    const ticket = randomHex32().slice(2, 18);
    const me = { address: request.address, name: request.name ?? short(request.address), isBot: false };

    if (request.bot) {
      const bot = { address: this.deps.chain?.botAddress ?? PRACTICE_BOT, name: 'House bot', isBot: true };
      const match = this.open(request, [me, bot]);
      this.botPickAt.set(match.id, this.now() + (this.deps.botDelayMs ?? 2500));
      this.tickets.set(ticket, match.id);
      return { ticket, matchId: match.id };
    }

    const key = `${request.duration}:${request.stake}`;
    const other = this.waiting.get(key);
    if (other && !same(other.request.address, request.address)) {
      this.waiting.delete(key);
      const them = { address: other.request.address, name: other.request.name ?? short(other.request.address), isBot: false };
      const match = this.open(request, [them, me]);
      this.tickets.set(other.ticket, match.id);
      this.tickets.set(ticket, match.id);
      return { ticket, matchId: match.id };
    }
    this.waiting.set(key, { ticket, request });
    this.tickets.set(ticket, null);
    return { ticket, matchId: null };
  }

  ticket(ticket: string): { matchId: Hex | null } {
    if (!this.tickets.has(ticket)) throw new RefereeError('Unknown ticket', 404);
    return { matchId: this.tickets.get(ticket) ?? null };
  }

  leaveQueue(ticket: string) {
    for (const [key, w] of this.waiting) if (w.ticket === ticket) this.waiting.delete(key);
    this.tickets.delete(ticket);
  }

  view(matchId: Hex, player: Address): MatchView {
    const { match, seat } = this.seatOf(matchId, player);
    return viewFor(match, seat);
  }

  /** The unfinished duel this address is seated in, so the app can pick a long duel back up after a restart. */
  activeFor(player: Address): Hex | null {
    let latest: Match | null = null;
    for (const m of this.matches.values()) {
      const unfinished = m.phase !== 'settled' || (m.onchain && !m.settleTx);
      if (unfinished && m.seats.some((s) => same(s.address, player)) && (!latest || m.createdAt > latest.createdAt)) latest = m;
    }
    return latest?.id ?? null;
  }

  async pick(matchId: Hex, player: Address, cardIndex: number, salt: Hex): Promise<MatchView> {
    const { match, seat } = this.seatOf(matchId, player);
    const card = match.seats[seat].hand[cardIndex];
    if (!card) throw new RefereeError(`No card at index ${cardIndex}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new RefereeError('Salt must be 32 bytes of hex');

    if (this.deps.chain) {
      // The stake and commitment must already be in the escrow, and must be for this exact card.
      const duel = await this.deps.chain.getDuel(match.id);
      const onchain = seat === 0 ? duel.commitA : duel.commitB;
      if (onchain !== pickCommit(match.id, match.seats[seat].address, card, salt)) {
        throw new RefereeError('The escrow does not hold a matching commitment for this card yet', 409);
      }
    }
    let next: Match;
    try {
      next = lockPick(match, seat, cardIndex, salt);
    } catch (e) {
      throw new RefereeError((e as Error).message, 409);
    }
    this.matches.set(match.id, next);
    return viewFor(next, seat);
  }

  /** Advance every duel by one step. Call on a short interval. */
  async step(): Promise<void> {
    for (const id of [...this.matches.keys()]) {
      try {
        await this.stepOne(id);
      } catch (e) {
        this.log(`duel ${short(id)}: ${(e as Error).message}`);
      }
    }
  }

  private async stepOne(id: Hex) {
    const { chain, feed } = this.deps;
    let match = this.matches.get(id) as Match;
    const now = this.now();

    if (match.phase === 'picking') {
      if (now - match.createdAt > PICK_TIMEOUT_MS) {
        this.matches.delete(id);
        this.log(`duel ${short(id)} abandoned before both players locked in`);
        return;
      }
      const botSeat = match.seats.findIndex((s) => s.isBot) as -1 | 0 | 1;
      const due = this.botPickAt.get(id);
      if (botSeat !== -1 && match.seats[botSeat]!.pick === null && due !== undefined && now >= due) {
        this.botPickAt.delete(id);
        const seat = match.seats[botSeat]!;
        const cardIndex = Math.floor(this.random() * seat.hand.length);
        const salt = randomHex32();
        if (chain) await chain.enterAsBot(match, pickCommit(match.id, seat.address, seat.hand[cardIndex]!, salt));
        match = lockPick(this.matches.get(id) as Match, botSeat, cardIndex, salt);
        this.matches.set(id, match);
      }
      if (match.seats.every((s) => s.pick !== null)) {
        let startAt = now;
        if (chain) {
          const duel = await chain.getDuel(id);
          if (duel.status !== DuelStatus.Live) return;
          // The escrow's clock is the one that decides when settlement is allowed.
          startAt = Number(duel.startedAt) * 1000;
        }
        match = start(match, feed.mids(), this.dealtFrom.get(id) as Market[], startAt);
        this.matches.set(id, match);
        this.log(`duel ${short(id)} is live for ${match.duration}s`);
      }
      return;
    }

    if (match.phase === 'live') {
      match = tick(match, feed.mids(), now);
      this.matches.set(id, match);
      if (match.phase !== 'settled') return;
      this.log(`duel ${short(id)} scored ${match.result!.lines[0].total} : ${match.result!.lines[1].total}`);
    }

    if (match.phase === 'settled' && chain && !match.settleTx && now >= (this.settleAfter.get(id) ?? 0)) {
      try {
        const settleTx = await chain.settle(match);
        this.matches.set(id, { ...(this.matches.get(id) as Match), settleTx, note: null });
        this.log(`duel ${short(id)} paid out in ${settleTx}`);
      } catch (e) {
        // Usually the chain's clock is a block behind ours. Try again shortly.
        this.settleAfter.set(id, now + SETTLE_RETRY_MS);
        this.matches.set(id, { ...(this.matches.get(id) as Match), note: 'Waiting for the escrow to accept the result' });
        throw e;
      }
    }
  }

  private open(request: QueueRequest, players: Parameters<typeof newMatch>[0]['players']): Match {
    const markets = this.deps.feed.markets();
    if (markets.length < 5) throw new RefereeError('Prices are not ready yet, try again in a moment', 503);
    const match = newMatch({
      nonce: randomHex32(),
      seed: randomHex32(),
      duration: request.duration,
      stake: BigInt(request.stake),
      players,
      markets,
      onchain: Boolean(this.deps.chain),
      now: this.now(),
    });
    this.matches.set(match.id, match);
    this.dealtFrom.set(match.id, markets);
    this.log(`duel ${short(match.id)} opened: ${players[0].name} vs ${players[1].name}`);
    return match;
  }

  private seatOf(matchId: Hex, player: Address): { match: Match; seat: 0 | 1 } {
    const match = this.matches.get(matchId);
    if (!match) throw new RefereeError('Unknown duel', 404);
    const seat = match.seats.findIndex((s) => same(s.address, player));
    if (seat === -1) throw new RefereeError('This address is not seated in that duel', 403);
    return { match, seat: seat as 0 | 1 };
  }
}
