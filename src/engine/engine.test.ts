import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKETS,
  LEVERAGE_TIERS,
  SECRETS,
  applyPrice,
  deal,
  decide,
  liquidationPrice,
  lockPick,
  marketByCoin,
  newMatch,
  openPosition,
  pickCommit,
  start,
  tick,
  viewFor,
  type Card,
  type Hex,
  type PositionState,
} from './index';

const SEED = `0x${'11'.repeat(32)}` as Hex;
const SALT = `0x${'22'.repeat(32)}` as Hex;
const A = '0x00000000000000000000000000000000000000a1' as const;
const B = '0x00000000000000000000000000000000000000b2' as const;

const card = (over: Partial<Card> = {}): Card => ({ coin: 'BTC', side: 'long', leverage: 100, secret: null, ...over });
const run = (c: Card, prices: number[], entry = 100): PositionState =>
  prices.reduce((pos, p, i) => applyPrice(pos, c, p, i), openPosition(c, entry));

describe('position math', () => {
  it('wipes a card out when the move against it equals its margin', () => {
    expect(liquidationPrice(100, 'long', 100)).toBeCloseTo(99, 6);
    expect(liquidationPrice(100, 'short', 100)).toBeCloseTo(101, 6);
    // At 1000x a tenth of a percent is the whole margin.
    expect(liquidationPrice(100, 'long', 1000)).toBeCloseTo(99.9, 6);
  });

  it('tracks return on margin for longs and shorts', () => {
    expect(run(card(), [100.1]).roe).toBeCloseTo(10);
    expect(run(card({ side: 'short' }), [100.1]).roe).toBeCloseTo(-10);
    expect(run(card({ side: 'short', leverage: 250 }), [99.9]).roe).toBeCloseTo(25);
    expect(run(card({ leverage: 1000 }), [100.05]).roe).toBeCloseTo(50);
  });

  it('liquidates on a cross and never recovers', () => {
    const pos = run(card(), [99.9, 99, 103]);
    expect(pos.liquidated).toBe(true);
    expect(pos.roe).toBe(-100);
    expect(pos.liquidatedAt).toBe(1);
    expect(pos.maxRoe).toBe(0);
    expect(pos.last).toBe(99);
  });

  it('records the closest approach to liquidation', () => {
    const pos = run(card(), [99.3, 100.4]);
    expect(pos.liquidated).toBe(false);
    expect(pos.maxLiqProgress).toBeCloseTo(0.7, 3);
    expect(pos.minRoe).toBeCloseTo(-70);
    expect(pos.maxRoe).toBeCloseTo(40);
  });
});

describe('dealing', () => {
  it('is deterministic for a seed and different across seeds', () => {
    expect(deal(SEED, DEFAULT_MARKETS)).toEqual(deal(SEED, DEFAULT_MARKETS));
    expect(deal(SEED, DEFAULT_MARKETS)).not.toEqual(deal(SALT, DEFAULT_MARKETS));
  });

  it('deals legal hands for many seeds', () => {
    for (let i = 0; i < 300; i++) {
      const seed = `0x${i.toString(16).padStart(64, '0')}` as Hex;
      for (const hand of deal(seed, DEFAULT_MARKETS)) {
        expect(hand).toHaveLength(5);
        expect(new Set(hand.map((c) => c.coin)).size).toBe(5);
        expect(hand.filter((c) => c.secret).length).toBe(2);
        expect(new Set(hand.map((c) => c.secret).filter(Boolean)).size).toBe(2);
        expect(new Set(hand.map((c) => c.side)).size).toBe(2);
        expect(hand.some((c) => marketByCoin(DEFAULT_MARKETS, c.coin)!.cls === 'crypto')).toBe(true);
        expect(hand.some((c) => marketByCoin(DEFAULT_MARKETS, c.coin)!.cls !== 'crypto')).toBe(true);
        for (const c of hand) expect(LEVERAGE_TIERS).toContain(c.leverage);
      }
    }
  });

  it('only deals markets it was given', () => {
    const cryptoOnly = DEFAULT_MARKETS.filter((m) => m.cls === 'crypto');
    for (const hand of deal(SEED, cryptoOnly)) for (const c of hand) expect(c.coin).not.toContain(':');
    expect(() => deal(SEED, cryptoOnly.slice(0, 3))).toThrow(/at least 5/);
  });
});

