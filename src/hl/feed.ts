import { dexesOf, type Market, type Mids } from '../engine';

export type FeedStatus = 'connecting' | 'live' | 'sim';

/** A source of mid prices. The app and the referee use the same implementations. */
export interface PriceFeed {
  start(): void;
  stop(): void;
  status(): FeedStatus;
  mids(): Mids;
  /** Markets that currently have a price, with max leverage as Hyperliquid reports it. */
  markets(): Market[];
  onUpdate(listener: () => void): () => void;
}

const MAINNET_WS = 'wss://api.hyperliquid.xyz/ws';
const MAINNET_INFO = 'https://api.hyperliquid.xyz/info';

class Emitter {
  private listeners = new Set<() => void>();
  onUpdate = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit() {
    for (const l of this.listeners) l();
  }
}

/** Prices set by hand. Used by tests and by anything that wants full control of the tape. */
export function createManualFeed(markets: Market[], initial?: Mids) {
  const emitter = new Emitter();
  let mids: Mids = initial ?? Object.fromEntries(markets.map((m) => [m.coin, m.simPrice]));
  return {
    start() {},
    stop() {},
    status: () => 'sim' as FeedStatus,
    mids: () => mids,
    markets: () => markets.filter((m) => (mids[m.coin] ?? 0) > 0),
    onUpdate: emitter.onUpdate,
    set(next: Mids) {
      mids = { ...mids, ...next };
      emitter.emit();
    },
  } satisfies PriceFeed & { set(next: Mids): void };
}

export interface SimFeedOptions {
  markets: Market[];
  intervalMs?: number;
  /** How much market time passes per real second. 1 = real time. */
  speed?: number;
  random?: () => number;
}

