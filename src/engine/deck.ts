import { SECRET_IDS } from './secrets';
import { pickOne, rngFromSeed, shuffled } from './rng';
import type { Card, Hex, Market } from './types';

export const HAND_SIZE = 5;
export const SECRETS_PER_HAND = 2;
/** Far beyond what any venue offers. Change this one line to turn the chaos up or down. */
export const LEVERAGE_TIERS = [100, 250, 500, 1000];

function dealHand(rand: () => number, markets: Market[]): Card[] {
  // Mix asset classes when the universe allows it: at least two crypto and two non-crypto.
  const crypto = shuffled(rand, markets.filter((m) => m.cls === 'crypto'));
  const other = shuffled(rand, markets.filter((m) => m.cls !== 'crypto'));
  const picked = [...crypto.slice(0, 2), ...other.slice(0, 2)];
  const rest = shuffled(rand, [...crypto.slice(2), ...other.slice(2)]);
  while (picked.length < HAND_SIZE && rest.length) picked.push(rest.pop() as Market);

  const cards: Card[] = shuffled(rand, picked).map((m) => ({
    coin: m.coin,
    side: rand() < 0.5 ? 'long' : 'short',
    leverage: pickOne(rand, LEVERAGE_TIERS),
    secret: null,
  }));

  // Every hand offers both directions.
  if (cards.length > 1 && cards.every((c) => c.side === cards[0]!.side)) {
    const flip = cards[Math.floor(rand() * cards.length)]!;
    flip.side = flip.side === 'long' ? 'short' : 'long';
  }

  const secretIds = shuffled(rand, SECRET_IDS);
  const slots = shuffled(rand, cards.map((_, i) => i)).slice(0, SECRETS_PER_HAND);
  slots.forEach((slot, i) => {
    cards[slot]!.secret = secretIds[i]!;
  });
  return cards;
}

/** Deal both hands from one seed. Deterministic, so a published seed lets anyone re-deal and check. */
export function deal(seed: Hex, markets: Market[]): [Card[], Card[]] {
  if (markets.length < HAND_SIZE) throw new Error(`Need at least ${HAND_SIZE} priced markets to deal, got ${markets.length}`);
  const rand = rngFromSeed(seed);
  return [dealHand(rand, markets), dealHand(rand, markets)];
}
