import { Platform } from 'react-native';
import type { Card, Side } from '../engine';

/** The slice of an EIP-1193 provider this app uses. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * Phantom's Ethereum provider. Present when the web build runs inside Phantom's in-app
 * browser on a phone, or in a desktop browser with the Phantom extension.
 */
export function phantomEthereum(): Eip1193 | null {
  if (Platform.OS !== 'web') return null;
  const w = globalThis as { phantom?: { ethereum?: Eip1193 }; ethereum?: Eip1193 & { isPhantom?: boolean } };
  return w.phantom?.ethereum ?? (w.ethereum?.isPhantom ? w.ethereum : null);
}

/**
 * A link that opens `url` in Phantom's in-app browser, where the wallet is injected.
 * https://docs.phantom.com/phantom-deeplinks/other-methods/browse
 */
export function phantomBrowseLink(url: string): string {
  const ref = new URL(url).origin;
  return `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}

/** A card travels to the page opened in Phantom as `#trade-<coin>-<side>-<leverage>`, e.g. `#trade-xyz.NVDA-short-500`. */
export function tradeHash(card: Card): string {
  return `#trade-${card.coin.replace(':', '.')}-${card.side}-${card.leverage}`;
}

export function cardFromHash(hash: string): Card | null {
  const m = /^#trade-([A-Za-z0-9.]+)-(long|short)-(\d+)$/.exec(hash);
  if (!m) return null;
  return { coin: (m[1] as string).replace('.', ':'), side: m[2] as Side, leverage: Number(m[3]), secret: null };
}
