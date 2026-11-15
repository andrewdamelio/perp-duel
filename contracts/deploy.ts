/**
 * Deploy DuelArena. Run: DEPLOYER_PRIVATE_KEY=0x… npm run contracts:deploy
 *
 * Defaults to HyperEVM testnet (chain 998). For mainnet: NETWORK=mainnet.
 * The deck's markets are looked up by name in Hyperliquid's `meta`, because perp indices
 * differ between mainnet and testnet. Markets the network does not list are skipped.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** HyperEVM's read precompile for perp mark prices. */
export const MARK_PX_PRECOMPILE: Address = '0x0000000000000000000000000000000000000806';
/** Native Hyperliquid perps only: the precompile is documented for these. */
export const ARENA_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'LINK', 'AVAX', 'kPEPE'];

const here = dirname(fileURLToPath(import.meta.url));
export const artifact = (name: string) =>
  JSON.parse(readFileSync(join(here, 'out', `${name}.json`), 'utf8')) as { abi: Abi; bytecode: Hex };

export async function deployContract(opts: { rpcUrl: string; chainId: number; deployerKey: Hex; name: string; args: unknown[] }) {
  const { abi, bytecode } = artifact(opts.name);
  const chain = defineChain({
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const account = privateKeyToAccount(opts.deployerKey);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const hash = await wallet.deployContract({ abi, bytecode, args: opts.args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deployment ${hash} failed`);
  return { address: receipt.contractAddress, gasUsed: receipt.gasUsed, hash };
}

async function main() {
  const { DEPLOYER_PRIVATE_KEY, NETWORK } = process.env;
  if (!DEPLOYER_PRIVATE_KEY) {
    console.error('Set DEPLOYER_PRIVATE_KEY');
    process.exit(1);
  }
  const mainnet = NETWORK === 'mainnet';
  const api = mainnet ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
  const rpcUrl = process.env.RPC_URL ?? (mainnet ? 'https://rpc.hyperliquid.xyz/evm' : 'https://rpc.hyperliquid-testnet.xyz/evm');

  const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
  const meta = (await res.json()) as { universe: { name: string; isDelisted?: boolean }[] };
  const found = ARENA_COINS.map((coin) => ({ coin, index: meta.universe.findIndex((a) => a.name === coin && !a.isDelisted) })).filter((m) => m.index >= 0);
  console.log(`Markets on ${mainnet ? 'mainnet' : 'testnet'}: ${found.map((m) => `${m.coin}=${m.index}`).join(' ')}`);
  if (found.length < 5) throw new Error('Fewer than five of the deck markets are listed on this network');

  const result = await deployContract({
    rpcUrl,
    chainId: Number(process.env.CHAIN_ID ?? (mainnet ? 999 : 998)),
    deployerKey: DEPLOYER_PRIVATE_KEY as Hex,
    name: 'DuelArena',
    args: [MARK_PX_PRECOMPILE, found.map((m) => m.index)],
  });
  console.log(`DuelArena deployed at ${result.address} (gas used ${result.gasUsed}, tx ${result.hash})`);
  console.log(`Set EXPO_PUBLIC_ARENA_ADDRESS=${result.address}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
