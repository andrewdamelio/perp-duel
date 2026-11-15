/**
 * Referee server. Run with: npm run referee
 *
 * Play money (no chain):   npm run referee
 * Escrowed on HyperEVM:    ESCROW_ADDRESS=0x… REFEREE_PRIVATE_KEY=0x… BOT_PRIVATE_KEY=0x… npm run referee
 *
 * Env:
 *   PORT                  default 8787
 *   PRICE_FEED            "live" (Hyperliquid mainnet mids, default) or "sim"
 *   RPC_URL               default https://rpc.hyperliquid-testnet.xyz/evm
 *   CHAIN_ID              default 998 (HyperEVM testnet)
 *   ESCROW_ADDRESS        deployed DuelEscrow; leave unset for play-money duels
 *   REFEREE_PRIVATE_KEY   must be the referee the escrow was deployed with
 *   BOT_PRIVATE_KEY       funded account the house bot stakes from
 */
import { serve } from '@hono/node-server';
import { DEFAULT_MARKETS, type Address, type Hex } from '../src/engine';
import { createLiveFeed, createSimFeed } from '../src/hl/feed';
import { createApp } from './app';
import { createEscrowChain } from './chain';
import { Referee } from './referee';

const env = process.env;
const feed =
  env.PRICE_FEED === 'sim'
    ? createSimFeed({ markets: DEFAULT_MARKETS, speed: Number(env.SIM_SPEED ?? 1) })
    : createLiveFeed({ markets: DEFAULT_MARKETS });
feed.start();

const chain = env.ESCROW_ADDRESS
  ? createEscrowChain({
      rpcUrl: env.RPC_URL ?? 'https://rpc.hyperliquid-testnet.xyz/evm',
      chainId: Number(env.CHAIN_ID ?? 998),
      escrow: env.ESCROW_ADDRESS as Address,
      refereeKey: required('REFEREE_PRIVATE_KEY') as Hex,
      botKey: required('BOT_PRIVATE_KEY') as Hex,
    })
  : undefined;

const referee = new Referee({ feed, chain, log: (line) => console.log(new Date().toISOString(), line) });

const loop = async () => {
  await referee.step();
  // Fast duels at high leverage need a fine-grained tape.
  setTimeout(loop, 500);
};
void loop();

const port = Number(env.PORT ?? 8787);
serve({ fetch: createApp(referee).fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Referee listening on :${port}`);
  console.log(chain ? `Escrow ${chain.escrow} on chain ${chain.chainId}, referee ${chain.refereeAddress}, bot ${chain.botAddress}` : 'No ESCROW_ADDRESS set: play-money duels only');
});

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when ESCROW_ADDRESS is set`);
  return value;
}
