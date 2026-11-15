import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cardHash, pickedCard, toOnchainScore, type Address, type Card, type Hex, type Match } from '../src/engine';
import { escrowAbi } from '../src/chain/escrowAbi';

/** Mirrors DuelEscrow.Status. */
export const DuelStatus = { None: 0, Open: 1, Live: 2, Settled: 3, Refunded: 4 } as const;

export interface OnchainDuel {
  status: number;
  startedAt: bigint;
  commitA: Hex;
  commitB: Hex;
}

/** Everything the referee needs from the chain. Kept behind an interface so the referee logic stays testable. */
export interface EscrowChain {
  chainId: number;
  rpcUrl: string;
  escrow: Address;
  refereeAddress: Address;
  botAddress: Address;
  getDuel(id: Hex): Promise<OnchainDuel>;
  /** The house bot stakes and commits like any other player. */
  enterAsBot(match: Match, commit: Hex): Promise<Hex>;
  /** Sign the result as referee and submit it. */
  settle(match: Match): Promise<Hex>;
  /** The typed-data signature on its own, so a player could submit the settlement themselves. */
  signResult(match: Match): Promise<Hex>;
}

export interface EscrowChainConfig {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  refereeKey: Hex;
  botKey: Hex;
}

const RESULT_TYPES = {
  Result: [
    { name: 'duelId', type: 'bytes32' },
    { name: 'cardA', type: 'bytes32' },
    { name: 'cardB', type: 'bytes32' },
    { name: 'scoreA', type: 'int32' },
    { name: 'scoreB', type: 'int32' },
  ],
} as const;

export function createEscrowChain(config: EscrowChainConfig): EscrowChain {
  const chain = defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl);
  const referee = privateKeyToAccount(config.refereeKey);
  const bot = privateKeyToAccount(config.botKey);
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const refereeWallet = createWalletClient({ account: referee, chain, transport });
  const botWallet = createWalletClient({ account: bot, chain, transport });

  const resultOf = (match: Match) => {
    if (!match.result) throw new Error('Duel has no result yet');
    const [a, b] = match.seats;
    return {
      duelId: match.id,
      cardA: cardHash(pickedCard(a) as Card),
      cardB: cardHash(pickedCard(b) as Card),
      scoreA: toOnchainScore(match.result.lines[0].total),
      scoreB: toOnchainScore(match.result.lines[1].total),
    };
  };

  const signResult = (match: Match) =>
    referee.signTypedData({
      domain: { name: 'PerpDuel', version: '1', chainId: config.chainId, verifyingContract: config.escrow },
      types: RESULT_TYPES,
      primaryType: 'Result',
      message: resultOf(match),
    });

  const mined = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted`);
    return hash;
  };

  return {
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    escrow: config.escrow,
    refereeAddress: referee.address,
    botAddress: bot.address,
    signResult,

    async getDuel(id) {
      const d = await publicClient.readContract({ address: config.escrow, abi: escrowAbi, functionName: 'getDuel', args: [id] });
      return { status: d.status, startedAt: d.startedAt, commitA: d.commitA, commitB: d.commitB };
    },

    async enterAsBot(match, commit) {
      const [a, b] = match.seats;
      const hash = await botWallet.writeContract({
        address: config.escrow,
        abi: escrowAbi,
        functionName: 'enter',
        args: [a.address, b.address, BigInt(match.duration), match.nonce, commit],
        value: BigInt(match.stake),
      });
      return mined(hash);
    },

    async settle(match) {
      const r = resultOf(match);
      const [a, b] = match.seats;
      const hash = await refereeWallet.writeContract({
        address: config.escrow,
        abi: escrowAbi,
        functionName: 'settle',
        args: [r.duelId, { card: r.cardA, salt: a.salt as Hex }, { card: r.cardB, salt: b.salt as Hex }, r.scoreA, r.scoreB, await signResult(match)],
      });
      return mined(hash);
    },
  };
}
