import { encodeAbiParameters, keccak256 } from 'viem';
import type { Address, Card, Hex } from './types';

/** keccak256(abi.encode(coin, isLong, leverage, secret)). Mirrors what the referee reveals on-chain. */
export function cardHash(card: Card): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'bool' }, { type: 'uint16' }, { type: 'string' }],
      [card.coin, card.side === 'long', card.leverage, card.secret ?? ''],
    ),
  );
}

/** keccak256(abi.encode(duelId, player, cardHash, salt)). Must match DuelEscrow._commitOf. */
export function pickCommit(duelId: Hex, player: Address, card: Card, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [duelId, player, cardHash(card), salt],
    ),
  );
}

/** keccak256(abi.encode(playerA, playerB, duration, stake, nonce)). Must match DuelEscrow.duelIdOf. */
export function duelIdOf(playerA: Address, playerB: Address, duration: number, stake: bigint, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'bytes32' }],
      [playerA, playerB, BigInt(duration), stake, nonce],
    ),
  );
}
