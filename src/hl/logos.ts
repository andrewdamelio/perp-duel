import { BUNDLED_LOGOS } from './logoData';

/**
 * Where a card's logo comes from, in order:
 *  1. Crypto icons bundled with the app (from the open-source web3icons set), so they
 *     always show, even offline.
 *  2. The icon Hyperliquid's own app serves for the market, fetched at runtime. This is
 *     the only source for stock, index and commodity perps.
 * If nothing loads, the card keeps its lettered medallion.
 */
const HL_ICONS = 'https://app.hyperliquid.xyz/coins';

export function logoUrls(coin: string): string[] {
  const urls: string[] = [];
  const bundled = BUNDLED_LOGOS[coin];
  if (bundled) urls.push(bundled);
  urls.push(`${HL_ICONS}/${coin}.svg`);
  // "k" markets (kPEPE = 1000 PEPE) share the underlying token's icon.
  if (!coin.includes(':') && /^k[A-Z]/.test(coin)) urls.push(`${HL_ICONS}/${coin.slice(1)}.svg`);
  return urls;
}
