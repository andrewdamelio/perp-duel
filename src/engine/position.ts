import type { Card, PositionState, Side } from './types';

const sign = (side: Side) => (side === 'long' ? 1 : -1);

/**
 * The price at which a card is wiped out: when the move against it equals its margin.
 * At 1000x that is a 0.1% move. These are synthetic positions at leverage no venue
 * offers, so there is no maintenance margin to model: the card dies at -100%.
 */
export function liquidationPrice(entry: number, side: Side, leverage: number): number {
  return entry * (1 - sign(side) / leverage);
}

export function roePercent(entry: number, price: number, side: Side, leverage: number): number {
  return sign(side) * (price / entry - 1) * leverage * 100;
}

export function openPosition(card: Card, entry: number): PositionState {
  return {
    entry,
    liq: liquidationPrice(entry, card.side, card.leverage),
    last: entry,
    roe: 0,
    minRoe: 0,
    maxRoe: 0,
    maxLiqProgress: 0,
    liquidated: false,
    liquidatedAt: null,
    ticks: 0,
  };
}

/** Apply one price observation. Once liquidated, a position never changes again. */
export function applyPrice(pos: PositionState, card: Card, price: number, at: number): PositionState {
  if (pos.liquidated || !(price > 0)) return pos;
  const s = sign(card.side);
  const adverse = -s * (price - pos.entry);
  const distance = Math.abs(pos.entry - pos.liq);
  const progress = Math.max(0, Math.min(1, adverse / distance));
  const crossed = s === 1 ? price <= pos.liq : price >= pos.liq;

  if (crossed) {
    return {
      ...pos,
      last: price,
      roe: -100,
      minRoe: -100,
      maxLiqProgress: 1,
      liquidated: true,
      liquidatedAt: at,
      ticks: pos.ticks + 1,
    };
  }
  const roe = roePercent(pos.entry, price, card.side, card.leverage);
  return {
    ...pos,
    last: price,
    roe,
    minRoe: Math.min(pos.minRoe, roe),
    maxRoe: Math.max(pos.maxRoe, roe),
    maxLiqProgress: Math.max(pos.maxLiqProgress, progress),
    ticks: pos.ticks + 1,
  };
}
