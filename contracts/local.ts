/**
 * Local playground: deploys a stand-in price feed and DuelArena to a chain you are
 * already running (e.g. `anvil`). Run: npm run contracts:local
 * Prices start at 1,000,000 raw for every market; move one with
 *   cast send <feed> "set(uint32,uint64)" <perp> <price>
 */
import type { Hex } from 'viem';
import { ARENA_COINS, artifact, deployContract } from './deploy';
import { createWalletClient, defineChain, http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const chainId = Number(process.env.CHAIN_ID ?? 31337);
// anvil's first well-known dev key
const deployerKey = (process.env.DEPLOYER_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex;

async function main() {
  const base = { rpcUrl, chainId, deployerKey };
  const perps = ARENA_COINS.map((_, i) => i);
  const feed = await deployContract({ ...base, name: 'MockPrices', args: [] });
  const chain = defineChain({ id: chainId, name: 'local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const wallet = createWalletClient({ account: privateKeyToAccount(deployerKey), chain, transport: http(rpcUrl) });
  const hash = await wallet.writeContract({ address: feed.address, abi: artifact('MockPrices').abi, functionName: 'setMany', args: [perps, perps.map(() => 1_000_000n)] });
  await createPublicClient({ chain, transport: http(rpcUrl) }).waitForTransactionReceipt({ hash });
  const arena = await deployContract({ ...base, name: 'DuelArena', args: [feed.address, perps] });
  console.log(`FEED=${feed.address}`);
  console.log(`ARENA=${arena.address}`);
  console.log(`COINS=${ARENA_COINS.join(',')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
