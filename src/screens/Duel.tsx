import { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_MARKETS, SECRETS, marketByCoin, type CardFace, type MatchView, type PositionState } from '../engine';
import { useGame } from '../game/store';
import { fmtClock, fmtHype, fmtPoints, fmtPrice } from '../ui/format';
import { Button, P, useNow } from '../ui/kit';
import { PerpCard } from '../ui/PerpCard';
import { color, font, size, space } from '../ui/theme';
import { TradeSheet } from './TradeSheet';

const pointsOf = (pos: PositionState | null) => Math.max(-100, pos?.roe ?? 0);
const tint = (n: number) => (n > 0 ? color.long : n < 0 ? color.short : color.text);

/** How far the price has travelled from entry towards liquidation, 0 to 1. */
function liqProgress(pos: PositionState, face: CardFace): number {
  if (pos.liquidated) return 1;
  const adverse = (face.side === 'long' ? -1 : 1) * (pos.last - pos.entry);
  return Math.max(0, Math.min(1, adverse / Math.abs(pos.entry - pos.liq)));
}

function Seat({ who, face, pos, cardWidth, seal, children }: {
  who: string;
  face: CardFace;
  pos: PositionState;
  cardWidth: number;
  seal: 'shown' | 'unknown';
  children?: React.ReactNode;
}) {
  const g = useGame();
  const market = marketByCoin(g.markets, face.coin) ?? marketByCoin(DEFAULT_MARKETS, face.coin);
  const points = pointsOf(pos);
  const progress = liqProgress(pos, face);
  return (
    <View style={styles.seat}>
      <PerpCard card={face} market={market} width={cardWidth} seal={seal} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.who}>{who}</Text>
        <Text
          style={[styles.points, { color: tint(points) }]}
          accessibilityLabel={`${who}: ${fmtPoints(points)} points`}
        >
          {fmtPoints(points)}
        </Text>
        {pos.liquidated ? (
          <Text style={[styles.stat, { color: color.short, fontFamily: font.semi }]}>Liquidated at {fmtPrice(pos.liq)}</Text>
        ) : (
          <>
            <Text style={styles.stat}>
              {fmtPrice(pos.last)}, in at {fmtPrice(pos.entry)}
            </Text>
            <Text style={styles.stat}>Wiped out at {fmtPrice(pos.liq)}</Text>
            <View style={styles.meter} accessibilityLabel={`${Math.round(progress * 100)}% of the way to liquidation`}>
              <View style={[styles.meterFill, { width: `${progress * 100}%`, backgroundColor: progress > 0.75 ? color.short : color.dim }]} />
            </View>
          </>
        )}
        {children}
      </View>
    </View>
  );
}

export function Duel({ view }: { view: MatchView }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const g = useGame();
  const now = useNow(100);
  const [trading, setTrading] = useState(false);
  const you = view.you;
  const opp = view.opp;
  if (!you.card || !you.pos || !opp.face || !opp.pos || !view.endAt) return null;

  const mine = pointsOf(you.pos);
  const theirs = pointsOf(opp.pos);
  // The rope: 50/50 when level, pulled towards whoever leads. Hidden bonuses are not on it.
  const share = 0.5 + 0.42 * Math.tanh((mine - theirs) / 80);
  const secret = you.card.secret ? SECRETS[you.card.secret] : null;
  const cardWidth = Math.min(124, (Math.min(width, 480) - 2 * space.l) * 0.33);

  return (
    <View style={[styles.page, { paddingTop: insets.top + space.l, paddingBottom: insets.bottom + space.l }]}>
      <Seat who={opp.name} face={opp.face} pos={opp.pos} cardWidth={cardWidth} seal="unknown">
        <Text style={styles.stat}>Their seal stays shut until the end.</Text>
      </Seat>

      <View style={styles.middle}>
        <Text style={styles.clock} accessibilityLabel={`${fmtClock(view.endAt - now)} left`}>
          {fmtClock(view.endAt - now)}
        </Text>
        <View style={styles.rope} accessibilityLabel={mine === theirs ? 'Level' : mine > theirs ? 'You lead' : `${opp.name} leads`}>
          <View style={[styles.ropeYou, { flex: share }]} />
          <View style={{ flex: 1 - share }} />
        </View>
        <View style={styles.ropeEnds}>
          <Text style={styles.ropeLabel}>You {fmtPoints(mine)}</Text>
          <Text style={styles.ropeLabel}>
            {opp.name} {fmtPoints(theirs)}
          </Text>
        </View>
        <P dim style={styles.pot}>
          {fmtHype(BigInt(view.stake) * 2n)} in the pot{view.onchain ? ', held in escrow' : ', play money'}.{' '}
          {g.feedStatus === 'live' ? 'Live Hyperliquid prices.' : 'Simulated prices.'}
        </P>
      </View>

      <Seat who="You" face={you.card} pos={you.pos} cardWidth={cardWidth} seal="shown">
        {secret ? (
          <Text style={[styles.stat, { color: color.foil }]}>
            {secret.name} +{secret.points}: {secret.rule}
          </Text>
        ) : null}
      </Seat>

      <View style={{ flex: 1 }} />
      <Button label="Open this trade for real" kind="quiet" onPress={() => setTrading(true)} />
      {trading ? <TradeSheet card={you.card} onClose={() => setTrading(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: space.l, width: '100%', maxWidth: 480, alignSelf: 'center' },
  seat: { flexDirection: 'row', gap: space.l, alignItems: 'center' },
  who: { fontFamily: font.semi, fontSize: size.body, color: color.dim },
  points: { fontFamily: font.display, fontSize: 46, lineHeight: 48 },
  stat: { fontFamily: font.body, fontSize: size.small, lineHeight: 19, color: color.dim },
  meter: { height: 4, borderRadius: 2, backgroundColor: color.line, marginTop: space.xs, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  middle: { marginVertical: space.xl },
  clock: { fontFamily: font.display, fontSize: size.huge, lineHeight: size.huge, color: color.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  rope: { flexDirection: 'row', height: 10, borderRadius: 5, backgroundColor: color.line, overflow: 'hidden', marginTop: space.m },
  ropeYou: { backgroundColor: color.lilac, borderRadius: 5 },
  ropeEnds: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  ropeLabel: { fontFamily: font.medium, fontSize: size.small, color: color.text },
  pot: { fontSize: size.small, lineHeight: 19, textAlign: 'center', marginTop: space.s },
});
