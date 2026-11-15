import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_MARKETS, SECRETS, marketByCoin, type CardFace, type MatchView, type PositionState } from '../engine';
import { useGame } from '../game/store';
import { fmtClock, fmtHype, fmtPoints, fmtPrice } from '../ui/format';
import { Button, useNow, useReducedMotion } from '../ui/kit';
import { PerpCard } from '../ui/PerpCard';
import { color, font, nativeDriver, size, space } from '../ui/theme';
import { TradeSheet } from './TradeSheet';

interface Sample {
  /** Fraction of the duel elapsed, 0 to 1. */
  t: number;
  you: number;
  opp: number;
}

const pointsOf = (pos: PositionState | null) => Math.max(-100, pos?.roe ?? 0);
const tint = (n: number) => (n > 0 ? color.long : n < 0 ? color.short : color.text);
const OPP_LINE = color.stock;
const buzz = (style: Haptics.ImpactFeedbackStyle) => {
  if (Platform.OS !== 'web') void Haptics.impactAsync(style).catch(() => {});
};

/** How far the price has travelled from entry towards liquidation, 0 to 1. */
function liqProgress(pos: PositionState, face: CardFace): number {
  if (pos.liquidated) return 1;
  const adverse = (face.side === 'long' ? -1 : 1) * (pos.last - pos.entry);
  return Math.max(0, Math.min(1, adverse / Math.abs(pos.entry - pos.liq)));
}

/** One word for how a seat is doing. */
function mood(points: number, progress: number, liquidated: boolean): { word: string; tone: string } {
  if (liquidated) return { word: 'Rekt', tone: color.short };
  if (progress >= 0.75) return { word: 'On the brink', tone: color.short };
  if (points >= 100) return { word: 'Sending it', tone: color.long };
  if (points >= 25) return { word: 'Printing', tone: color.long };
  if (points >= 5) return { word: 'Up', tone: color.long };
  if (points > -5) return { word: 'Flat', tone: color.dim };
  if (points > -40) return { word: 'Bleeding', tone: color.short };
  return { word: 'Down bad', tone: color.short };
}

/** Both scores over the duel so far, drawn as two lines racing left to right. */
function Tape({ samples, width, height, elapsed }: { samples: Sample[]; width: number; height: number; elapsed: number }) {
  const values = samples.flatMap((s) => [s.you, s.opp]);
  const top = Math.max(20, ...values) * 1.15;
  const bottom = Math.min(-20, ...values) * 1.15;
  const x = (t: number) => Math.min(1, t) * (width - 10);
  const y = (v: number) => ((top - v) / (top - bottom)) * height;
  const line = (key: 'you' | 'opp', stroke: string, thick: number) =>
    samples.slice(1).map((s, i) => {
      const p = samples[i]!;
      const [x1, y1, x2, y2] = [x(p.t), y(p[key]), x(s.t), y(s[key])];
      const length = Math.hypot(x2 - x1, y2 - y1) + 0.6;
      return (
        <View
          key={`${key}${i}`}
          style={{
            position: 'absolute',
            left: (x1 + x2) / 2 - length / 2,
            top: (y1 + y2) / 2 - thick / 2,
            width: length,
            height: thick,
            borderRadius: thick / 2,
            backgroundColor: stroke,
            transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
          }}
        />
      );
    });
  const last = samples[samples.length - 1];
  const dot = (v: number, fill: string, r: number) => (
    <View style={{ position: 'absolute', left: x(last?.t ?? 0) - r, top: y(v) - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: fill }} />
  );
  return (
    <View style={[styles.tape, { width, height }]} accessible accessibilityLabel="Both scores over the duel so far">
      {/* Time still to run. */}
      <View style={{ position: 'absolute', left: x(elapsed), right: 0, top: 0, bottom: 0, backgroundColor: color.table, opacity: 0.55 }} />
      <View style={[styles.rule, { top: y(0) }]} />
      {bottom <= -100 ? <View style={[styles.rule, { top: y(-100), backgroundColor: color.short, opacity: 0.6 }]} /> : null}
      <Text style={[styles.axis, { top: y(0) - 15 }]}>0</Text>
      {bottom <= -100 ? <Text style={[styles.axis, { top: y(-100) - 15, color: color.short }]}>wiped</Text> : null}
      {line('opp', OPP_LINE, 2)}
      {line('you', color.lilac, 3)}
      {last ? dot(last.opp, OPP_LINE, 4) : null}
      {last ? dot(last.you, color.lilac, 6) : null}
    </View>
  );
}

