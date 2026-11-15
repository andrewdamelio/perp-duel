# Perp Duel

A 1v1 card game on top of Hyperliquid prices, built with React Native (Expo).

Two players are each dealt five cards. A card is a synthetic perp: an asset, a side and a
leverage from 100× to 1000× (`NVDA short 500×`). Each player locks in one card, a clock
runs for 30 seconds, 1 minute or 2 minutes, and whoever's position did better takes the pot. Two cards in every
hand carry a hidden win condition that only their owner can see, such as *Phoenix: get
liquidated, +250 points*.

No positions are opened. Hyperliquid is the price feed, and the stakes sit in a small
escrow contract on HyperEVM until the result is in.

## Run it

```sh
npm install
npx expo start        # scan the QR code with Expo Go, or press w for the browser
```

With no configuration this is the practice table: live Hyperliquid mid prices, a bot
opponent on the device, play-money stakes. Prices come over WebSocket, with HTTPS polling
as a second route. If Hyperliquid cannot be reached either way the app says so and switches
to a simulated tape so a demo never stalls.

```sh
npm test              # engine, referee and escrow tests
npm run typecheck
```

The escrow tests start a local chain with `anvil` (Foundry). Without it on PATH, or in
`ANVIL_BIN`, that suite is skipped.

## How a duel is scored

- 1 point per 1% return on margin. A 1000× long that rises 0.05% scores +50.
- A card is wiped out, for −100 and for good, when the move against it equals its margin:
  0.1% at 1000×, 1% at 100×. The leverage is far beyond what any venue offers (the tiers
  are one line in `src/engine/deck.ts`), so there is no maintenance margin to model.
- In a quiet market a 30 second duel on a stock card can end 0 : 0. Crypto cards and the
  2 minute length move more.
- A card's hidden bonus is added if its condition was met. All eight are decided from the
  price path alone (`src/engine/secrets.ts`).
- Higher total wins the pot. Equal totals return both stakes.

Your opponent sees your card's face once the duel starts, never its seal. On the result
screen their card turns over with the seal open.

## Layout

```
src/engine/     Pure TypeScript game rules: deck, positions, secrets, scoring, match state.
                Shared by the app and the referee, so both always agree.
src/hl/         feed.ts   Hyperliquid allMids, WebSocket then HTTPS polling (native dex + the xyz HIP-3 dex)
                logos.ts  Market icons, loaded at runtime from Hyperliquid's own app
                trade.ts  Real order on the Phantom wallet's account, builder code attached
src/chain/      Demo wallet, Phantom detection and deep link, escrow client, generated ABI
src/game/       Store, plus two drivers: the on-device practice table and the referee client
src/screens/    Lobby, Deal, Duel, Result, TradeSheet
server/         Referee: matchmaking, dealing, scoring, signing and submitting results
contracts/      DuelEscrow.sol, compile and deploy scripts, end-to-end tests
```

## Stakes on-chain

`contracts/DuelEscrow.sol` holds both stakes and pays the winner. The flow:

1. The referee pairs two players and deals. Each player sees only their own hand.
2. Locking a card sends one transaction: the stake plus `keccak256(duelId, player, cardHash, salt)`.
   The duel starts when the second player's transaction lands.
3. The referee samples Hyperliquid mids for the duration and scores both positions.
4. The referee signs `Result(duelId, cardA, cardB, scoreA, scoreB)` (EIP-712) and calls
   `settle` with both reveals. The contract checks the reveals against the commitments,
   checks the signature, and pays out.

The referee cannot change which card anyone picked, cannot send funds anywhere but the two
players, and cannot stall forever: `refund` returns stakes if the opponent never joins
(15 minutes) or no result arrives (1 day after the end). It is trusted for the scores,
because liquidations and most bonuses depend on the price path rather than two endpoints.

To run it on HyperEVM testnet (chain 998):

```sh
npm run contracts:build
DEPLOYER_PRIVATE_KEY=0x… REFEREE_ADDRESS=0x… npm run contracts:deploy
ESCROW_ADDRESS=0x… REFEREE_PRIVATE_KEY=0x… BOT_PRIVATE_KEY=0x… npm run referee
```

