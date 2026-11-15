import { formatEther } from 'viem';

export function fmtPrice(n: number | undefined): string {
  if (!n || !(n > 0)) return '…';
  // Enough digits to see a 0.1% move, which is a whole card at 1000x.
  const digits = n >= 10000 ? 0 : n >= 1000 ? 1 : n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
}

export function fmtPoints(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
}

export function fmtPercent(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function fmtHype(wei: string | bigint, digits = 4): string {
  const n = Number(formatEther(BigInt(wei)));
  return `${parseFloat(n.toFixed(digits))} HYPE`;
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds === 60) return '1 minute';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  const h = seconds / 3600;
  return h === 1 ? '1 hour' : `${h} hours`;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
