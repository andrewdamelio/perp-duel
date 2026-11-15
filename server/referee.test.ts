import { describe, expect, it } from 'vitest';
import { DEFAULT_MARKETS, SECRETS, randomHex32, type Hex, type MatchView } from '../src/engine';
import { createManualFeed } from '../src/hl/feed';
import { createApp } from './app';
import { Referee } from './referee';

const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';

function setup() {
  let clock = 1_700_000_000_000;
  const feed = createManualFeed(DEFAULT_MARKETS);
  const referee = new Referee({ feed, now: () => clock, botDelayMs: 0 });
  const app = createApp(referee);
  const json = async <T>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, feed, referee, json, post, advance: (ms: number) => (clock += ms) };
}

describe('referee over HTTP, play money', () => {
  it('pairs two humans with the same terms and scores the duel', async () => {
    const { app, feed, referee, json, post, advance } = setup();
    const terms = { duration: 30, stake: '100000000000000000' };

    const first = await json<{ ticket: string; matchId: Hex | null }>(post('/queue', { address: ALICE, ...terms }));
    expect(first.matchId).toBeNull();
    // Different terms do not match.
    const other = await json<{ matchId: Hex | null }>(post('/queue', { address: BOB, ...terms, duration: 120 }));
    expect(other.matchId).toBeNull();

    const second = await json<{ matchId: Hex }>(post('/queue', { address: BOB, ...terms }));
    expect(second.matchId).toMatch(/^0x/);
    expect((await json<{ matchId: Hex }>(app.request(`/ticket/${first.ticket}`))).matchId).toBe(second.matchId);

    const id = second.matchId;
    const viewOf = (who: string) => json<MatchView>(app.request(`/match/${id}?player=${who}`));
    const alice = await viewOf(ALICE);
    const bob = await viewOf(BOB);
    expect(alice.you.hand).not.toEqual(bob.you.hand);
    expect(alice.onchain).toBe(false);
    expect((await app.request(`/match/${id}?player=0x00000000000000000000000000000000000000ff`)).status).toBe(403);

    expect((await post(`/match/${id}/pick`, { player: ALICE, cardIndex: 0, salt: randomHex32() })).status).toBe(200);
    expect((await post(`/match/${id}/pick`, { player: ALICE, cardIndex: 1, salt: randomHex32() })).status).toBe(409);
    expect((await viewOf(BOB)).opp).toMatchObject({ locked: true, face: null });
    await post(`/match/${id}/pick`, { player: BOB, cardIndex: 4, salt: randomHex32() });

    await referee.step();
    const live = await viewOf(ALICE);
    expect(live.phase).toBe('live');
    expect(live.opp.face?.coin).toBe(bob.you.hand[4]!.coin);
    expect(await json(app.request(`/active?player=${BOB}`))).toEqual({ matchId: id });

    // Crash Alice's market far enough to liquidate a long or moon a short.
    const mine = live.you.card!;
    feed.set({ [mine.coin]: feed.mids()[mine.coin]! * 0.4 });
    advance(5_000);
    await referee.step();
    advance(30_000);
    await referee.step();

    const done = await viewOf(ALICE);
    expect(done.phase).toBe('settled');
    expect(done.settleTx).toBeNull();
    if (mine.side === 'long') {
      expect(done.you.pos?.liquidated).toBe(true);
      expect(done.result!.you.base).toBe(-100);
      expect(done.result!.you.bonus).toBe(mine.secret === 'phoenix' ? SECRETS.phoenix.points : 0);
    } else {
      expect(done.result!.you.base).toBeCloseTo(60 * mine.leverage, 0);
    }
    const bobDone = await viewOf(BOB);
    expect(bobDone.result!.you).toEqual(done.result!.opp);
    expect(await json(app.request(`/active?player=${BOB}`))).toEqual({ matchId: null });
  });

  it('plays the house bot on request and reports its setup', async () => {
    const { app, referee, json, post } = setup();
    const { matchId } = await json<{ matchId: Hex }>(post('/queue', { address: ALICE, duration: 120, stake: '1', bot: true }));
    await referee.step();
    const view = await json<MatchView>(app.request(`/match/${matchId}?player=${ALICE}`));
    expect(view.opp).toMatchObject({ isBot: true, locked: true, name: 'House bot' });
    expect(await json(app.request('/health'))).toEqual({ feed: 'sim', markets: DEFAULT_MARKETS.length, chain: null });
  });

  it('rejects bad requests with a reason', async () => {
    const { json, post, app } = setup();
    expect(await json(post('/queue', { address: ALICE, duration: 5, stake: '1' }))).toEqual({ error: 'Duration must be at least 30 seconds' });
    expect((await post('/queue', { address: ALICE, duration: 30, stake: '0' })).status).toBe(400);
    expect((await app.request(`/match/0x${'00'.repeat(32)}?player=${ALICE}`)).status).toBe(404);
  });
});
