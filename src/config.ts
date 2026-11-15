import type { Address } from './engine';

/**
 * Everything here comes from EXPO_PUBLIC_* variables (see .env.example). With none set,
 * the app runs as a practice table: live Hyperliquid prices, a local bot, play-money stakes.
 */
export const config = {
  /** Base URL of the referee server. Enables matchmaking and, if the server has an escrow, on-chain stakes. */
  refereeUrl: process.env.EXPO_PUBLIC_REFEREE_URL?.replace(/\/$/, '') || null,
  /** Your Hyperliquid builder address. Real orders carry it as their builder code; without it they go through with no builder fee. */
  builder: (process.env.EXPO_PUBLIC_BUILDER_ADDRESS as Address | undefined) || null,
  /** Builder fee in tenths of a basis point (10 = 1 bp = 0.01%). Perps allow at most 100. */
  builderFee: Number(process.env.EXPO_PUBLIC_BUILDER_FEE ?? 10),
  /** Real trades go to Hyperliquid mainnet, where Phantom's perps live, unless this is "testnet". */
  hlTestnet: process.env.EXPO_PUBLIC_HL_NETWORK === 'testnet',
  /** Public address of the web build, e.g. https://you.github.io/perp-duel/. The native app hands real trades to Phantom through it. */
  webUrl: process.env.EXPO_PUBLIC_WEB_URL || null,
  /** Margin, in USDC, behind a real trade opened from a card. */
  realTradeMarginUsd: 10 as number,
};

export const STAKES = ['10000000000000000', '50000000000000000', '100000000000000000'] as const;
export const DURATIONS = [
  { seconds: 30, label: '30 seconds', note: null },
  { seconds: 60, label: '1 minute', note: null },
  { seconds: 120, label: '2 minutes', note: null },
] as const;
