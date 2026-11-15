import { duelIdOf, pickCommit } from './commit';
import { deal } from './deck';
import { marketByCoin } from './markets';
import { applyPrice, openPosition } from './position';
import { decide } from './scoring';
import type { Address, Card, Hex, Market, Match, MatchView, Seat } from './types';

export type Mids = Record<string, number>;

export interface NewMatchInput {
  nonce: Hex;
  seed: Hex;
  duration: number;
  stake: bigint;
  players: [{ address: Address; name: string; isBot: boolean }, { address: Address; name: string; isBot: boolean }];
  markets: Market[];
  onchain: boolean;
  now: number;
}

export function newMatch(input: NewMatchInput): Match {
  const [handA, handB] = deal(input.seed, input.markets);
  const [a, b] = input.players;
  const seat = (p: typeof a, hand: Card[]): Seat => ({ ...p, hand, pick: null, salt: null, commit: null, pos: null });
  return {
    id: duelIdOf(a.address, b.address, input.duration, input.stake, input.nonce),
    nonce: input.nonce,
    seed: input.seed,
    duration: input.duration,
    stake: input.stake.toString(),
    seats: [seat(a, handA), seat(b, handB)],
    phase: 'picking',
    createdAt: input.now,
    startAt: null,
    endAt: null,
    result: null,
    onchain: input.onchain,
    settleTx: null,
    note: null,
  };
}

export const pickedCard = (seat: Seat): Card | null => (seat.pick === null ? null : (seat.hand[seat.pick] ?? null));

/** Lock a seat's card. A pick is final: the salted commitment is what goes on-chain. */
export function lockPick(match: Match, seatIndex: 0 | 1, cardIndex: number, salt: Hex): Match {
  if (match.phase !== 'picking') throw new Error('Picks are closed for this duel');
  const seat = match.seats[seatIndex];
  if (seat.pick !== null) throw new Error('This seat has already locked a card');
  const card = seat.hand[cardIndex];
  if (!card) throw new Error(`No card at index ${cardIndex}`);
  const next: Seat = { ...seat, pick: cardIndex, salt, commit: pickCommit(match.id, seat.address, card, salt) };
  const seats: [Seat, Seat] = seatIndex === 0 ? [next, match.seats[1]] : [match.seats[0], next];
  return { ...match, seats };
}

/** Open both positions at the current mids. `startAt` is passed in so it can follow the escrow's own clock. */
export function start(match: Match, mids: Mids, markets: Market[], startAt: number): Match {
  if (match.phase !== 'picking') return match;
  const cards = match.seats.map(pickedCard);
  if (!cards[0] || !cards[1]) throw new Error('Both players must lock a card before the duel starts');
  const seats = match.seats.map((seat, i) => {
    const card = cards[i] as Card;
    const market = marketByCoin(markets, card.coin);
    const entry = mids[card.coin];
    if (!market || !(entry && entry > 0)) throw new Error(`No live price for ${card.coin}`);
    return { ...seat, pos: openPosition(card, entry) };
  }) as [Seat, Seat];
  return { ...match, seats, phase: 'live', startAt, endAt: startAt + match.duration * 1000 };
}

/** Feed one set of mids into a live duel. Settles it once the clock runs out. */
export function tick(match: Match, mids: Mids, now: number): Match {
  if (match.phase !== 'live' || match.endAt === null) return match;
  const at = Math.min(now, match.endAt);
  const seats = match.seats.map((seat) => {
    const card = pickedCard(seat) as Card;
    const price = mids[card.coin];
    return price && seat.pos ? { ...seat, pos: applyPrice(seat.pos, card, price, at) } : seat;
  }) as [Seat, Seat];
  const next = { ...match, seats };
  return now >= match.endAt ? settle(next) : next;
}

export function settle(match: Match): Match {
  if (match.phase !== 'live') return match;
  const [a, b] = match.seats;
  const result = decide(
    { card: pickedCard(a) as Card, pos: a.pos! },
    { card: pickedCard(b) as Card, pos: b.pos! },
  );
  return { ...match, phase: 'settled', result };
}

/** Redact a match for one seat. Hands, secrets and salts of the other seat stay private until settlement. */
export function viewFor(match: Match, seatIndex: 0 | 1): MatchView {
  const you = match.seats[seatIndex];
  const opp = match.seats[seatIndex === 0 ? 1 : 0];
  const oppCard = pickedCard(opp);
  const settled = match.phase === 'settled';
  const live = match.phase !== 'picking';
  const lines = match.result?.lines;
  return {
    id: match.id,
    nonce: match.nonce,
    duration: match.duration,
    stake: match.stake,
    phase: match.phase,
    startAt: match.startAt,
    endAt: match.endAt,
    seat: seatIndex,
    onchain: match.onchain,
    settleTx: match.settleTx,
    note: match.note,
    you: { address: you.address, name: you.name, hand: you.hand, pick: you.pick, card: pickedCard(you), pos: you.pos },
    opp: {
      address: opp.address,
      name: opp.name,
      isBot: opp.isBot,
      locked: opp.pick !== null,
      face: live && oppCard ? { coin: oppCard.coin, side: oppCard.side, leverage: oppCard.leverage } : null,
      card: settled ? oppCard : null,
      salt: settled ? opp.salt : null,
      pos: live ? opp.pos : null,
    },
    yourSalt: you.salt,
    result:
      settled && lines && match.result
        ? {
            you: lines[seatIndex],
            opp: lines[seatIndex === 0 ? 1 : 0],
            outcome: match.result.winner === null ? 'draw' : match.result.winner === seatIndex ? 'win' : 'loss',
          }
        : null,
  };
}
