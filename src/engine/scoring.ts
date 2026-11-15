import { SECRETS } from './secrets';
import type { Card, MatchResult, PositionState, ScoreLine } from './types';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreLine(card: Card, pos: PositionState, oppCard: Card, oppPos: PositionState): ScoreLine {
  const base = round1(Math.max(-100, pos.roe));
  const secret = card.secret ? SECRETS[card.secret] : null;
  const secretHit = secret ? secret.met({ card, pos, oppCard, oppPos }) : false;
  const bonus = secret && secretHit ? secret.points : 0;
  return { base, bonus, total: round1(base + bonus), secret: card.secret, secretHit };
}

export function decide(
  a: { card: Card; pos: PositionState },
  b: { card: Card; pos: PositionState },
): MatchResult {
  const la = scoreLine(a.card, a.pos, b.card, b.pos);
  const lb = scoreLine(b.card, b.pos, a.card, a.pos);
  const winner = la.total === lb.total ? null : la.total > lb.total ? 0 : 1;
  return { lines: [la, lb], winner };
}

/** Scores go on-chain as integers in tenths of a point. */
export const toOnchainScore = (total: number) => Math.round(total * 10);
