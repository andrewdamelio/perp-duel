import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { explorerTx } from '../chain/escrow';
import { DEFAULT_MARKETS, SECRETS, marketByCoin, type Card, type MatchView, type PositionState, type ScoreLine } from '../engine';
import { useGame } from '../game/store';
import { fmtHype, fmtPoints, shortAddress } from '../ui/format';
import { Button, P, useReducedMotion } from '../ui/kit';
import { PerpCard } from '../ui/PerpCard';
import { color, font, nativeDriver, size, space } from '../ui/theme';
import { TradeSheet } from './TradeSheet';

function Column({ who, card, pos, line, width, sealOpen }: {
  who: string;
  card: Card;
  pos: PositionState | null;
  line: ScoreLine;
  width: number;
  sealOpen: boolean;
}) {
  const g = useGame();
  const market = marketByCoin(g.markets, card.coin) ?? marketByCoin(DEFAULT_MARKETS, card.coin);
  const secret = card.secret ? SECRETS[card.secret] : null;
  const row = (label: string, value: string, strong = false) => (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && { color: color.text, fontFamily: font.semi }]}>{label}</Text>
      <Text style={[styles.rowValue, strong && { fontSize: size.title }]}>{value}</Text>
    </View>
  );
  return (
    <View style={{ width, gap: space.s }}>
      <Text style={styles.who}>{who}</Text>
      <PerpCard card={card} market={market} width={width} seal={sealOpen ? 'shown' : 'unknown'} />
      <View style={{ opacity: sealOpen ? 1 : 0 }}>
        {row(pos?.liquidated ? 'Liquidated' : 'Return', fmtPoints(line.base))}
        {row(secret ? secret.name : 'No hidden bonus', secret ? (line.secretHit ? `+${secret.points}` : 'missed') : '0')}
        {row('Total', fmtPoints(line.total), true)}
        {secret ? <P dim style={styles.rule}>{secret.rule}</P> : null}
      </View>
    </View>
  );
}

export function Result({ view }: { view: MatchView }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const g = useGame();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [trading, setTrading] = useState(false);
  const flip = useRef(new Animated.Value(1)).current;

  // The reveal: the opponent's card turns over and comes back with its seal broken.
  useEffect(() => {
    if (reduced) {
      setOpen(true);
      return;
    }
    const half = { duration: 260, useNativeDriver: nativeDriver, easing: Easing.inOut(Easing.quad) };
    Animated.sequence([Animated.delay(500), Animated.timing(flip, { toValue: 0, ...half })]).start(() => {
      setOpen(true);
      if (Platform.OS !== 'web') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Animated.timing(flip, { toValue: 1, ...half }).start();
    });
  }, [flip, reduced]);

  const result = view.result;
  if (!result || !view.you.card || !view.opp.card) return null;
  const pot = BigInt(view.stake) * 2n;
  const headline =
    result.outcome === 'win' ? 'You take the pot' : result.outcome === 'loss' ? `${view.opp.name} takes the pot` : 'Dead heat';
  const money = view.onchain ? '' : ' of play money';
  const sub =
    result.outcome === 'draw'
      ? `Both stakes${money} go back.`
      : result.outcome === 'win'
        ? `${fmtHype(pot)}${money}, ${fmtPoints(result.you.total)} to ${fmtPoints(result.opp.total)}.`
        : `${fmtHype(pot)}${money}, ${fmtPoints(result.opp.total)} to ${fmtPoints(result.you.total)}.`;
  const chain = g.referee?.chain ?? null;
  const txUrl = chain && view.settleTx ? explorerTx(chain, view.settleTx) : null;
  const colWidth = Math.min(176, (Math.min(width, 480) - 2 * space.l - space.l) / 2);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.page, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}
    >
      <Text accessibilityRole="header" style={[styles.headline, { opacity: open ? 1 : 0 }]}>
        {headline}
      </Text>
      <P style={{ fontSize: size.lead, marginTop: space.s, opacity: open ? 1 : 0 }}>{sub}</P>

      <View style={styles.columns}>
        <Column who="You" card={view.you.card} pos={view.you.pos} line={result.you} width={colWidth} sealOpen />
        <Animated.View style={{ transform: [{ scaleX: flip }] }}>
          <Column who={view.opp.name} card={view.opp.card} pos={view.opp.pos} line={result.opp} width={colWidth} sealOpen={open} />
        </Animated.View>
      </View>

      {view.onchain ? (
        <View style={styles.chain}>
          {view.settleTx ? (
            <>
              <P>The escrow checked both cards against the commitments made before the duel and paid out.</P>
              <Pressable accessibilityRole="link" disabled={!txUrl} onPress={() => txUrl && Linking.openURL(txUrl)}>
                <Text selectable style={styles.link}>
                  {txUrl ? `View settlement ${shortAddress(view.settleTx)}` : `Settlement ${view.settleTx}`}
                </Text>
              </Pressable>
            </>
          ) : (
            <P dim>{view.note ?? 'The referee is submitting the result to the escrow.'}</P>
          )}
        </View>
      ) : null}

      <View style={{ gap: space.m, marginTop: space.xl }}>
        <Button label="Play again" onPress={g.leave} />
        <Button label="Open my trade for real" kind="quiet" onPress={() => setTrading(true)} />
      </View>
      {trading ? <TradeSheet card={view.you.card} onClose={() => setTrading(false)} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: space.l, width: '100%', maxWidth: 480, alignSelf: 'center' },
  headline: { fontFamily: font.display, fontSize: 48, lineHeight: 50, color: color.text },
  columns: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xl },
  who: { fontFamily: font.semi, fontSize: size.body, color: color.dim },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 3 },
  rowLabel: { fontFamily: font.body, fontSize: size.small, color: color.dim, flexShrink: 1 },
  rowValue: { fontFamily: font.displayBold, fontSize: size.lead, color: color.text, fontVariant: ['tabular-nums'] },
  rule: { fontSize: size.small, lineHeight: 18, marginTop: 2 },
  chain: { marginTop: space.xl, padding: space.m, borderRadius: 12, backgroundColor: color.raised, gap: space.s },
  link: { fontFamily: font.semi, fontSize: size.body, color: color.lilac },
});
