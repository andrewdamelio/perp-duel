/**
 * End-to-end: the real DuelArena bytecode on a local anvil chain, with a stand-in for the
 * HyperEVM price precompile. Needs the `anvil` binary (Foundry) on PATH or in ANVIL_BIN;
 * the suite is skipped when it is missing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { arenaAbi } from '../src/chain/arenaAbi';
import { SECRET_IDS, arenaBonus, arenaHand, dealCommitOf, deriveSalt, pickCommitOf, randomHex32, secretCommitOf, seedOf } from '../src/engine';
import { ArenaPlayer } from '../src/chain/arenaPlayer';
import type { MatchView } from '../src/engine';
import { artifact, deployContract } from './deploy';

const ANVIL = process.env.ANVIL_BIN ?? 'anvil';
const hasAnvil = spawnSync(ANVIL, ['--version']).status === 0;
const PORT = 8598;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  carol: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;
const STAKE = parseEther('0.1');
const DURATION = 60;
const PERPS = [0, 1, 5, 159, 25, 12, 14, 18, 6, 15];
const START_PX = 1_000_000n;
const Phase = { Open: 1, Joined: 2, Picking: 3, Live: 4, Closed: 5, Settled: 6, Cancelled: 7 } as const;

describe.skipIf(!hasAnvil)('DuelArena', () => {
  let anvil: ChildProcess;
  let arena: Address;
  let feed: Address;
  let terms = 0;
  const transport = http(RPC);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport });
  const alice = wallet(KEYS.alice);
  const bob = wallet(KEYS.bob);
  const carol = wallet(KEYS.carol);
  const admin = wallet(KEYS.deployer);
  type W = typeof alice;

  const mined = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    return receipt;
  };
  const read = <F extends string>(functionName: F, args: unknown[] = []) =>
    publicClient.readContract({ address: arena, abi: arenaAbi, functionName: functionName as never, args: args as never }) as Promise<any>;
  const send = (w: W, functionName: string, args: unknown[], value?: bigint) =>
    w.writeContract({ address: arena, abi: arenaAbi, functionName: functionName as never, args: args as never, value: value as never }).then(mined);
  const dry = (w: W, functionName: string, args: unknown[], value?: bigint) =>
    publicClient.simulateContract({ address: arena, abi: arenaAbi, functionName: functionName as never, args: args as never, value: value as never, account: w.account });
  const reverts = (call: Promise<unknown>, error: string) => expect(call).rejects.toThrow(new RegExp(error));
  const balance = (a: Address) => publicClient.getBalance({ address: a });
  const warp = async (seconds: number) => {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
  };
  const setPx = (perp: number, px: bigint) =>
    admin.writeContract({ address: feed, abi: artifact('MockPrices').abi, functionName: 'set', args: [perp, px] }).then(mined);
  const resetPrices = () =>
    admin
      .writeContract({ address: feed, abi: artifact('MockPrices').abi, functionName: 'setMany', args: [PERPS, PERPS.map(() => START_PX)] })
      .then(mined);

  /** Every duel in this file uses its own stake so they never collide in the waiting list. */
  const nextStake = () => STAKE + BigInt(++terms);

  /** Play up to the point where both hands are dealt. */
  const dealt = async (a: W = alice, b: W = bob) => {
    const stake = nextStake();
    const nonce = (await read('opened', [a.account.address])) as bigint;
    const salts = {
      dealA: deriveSalt(KEYS.alice, 'deal', nonce),
      secretA: deriveSalt(KEYS.alice, 'secret', nonce),
      saltB: randomHex32(),
      secretB: randomHex32(),
    };
    await send(a, 'open', [DURATION, dealCommitOf(a.account.address, salts.dealA), secretCommitOf(a.account.address, salts.secretA)], stake);
    const id = (await read('activeOf', [a.account.address])) as bigint;
    await send(b, 'join', [id, salts.saltB, secretCommitOf(b.account.address, salts.secretB)], stake);
    await send(a, 'deal', [id, salts.dealA]);
    const seed = seedOf(id, salts.dealA, salts.saltB);
    return { id, stake, seed, salts, a, b };
  };

  /** Play up to a live duel, with each seat on a chosen card. */
  const started = async (pickA = 0, pickB = 0) => {
    const d = await dealt();
    const pickSalts = [randomHex32(), randomHex32()] as const;
    await send(d.a, 'commitPick', [d.id, pickCommitOf(d.id, d.a.account.address, pickA, pickSalts[0])]);
    await send(d.b, 'commitPick', [d.id, pickCommitOf(d.id, d.b.account.address, pickB, pickSalts[1])]);
    await send(d.a, 'revealPick', [d.id, pickA, pickSalts[0]]);
    await send(d.b, 'revealPick', [d.id, pickB, pickSalts[1]]);
    const hands = [arenaHand(d.seed, 0, PERPS.length), arenaHand(d.seed, 1, PERPS.length)] as const;
    const cards = [hands[0][pickA]!, hands[1][pickB]!] as const;
    /** Move a seat's market so its return on margin is `roePercent`. */
    const move = (seat: 0 | 1, roePercent: number) => {
      const card = cards[seat];
      const dir = card.side === 'long' ? 1 : -1;
      const delta = Math.round((Number(START_PX) * roePercent * dir) / (100 * card.leverage));
      return setPx(PERPS[card.market]!, START_PX + BigInt(delta));
    };
    return { ...d, hands, cards, picks: [pickA, pickB] as const, move };
  };

  beforeAll(async () => {
    anvil = spawn(ANVIL, ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const base = { rpcUrl: RPC, chainId: foundry.id, deployerKey: KEYS.deployer as Hex };
    feed = (await deployContract({ ...base, name: 'MockPrices', args: [] })).address;
    // The constructor refuses markets with no price.
    await expect(deployContract({ ...base, name: 'DuelArena', args: [feed, PERPS] })).rejects.toThrow();
    await resetPrices();
    const deployed = await deployContract({ ...base, name: 'DuelArena', args: [feed, PERPS] });
    arena = deployed.address;
    console.log(`deploy gas: ${deployed.gasUsed}`);
  });

  afterAll(() => {
    anvil?.kill();
  });

  it('deals the same hands and bonuses the client works out for itself', async () => {
    for (let i = 0; i < 12; i++) {
      const seed = randomHex32();
      const secret = randomHex32();
      for (const seat of [0, 1] as const) {
        const onchain = (await read('handOf', [seed, seat])) as { market: number; isLong: boolean; leverage: number }[];
        const mine = arenaHand(seed, seat, PERPS.length);
        expect(onchain.map((c) => [c.market, c.isLong ? 'long' : 'short', c.leverage])).toEqual(mine.map((c) => [c.market, c.side, c.leverage]));
        expect(new Set(mine.map((c) => c.market)).size).toBe(5);
      }
      const bonuses = await Promise.all([0, 1, 2, 3, 4].map((card) => read('bonusOf', [secret, seed, card]) as Promise<number>));
      expect(bonuses.map((b) => (b === 0 ? null : SECRET_IDS[b - 1]))).toEqual([0, 1, 2, 3, 4].map((card) => arenaBonus(secret, seed, card)));
      expect(bonuses.filter((b) => b !== 0)).toHaveLength(2);
      expect(new Set(bonuses.filter((b) => b !== 0)).size).toBe(2);
    }
  });

  it('plays a full duel with nobody in the middle and pays the winner', async () => {
    await resetPrices();
    const d = await started(1, 3);
    let duel = await read('getDuel', [d.id]);
    expect(duel.phase).toBe(Phase.Live);
    expect(duel.seed).toBe(d.seed);
    for (const seat of [0, 1] as const) {
      expect(duel.seats[seat].perp).toBe(PERPS[d.cards[seat].market]);
      expect(duel.seats[seat].isLong).toBe(d.cards[seat].side === 'long');
      expect(duel.seats[seat].leverage).toBe(d.cards[seat].leverage);
      expect(duel.seats[seat].entryPx).toBe(START_PX);
    }
    expect(await publicClient.getBalance({ address: arena })).toBeGreaterThanOrEqual(d.stake * 2n);
    const sameMarket = d.cards[0].market === d.cards[1].market;

    // A goes up 30%. The view reflects it before anyone pokes; a poke writes it down.
    await d.move(0, 30);
    const [liveA] = (await read('live', [d.id])) as [{ roe: number; maxRoe: number }];
    expect(liveA.roe).toBeGreaterThanOrEqual(2900);
    expect((await read('getDuel', [d.id])).seats[0].roe).toBe(0);
    await send(carol, 'poke', [d.id]); // anyone may poke
    expect((await read('getDuel', [d.id])).seats[0].maxRoe).toBe(liveA.roe);

    // Nothing can be revealed or settled while the clock runs.
    await reverts(dry(d.a, 'reveal', [d.id, d.salts.secretA]), 'TooEarly');
    await reverts(dry(d.a, 'settle', [d.id]), 'WrongPhase');

    await warp(DURATION + 1);
    const before = { a: await balance(d.a.account.address), b: await balance(d.b.account.address) };
    const gasOf = async (r: Awaited<ReturnType<typeof mined>>) => r.gasUsed * r.effectiveGasPrice;
    const gasA = await gasOf(await send(d.a, 'reveal', [d.id, d.salts.secretA]));
    expect((await read('getDuel', [d.id])).phase).toBe(Phase.Closed);
    await reverts(dry(d.a, 'reveal', [d.id, d.salts.secretA]), 'AlreadyDone');
    await reverts(dry(d.b, 'reveal', [d.id, randomHex32()]), 'BadReveal');
    const gasB = await gasOf(await send(d.b, 'reveal', [d.id, d.salts.secretB]));

    duel = await read('getDuel', [d.id]);
    expect(duel.phase).toBe(Phase.Settled);
    // The contract's bonus for each picked card is the one the client derived in private.
    expect(duel.seats[0].bonus === 0 ? null : SECRET_IDS[duel.seats[0].bonus - 1]).toBe(arenaBonus(d.salts.secretA, d.seed, 1));
    expect(duel.seats[1].bonus === 0 ? null : SECRET_IDS[duel.seats[1].bonus - 1]).toBe(arenaBonus(d.salts.secretB, d.seed, 3));
    expect(duel.scoreA).toBe(await read('scoreOf', [duel.seats[0], duel.seats[1]]));
    expect(Math.floor(duel.scoreA / 10) * 10).toBeGreaterThanOrEqual(Math.floor(duel.seats[0].roe / 10));

    const after = { a: await balance(d.a.account.address), b: await balance(d.b.account.address) };
    const paid = { a: after.a - before.a + gasA, b: after.b - before.b + gasB };
    if (duel.scoreA === duel.scoreB) expect(paid).toEqual({ a: d.stake, b: d.stake });
    else if (duel.scoreA > duel.scoreB) expect(paid).toEqual({ a: d.stake * 2n, b: 0n });
    else expect(paid).toEqual({ a: 0n, b: d.stake * 2n });
    if (!sameMarket) expect(duel.winner).toBe(duel.scoreA > duel.scoreB ? d.a.account.address : d.b.account.address);
    expect(await read('activeOf', [d.a.account.address])).toBe(0n);
    await resetPrices();
  });

  it('liquidates on a poke, for good, and misses a wick nobody poked', async () => {
    await resetPrices();
    const d = await started(0, 0);
    const other = d.cards[0].market === d.cards[1].market ? null : 1;

    // A wick through A's wipe-out price that reverses before anyone pokes leaves no trace.
    await d.move(0, -150);
    await d.move(0, 0);
    await send(d.b, 'poke', [d.id]);
    expect((await read('getDuel', [d.id])).seats[0].liquidated).toBe(false);

    // This time B pokes while A is under water.
    await d.move(0, -100);
    await send(d.b, 'poke', [d.id]);
    let seat = (await read('getDuel', [d.id])).seats[0];
    expect(seat).toMatchObject({ liquidated: true, roe: -10000, minRoe: -10000 });

    // A recovery afterwards changes nothing for A.
    await d.move(0, 400);
    await send(d.a, 'poke', [d.id]);
    seat = (await read('getDuel', [d.id])).seats[0];
    expect(seat).toMatchObject({ liquidated: true, roe: -10000, maxRoe: 0 });

    await warp(DURATION + 1);
    await send(d.a, 'reveal', [d.id, d.salts.secretA]);
    await send(d.b, 'reveal', [d.id, d.salts.secretB]);
    const duel = await read('getDuel', [d.id]);
    const bonusA = arenaBonus(d.salts.secretA, d.seed, 0);
    // -100 points, unless A was holding the phoenix.
    expect(duel.scoreA).toBe(-1000 + (bonusA === 'phoenix' ? 2500 : 0));
    if (other !== null && arenaBonus(d.salts.secretB, d.seed, 0) === 'schadenfreude') expect(duel.scoreB).toBeGreaterThanOrEqual(1000);
    await resetPrices();
  });

  it('scores every bonus the way the rules say', async () => {
    const seat = (over: Record<string, unknown> = {}) => ({
      player: alice.account.address,
      secretCommit: `0x${'00'.repeat(32)}`,
      pickCommit: `0x${'00'.repeat(32)}`,
      pick: 0,
      pickRevealed: true,
      secretRevealed: true,
      bonus: 0,
      perp: 0,
      isLong: true,
      leverage: 500,
      entryPx: 1n,
      lastPx: 1n,
      roe: 0,
      minRoe: 0,
      maxRoe: 0,
      liquidated: false,
      ...over,
    });
    const points = (id: number, me: object, opp: object = seat()) => read('bonusPoints', [id, me, opp]) as Promise<number>;
    const wiped = seat({ liquidated: true, roe: -10000, minRoe: -10000 });

    expect(await points(0, wiped)).toBe(250); // phoenix
    expect(await points(0, seat())).toBe(0);
    expect(await points(1, seat({ minRoe: -7500 }))).toBe(100); // close shave
    expect(await points(1, seat({ minRoe: -7499 }))).toBe(0);
    expect(await points(1, wiped)).toBe(0);
    expect(await points(2, seat({ minRoe: -5000, roe: 1 }))).toBe(80); // comeback
    expect(await points(2, seat({ minRoe: -5000, roe: 0 }))).toBe(0);
    expect(await points(3, seat({ maxRoe: 10000, roe: -50 }))).toBe(60); // moonshot
    expect(await points(3, seat({ maxRoe: 9999 }))).toBe(0);
    expect(await points(4, seat(), wiped)).toBe(100); // schadenfreude
    expect(await points(4, wiped, seat())).toBe(0);
    expect(await points(5, seat({ roe: -1000 }))).toBe(75); // flatline
    expect(await points(5, seat({ roe: 1001 }))).toBe(0);
    expect(await points(6, seat({ leverage: 100, roe: 5 }), seat({ leverage: 1000, roe: 4 }))).toBe(75); // underdog
    expect(await points(6, seat({ leverage: 1000, roe: 5 }), seat({ leverage: 100, roe: 4 }))).toBe(0);
    expect(await points(7, seat({ maxRoe: 5000, minRoe: -5000 }))).toBe(80); // whipsaw
    expect(await points(7, seat({ maxRoe: 5000, minRoe: -4999 }))).toBe(0);

    // One point per 1%, in tenths, plus the bonus.
    expect(await read('scoreOf', [seat({ roe: 1234, bonus: 4, maxRoe: 10000 }), seat()])).toBe(123 + 600);
    expect(await read('scoreOf', [wiped, seat()])).toBe(-1000);
  });

  it('refuses the ways a player could cheat', async () => {
    await resetPrices();
    const d = await dealt();
    const salt = randomHex32();
    const me = d.a.account.address;

    await reverts(dry(carol, 'commitPick', [d.id, salt]), 'NotSeated');
    // No showing a card before both have committed.
    await send(d.a, 'commitPick', [d.id, pickCommitOf(d.id, me, 2, salt)]);
    await reverts(dry(d.a, 'revealPick', [d.id, 2, salt]), 'WrongPhase');
    // No changing your mind.
    await reverts(dry(d.a, 'commitPick', [d.id, pickCommitOf(d.id, me, 4, salt)]), 'AlreadyDone');
    await send(d.b, 'commitPick', [d.id, pickCommitOf(d.id, d.b.account.address, 0, salt)]);
    // No revealing a different card than the one committed, or someone else's commitment.
    await reverts(dry(d.a, 'revealPick', [d.id, 3, salt]), 'BadReveal');
    await reverts(dry(d.a, 'revealPick', [d.id, 9, salt]), 'BadReveal');
    await reverts(dry(d.b, 'revealPick', [d.id, 2, salt]), 'BadReveal');
    await send(d.a, 'revealPick', [d.id, 2, salt]);
    await reverts(dry(d.a, 'revealPick', [d.id, 2, salt]), 'AlreadyDone');
    // No second duel while seated, and no dealing twice.
    await reverts(dry(d.a, 'open', [DURATION, salt, salt], nextStake()), 'Busy');
    await reverts(dry(d.a, 'deal', [d.id, d.salts.dealA]), 'WrongPhase');

    // B now stalls instead of showing a losing card: A takes the pot after the deadline.
    await reverts(dry(d.a, 'timeout', [d.id]), 'TooEarly');
    await warp(91);
    await reverts(dry(d.b, 'revealPick', [d.id, 0, salt]), 'TooLate');
    const before = await balance(me);
    await send(carol, 'timeout', [d.id]);
    expect((await balance(me)) - before).toBe(d.stake * 2n);
    expect((await read('getDuel', [d.id])).phase).toBe(Phase.Cancelled);
  });

  it('handles walk-aways at every step before the start', async () => {
    const a = alice.account.address;
    const b = bob.account.address;

    // Nobody joins: A cancels and is refunded. Only A can.
    let stake = nextStake();
    await send(alice, 'open', [DURATION, randomHex32(), randomHex32()], stake);
    let id = (await read('activeOf', [a])) as bigint;
    expect(await read('waiting', [await read('termsKey', [DURATION, stake])])).toBe(id);
    await reverts(dry(carol, 'open', [DURATION, randomHex32(), randomHex32()], stake), 'Taken');
    await reverts(dry(bob, 'join', [id, randomHex32(), randomHex32()], stake - 1n), 'BadValue');
    await reverts(dry(bob, 'cancel', [id]), 'NotSeated');
    let before = await balance(a);
    const r = await send(alice, 'cancel', [id]);
    expect((await balance(a)) - before + r.gasUsed * r.effectiveGasPrice).toBe(stake);
    expect(await read('waiting', [await read('termsKey', [DURATION, stake])])).toBe(0n);

    // A sees the seed, dislikes the hand and never deals: B takes the pot.
    stake = nextStake();
    const dealSalt = randomHex32();
    await send(alice, 'open', [DURATION, dealCommitOf(a, dealSalt), randomHex32()], stake);
    id = (await read('activeOf', [a])) as bigint;
    await send(bob, 'join', [id, randomHex32(), randomHex32()], stake);
    await reverts(dry(alice, 'deal', [id, randomHex32()]), 'BadReveal');
    await reverts(dry(alice, 'cancel', [id]), 'WrongPhase');
    await warp(91);
    before = await balance(b);
    await send(carol, 'timeout', [id]);
    expect((await balance(b)) - before).toBe(stake * 2n);

    // Both go quiet after the deal: stakes go back.
    const d = await dealt();
    await warp(91);
    const both = { a: await balance(a), b: await balance(b) };
    await send(carol, 'timeout', [d.id]);
    expect((await balance(a)) - both.a).toBe(d.stake);
    expect((await balance(b)) - both.b).toBe(d.stake);
  });

  it('settles without a player who never reveals their secret, with no bonus for them', async () => {
    await resetPrices();
    const d = await started(2, 2);
    await d.move(1, 12);
    await warp(DURATION + 1);
    await send(d.b, 'reveal', [d.id, d.salts.secretB]);
    await reverts(dry(d.b, 'settle', [d.id]), 'TooEarly');
    await warp(61);
    await send(carol, 'settle', [d.id]);
    const duel = await read('getDuel', [d.id]);
    expect(duel.phase).toBe(Phase.Settled);
    expect(duel.seats[0]).toMatchObject({ secretRevealed: false, bonus: 0 });
    expect(duel.scoreA).toBe(Math.trunc(duel.seats[0].roe / 10));
    await resetPrices();
  });

  it('runs a whole duel between two ordinary players using the app\'s own client', async () => {
    await resetPrices();
    const info = { chainId: foundry.id, rpcUrl: RPC, address: arena };
    const coins = PERPS.map((p) => ({ coin: `P${p}`, scale: 1 }));
    const views: { human?: MatchView; bot?: MatchView } = {};
    const errors: string[] = [];
    const events = (who: 'human' | 'bot') => ({ onView: (v: MatchView) => (views[who] = v), onBusy: () => {}, onError: (m: string) => errors.push(`${who}: ${m}`) });
    const human = new ArenaPlayer(info, KEYS.alice, coins, events('human'));
    const bot = new ArenaPlayer(info, KEYS.bob, coins, events('bot'), () => 4);
    const stake = nextStake();
    const round = async (n = 1) => {
      for (let i = 0; i < n; i++) {
        await human.tick();
        await bot.tick();
      }
    };

    await human.find({ duration: 30, stake });
    await round();
    expect(views.human).toBeUndefined(); // nothing to show until someone joins and the cards are dealt
    await bot.find({ duration: 30, stake });
    expect(bot.duelId).toBe(human.duelId);
    await round(2); // human deals; bot commits its pick
    expect(views.human!.phase).toBe('picking');
    expect(views.human!.you.hand).toHaveLength(5);
    expect(views.human!.you.hand.filter((c) => c.secret)).toHaveLength(2);
    expect(views.human!.opp).toMatchObject({ locked: true, face: null, card: null });
    // The human sees their own hand, not the bot's, and the two differ.
    expect(views.bot!.you.hand).not.toEqual(views.human!.you.hand);

    // A second client on the same key, as after an app restart, finds the duel again.
    const again = new ArenaPlayer(info, KEYS.alice, coins, events('human'));
    expect(await again.resume()).toBe(true);
    expect(again.duelId).toBe(human.duelId);

    human.choose(2);
    await round(3); // commit, both reveal, start
    expect(views.human!.phase).toBe('live');
    expect(views.human!.you.card).toEqual(views.human!.you.hand[2]);
    expect(views.human!.opp.face).toEqual({ coin: views.bot!.you.card!.coin, side: views.bot!.you.card!.side, leverage: views.bot!.you.card!.leverage });
    expect(views.human!.opp.face).not.toHaveProperty('secret');

    // Sink the bot's market. The human's client notices and pokes without being asked.
    const botCard = views.bot!.you.card!;
    const humanCard = views.human!.you.card!;
    if (botCard.coin !== humanCard.coin) {
      const perp = Number(botCard.coin.slice(1));
      await setPx(perp, botCard.side === 'long' ? (START_PX * 98n) / 100n : (START_PX * 102n) / 100n);
      await human.tick();
      await human.tick();
      expect((await read('getDuel', [human.duelId])).seats[1].liquidated).toBe(true);
      expect(views.human!.opp.pos).toMatchObject({ liquidated: true, roe: -100 });
    }

    await warp(31);
    await round(3); // both open their seals; the second one settles
    expect(human.done && bot.done).toBe(true);
    const mine = views.human!.result!;
    const theirs = views.bot!.result!;
    expect(views.human!.phase).toBe('settled');
    expect(mine.you).toEqual(theirs.opp);
    expect(mine.opp).toEqual(theirs.you);
    expect([mine.outcome, theirs.outcome].sort()).toEqual(mine.outcome === 'draw' ? ['draw', 'draw'] : ['loss', 'win']);
    expect(views.human!.opp.card!.coin).toBe(botCard.coin);
    if (botCard.coin !== humanCard.coin) {
      expect(theirs.you.base).toBe(-100);
      expect(theirs.you.bonus).toBe(botCard.secret === 'phoenix' ? 250 : 0);
    }
    expect(errors).toEqual([]);
    await resetPrices();
  });
});
