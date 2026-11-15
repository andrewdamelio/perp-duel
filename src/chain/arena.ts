import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from '../engine';
import { arenaAbi } from './arenaAbi';

/** Where the DuelArena contract lives. */
export interface ArenaInfo {
  chainId: number;
  rpcUrl: string;
  address: Address;
  /** Market names in the contract's market order. Only needed where Hyperliquid's API cannot say (a local test chain). */
  coins?: string[];
}

/** A market the contract deals from, in contract order. `scale` turns a raw precompile price into dollars. */
export interface ArenaMarket {
  coin: string;
  scale: number;
}

export const chainOf = (info: ArenaInfo) =>
  defineChain({
    id: info.chainId,
    name: info.chainId === 998 ? 'HyperEVM testnet' : info.chainId === 999 ? 'HyperEVM' : `Chain ${info.chainId}`,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
  });

export const chainName = (info: ArenaInfo) => chainOf(info).name;

export function explorerTx(info: ArenaInfo, hash: Hex): string | null {
  if (info.chainId === 998) return `https://testnet.purrsec.com/tx/${hash}`;
  if (info.chainId === 999) return `https://hyperevmscan.io/tx/${hash}`;
  return null;
}

export const publicClientOf = (info: ArenaInfo): PublicClient => createPublicClient({ chain: chainOf(info), transport: http(info.rpcUrl) });

export const walletClientOf = (info: ArenaInfo, key: Hex) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: chainOf(info), transport: http(info.rpcUrl) });

export const balanceOf = (info: ArenaInfo, address: Address): Promise<bigint> => publicClientOf(info).getBalance({ address });

/**
 * Name the contract's markets. The contract stores Hyperliquid perp indices; the index of a
 * perp is its position in Hyperliquid's `meta.universe`, which also gives the price scale:
 * dollars = raw / 10^(6 - szDecimals).
 */
export async function loadArenaMarkets(info: ArenaInfo): Promise<ArenaMarket[]> {
  const indices = (await publicClientOf(info).readContract({ address: info.address, abi: arenaAbi, functionName: 'marketList' })) as readonly number[];
  if (info.coins) return indices.map((_, i) => ({ coin: info.coins?.[i] ?? `#${i}`, scale: 1 }));
  const api = info.chainId === 999 ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
  const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
  const meta = (await res.json()) as { universe: { name: string; szDecimals: number }[] };
  return indices.map((index) => {
    const asset = meta.universe[index];
    if (!asset) throw new Error(`The contract deals perp #${index}, which Hyperliquid does not list`);
    return { coin: asset.name, scale: 10 ** -(6 - asset.szDecimals) };
  });
}
