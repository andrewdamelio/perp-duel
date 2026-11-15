import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Address, Hex } from '../src/engine';
import { Referee, RefereeError } from './referee';

/** HTTP surface of the referee. Plain JSON, polled by the app. */
export function createApp(referee: Referee) {
  const app = new Hono();
  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof RefereeError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'Referee error' }, 500);
  });

  app.get('/health', (c) => c.json(referee.info()));

  app.post('/queue', async (c) => c.json(referee.queue(await c.req.json())));
  app.get('/ticket/:ticket', (c) => c.json(referee.ticket(c.req.param('ticket'))));
  app.delete('/ticket/:ticket', (c) => {
    referee.leaveQueue(c.req.param('ticket'));
    return c.json({ ok: true });
  });

  app.get('/active', (c) => c.json({ matchId: referee.activeFor(c.req.query('player') as Address) }));
  app.get('/match/:id', (c) => c.json(referee.view(c.req.param('id') as Hex, c.req.query('player') as Address)));
  app.post('/match/:id/pick', async (c) => {
    const body = (await c.req.json()) as { player: Address; cardIndex: number; salt: Hex };
    return c.json(await referee.pick(c.req.param('id') as Hex, body.player, body.cardIndex, body.salt));
  });

  return app;
}
