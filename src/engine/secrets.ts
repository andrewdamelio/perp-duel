import type { Card, PositionState, SecretId } from './types';

export interface SecretContext {
  card: Card;
  pos: PositionState;
  oppCard: Card;
  oppPos: PositionState;
}

export interface Secret {
  id: SecretId;
  name: string;
  /** Shown to the card's owner, and to everyone once the duel settles. */
  rule: string;
  points: number;
  met: (ctx: SecretContext) => boolean;
}

/**
 * Hidden win conditions. Each is decided purely from the price path of the two
 * positions, so the referee and anyone replaying the ticks reach the same answer.
 */
export const SECRETS: Record<SecretId, Secret> = {
  phoenix: {
    id: 'phoenix',
    name: 'Phoenix',
    rule: 'Get liquidated.',
    points: 250,
    met: ({ pos }) => pos.liquidated,
  },
  closeShave: {
    id: 'closeShave',
    name: 'Close shave',
    rule: 'Get three quarters of the way to liquidation and survive.',
    points: 100,
    met: ({ pos }) => !pos.liquidated && pos.maxLiqProgress >= 0.75,
  },
  comeback: {
    id: 'comeback',
    name: 'Comeback',
    rule: 'Drop to −50% or worse, then finish in profit.',
    points: 80,
    met: ({ pos }) => !pos.liquidated && pos.minRoe <= -50 && pos.roe > 0,
  },
  moonshot: {
    id: 'moonshot',
    name: 'Moonshot',
    rule: 'Touch +100% at any point.',
    points: 60,
    met: ({ pos }) => pos.maxRoe >= 100,
  },
  schadenfreude: {
    id: 'schadenfreude',
    name: 'Schadenfreude',
    rule: 'Your opponent gets liquidated.',
    points: 100,
    met: ({ oppPos }) => oppPos.liquidated,
  },
  flatline: {
    id: 'flatline',
    name: 'Flatline',
    rule: 'Finish within 10% of where you started.',
    points: 75,
    met: ({ pos }) => !pos.liquidated && Math.abs(pos.roe) <= 10,
  },
  underdog: {
    id: 'underdog',
    name: 'Underdog',
    rule: 'Out-earn your opponent using less leverage than they did.',
    points: 75,
    met: ({ card, pos, oppCard, oppPos }) => card.leverage < oppCard.leverage && pos.roe > oppPos.roe,
  },
  whipsaw: {
    id: 'whipsaw',
    name: 'Whipsaw',
    rule: 'Touch both +50% and −50% during the duel.',
    points: 80,
    met: ({ pos }) => pos.maxRoe >= 50 && pos.minRoe <= -50,
  },
};

export const SECRET_IDS = Object.keys(SECRETS) as SecretId[];