/** A random walk per market. Clearly labelled as simulated wherever it is shown. */
export function createSimFeed({ markets, intervalMs = 1000, speed = 1, random = Math.random }: SimFeedOptions): PriceFeed {
  const emitter = new Emitter();
  const mids: Mids = Object.fromEntries(markets.map((m) => [m.coin, m.simPrice]));
  let timer: ReturnType<typeof setInterval> | null = null;
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const step = () => {
    const dtYears = ((intervalMs / 1000) * speed) / (365 * 24 * 3600);
    for (const m of markets) mids[m.coin] = (mids[m.coin] as number) * Math.exp(m.simVol * Math.sqrt(dtYears) * gaussian());
    emitter.emit();
  };
  return {
    start() {
      if (!timer) timer = setInterval(step, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status: () => 'sim',
    mids: () => ({ ...mids }),
    markets: () => markets,
    onUpdate: emitter.onUpdate,
  };
}

export interface LiveFeedOptions {
  markets: Market[];
  /** If no price arrives within this window, fall back to the simulated feed. */
  fallbackAfterMs?: number;
  simSpeed?: number;
  wsUrl?: string;
  infoUrl?: string;
}

type MetaUniverse = { universe: { name: string; maxLeverage: number; isDelisted?: boolean }[] };

/**
 * Hyperliquid mainnet mid prices. Public data, no key needed.
 *
 * Route 1: WebSocket, one `allMids` subscription per perp dex: the native dex for crypto,
 *          plus each HIP-3 builder dex (e.g. "xyz") for stock perps, whose coins arrive
 *          prefixed, like "xyz:NVDA".
 * Route 2: if the socket is quiet, the same data polled over HTTPS once a second.
 * Route 3: if neither answers, a simulated tape, clearly labelled.
 */
export function createLiveFeed(options: LiveFeedOptions): PriceFeed {
  const { fallbackAfterMs = 8000, wsUrl = MAINNET_WS, infoUrl = MAINNET_INFO } = options;
  const emitter = new Emitter();
  const dexes = dexesOf(options.markets);
  const wanted = new Set(options.markets.map((m) => m.coin));
  const maxLeverage = new Map(options.markets.map((m) => [m.coin, m.maxLeverage]));
  const delisted = new Set<string>();
  const mids: Mids = {};
  let status: FeedStatus = 'connecting';
  let ws: WebSocket | null = null;
  let sim: PriceFeed | null = null;
  let stopped = true;
  let retry = 0;
  let wsFailed = false;
  let httpFailed = false;
  let lastSocketData = 0;
  let polling = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let ping: ReturnType<typeof setInterval> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const fallBack = () => {
    if (status === 'live' || sim || stopped) return;
    status = 'sim';
    ws?.close();
    if (poll) clearInterval(poll);
    sim = createSimFeed({ markets: options.markets, speed: options.simSpeed ?? 1, intervalMs: 500 });
    sim.onUpdate(() => emitter.emit());
    sim.start();
    emitter.emit();
  };
  // Simulate only once both real routes have refused, or the grace period ran out.
  const giveUpIfBothFailed = () => {
    if (wsFailed && httpFailed) fallBack();
  };

  const apply = (incoming: Record<string, string>) => {
    let changed = false;
    for (const [coin, px] of Object.entries(incoming)) {
      if (!wanted.has(coin)) continue;
      const price = Number(px);
      if (price > 0 && mids[coin] !== price) {
        mids[coin] = price;
        changed = true;
      }
    }
    if (changed) {
      status = 'live';
      emitter.emit();
    }
  };

  const post = async <T>(body: unknown): Promise<T> => {
    const res = await fetch(infoUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
    return (await res.json()) as T;
  };

  const loadMeta = async (dex: string) => {
    try {
      const meta = await post<MetaUniverse>({ type: 'meta', dex });
      for (const asset of meta.universe ?? []) {
        if (!wanted.has(asset.name)) continue;
        maxLeverage.set(asset.name, asset.maxLeverage);
        if (asset.isDelisted) delisted.add(asset.name);
      }
    } catch {
      // Defaults from markets.ts stay in place.
    }
  };

  const pollOnce = async () => {
    if (polling || stopped || sim || Date.now() - lastSocketData < 3000) return;
    polling = true;
    try {
      const results = await Promise.all(dexes.map((dex) => post<Record<string, string>>({ type: 'allMids', dex })));
      results.forEach(apply);
      httpFailed = false;
    } catch {
      httpFailed = true;
      giveUpIfBothFailed();
    } finally {
      polling = false;
    }
  };

  const connect = () => {
    if (stopped || sim) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      // Some browsers throw here, instead of firing an error event, when a page's
      // security policy forbids the connection. There is no point retrying.
      wsFailed = true;
      giveUpIfBothFailed();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      for (const dex of dexes) {
        const subscription = dex ? { type: 'allMids', dex } : { type: 'allMids' };
        socket.send(JSON.stringify({ method: 'subscribe', subscription }));
      }
      ping = setInterval(() => socket.readyState === 1 && socket.send(JSON.stringify({ method: 'ping' })), 30_000);
    };
    socket.onmessage = (event) => {
      let msg: { channel?: string; data?: { mids?: Record<string, string> } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.channel !== 'allMids' || !msg.data?.mids) return;
      lastSocketData = Date.now();
      wsFailed = false;
      retry = 0;
      apply(msg.data.mids);
    };
    socket.onclose = () => {
      if (ping) clearInterval(ping);
      if (stopped || sim) return;
      if (lastSocketData === 0 && retry >= 1) {
        wsFailed = true;
        giveUpIfBothFailed();
      }
      // Keep the last prices and reconnect with backoff; polling covers the gap.
      timers.push(setTimeout(connect, Math.min(15_000, 500 * 2 ** retry++)));
    };
    socket.onerror = () => socket.close();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      for (const dex of dexes) void loadMeta(dex);
      timers.push(setTimeout(fallBack, fallbackAfterMs));
      poll = setInterval(() => void pollOnce(), 1000);
      void pollOnce();
      connect();
    },
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      timers = [];
      if (ping) clearInterval(ping);
      if (poll) clearInterval(poll);
      ws?.close();
      sim?.stop();
    },
    status: () => status,
    mids: () => (sim ? sim.mids() : { ...mids }),
    markets: () =>
      sim
        ? sim.markets()
        : options.markets
            .filter((m) => (mids[m.coin] ?? 0) > 0 && !delisted.has(m.coin))
            .map((m) => ({ ...m, maxLeverage: maxLeverage.get(m.coin) ?? m.maxLeverage })),
    onUpdate: emitter.onUpdate,
  };
}
