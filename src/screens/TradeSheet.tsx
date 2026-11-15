import { useState } from 'react';
import { Linking, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { phantomBrowseLink, phantomEthereum, tradeHash } from '../chain/phantom';
import { config } from '../config';
import { DEFAULT_MARKETS, marketByCoin, type Card } from '../engine';
import { useGame } from '../game/store';
import { openRealTrade } from '../hl/trade';
import { shortAddress } from '../ui/format';
import { Button, Notice, P } from '../ui/kit';
import { color, font, size, space } from '../ui/theme';

/** The public web address a card can be handed to Phantom through, if there is one. */
function shareableUrl(sandboxed: boolean): string | null {
  if (config.webUrl) return config.webUrl;
  if (Platform.OS !== 'web' || sandboxed) return null;
  const { protocol, origin, pathname } = globalThis.location;
  return protocol === 'https:' ? origin + pathname : null;
}

/**
 * The bridge from the game to a real position. Inside Phantom, the card becomes a real
 * Hyperliquid order on the user's Phantom perps account. Anywhere else, the sheet hands
 * the card over to Phantom's in-app browser.
 */
export function TradeSheet({ card, onClose }: { card: Card; onClose: () => void }) {
  const g = useGame();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const market = marketByCoin(g.markets, card.coin) ?? marketByCoin(DEFAULT_MARKETS, card.coin);
  const network = config.hlTestnet ? 'testnet' : 'mainnet';
  // Cards run to 1000x; a real order is capped at what Hyperliquid lists for the market.
  const leverage = Math.min(card.leverage, market?.maxLeverage ?? 1);
  const feePercent = (config.builderFee / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const phantom = phantomEthereum();
  // A page that cannot reach Hyperliquid cannot reach Phantom either: it is a sandboxed preview.
  const url = shareableUrl(g.feedStatus === 'sim');
  const what = `${card.side === 'long' ? 'Long' : 'Short'} ${market?.name ?? card.coin} at ${leverage}× with $${config.realTradeMarginUsd} of margin`;

  const place = async () => {
    const key = g.key();
    if (!key || !phantom) return;
    setError(null);
    setBusy('Connecting to Phantom');
    try {
      const fill = await openRealTrade({
        card,
        leverage,
        marginUsd: config.realTradeMarginUsd,
        key,
        phantom,
        testnet: config.hlTestnet,
        builder: config.builder,
        builderFee: config.builderFee,
        onStep: setBusy,
      });
      setDone(`Filled ${fill.filledSize} ${market?.ticker ?? card.coin} at ${fill.averagePrice} on ${shortAddress(fill.account)}. It is in your Phantom perps tab.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openInPhantom = () => {
    if (url) void Linking.openURL(phantomBrowseLink(url + tradeHash(card)));
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.title}>
            Open this trade for real
          </Text>
          <P>
            {what}, as a market order on Hyperliquid {network}
            {config.hlTestnet ? '' : ', with real funds'}.
            {leverage < card.leverage ? ` Your card says ${card.leverage}×, but ${leverage}× is the most Hyperliquid offers on this market.` : ''}
          </P>

          {phantom ? (
            <P dim>
              The position opens on the Hyperliquid account of your Phantom wallet, the same one Phantom's perps tab uses. The first time, Phantom asks
              you to approve this device as a trading agent{config.builder ? ' and to approve the builder fee' : ''}.
            </P>
          ) : url ? (
            <P dim>Phantom opens this card in its own browser, where you confirm the order with your wallet.</P>
          ) : (
            <Notice
              tone="info"
              text={
                Platform.OS === 'web'
                  ? 'This preview is sandboxed, so it cannot reach Phantom or Hyperliquid. Real trades work from the hosted or installed app.'
                  : 'Set EXPO_PUBLIC_WEB_URL to where the web build is hosted, so this card can be opened inside Phantom.'
              }
            />
          )}
          {phantom || url ? (
            <P dim>
              {config.builder
                ? `The order carries this app's builder code: ${feePercent}% of the fill goes to ${shortAddress(config.builder)}.`
                : 'No builder address is configured, so the order carries no builder fee.'}
            </P>
          ) : null}

          {error ? <Notice text={error} onDismiss={() => setError(null)} /> : null}
          {done ? <Notice tone="info" text={done} /> : null}
          {busy ? <P style={{ textAlign: 'center' }}>{busy}</P> : null}
          <View style={{ gap: space.s, marginTop: space.s }}>
            {done ? null : phantom ? (
              <Button label="Place order with Phantom" onPress={place} busy={Boolean(busy)} />
            ) : url ? (
              <Button label="Open in Phantom" onPress={openInPhantom} />
            ) : null}
            <Button label={done ? 'Close' : 'Cancel'} kind="quiet" onPress={onClose} disabled={Boolean(busy)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10, 7, 22, 0.7)' },
  sheet: {
    backgroundColor: color.table,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.xl,
    paddingBottom: space.xxl,
    gap: space.m,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  title: { fontFamily: font.display, fontSize: size.big, lineHeight: size.big + 2, color: color.text },
});
