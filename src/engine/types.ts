export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export type Side = 'long' | 'short';
export type AssetClass = 'crypto' | 'stock' | 'index' | 'commodity';

/** A Hyperliquid perp market. `coin` is the key Hyperliquid uses in allMids, e.g. "BTC" or "xyz:NVDA". */
export interface Market {
  coin: string;
  ticker: string;
  name: string;
  cls: AssetClass;
  /** Perp dex the market lives on: '' for the native dex, e.g. 'xyz' for a HIP-3 builder dex. */
  dex: string;
  maxLeverage: number;
  /** Rough price used only by the simulated feed. */
  simPrice: number;
  /** Rough annualised volatility used only by the simulated feed. */
  simVol: number;
}

export type SecretId =
  | 'phoenix'
  | 'closeShave'
  | 'comeback'
  | 'moonshot'
  | 'schadenfreude'
  | 'flatline'
  | 'underdog'
  | 'whipsaw';

/** One playing card: a synthetic perp position, optionally carrying a hidden win condition. */
export interface Card {
  coin: string;
  side: Side;
  leverage: number;
  secret: SecretId | null;
}

/** What the opponent is allowed to see of a card while the duel is live. */
export type CardFace = Omit<Card, 'secret'>;

/** Running state of a synthetic position, updated on every price tick. */
export interface PositionState {
  entry: number;
  liq: number;
  last: number;
  /** Return on margin in percent. Frozen at -100 once liquidated. */
  roe: number;
  minRoe: number;
  maxRoe: number;
  /** Closest approach to liquidation: 0 = never moved against you, 1 = liquidated. */
  maxLiqProgress: number;
  liquidated: boolean;
  liquidatedAt: number | null;
  ticks: number;
}

export interface ScoreLine {
  /** Points from return on margin: 1 point per 1%, floored at -100. */
  base: number;
  /** Points from the card's hidden win condition, 0 if none or not met. */
  bonus: number;
  total: number;
  secret: SecretId | null;
  secretHit: boolean;
}

export type Phase = 'picking' | 'live' | 'settled';

export interface Seat {
  address: Address;
  name: string;
  isBot: boolean;
  hand: Card[];
  pick: number | null;
  salt: Hex | null;
  commit: Hex | null;
  pos: PositionState | null;
}

export interface MatchResult {
  lines: [ScoreLine, ScoreLine];
  /** Seat index of the winner, or null for a draw (stakes returned). */
  winner: 0 | 1 | null;
}

export interface Match {
  id: Hex;
  nonce: Hex;
  seed: Hex;
  /** Seconds. */
  duration: number;
  /** Stake per player in wei, as a decimal string. */
  stake: string;
  seats: [Seat, Seat];
  phase: Phase;
  createdAt: number;
  /** Milliseconds since epoch. */
  startAt: number | null;
  endAt: number | null;
  result: MatchResult | null;
  /** True when stakes are escrowed in the DuelEscrow contract. */
  onchain: boolean;
  settleTx: Hex | null;
  note: string | null;
}

/** A match as one player is allowed to see it. The opponent's hand and secret stay hidden until settlement. */
export interface MatchView {
  id: Hex;
  nonce: Hex;
  duration: number;
  stake: string;
  phase: Phase;
  startAt: number | null;
  endAt: number | null;
  seat: 0 | 1;
  onchain: boolean;
  settleTx: Hex | null;
  note: string | null;
  you: {
    address: Address;
    name: string;
    hand: Card[];
    pick: number | null;
    card: Card | null;
    pos: PositionState | null;
  };
  opp: {
    address: Address;
    name: string;
    isBot: boolean;
    locked: boolean;
    face: CardFace | null;
    /** Null until the duel settles. */
    card: Card | null;
    salt: Hex | null;
    pos: PositionState | null;
  };
  /** Your own reveal data, needed to check the on-chain commitment. */
  yourSalt: Hex | null;
  result: { you: ScoreLine; opp: ScoreLine; outcome: 'win' | 'loss' | 'draw' } | null;
}
