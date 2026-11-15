import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import type { Address, Hex, MatchView } from '../engine';
import { escrowAbi } from './escrowAbi';
import { accountOf } from './wallet';

export interface ChainInfo {
  chainId: number;
  rpcUrl: string;
  escrow: Address;
  referee: Address;
}

const chainOf = (info: ChainInfo) =>
  defineChain({
    id: info.chainId,
    name: info.chainId === 998 ? 'HyperEVM testnet' : info.chainId === 999 ? 'HyperEVM' : `Chain ${info.chainId}`,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
  });

export const chainName = (info: ChainInfo) => chainOf(info).name;

export function explorerTx(info: ChainInfo, hash: Hex): string | null {
  if (info.chainId === 998) return `https://testnet.purrsec.com/tx/${hash}`;
  if (info.chainId === 999) return `https://hyperevmscan.io/tx/${hash}`;
  return null;
}

export function balanceOf(info: ChainInfo, address: Address): Promise<bigint> {
  return createPublicClient({ chain: chainOf(info), transport: http(info.rpcUrl) }).getBalance({ address });
}

/** Stake and commit in one transaction. Resolves once the transaction is mined. */
export async function enterDuel(info: ChainInfo, key: Hex, view: MatchView, commit: Hex): Promise<Hex> {
  const chain = chainOf(info);
  const transport = http(info.rpcUrl);
  const account = accountOf(key);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  // Seat 0 is always playerA in the escrow's terms.
  const [playerA, playerB] = view.seat === 0 ? [view.you.address, view.opp.address] : [view.opp.address, view.you.address];
  const hash = await wallet.writeContract({
    address: info.escrow,
    abi: escrowAbi,
    functionName: 'enter',
    args: [playerA, playerB, BigInt(view.duration), view.nonce, commit],
    value: BigInt(view.stake),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The escrow rejected the stake');
  return hash;
}
