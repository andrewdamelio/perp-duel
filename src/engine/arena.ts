import { encodeAbiParameters, keccak256 } from 'viem';
import { SECRET_IDS } from './secrets';
import type { Address, Hex, SecretId, Side } from './types';

/**
 * TypeScript mirror of the pure functions in contracts/DuelArena.sol. The contract is the
 * authority; these let a client work out its own hand and hidden bonuses without asking
 * anyone. The end-to-end tests check both sides agree.
 */

export const ARENA_HAND_SIZE = 5;
export const ARENA_TIERS = [100, 250, 500, 1000] as const;

/** A card as the contract deals it: `market` indexes the contract's market list. */
export interface ArenaCard {
  market: number;
  side: Side;
  leverage: number;
}

const b32 = { type: 'bytes32' } as const;
const u256 = { type: 'uint256' } as const;
const addr = { type: 'address' } as const;
const u8 = { type: 'uint8' } as const;

/** A salt only the key holder can reproduce, so a duel can be resumed with nothing stored. */
export function deriveSalt(key: Hex, tag: string, n: bigint): Hex {
  return keccak256(encodeAbiParameters([b32, { type: 'string' }, u256], [key, tag, n]));
}

export const dealCommitOf = (player: Address, dealSalt: Hex): Hex => keccak256(encodeAbiParameters([addr, b32], [player, dealSalt]));
export const secretCommitOf = (player: Address, secretSalt: Hex): Hex => keccak256(encodeAbiParameters([addr, b32], [player, secretSalt]));
export const pickCommitOf = (id: bigint, player: Address, cardIndex: number, pickSalt: Hex): Hex =>
  keccak256(encodeAbiParameters([u256, addr, u8, b32], [id, player, cardIndex, pickSalt]));
export const seedOf = (id: bigint, saltA: Hex, saltB: Hex): Hex => keccak256(encodeAbiParameters([u256, b32, b32], [id, saltA, saltB]));

/** Mirrors DuelArena.handOf: a partial shuffle of the market list, one keccak per card. */
export function arenaHand(seed: Hex, seat: 0 | 1, marketCount: number): ArenaCard[] {
  const order = Array.from({ length: marketCount }, (_, i) => i);
  const hand: ArenaCard[] = [];
  for (let i = 0; i < ARENA_HAND_SIZE; i++) {
    const h = BigInt(keccak256(encodeAbiParameters([b32, u8, u256], [seed, seat, BigInt(i)])));
    const j = i + Number(h % BigInt(marketCount - i));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
    hand.push({
      market: order[i] as number,
      side: ((h >> 128n) & 1n) === 1n ? 'long' : 'short',
      leverage: ARENA_TIERS[Number((h >> 160n) % 4n)] as number,
    });
  }
  return hand;
}

/** Mirrors DuelArena.bonusOf: the hidden bonus on a card, or null. Two cards per hand carry one. */
export function arenaBonus(secretSalt: Hex, seed: Hex, cardIndex: number): SecretId | null {
  const b = BigInt(keccak256(encodeAbiParameters([b32, b32], [secretSalt, seed])));
  const slot1 = Number(b % 5n);
  const slot2 = (slot1 + 1 + Number((b >> 8n) % 4n)) % 5;
  const id1 = Number((b >> 16n) % 8n);
  const id2 = (id1 + 1 + Number((b >> 24n) % 7n)) % 8;
  if (cardIndex === slot1) return SECRET_IDS[id1] as SecretId;
  if (cardIndex === slot2) return SECRET_IDS[id2] as SecretId;
  return null;
}

/** The contract stores a bonus as id + 1, with 0 for none. */
export const bonusFromChain = (bonus: number): SecretId | null => (bonus === 0 ? null : (SECRET_IDS[bonus - 1] as SecretId));
