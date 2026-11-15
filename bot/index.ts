/**
 * A sparring partner for the on-chain arena. Run with: npm run bot
 *
 * It is an ordinary player: it stakes its own HYPE, joins any duel waiting at the terms
 * the app offers, picks a random card and plays it out with the same client the app uses.
 * It has no special access to the contract and cannot see your hidden bonus.
 *
 * Env:
 *   BOT_PRIVATE_KEY   a funded account (required)
 *   ARENA_ADDRESS     the deployed DuelArena (required)
 *   RPC_URL           default https://rpc.hyperliquid-testnet.xyz/evm
 *   CHAIN_ID          default 998 (HyperEVM testnet)
 *   ARENA_COINS       comma-separated market names, only for a local test chain
 */
import { formatEther } from 'viem';
import { loadArenaMarkets, publicClientOf, type ArenaInfo } from '../src/chain/arena';
import { arenaAbi } from '../src/chain/arenaAbi';
import { ArenaPlayer } from '../src/chain/arenaPlayer';
import { DURATIONS, STAKES } from '../src/config';
import type { Address, Hex } from '../src/engine';

const env = process.env;
if (!env.BOT_PRIVATE_KEY || !env.ARENA_ADDRESS) {
  console.error('Set BOT_PRIVATE_KEY and ARENA_ADDRESS');
  process.exit(1);
}
const info: ArenaInfo = {
  address: env.ARENA_ADDRESS as Address,
  chainId: Number(env.CHAIN_ID ?? 998),
  rpcUrl: env.RPC_URL ?? 'https://rpc.hyperliquid-testnet.xyz/evm',
  coins: env.ARENA_COINS?.split(','),
};
const key = env.BOT_PRIVATE_KEY as Hex;
const log = (line: string) => console.log(new Date().toISOString(), line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = publicClientOf(info);
  const markets = await loadArenaMarkets(info);
  const read = (functionName: string, args: unknown[]) =>
    client.readContract({ address: info.address, abi: arenaAbi, functionName: functionName as never, args: args as never }) as Promise<unknown>;
  const newPlayer = () =>
    new ArenaPlayer(
      info,
      key,
      markets,
      { onView: () => {}, onBusy: (text) => text && log(text), onError: (message) => log(`error: ${message}`) },
      (hand) => Math.floor(Math.random() * hand.length),
    );

  const me = newPlayer().address;
  log(`Bot ${me} watching ${info.address} with ${markets.length} markets, balance ${formatEther(await client.getBalance({ address: me }))} HYPE`);

  for (;;) {
    try {
      const player = newPlayer();
      let seated = await player.resume();
      if (!seated) {
        // Look for someone waiting at any of the terms the app offers.
        for (const d of DURATIONS) {
          for (const stake of STAKES) {
            const waiting = (await read('waiting', [await read('termsKey', [BigInt(d.seconds), BigInt(stake)])])) as bigint;
            if (waiting === 0n || seated) continue;
            await player.find({ duration: d.seconds, stake: BigInt(stake) });
            seated = player.duelId !== 0n;
          }
        }
      }
      if (seated) {
        log(`Seated in duel ${player.duelId}`);
        while (!player.done) {
          await player.tick();
          await sleep(500);
        }
        log(`Duel ${player.duelId} finished`);
      }
    } catch (e) {
      log(`error: ${(e as Error).message.split('\n')[0]}`);
    }
    await sleep(1500);
  }
}

void main();
