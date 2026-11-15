import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import { createWalletClient, custom } from 'viem';
import type { Eip1193 } from '../chain/phantom';
import { accountOf } from '../chain/wallet';
import type { Address, Card, Hex } from '../engine';

export interface RealTradeRequest {
  card: Card;
  /** Leverage for the real position. Cards go far beyond what Hyperliquid allows, so this is capped by the caller. */
  leverage: number;
  /** Margin in USDC. Notional is margin * leverage. */
  marginUsd: number;
  /** The key kept on this device. With Phantom it only ever acts as an approved trading agent. */
  key: Hex;
  /** Phantom's Ethereum provider. When present, the trade lands in the user's Phantom perps account. */
  phantom: Eip1193 | null;
  testnet: boolean;
  /** Builder code to attach, if one is configured. */
  builder: Address | null;
  /** Tenths of a basis point: 10 = 0.01%. */
  builderFee: number;
  onStep?: (text: string) => void;
}

export interface RealTradeResult {
  account: Address;
  filledSize: string;
  averagePrice: string;
  orderId: number;
}

const SLIPPAGE = 0.01;
const AGENT_NAME = 'PerpDuel';

/**
 * Turn a card into a real Hyperliquid position.
 *
 * With Phantom, the position belongs to the Ethereum address in the user's Phantom wallet,
 * which is the same Hyperliquid account Phantom's own perps tab trades from. Phantom signs
 * two one-time approvals; after that the device key places orders as an agent, which can
 * trade but can never withdraw:
 *
 *   1. approveBuilderFee  lets orders carry this app's builder code, up to a max fee
 *   2. approveAgent       lets the device key sign orders for the account
 *   3. updateLeverage     isolated margin at the (capped) leverage     } signed by
 *   4. order              IOC, with `builder: { b, f }` attached       } the agent
 *
 * Without Phantom (a dev fallback), the device key is the account and signs everything.
 */
export async function openRealTrade(req: RealTradeRequest): Promise<RealTradeResult> {
  const step = req.onStep ?? (() => {});
  const transport = new HttpTransport({ isTestnet: req.testnet });
  const info = new InfoClient({ transport });
  const agentAccount = accountOf(req.key);
  const agent = new ExchangeClient({ transport, wallet: agentAccount });

  let account: Address = agentAccount.address;
  // Whoever owns the account signs the two approvals: Phantom if present, otherwise the device key.
  let owner: Pick<typeof agent, 'approveBuilderFee' | 'approveAgent'> = agent;

  if (req.phantom) {
    step('Connecting to Phantom');
    const wallet = createWalletClient({ transport: custom(req.phantom) });
    const [address] = await wallet.requestAddresses();
    if (!address) throw new Error('Phantom did not share an Ethereum address');
    account = address;
    owner = new ExchangeClient({
      transport,
      wallet: createWalletClient({
        account: address,
        transport: custom(req.phantom),
      }),
    });
  }

  const dex = req.card.coin.includes(':') ? (req.card.coin.split(':')[0] as string) : null;
  const symbols = await SymbolConverter.create({
    transport,
    dexs: dex ? [dex] : false,
  });
  const assetId = symbols.getAssetId(req.card.coin);
  const decimals = symbols.getSzDecimals(req.card.coin);
  if (assetId === undefined || decimals === undefined) {
    throw new Error(`${req.card.coin} is not listed on Hyperliquid ${req.testnet ? 'testnet' : 'mainnet'}`);
  }
  const asset: number = assetId;
  const szDecimals: number = decimals;

  // Check the money before asking for any signature. A page in Phantom's browser can only
  // use what is already in the wallet's Hyperliquid perps balance; it cannot pull from
  // Cash, SOL or USDC on Solana the way Phantom's own perps tab does when you open a trade.
  if (req.phantom) {
    const available = await availableUsd(info, account);
    if (available !== null && available < req.marginUsd) throw new Error(needsFunds(account, available, req.marginUsd));
  }

  try {
    return await approveAndOrder();
  } catch (e) {
    const message = (e as Error).message ?? '';
    // An account Hyperliquid has never seen cannot sign anything yet.
    if (/must deposit|does not exist/i.test(message)) throw new Error(needsFunds(account, 0, req.marginUsd));
    throw e;
  }

  async function approveAndOrder(): Promise<RealTradeResult> {
    if (req.builder) {
      const approved = await info.maxBuilderFee({
        user: account,
        builder: req.builder,
      });
      if (approved < req.builderFee) {
        step(req.phantom ? 'Approve the builder fee in Phantom' : 'Approving the builder fee');
        await owner.approveBuilderFee({
          builder: req.builder,
          maxFeeRate: `${req.builderFee / 1000}%`,
        });
      }
    }

    if (req.phantom) {
      const agents = await info.extraAgents({ user: account });
      const known = agents.some((a) => a.address.toLowerCase() === agentAccount.address.toLowerCase());
      if (!known) {
        step('Approve this device as a trading agent in Phantom');
        await owner.approveAgent({
          agentAddress: agentAccount.address,
          agentName: AGENT_NAME,
        });
      }
    }

    step('Placing the order');
    await agent.updateLeverage({
      asset,
      isCross: false,
      leverage: req.leverage,
    });

    const mids = await info.allMids(dex ? { dex } : undefined);
    const mid = Number(mids[req.card.coin]);
    if (!(mid > 0)) throw new Error(`No price for ${req.card.coin}`);
    const isBuy = req.card.side === 'long';
    const price = formatPrice(mid * (isBuy ? 1 + SLIPPAGE : 1 - SLIPPAGE), szDecimals, 'perp');
    const size = formatSize((req.marginUsd * req.leverage) / mid, szDecimals);

    const res = await agent.order({
      orders: [
        {
          a: asset,
          b: isBuy,
          p: price,
          s: size,
          r: false,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
      ...(req.builder ? { builder: { b: req.builder, f: req.builderFee } } : {}),
    });
    const status = res.response.data.statuses[0];
    if (status && typeof status === 'object' && 'filled' in status) {
      return {
        account,
        filledSize: status.filled.totalSz,
        averagePrice: status.filled.avgPx,
        orderId: status.filled.oid,
      };
    }
    throw new Error('The order was accepted but did not fill. Try again.');
  }
}

/**
 * USDC the account can trade with, or null if Hyperliquid could not be asked.
 * Accounts funded through Phantom are "unified": their USDC sits in the spot balance and
 * backs perps from there, so the perps ledger alone reads zero. Count both.
 */
async function availableUsd(info: InfoClient, user: Address): Promise<number | null> {
  const [perps, spot] = await Promise.allSettled([info.clearinghouseState({ user }), info.spotClearinghouseState({ user })]);
  if (perps.status === 'rejected' && spot.status === 'rejected') return null;
  const perpsFree = perps.status === 'fulfilled' ? Number(perps.value.withdrawable) : 0;
  const usdc = spot.status === 'fulfilled' ? spot.value.balances.find((b) => b.coin === 'USDC') : undefined;
  const spotFree = usdc ? Number(usdc.total) - Number(usdc.hold) : 0;
  return Math.max(perpsFree, spotFree);
}

function needsFunds(account: Address, available: number, needed: number): string {
  const have = available > 0 ? `has $${available.toFixed(2)}` : 'is empty';
  return (
    `Hyperliquid says the perps balance of ${account.slice(0, 6)}…${account.slice(-4)} ${have}, and this trade needs $${needed}. ` +
    'Money in Cash or your main wallet does not count until you move it: in Phantom, go to Home, then Perps, then Add under Available funds. ' +
    `Add a little more than $${needed} to cover fees, then come back and place the order.`
  );
}
