import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { SECRETS, type Card, type CardFace, type Market, type Side } from '../engine';
import { logoUrls } from '../hl/logos';
import { color, font } from './theme';

/** How the card's hidden win condition is drawn. */
export type SealMode =
  /** Face the owner sees: a foil seal if the card carries a secret. */
  | 'shown'
  /** An opponent's live card: always a blank seal, so it gives nothing away. */
  | 'unknown'
  | 'none';

interface Props {
  card: Card | CardFace;
  market: Market | undefined;
  width: number;
  seal?: SealMode;
  selected?: boolean;
  style?: ViewStyle;
}

export const CARD_RATIO = 1.4;
const sideInk = (side: Side) => (side === 'long' ? color.longInk : color.shortInk);
const CLASS_LABEL = { crypto: 'Crypto', stock: 'Stock', index: 'Index', commodity: 'Commodity' } as const;

/** The suit: an up triangle for long, a down triangle for short. */
export function Pip({ side, size, tint, opacity = 1 }: { side: Side; size: number; tint?: string; opacity?: number }) {
  const edge = { borderLeftWidth: size / 2, borderRightWidth: size / 2, borderLeftColor: 'transparent', borderRightColor: 'transparent' };
  const c = tint ?? sideInk(side);
  return (
    <View
      style={[
        { width: 0, height: 0, opacity },
        edge,
        side === 'long' ? { borderBottomWidth: size * 0.86, borderBottomColor: c } : { borderTopWidth: size * 0.86, borderTopColor: c },
      ]}
    />
  );
}

/** The rank: leverage, set like a playing-card index with the suit under it. */
function Index({ card, width }: { card: CardFace; width: number }) {
  const digits = String(card.leverage).length;
  const rank = width * (digits >= 4 ? 0.135 : digits === 3 ? 0.16 : 0.2);
  return (
    <View style={styles.index}>
      <Text style={[styles.rank, { fontSize: rank, lineHeight: rank, color: sideInk(card.side) }]}>
        {card.leverage}
        <Text style={{ fontSize: rank * 0.6 }}>×</Text>
      </Text>
      <Pip side={card.side} size={width * 0.085} />
    </View>
  );
}

/**
 * The market's logo in a ringed medallion. The lettered coin underneath is always
 * drawn, and the real icon covers it once (and only if) it loads.
 */
function Medallion({ coin, ticker, side, size }: { coin: string; ticker: string; side: Side; size: number }) {
  const urls = logoUrls(coin);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const letter = ticker.replace(/^k(?=[A-Z])/, '').charAt(0);
  const inner = size * 0.8;
  return (
    <View style={[styles.medallion, { width: size, height: size, borderRadius: size / 2, borderColor: sideInk(side) }]}>
      <View style={[styles.medallionFace, { width: inner, height: inner, borderRadius: inner / 2 }]}>
        {loaded ? null : <Text style={[styles.monogram, { fontSize: inner * 0.62, lineHeight: inner * 0.7, color: sideInk(side) }]}>{letter}</Text>}
        {attempt < urls.length ? (
          <Image
            key={urls[attempt]}
            source={{ uri: urls[attempt] }}
            contentFit="contain"
            accessible={false}
            onLoad={() => setLoaded(true)}
            onError={() => setAttempt((n) => n + 1)}
            style={{ position: 'absolute', width: inner, height: inner, borderRadius: inner / 2, opacity: loaded ? 1 : 0 }}
          />
        ) : null}
      </View>
    </View>
  );
}

