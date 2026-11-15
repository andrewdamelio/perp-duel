import type { Market } from './types';

/**
 * The deck's universe. Native Hyperliquid perps plus stock, index and commodity perps
 * from the "xyz" HIP-3 builder dex. maxLeverage values are defaults; the live feed
 * replaces them with Hyperliquid's own `meta` response, and markets with no live
 * price are dropped before dealing.
 */
export const DEFAULT_MARKETS: Market[] = [
  { coin: 'BTC', ticker: 'BTC', name: 'Bitcoin', cls: 'crypto', dex: '', maxLeverage: 40, simPrice: 100000, simVol: 0.5 },
  { coin: 'ETH', ticker: 'ETH', name: 'Ethereum', cls: 'crypto', dex: '', maxLeverage: 25, simPrice: 3500, simVol: 0.65 },
  { coin: 'SOL', ticker: 'SOL', name: 'Solana', cls: 'crypto', dex: '', maxLeverage: 20, simPrice: 180, simVol: 0.8 },
  { coin: 'HYPE', ticker: 'HYPE', name: 'Hyperliquid', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 40, simVol: 0.95 },
  { coin: 'XRP', ticker: 'XRP', name: 'XRP', cls: 'crypto', dex: '', maxLeverage: 20, simPrice: 2.5, simVol: 0.8 },
  { coin: 'DOGE', ticker: 'DOGE', name: 'Dogecoin', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 0.2, simVol: 0.9 },
  { coin: 'SUI', ticker: 'SUI', name: 'Sui', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 3, simVol: 0.95 },
  { coin: 'LINK', ticker: 'LINK', name: 'Chainlink', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 18, simVol: 0.85 },
  { coin: 'AVAX', ticker: 'AVAX', name: 'Avalanche', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 25, simVol: 0.9 },
  { coin: 'kPEPE', ticker: 'kPEPE', name: 'Pepe', cls: 'crypto', dex: '', maxLeverage: 10, simPrice: 0.01, simVol: 1.2 },
  { coin: 'xyz:NVDA', ticker: 'NVDA', name: 'Nvidia', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 180, simVol: 0.45 },
  { coin: 'xyz:TSLA', ticker: 'TSLA', name: 'Tesla', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 400, simVol: 0.6 },
  { coin: 'xyz:AAPL', ticker: 'AAPL', name: 'Apple', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 250, simVol: 0.28 },
  { coin: 'xyz:MSFT', ticker: 'MSFT', name: 'Microsoft', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 480, simVol: 0.25 },
  { coin: 'xyz:GOOGL', ticker: 'GOOGL', name: 'Alphabet', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 280, simVol: 0.3 },
  { coin: 'xyz:AMZN', ticker: 'AMZN', name: 'Amazon', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 230, simVol: 0.32 },
  { coin: 'xyz:META', ticker: 'META', name: 'Meta', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 650, simVol: 0.35 },
  { coin: 'xyz:COIN', ticker: 'COIN', name: 'Coinbase', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 300, simVol: 0.75 },
  { coin: 'xyz:HOOD', ticker: 'HOOD', name: 'Robinhood', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 120, simVol: 0.7 },
  { coin: 'xyz:PLTR', ticker: 'PLTR', name: 'Palantir', cls: 'stock', dex: 'xyz', maxLeverage: 10, simPrice: 180, simVol: 0.65 },
  { coin: 'xyz:XYZ100', ticker: 'XYZ100', name: 'US tech 100', cls: 'index', dex: 'xyz', maxLeverage: 20, simPrice: 25000, simVol: 0.2 },
  { coin: 'xyz:GOLD', ticker: 'GOLD', name: 'Gold', cls: 'commodity', dex: 'xyz', maxLeverage: 20, simPrice: 4000, simVol: 0.18 },
];

export function marketByCoin(markets: Market[], coin: string): Market | undefined {
  return markets.find((m) => m.coin === coin);
}

/** Perp dexes the deck draws from, in the form Hyperliquid's API expects ('' = native). */
export function dexesOf(markets: Market[]): string[] {
  return [...new Set(markets.map((m) => m.dex))];
}