function Seat({ who, face, pos, cardWidth, seal, lineColor, reduced, children }: {
  who: string;
  face: CardFace;
  pos: PositionState;
  cardWidth: number;
  seal: 'shown' | 'unknown';
  lineColor: string;
  reduced: boolean;
  children?: React.ReactNode;
}) {
  const g = useGame();
  const market = marketByCoin(g.markets, face.coin) ?? marketByCoin(DEFAULT_MARKETS, face.coin);
  const points = pointsOf(pos);
  const progress = liqProgress(pos, face);
  const state = mood(points, progress, pos.liquidated);
  const danger = progress >= 0.75 && !pos.liquidated;
  const away = Math.abs(pos.last - pos.liq) / pos.last;

  // A card close to its wipe-out price trembles.
  const shake = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!danger || reduced) {
      shake.setValue(0);
      return;
    }
    const step = (toValue: number) => Animated.timing(shake, { toValue, duration: 70, useNativeDriver: nativeDriver, easing: Easing.linear });
    const loop = Animated.loop(Animated.sequence([step(1), step(-1), step(0), Animated.delay(260)]));
    loop.start();
    return () => loop.stop();
  }, [danger, reduced, shake]);

  // The score pops when it moves a meaningful amount.
  const pop = useRef(new Animated.Value(1)).current;
  const bucket = Math.round(points / 10);
  useEffect(() => {
    if (reduced) return;
    Animated.sequence([
      Animated.timing(pop, { toValue: 1.1, duration: 90, useNativeDriver: nativeDriver }),
      Animated.spring(pop, { toValue: 1, useNativeDriver: nativeDriver, friction: 5 }),
    ]).start();
  }, [bucket, pop, reduced]);

  return (
    <View style={styles.seat}>
      <Animated.View style={{ opacity: pos.liquidated ? 0.4 : 1, transform: [{ rotate: shake.interpolate({ inputRange: [-1, 1], outputRange: ['-2.5deg', '2.5deg'] }) }] }}>
        <PerpCard card={face} market={market} width={cardWidth} seal={seal} />
      </Animated.View>
      {pos.liquidated ? (
        <View style={[styles.rekt, { left: cardWidth * 0.08, top: cardWidth * 0.5 }]}>
          <Text style={styles.rektText}>Rekt</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <View style={[styles.swatch, { backgroundColor: lineColor }]} />
          <Text style={styles.who}>{who}</Text>
          <View style={[styles.chip, { borderColor: state.tone }]}>
            <Text style={[styles.chipText, { color: state.tone }]}>{state.word}</Text>
          </View>
        </View>
        <Animated.Text
          style={[styles.points, { color: tint(points), transform: [{ scale: pop }] }]}
          accessibilityLabel={`${who}: ${fmtPoints(points)} points`}
        >
          {fmtPoints(points)}
        </Animated.Text>
        {pos.liquidated ? (
          <Text style={[styles.stat, { color: color.short }]}>Wiped out at {fmtPrice(pos.liq)}</Text>
        ) : (
          <>
            <Text style={styles.stat}>
              {fmtPrice(pos.last)}
              <Text style={{ color: color.line }}>  ·  </Text>in at {fmtPrice(pos.entry)}
            </Text>
            <View style={styles.meter} accessibilityLabel={`${Math.round(progress * 100)}% of the way to wipe-out`}>
              {Array.from({ length: 12 }, (_, i) => {
                const on = progress * 12 > i;
                return <View key={i} style={[styles.tick, on && { backgroundColor: i >= 9 ? color.short : i >= 6 ? color.foil : color.dim }]} />;
              })}
            </View>
            <Text style={[styles.stat, danger && { color: color.short, fontFamily: font.semi }]}>
              {(away * 100).toFixed(away < 0.001 ? 3 : 2)}% from wipe-out at {fmtPrice(pos.liq)}
            </Text>
          </>
        )}
        {children}
      </View>
    </View>
  );
}

export function Duel({ view }: { view: MatchView }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const g = useGame();
  const now = useNow(100);
  const reduced = useReducedMotion();
  const [trading, setTrading] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([{ t: 0, you: 0, opp: 0 }]);
  const you = view.you;
  const opp = view.opp;
  const mine = pointsOf(you.pos);
  const theirs = pointsOf(opp.pos);
  const span = view.endAt && view.startAt ? view.endAt - view.startAt : 1;
  const elapsed = view.startAt ? Math.max(0, Math.min(1, (now - view.startAt) / span)) : 0;
  const left = (view.endAt ?? now) - now;
  const lastCall = left <= 10_000 && left > 0;

  // Record the race. About 150 points across the duel, however long it is.
  useEffect(() => {
    if (!view.startAt) return;
    const t = Math.max(0, Math.min(1, (Date.now() - view.startAt) / span));
    setSamples((prev) => {
      const last = prev[prev.length - 1]!;
      if (t - last.t < 1 / 150 && t < 1) return prev;
      return [...prev, { t, you: mine, opp: theirs }];
    });
  }, [mine, theirs, now, view.startAt, span]);

  // Feel the moments that matter: the lead changing hands, and a wipe-out.
  const leader = mine === theirs ? 0 : mine > theirs ? 1 : -1;
  const prevLeader = useRef(leader);
  useEffect(() => {
    if (leader !== 0 && prevLeader.current !== 0 && leader !== prevLeader.current) buzz(Haptics.ImpactFeedbackStyle.Light);
    if (leader !== 0) prevLeader.current = leader;
  }, [leader]);
  const wiped = Boolean(you.pos?.liquidated) || Boolean(opp.pos?.liquidated);
  useEffect(() => {
    if (wiped) buzz(Haptics.ImpactFeedbackStyle.Heavy);
  }, [wiped]);

  // The clock beats in the last ten seconds.
  const beat = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!lastCall || reduced) {
      beat.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(beat, { toValue: 1.06, duration: 160, useNativeDriver: nativeDriver }),
        Animated.timing(beat, { toValue: 1, duration: 840, useNativeDriver: nativeDriver }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [lastCall, reduced, beat]);

  if (!you.card || !you.pos || !opp.face || !opp.pos || !view.endAt) return null;

  const gap = Math.abs(mine - theirs);
  const headline =
    you.pos.liquidated && opp.pos.liquidated
      ? 'Double wipe-out'
      : opp.pos.liquidated
        ? `${opp.name} got rekt`
        : you.pos.liquidated
          ? 'You got rekt'
          : gap < 0.5
            ? 'Dead even'
            : mine > theirs
              ? `You're up ${gap.toFixed(1)}`
              : `${opp.name} is up ${gap.toFixed(1)}`;
  const secret = you.card.secret ? SECRETS[you.card.secret] : null;
  const pageWidth = Math.min(width, 480) - 2 * space.l;
  const cardWidth = Math.min(100, pageWidth * 0.27);
  const feedLine = view.note ?? (view.onchain ? 'Hyperliquid mark prices, read on-chain' : g.feedStatus === 'live' ? 'Live Hyperliquid prices' : 'Simulated prices');

  return (
    <View style={[styles.page, { paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.l }]}>
      <Animated.Text
        style={[styles.clock, lastCall && { color: color.short }, { transform: [{ scale: beat }] }]}
        accessibilityLabel={`${fmtClock(left)} left`}
      >
        {fmtClock(left)}
      </Animated.Text>
      <Text style={[styles.headline, { color: gap < 0.5 ? color.text : mine > theirs ? color.long : color.short }]} accessibilityLiveRegion="polite">
        {headline}
      </Text>

      <Tape samples={samples} width={pageWidth} height={Math.max(110, Math.min(220, height - 650))} elapsed={elapsed} />
      <Text style={styles.feed}>
        {view.onchain ? `${fmtHype(BigInt(view.stake) * 2n)} in the pot. ` : ''}
        {feedLine}.
      </Text>

      <View style={styles.seats}>
        <Seat who={opp.name} face={opp.face} pos={opp.pos} cardWidth={cardWidth} seal="unknown" lineColor={OPP_LINE} reduced={reduced} />
        <Seat who="You" face={you.card} pos={you.pos} cardWidth={cardWidth} seal="shown" lineColor={color.lilac} reduced={reduced}>
          {secret ? (
            <Text style={[styles.stat, { color: color.foil }]} numberOfLines={2}>
              {secret.name} +{secret.points}: {secret.rule}
            </Text>
          ) : null}
        </Seat>
      </View>

      <View style={{ flex: 1 }} />
      <Button label="Open this trade for real" kind="quiet" onPress={() => setTrading(true)} />
      {trading ? <TradeSheet card={you.card} onClose={() => setTrading(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: space.l, width: '100%', maxWidth: 480, alignSelf: 'center' },
  clock: { fontFamily: font.display, fontSize: 68, lineHeight: 68, color: color.text, textAlign: 'center', fontVariant: ['tabular-nums'] },
  headline: { fontFamily: font.display, fontSize: size.title + 4, lineHeight: size.title + 8, textAlign: 'center', marginBottom: space.m },
  tape: { backgroundColor: color.raised, borderRadius: 16, overflow: 'hidden' },
  rule: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: color.line },
  axis: { position: 'absolute', right: 6, fontFamily: font.medium, fontSize: 11, color: color.dim },
  feed: { fontFamily: font.body, fontSize: size.small, lineHeight: 19, color: color.dim, textAlign: 'center', marginTop: space.s },
  seats: { gap: space.l, marginTop: space.l },
  seat: { flexDirection: 'row', gap: space.l, alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  who: { fontFamily: font.semi, fontSize: size.body, color: color.text, flexShrink: 1 },
  chip: { borderWidth: 1.5, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1 },
  chipText: { fontFamily: font.semi, fontSize: size.small },
  points: { fontFamily: font.display, fontSize: 50, lineHeight: 52, alignSelf: 'flex-start' },
  stat: { fontFamily: font.body, fontSize: size.small, lineHeight: 19, color: color.dim, fontVariant: ['tabular-nums'] },
  meter: { flexDirection: 'row', gap: 3, marginVertical: 4 },
  tick: { flex: 1, height: 6, borderRadius: 2, backgroundColor: color.line },
  rekt: { position: 'absolute', borderWidth: 3, borderColor: color.short, borderRadius: 8, paddingHorizontal: 8, backgroundColor: color.table, transform: [{ rotate: '-14deg' }] },
  rektText: { fontFamily: font.display, fontSize: size.title, color: color.short },
});