describe('hidden win conditions', () => {
  const flat = run(card(), [100]);
  const met = (id: keyof typeof SECRETS, c: Card, pos: PositionState, oppCard = card(), oppPos = flat) =>
    SECRETS[id].met({ card: c, pos, oppCard, oppPos });

  it('phoenix pays only on liquidation', () => {
    expect(met('phoenix', card(), run(card(), [99]))).toBe(true);
    expect(met('phoenix', card(), run(card(), [99.2]))).toBe(false);
  });
  it('close shave needs a near miss that survives', () => {
    expect(met('closeShave', card(), run(card(), [99.2, 100]))).toBe(true);
    expect(met('closeShave', card(), run(card(), [99.5, 100]))).toBe(false);
    expect(met('closeShave', card(), run(card(), [99.2, 98.9]))).toBe(false);
  });
  it('comeback needs a drawdown then a profit', () => {
    expect(met('comeback', card(), run(card(), [99.4, 100.05]))).toBe(true);
    expect(met('comeback', card(), run(card(), [99.6, 100.05]))).toBe(false);
    expect(met('comeback', card(), run(card(), [99.4, 99.99]))).toBe(false);
  });
  it('moonshot counts the peak, not the finish', () => {
    expect(met('moonshot', card(), run(card(), [101.1, 99.9]))).toBe(true);
    expect(met('moonshot', card(), run(card(), [100.9]))).toBe(false);
  });
  it('schadenfreude watches the other seat', () => {
    expect(met('schadenfreude', card(), flat, card(), run(card(), [99]))).toBe(true);
    expect(met('schadenfreude', card(), run(card(), [99]), card(), flat)).toBe(false);
  });
  it('flatline needs a quiet finish', () => {
    expect(met('flatline', card(), run(card(), [100.5, 100.02]))).toBe(true);
    expect(met('flatline', card(), run(card(), [100.2]))).toBe(false);
  });
  it('underdog needs less leverage and a better return', () => {
    const low = card({ leverage: 100 });
    const high = card({ leverage: 1000, side: 'short' });
    expect(met('underdog', low, run(low, [100.05]), high, run(high, [100.05]))).toBe(true);
    expect(met('underdog', high, run(high, [99.95]), low, run(low, [99.95]))).toBe(false);
  });
  it('whipsaw needs both extremes', () => {
    expect(met('whipsaw', card(), run(card(), [100.6, 99.4, 100]))).toBe(true);
    expect(met('whipsaw', card(), run(card(), [100.6, 99.8]))).toBe(false);
  });
});

describe('scoring', () => {
  it('lets a hidden phoenix beat a profitable opponent', () => {
    const phoenix = card({ secret: 'phoenix', leverage: 1000 });
    const steady = card({ side: 'short', leverage: 100 });
    const result = decide({ card: phoenix, pos: run(phoenix, [99.8]) }, { card: steady, pos: run(steady, [99.8]) });
    expect(result.lines[0]).toMatchObject({ base: -100, bonus: 250, total: 150, secretHit: true });
    expect(result.lines[1]).toMatchObject({ base: 20, bonus: 0, total: 20 });
    expect(result.winner).toBe(0);
  });

  it('scores an unmet secret as zero and calls a draw on equal totals', () => {
    const a = card({ secret: 'moonshot' });
    const result = decide({ card: a, pos: run(a, [100.1]) }, { card: card(), pos: run(card(), [100.1]) });
    expect(result.lines[0]).toMatchObject({ bonus: 0, secretHit: false, total: 10 });
    expect(result.winner).toBeNull();
  });
});

describe('match flow', () => {
  const mids = Object.fromEntries(DEFAULT_MARKETS.map((m) => [m.coin, m.simPrice]));
  const fresh = () =>
    newMatch({
      nonce: SALT,
      seed: SEED,
      duration: 60,
      stake: 10n ** 17n,
      players: [
        { address: A, name: 'a', isBot: false },
        { address: B, name: 'b', isBot: true },
      ],
      markets: DEFAULT_MARKETS,
      onchain: false,
      now: 0,
    });

  it('hides the other hand, secret and salt until settlement', () => {
    let m = lockPick(lockPick(fresh(), 0, 0, SALT), 1, 1, SEED);
    const picking = viewFor(m, 0);
    expect(picking.opp).toMatchObject({ locked: true, face: null, card: null, salt: null, pos: null });
    expect(JSON.stringify(picking)).not.toContain(SEED.slice(2));

    m = start(m, mids, DEFAULT_MARKETS, 1_000);
    const live = viewFor(m, 0);
    expect(live.opp.face).toEqual({ coin: m.seats[1].hand[1]!.coin, side: m.seats[1].hand[1]!.side, leverage: m.seats[1].hand[1]!.leverage });
    expect(live.opp.face).not.toHaveProperty('secret');
    expect(live.opp.card).toBeNull();

    m = tick(m, mids, 1_000 + 60_000);
    const done = viewFor(m, 0);
    expect(done.phase).toBe('settled');
    expect(done.opp.card).toEqual(m.seats[1].hand[1]);
    expect(done.opp.salt).toBe(SEED);
    expect(done.result?.outcome).toBe(viewFor(m, 1).result?.outcome === 'win' ? 'loss' : viewFor(m, 1).result?.outcome === 'loss' ? 'win' : 'draw');
  });

  it('commits to the pick and refuses a second one', () => {
    const m = lockPick(fresh(), 0, 2, SALT);
    expect(m.seats[0].commit).toBe(pickCommit(m.id, A, m.seats[0].hand[2]!, SALT));
    expect(() => lockPick(m, 0, 3, SALT)).toThrow(/already locked/);
    expect(() => start(m, mids, DEFAULT_MARKETS, 0)).toThrow(/Both players/);
  });

  it('ignores ticks after the final whistle', () => {
    let m = start(lockPick(lockPick(fresh(), 0, 0, SALT), 1, 0, SALT), mids, DEFAULT_MARKETS, 0);
    m = tick(m, mids, 60_000);
    const crashed = Object.fromEntries(Object.entries(mids).map(([k, v]) => [k, v * 0.1]));
    expect(tick(m, crashed, 61_000)).toBe(m);
  });
});
