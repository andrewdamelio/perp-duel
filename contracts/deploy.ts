/**
 * Deploy DuelEscrow. Run: DEPLOYER_PRIVATE_KEY=0x… REFEREE_ADDRESS=0x… npm run contracts:deploy
 * Defaults to HyperEVM testnet (chain 998). Override with RPC_URL and CHAIN_ID.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export async function deployEscrow(opts: { rpcUrl: string; chainId: number; deployerKey: Hex; referee: Address }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = JSON.parse(readFileSync(join(here, 'out', 'DuelEscrow.json'), 'utf8')) as { abi: Abi; bytecode: Hex };
  const chain = defineChain({
    id: opts.chainId,
    name: `chain-${opts.chainId}`,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const account = privateKeyToAccount(opts.deployerKey);
  const publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [opts.referee] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`Deployment ${hash} did not create a contract`);
  return { address: receipt.contractAddress, gasUsed: receipt.gasUsed, hash };
}

async function main() {
  const { DEPLOYER_PRIVATE_KEY, REFEREE_ADDRESS, RPC_URL, CHAIN_ID } = process.env;
  if (!DEPLOYER_PRIVATE_KEY || !REFEREE_ADDRESS) {
    console.error('Set DEPLOYER_PRIVATE_KEY and REFEREE_ADDRESS');
    process.exit(1);
  }
  const result = await deployEscrow({
    rpcUrl: RPC_URL ?? 'https://rpc.hyperliquid-testnet.xyz/evm',
    chainId: Number(CHAIN_ID ?? 998),
    deployerKey: DEPLOYER_PRIVATE_KEY as Hex,
    referee: REFEREE_ADDRESS as Address,
  });
  console.log(`DuelEscrow deployed at ${result.address} (gas used ${result.gasUsed}, tx ${result.hash})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
