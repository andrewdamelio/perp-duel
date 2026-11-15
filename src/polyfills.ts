import * as ExpoCrypto from 'expo-crypto';

// viem and the deck's salts need crypto.getRandomValues, which Hermes does not ship.
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = ExpoCrypto.getRandomValues;
}