export function PerpCard({ card, market, width, seal = 'none', selected, style }: Props) {
  const height = width * CARD_RATIO;
  const ticker = market?.ticker ?? card.coin;
  const secret = 'secret' in card && card.secret ? SECRETS[card.secret] : null;
  const ink = sideInk(card.side);
  const tickerSize = width * (ticker.length <= 4 ? 0.2 : ticker.length === 5 ? 0.17 : 0.145);
  const sealSize = width * 0.2;
  const inset = width * 0.04;
  const small = Math.max(8, width * 0.062);
  const wipe = 100 / card.leverage;
  // Small cards keep only what reads at a glance.
  const roomy = width >= 150;
  const label = `${card.side === 'long' ? 'Long' : 'Short'} ${market?.name ?? ticker} at ${card.leverage} times leverage${
    seal === 'shown' && secret ? `, hidden bonus ${secret.name}` : ''
  }`;

  return (
    <View
      accessible
      accessibilityLabel={label}
      style={[styles.card, { width, height, borderRadius: width * 0.075 }, selected && styles.selected, style]}
    >
      {/* Printed frame, as on a court card. */}
      <View pointerEvents="none" style={[styles.frame, { top: inset, left: inset, right: inset, bottom: inset, borderRadius: width * 0.05, borderColor: ink }]} />
      <View pointerEvents="none" style={[styles.frame, { top: inset * 1.7, left: inset * 1.7, right: inset * 1.7, bottom: inset * 1.7, borderRadius: width * 0.035, borderColor: ink, opacity: 0.18 }]} />

      <View style={[styles.corner, { top: width * 0.085, left: width * 0.085 }]}>
        <Index card={card} width={width} />
      </View>
      <View style={[styles.corner, { bottom: width * 0.085, right: width * 0.085, transform: [{ rotate: '180deg' }] }]}>
        <Index card={card} width={width} />
      </View>
      {roomy ? <Text style={[styles.tag, { top: width * 0.095, right: width * 0.1, fontSize: small }]}>{market ? CLASS_LABEL[market.cls] : ''}</Text> : null}

      <View style={styles.centre}>
        <View style={styles.watermark}>
          <Pip side={card.side} size={width * 0.8} opacity={0.07} />
        </View>
        <Medallion coin={card.coin} ticker={ticker} side={card.side} size={width * 0.4} />
        <Text style={[styles.ticker, { fontSize: tickerSize, lineHeight: tickerSize * 1.05, marginTop: width * 0.025 }]} numberOfLines={1}>
          {ticker}
        </Text>
        <Text style={[styles.name, { fontSize: small }]} numberOfLines={1}>
          {market?.name ?? ''}
        </Text>
        <View style={[styles.plate, { backgroundColor: ink, borderRadius: width * 0.03, paddingHorizontal: width * 0.05, marginTop: width * 0.025 }]}>
          <Text style={[styles.plateText, { fontSize: Math.max(9, width * 0.075) }]}>{card.side === 'long' ? 'Long' : 'Short'}</Text>
        </View>
        {roomy ? (
          <Text style={[styles.name, { fontSize: small, marginTop: width * 0.015 }]}>
            wiped at {card.side === 'long' ? '−' : '+'}
            {wipe < 1 ? wipe.toFixed(2).replace(/0$/, '') : wipe}%
          </Text>
        ) : null}
      </View>

      {seal === 'shown' && secret ? (
        <View style={[styles.seal, styles.sealFoil, { width: sealSize, height: sealSize, borderRadius: sealSize / 2, left: width * 0.075, bottom: width * 0.075 }]}>
          <View style={{ width: sealSize * 0.34, height: sealSize * 0.34, backgroundColor: color.foilDeep, transform: [{ rotate: '45deg' }] }} />
        </View>
      ) : null}
      {seal === 'unknown' ? (
        <View style={[styles.seal, styles.sealBlank, { width: sealSize, height: sealSize, borderRadius: sealSize / 2, left: width * 0.075, bottom: width * 0.075 }]}>
          <Text style={[styles.sealMark, { fontSize: sealSize * 0.6, lineHeight: sealSize * 0.72 }]}>?</Text>
        </View>
      ) : null}
    </View>
  );
}

/** A face-down card. */
export function CardBack({ width, style }: { width: number; style?: ViewStyle }) {
  const height = width * CARD_RATIO;
  return (
    <View accessible accessibilityLabel="Face-down card" style={[styles.back, { width, height, borderRadius: width * 0.075 }, style]}>
      <View style={[styles.backInner, { borderRadius: width * 0.045, margin: width * 0.07 }]}>
        <Pip side="long" size={width * 0.22} tint={color.lilac} />
        <View style={{ height: width * 0.05 }} />
        <Pip side="short" size={width * 0.22} tint={color.lilac} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.stock,
    borderWidth: 1,
    borderColor: color.stockEdge,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  selected: { borderWidth: 3, borderColor: color.lilac },
  frame: { position: 'absolute', borderWidth: 1, opacity: 0.45 },
  corner: { position: 'absolute' },
  index: { alignItems: 'center' },
  rank: { fontFamily: font.display },
  tag: { position: 'absolute', fontFamily: font.semi, color: color.inkSoft },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  watermark: { position: 'absolute' },
  medallion: { borderWidth: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: color.stock },
  medallionFace: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFDF8', overflow: 'hidden' },
  monogram: { fontFamily: font.display },
  ticker: { fontFamily: font.display, color: color.ink },
  name: { fontFamily: font.medium, color: color.inkSoft },
  plate: { paddingVertical: 1 },
  plateText: { fontFamily: font.semi, color: '#FFFDF8' },
  seal: { position: 'absolute', alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  sealFoil: { backgroundColor: color.foil, borderColor: color.foilDeep },
  sealBlank: { backgroundColor: color.stockEdge, borderColor: color.inkSoft },
  sealMark: { fontFamily: font.display, color: color.inkSoft },
  back: {
    backgroundColor: color.raised,
    borderWidth: 1,
    borderColor: color.line,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  backInner: { flex: 1, borderWidth: 1.5, borderColor: color.lilac, alignItems: 'center', justifyContent: 'center', opacity: 0.8 },
});
