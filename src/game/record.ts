import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** A running win/loss record, kept on the device. */
export interface Standing {
  wins: number;
  losses: number;
  draws: number;
  /** Positive for a winning streak, negative for a losing one. */
  streak: number;
}

export const EMPTY_RECORD: Standing = { wins: 0, losses: 0, draws: 0, streak: 0 };
const KEY = 'perp-duel.record';

export async function loadRecord(): Promise<Standing> {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) : await SecureStore.getItemAsync(KEY);
    return raw ? { ...EMPTY_RECORD, ...(JSON.parse(raw) as Partial<Standing>) } : EMPTY_RECORD;
  } catch {
    return EMPTY_RECORD;
  }
}

export function addResult(record: Standing, outcome: 'win' | 'loss' | 'draw'): Standing {
  if (outcome === 'draw') return { ...record, draws: record.draws + 1, streak: 0 };
  if (outcome === 'win') return { ...record, wins: record.wins + 1, streak: Math.max(0, record.streak) + 1 };
  return { ...record, losses: record.losses + 1, streak: Math.min(0, record.streak) - 1 };
}

export async function saveRecord(record: Standing): Promise<void> {
  try {
    const raw = JSON.stringify(record);
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, raw);
    else await SecureStore.setItemAsync(KEY, raw);
  } catch {
    // The record lasts for this session only.
  }
}

export const streakLabel = (r: Standing) => (r.streak >= 2 ? `${r.streak} wins running` : r.streak <= -2 ? `${-r.streak} losses running` : null);
