/**
 * End-to-end: real DuelEscrow bytecode on a local anvil chain, driven by the real referee
 * over its HTTP surface. Needs the `anvil` binary (Foundry) on PATH or in ANVIL_BIN;
 * the suite is skipped when it is missing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { escrowAbi } from '../src/chain/escrowAbi';
import { DEFAULT_MARKETS, cardHash, duelIdOf, pickCommit, randomHex32, type Card, type MatchView } from '../src/engine';
import { createManualFeed } from '../src/hl/feed';
import { createApp } from '../server/app';
import { createEscrowChain, DuelStatus } from '../server/chain';
import { Referee } from '../server/referee';
import { deployEscrow } from './deploy';

const ANVIL = process.env.ANVIL_BIN ?? 'anvil';
const hasAnvil = spawnSync(ANVIL, ['--version']).status === 0;
const PORT = 8599;
const RPC = `http://127.0.0.1:${PORT}`;

// anvil's well-known dev keys
const KEYS = {
  referee: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bot: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  carol: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;
const STAKE = parseEther('0.1');
const DUEL = 60;

describe.skipIf(!hasAnvil)('DuelEscrow with the referee', () => {
  let anvil: ChildProcess;
  let escrow: Address;
  const transport = http(RPC);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport });
  const alice = wallet(KEYS.alice);
  const carol = wallet(KEYS.carol);
  const bot = wallet(KEYS.bot);
  const referee = privateKeyToAccount(KEYS.referee);

  const mined = async (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });
  const balance = (a: Address) => publicClient.getBalance({ address: a });
  const warp = async (seconds: number) => {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
  };
  const duel = (id: Hex) => publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: 'getDuel', args: [id] });
  const enter = (w: typeof alice, a: Address, b: Address, nonce: Hex, commit: Hex, value = STAKE, duration = DUEL) =>
    w.writeContract({ address: escrow, abi: escrowAbi, functionName: 'enter', args: [a, b, BigInt(duration), nonce, commit], value });
  const signResult = (signer: typeof referee, duelId: Hex, cardA: Hex, cardB: Hex, scoreA: number, scoreB: number) =>
    signer.signTypedData({
      domain: { name: 'PerpDuel', version: '1', chainId: foundry.id, verifyingContract: escrow },
      types: {
        Result: [
          { name: 'duelId', type: 'bytes32' },
          { name: 'cardA', type: 'bytes32' },
          { name: 'cardB', type: 'bytes32' },
          { name: 'scoreA', type: 'int32' },
          { name: 'scoreB', type: 'int32' },
        ],
      },
      primaryType: 'Result',
      message: { duelId, cardA, cardB, scoreA, scoreB },
    });
  const expectRevert = async (call: Promise<unknown>, errorName: string) => {
    await expect(call).rejects.toThrow(new RegExp(errorName));
  };

  /** Two players entered directly against the contract, no referee server involved. */
  const liveDuel = async () => {
    const nonce = randomHex32();
    const id = duelIdOf(alice.account.address, carol.account.address, DUEL, STAKE, nonce);
    const cardA: Card = { coin: 'BTC', side: 'long', leverage: 10, secret: 'phoenix' };
    const cardB: Card = { coin: 'xyz:NVDA', side: 'short', leverage: 5, secret: null };
    const saltA = randomHex32();
    const saltB = randomHex32();
    await mined(await enter(alice, alice.account.address, carol.account.address, nonce, pickCommit(id, alice.account.address, cardA, saltA)));
    await mined(await enter(carol, alice.account.address, carol.account.address, nonce, pickCommit(id, carol.account.address, cardB, saltB)));
    const reveals = [
      { card: cardHash(cardA), salt: saltA },
      { card: cardHash(cardB), salt: saltB },
    ] as const;
    const settleArgs = async (scoreA: number, scoreB: number, signer = referee) =>
      [id, reveals[0], reveals[1], scoreA, scoreB, await signResult(signer, id, reveals[0].card, reveals[1].card, scoreA, scoreB)] as const;
    return { id, nonce, reveals, settleArgs };
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
    const deployed = await deployEscrow({ rpcUrl: RPC, chainId: foundry.id, deployerKey: KEYS.referee, referee: referee.address });
    escrow = deployed.address;
    console.log(`deploy gas: ${deployed.gasUsed}`);
  });

  afterAll(() => {
    anvil?.kill();
  });

  it('plays a full duel against the house bot and pays the winner from escrow', async () => {
    let clock = Date.now();
    const feed = createManualFeed(DEFAULT_MARKETS);
    const chain = createEscrowChain({ rpcUrl: RPC, chainId: foundry.id, escrow, refereeKey: KEYS.referee, botKey: KEYS.bot });
    const ref = new Referee({ feed, chain, now: () => clock, botDelayMs: 0, random: () => 0.5 });
    const app = createApp(ref);
    const me = alice.account.address;
    const get = async (path: string) => (await app.request(path)).json();
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const queued = (await (await post('/queue', { address: me, duration: DUEL, stake: STAKE.toString(), bot: true })).json()) as { matchId: Hex };
    let view = (await get(`/match/${queued.matchId}?player=${me}`)) as MatchView;
    expect(view.phase).toBe('picking');
    expect(view.onchain).toBe(true);
    expect(view.you.hand).toHaveLength(5);
    expect(view.id).toBe(duelIdOf(me, bot.account.address, DUEL, STAKE, view.nonce));

    // The referee refuses a pick until the stake and commitment are in the escrow.
    const cardIndex = 1;
    const salt = randomHex32();
    const early = await post(`/match/${view.id}/pick`, { player: me, cardIndex, salt });
    expect(early.status).toBe(409);

    const commit = pickCommit(view.id, me, view.you.hand[cardIndex]!, salt);
    await mined(await enter(alice, me, bot.account.address, view.nonce, commit));

    // Claiming a different card than the one committed is refused too.
    expect((await post(`/match/${view.id}/pick`, { player: me, cardIndex: 2, salt })).status).toBe(409);
    expect((await post(`/match/${view.id}/pick`, { player: me, cardIndex, salt })).status).toBe(200);

    await ref.step(); // bot stakes, commits, and the duel goes live
    view = (await get(`/match/${view.id}?player=${me}`)) as MatchView;
    expect(view.phase).toBe('live');
    expect((await duel(view.id)).status).toBe(DuelStatus.Live);
    expect(view.startAt).toBe(Number((await duel(view.id)).startedAt) * 1000);
    expect(view.opp.face).not.toBeNull();
    expect(view.opp.card).toBeNull();
    expect(await publicClient.getBalance({ address: escrow })).toBe(STAKE * 2n);

    // Move the tape: my card's market goes my way by 2%, everything else drifts 1% the other way.
    const mine = view.you.card!;
    const mids = feed.mids();
    const moved = Object.fromEntries(
      Object.entries(mids).map(([coin, px]) => [coin, px * (coin === mine.coin ? (mine.side === 'long' ? 1.02 : 0.98) : mine.side === 'long' ? 0.99 : 1.01)]),
    );
    feed.set(moved);
    clock += 5_000;
    await ref.step();

    // Too early for the escrow, however the scores look.
    const before = { me: await balance(me), bot: await balance(bot.account.address) };
    await warp(DUEL + 1);
    clock = (view.endAt as number) + 1000;
    await ref.step();

    view = (await get(`/match/${view.id}?player=${me}`)) as MatchView;
    expect(view.phase).toBe('settled');
    expect(view.settleTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.opp.card).not.toBeNull();
    expect(view.result!.you.base).toBeCloseTo(2 * mine.leverage, 1);

    const receipt = await publicClient.getTransactionReceipt({ hash: view.settleTx as Hex });
    const settled = receipt.logs
      .map((log) => decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics }))
      .find((e) => e.eventName === 'Settled')!;
    const args = settled.args as { winner: Address; scoreA: number; scoreB: number; payout: bigint };
    expect(args.scoreA).toBe(Math.round(view.result!.you.total * 10));
    expect(args.scoreB).toBe(Math.round(view.result!.opp.total * 10));

    const after = { me: await balance(me), bot: await balance(bot.account.address) };
    expect((await duel(view.id)).status).toBe(DuelStatus.Settled);
    expect(await publicClient.getBalance({ address: escrow })).toBe(0n);
    if (view.result!.outcome === 'win') {
      expect(args.winner).toBe(me);
      expect(after.me - before.me).toBe(STAKE * 2n);
      expect(after.bot).toBe(before.bot);
    } else if (view.result!.outcome === 'loss') {
      expect(args.winner).toBe(bot.account.address);
      expect(after.bot - before.bot).toBe(STAKE * 2n);
    } else {
      expect(after.me - before.me).toBe(STAKE);
      expect(after.bot - before.bot).toBe(STAKE);
    }

    // The revealed card and salt reproduce the bot's on-chain commitment.
    const onchain = await duel(view.id);
    expect(pickCommit(view.id, bot.account.address, view.opp.card!, view.opp.salt!)).toBe(onchain.commitB);
  });

  it('rejects early, forged and mismatched settlements', async () => {
    const d = await liveDuel();
    const settle = (args: Awaited<ReturnType<typeof d.settleArgs>>) =>
      publicClient.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'settle', args, account: carol.account });

    await expectRevert(settle(await d.settleArgs(500, -1000)), 'TooEarly');
    await warp(DUEL + 1);
    await expectRevert(settle(await d.settleArgs(500, -1000, privateKeyToAccount(KEYS.carol))), 'BadSignature');

    const good = await d.settleArgs(500, -1000);
    const tampered = [good[0], good[1], good[2], good[3], 9999, good[5]] as const;
    await expectRevert(settle(tampered), 'BadSignature');
    const wrongReveal = [good[0], { ...good[1], salt: randomHex32() }, good[2], good[3], good[4], good[5]] as const;
    await expectRevert(settle(wrongReveal), 'BadReveal');

    // Anyone may submit a correctly signed result: here the loser does, and the winner is paid.
    const before = await balance(alice.account.address);
    await mined(await carol.writeContract({ address: escrow, abi: escrowAbi, functionName: 'settle', args: good }));
    expect((await balance(alice.account.address)) - before).toBe(STAKE * 2n);
    await expectRevert(settle(good), 'WrongStatus');
  });

  it('returns both stakes on a draw', async () => {
    const d = await liveDuel();
    await warp(DUEL + 1);
    const before = { a: await balance(alice.account.address), c: await balance(carol.account.address) };
    await mined(await wallet(KEYS.referee).writeContract({ address: escrow, abi: escrowAbi, functionName: 'settle', args: await d.settleArgs(120, 120) }));
    expect((await balance(alice.account.address)) - before.a).toBe(STAKE);
    expect((await balance(carol.account.address)) - before.c).toBe(STAKE);
  });

  it('lets players out if the opponent or the referee never shows', async () => {
    const refund = (id: Hex) => publicClient.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'refund', args: [id], account: carol.account });

    // Opponent never joins.
    const nonce = randomHex32();
    const id = duelIdOf(alice.account.address, carol.account.address, DUEL, STAKE, nonce);
    await mined(await enter(alice, alice.account.address, carol.account.address, nonce, randomHex32()));
    expect((await duel(id)).status).toBe(DuelStatus.Open);
    await expectRevert(refund(id), 'TooEarly');
    await warp(15 * 60 + 1);
    const before = await balance(alice.account.address);
    await mined(await carol.writeContract({ address: escrow, abi: escrowAbi, functionName: 'refund', args: [id] }));
    expect((await balance(alice.account.address)) - before).toBe(STAKE);
    expect((await duel(id)).status).toBe(DuelStatus.Refunded);

    // Referee goes missing after the duel starts.
    const d = await liveDuel();
    await warp(DUEL + 1);
    await expectRevert(refund(d.id), 'TooEarly');
    await warp(24 * 3600);
    const b2 = { a: await balance(alice.account.address), c: await balance(carol.account.address) };
    await mined(await wallet(KEYS.referee).writeContract({ address: escrow, abi: escrowAbi, functionName: 'refund', args: [d.id] }));
    expect((await balance(alice.account.address)) - b2.a).toBe(STAKE);
    expect((await balance(carol.account.address)) - b2.c).toBe(STAKE);
  });

  it('keeps outsiders and mismatched terms out', async () => {
    const nonce = randomHex32();
    const a = alice.account.address;
    const c = carol.account.address;
    const sim = (w: typeof alice, args: readonly [Address, Address, bigint, Hex, Hex], value = STAKE) =>
      publicClient.simulateContract({ address: escrow, abi: escrowAbi, functionName: 'enter', args, value, account: w.account });

    await expectRevert(sim(bot, [a, c, BigInt(DUEL), nonce, randomHex32()]), 'NotAPlayer');
    await expectRevert(sim(alice, [a, a, BigInt(DUEL), nonce, randomHex32()]), 'SamePlayer');
    await expectRevert(sim(alice, [a, c, 10n, nonce, randomHex32()]), 'BadDuration');
    await expectRevert(sim(alice, [a, c, BigInt(DUEL), nonce, randomHex32()], 0n), 'BadStake');

    // A different stake is a different duel, so the second player can never be pulled into terms they did not sign up for.
    await mined(await enter(alice, a, c, nonce, randomHex32()));
    await mined(await enter(carol, a, c, nonce, randomHex32(), STAKE / 2n));
    expect((await duel(duelIdOf(a, c, DUEL, STAKE, nonce))).status).toBe(DuelStatus.Open);
    expect((await duel(duelIdOf(a, c, DUEL, STAKE / 2n, nonce))).status).toBe(DuelStatus.Open);
    await expectRevert(sim(alice, [a, c, BigInt(DUEL), nonce, randomHex32()]), 'AlreadyEntered');
  });
});
