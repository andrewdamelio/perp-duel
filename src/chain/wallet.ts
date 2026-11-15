import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '../engine';

const KEY = 'perp-duel.burner-key';
let memory: Hex | null = null;

/**
 * A burner key kept in the device keychain (browser storage on web). It is a demo wallet:
 * fund it with testnet HYPE only. A production build would swap this for a wallet
 * connection behind the same two functions.
 */
export async function loadBurnerKey(): Promise<Hex> {
  if (memory) return memory;
  let stored: string | null = null;
  try {
    stored = Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : await SecureStore.getItemAsync(KEY);
  } catch {
    // Storage can be unavailable (private windows, locked keychain). Fall through to a session-only key.
  }
  const key = (stored as Hex | null) ?? generatePrivateKey();
  if (!stored) {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, key);
      else await SecureStore.setItemAsync(KEY, key);
    } catch {
      // Session-only key.
    }
  }
  memory = key;
  return key;
}

export const accountOf = (key: Hex) => privateKeyToAccount(key);
