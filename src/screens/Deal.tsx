import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DEFAULT_MARKETS, SECRETS, liquidationPrice, marketByCoin, type MatchView } from '../engine';
import { useGame } from '../game/store';
import { fmtDuration, fmtHype, fmtPercent, fmtPrice } from '../ui/format';
import { Button, Notice, P, useReducedMotion } from '../ui/kit';
import { PerpCard, Pip } from '../ui/PerpCard';
import { color, font, nativeDriver, size, space } from '../ui/theme';

/** Your hand. Tap a card to read it, then lock it in. */
export function Deal({ view }: { view: MatchView }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const g = useGame();
  const reduced = useReducedMotion();
  const [selected, setSelected] = useState(0);
  const locked = view.you.pick !== null;
  const chosen = locked ? (view.you.pick as number) : selected;
  const hand = view.you.hand;
  const pageWidth = Math.min(width, 480);
  const cardWidth = Math.max(128, Math.min(184, (pageWidth - 2 * space.l - 2 * space.m) / 2.35));
  const marketOf = (coin: string) => marketByCoin(g.markets, coin) ?? marketByCoin(DEFAULT_MARKETS, coin);

  // The one staged moment on this screen: the hand is dealt, one card after another.
  const dealt = useRef(hand.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduced) {
      dealt.forEach((v) => v.setValue(1));
      return;
    }
    Animated.stagger(
      90,
      dealt.map((v) => Animated.spring(v, { toValue: 1, useNativeDriver: nativeDriver, friction: 8, tension: 60 })),
    ).start();
  }, [dealt, reduced]);

  const card = hand[chosen]!;
  const market = marketOf(card.coin);
  const mid = g.mids[card.coin];
  const secret = card.secret ? SECRETS[card.secret] : null;
  const liq = useMemo(
    () => (mid ? liquidationPrice(mid, card.side, card.leverage) : null),
    [mid, card.side, card.leverage],
  );

  const lockIn = () => {
    if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    void g.pick(chosen);
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + space.l, paddingBottom: insets.bottom + space.l }}>
      <View style={styles.pad}>
        <Text accessibilityRole="header" style={styles.title}>
          Your hand
        </Text>
        <P dim>
          {fmtDuration(view.duration)} against {view.opp.name}, {fmtHype(view.stake)} each{view.onchain ? '' : ' in play money'}. Pick one card{view.onchain ? ' within 90 seconds, or forfeit' : ''}.
        </P>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={[styles.hand, { paddingHorizontal: Math.max(space.l, (width - pageWidth) / 2 + space.l) }]}
      >
        {hand.map((c, i) => (
          <Animated.View
            key={`${c.coin}-${i}`}
            style={{
              opacity: locked && i !== chosen ? 0.35 : dealt[i],
              transform: [
                { translateY: dealt[i]!.interpolate({ inputRange: [0, 1], outputRange: [70, i === chosen ? -10 : 0] }) },
                { rotate: dealt[i]!.interpolate({ inputRange: [0, 1], outputRange: ['8deg', '0deg'] }) },
              ],
            }}
          >
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: i === chosen, disabled: locked }}
              disabled={locked}
              onPress={() => setSelected(i)}
            >
              <PerpCard card={c} market={marketOf(c.coin)} width={cardWidth} seal="shown" selected={i === chosen} />
            </Pressable>
          </Animated.View>
        ))}
      </ScrollView>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.pad, { gap: space.m, paddingTop: space.s }]}>
        <View style={styles.readout}>
          <Pip side={card.side} size={18} tint={card.side === 'long' ? color.long : color.short} />
          <Text style={styles.readoutTitle}>
            {card.side === 'long' ? 'Long' : 'Short'} {market?.name ?? card.coin} at {card.leverage}×
          </Text>
        </View>
        <P>
          {mid && liq
            ? `${market?.ticker} is at ${fmtPrice(mid)}. A ${fmtPercent(Math.abs(liq / mid - 1) * 100, 2)} ${card.side === 'long' ? 'drop' : 'rise'} to ${fmtPrice(liq)} wipes this card out.`
            : `Waiting for a price on ${market?.ticker ?? card.coin}.`}
        </P>
        {secret ? (
          <View style={styles.secret}>
            <Text style={styles.secretTitle}>
              {secret.name}, +{secret.points} points
            </Text>
            <P style={{ color: color.ink }}>{secret.rule}</P>
            <P style={{ color: color.inkSoft, fontSize: size.small }}>Your opponent sees the card but not this.</P>
          </View>
        ) : (
          <P dim>No hidden bonus on this card.</P>
        )}
        {g.error ? <Notice text={g.error} onDismiss={g.dismissError} /> : null}
      </ScrollView>

      <View style={[styles.pad, { gap: space.s }]}>
        <P dim style={{ textAlign: 'center' }}>
          {g.busy ?? (locked ? `Locked in. Waiting for ${view.opp.name}.` : view.opp.locked ? `${view.opp.name} has locked a card.` : `${view.opp.name} is still choosing.`)}
        </P>
        <Button
          label={locked ? 'Locked in' : `Lock in ${market?.ticker ?? card.coin} ${card.side} ${card.leverage}×`}
          onPress={lockIn}
          disabled={locked}
          busy={Boolean(g.busy)}
        />
        {!locked && !g.busy && !view.onchain ? <Button label="Leave the table" kind="quiet" onPress={g.leave} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.l, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontFamily: font.display, fontSize: size.big, lineHeight: size.big + 2, color: color.text },
  hand: { gap: space.m, paddingTop: space.xl, paddingBottom: space.l },
  readout: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  readoutTitle: { fontFamily: font.semi, fontSize: size.title, color: color.text, flexShrink: 1 },
  secret: { backgroundColor: color.foil, borderRadius: 12, padding: space.m, gap: 2 },
  secretTitle: { fontFamily: font.semi, fontSize: size.lead, color: color.ink },
});