Then put `EXPO_PUBLIC_REFEREE_URL=http://<your-computer's-LAN-address>:8787` in `.env` and
restart Expo. The lobby shows a demo wallet address; send it testnet HYPE. The bot's account
needs testnet HYPE too. Deployment measured 1.50M gas on a local chain.

Without `ESCROW_ADDRESS` the referee still runs matchmaking between two phones, with
play-money stakes.

## Real trades, through Phantom

Phantom's perps run on Hyperliquid, on the account of the wallet's Ethereum address. "Open
this trade for real" puts a card onto that same account, so the position shows up in
Phantom's own perps tab.

- **Inside Phantom** (its in-app browser, or a desktop browser with the extension) the web
  build finds `window.phantom.ethereum` and places the order (`src/hl/trade.ts`):
  1. `approveBuilderFee`, signed in Phantom, once, if a builder address is configured.
  2. `approveAgent`, signed in Phantom, once. The key stored on the device becomes a trading
     agent: it can place orders for the account but can never withdraw.
  3. `updateLeverage` to isolated margin, capped at the market's real max leverage (a 1000×
     card becomes, say, a 40× BTC position), signed by the agent.
  4. An IOC order carrying `builder: { b: <your address>, f: <fee in tenths of a bp> }`.
- **Anywhere else** (the phone app, Safari, Chrome) the button opens the hosted web build
  inside Phantom with a `phantom.com/ul/browse/…` link. The card rides along in the address
  as `#trade-BTC-long-1000`.

This is mainnet and real money: $10 of margin per trade. The Phantom wallet needs USDC in
its perps balance already: a page in Phantom's browser cannot draw on Cash, SOL or Solana
USDC the way Phantom's own perps tab can (Home → Perps → Add moves money across). The sheet
checks the balance before asking for any signature. Phantom does not offer perps in every region.

A synthetic duel places no orders, so this button is the one place a builder code applies.
Set `EXPO_PUBLIC_BUILDER_ADDRESS` (see `.env.example`); without it orders go through with no
builder fee. The builder account needs at least 100 USDC of perps account value to earn fees.

## Hosting the web build

The hand-off to Phantom needs the web build at a public https address. The included
workflow (`.github/workflows/pages.yml`) publishes it to GitHub Pages on every push to
`main`: push this folder to a repository, then set Settings → Pages → Source to "GitHub
Actions". Put the resulting address in `EXPO_PUBLIC_WEB_URL` for the phone app.

Netlify works too. Either connect the repository (`netlify.toml` is included), or run
`npm run build:web` and drag the resulting `dist` folder onto Netlify. Dropping the project
folder itself fails, because Netlify then tries to build it without the right settings.

## What has and has not been exercised

Run and passing:

- Engine unit tests, referee tests over its HTTP API, and escrow tests against the compiled
  contract on a local chain: a full duel, forged and early settlements, draws, refunds.
- The app's web build, driven through a full duel in a headless browser, both on the
  practice table and against the referee with stakes going through the escrow on a local chain.
- iOS and Android bundles compile.

Not yet run, because the build machine had no route to Hyperliquid and no phone:

- The live price subscription. It is written against Hyperliquid's documented `allMids`
  format; everything was tested on the simulated feed.
- A real order through Phantom. The flow was run in a browser against a stand-in wallet
  and a stand-in Hyperliquid API, which confirmed the sequence of signatures and requests.
- A deployment to HyperEVM testnet.
- The app on a physical device.

## Known limits

- The demo wallet is a key stored on the device. Swap `src/chain/wallet.ts` for a wallet
  connection before using real funds.
- The referee keeps duels in memory and its API is unauthenticated. A production referee
  would persist state, require a wallet signature per request, and publish a commitment to
  the deal seed.
- On the practice table a duel only advances while the app is open.
- The referee samples prices every half second, so a shorter wick can be missed.
- Card logos are fetched from `app.hyperliquid.xyz/coins/<coin>.svg` and belong to their
  owners. If one fails to load the card shows a lettered medallion.
