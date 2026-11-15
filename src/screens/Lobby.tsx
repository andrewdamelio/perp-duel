import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chainName } from '../chain/arena';
import { DURATIONS, STAKES } from '../config';
import { DEFAULT_MARKETS, marketByCoin, type Card } from '../engine';
import { useGame } from '../game/store';
import { fmtHype, shortAddress } from '../ui/format';
import { Button, Choice, Notice, P } from '../ui/kit';
import { CARD_RATIO, PerpCard } from '../ui/PerpCard';
import { color, font, size, space } from '../ui/theme';

const SHOWCASE: Card[] = [
  { coin: 'BTC', side: 'long', leverage: 1000, secret: null },
  { coin: 'xyz:NVDA', side: 'short', leverage: 500, secret: 'phoenix' },
  { coin: 'HYPE', side: 'long', leverage: 250, secret: null },
];

const FEED_LINE = {
  connecting: 'Connecting to Hyperliquid for prices.',
  live: 'Prices are live mids from Hyperliquid.',
  sim: 'Hyperliquid is unreachable from here, so prices are simulated.',
} as const;

export function Lobby() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const g = useGame();
  const cardWidth = Math.min(132, (Math.min(width, 480) - 2 * space.l) * 0.31);
  const escrow = g.arena;
  const short = escrow && g.balance !== null && g.balance <= BigInt(g.stake);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.page, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}
    >
      <Text accessibilityRole="header" style={styles.title}>
        Perp Duel
      </Text>
      <P style={styles.pitch}>Two players, one card each, up to 1000× leverage. Best trade when the clock stops takes the pot.</P>

      <View style={[styles.fan, { height: cardWidth * CARD_RATIO + 28 }]} accessible accessibilityLabel="Three example cards">
        {SHOWCASE.map((card, i) => (
          <PerpCard
            key={card.coin}
            card={card}
            market={marketByCoin(DEFAULT_MARKETS, card.coin)}
            width={cardWidth}
            seal="shown"
            style={{
              marginHorizontal: -cardWidth * 0.02,
              zIndex: i === 1 ? 2 : 1,
              transform: [{ rotate: `${(i - 1) * 9}deg` }, { translateY: i === 1 ? -10 : 8 }],
            }}
          />
        ))}
      </View>

      <P dim>
        Each card is a synthetic perp: an asset, a side and a leverage. You score a point for every 1% it returns on margin, so at
        1000× a 0.1% move is 100 points, or a wipe-out. Two cards in every hand carry a gold seal, a hidden bonus only you can read.
      </P>

      <Choice title="Length" value={g.duration} onChange={(duration) => g.setTerms({ duration })} options={DURATIONS.map((d) => ({ value: d.seconds, label: d.label, note: d.note }))} />
      <Choice
        title={escrow ? 'Stake each' : 'Stake each, play money'}
        value={g.stake}
        onChange={(stake) => g.setTerms({ stake })}
        options={STAKES.map((s) => ({ value: s, label: fmtHype(s) }))}
      />
      <View style={{ marginTop: space.xl, gap: space.m }}>
        {g.error ? <Notice text={g.error} onDismiss={g.dismissError} /> : null}
        {g.arenaError ? <Notice text={g.arenaError} tone="info" /> : null}
        {short ? <Notice tone="info" text={`This wallet holds ${fmtHype(g.balance ?? 0n)}. It needs the stake plus a little for gas before you can lock a card.`} /> : null}
        <Button label="Deal me in" onPress={g.findDuel} disabled={!g.ready} />
      </View>

      <View style={styles.footer}>
        <P dim style={styles.small}>
          {FEED_LINE[g.feedStatus]}
        </P>
        {escrow ? (
          <P dim style={styles.small}>
            No house and no referee. The contract at {shortAddress(escrow.address)} on {chainName(escrow)} holds both stakes, deals the cards, reads
            Hyperliquid's prices and pays the winner.
          </P>
        ) : (
          <P dim style={styles.small}>
            Practice table. Nothing leaves this device except the price subscription.
          </P>
        )}
        {escrow && g.address ? (
          <P dim style={styles.small}>
            Demo wallet{' '}
            <Text selectable style={{ color: color.text }}>
              {g.address}
            </Text>
            {g.balance !== null ? ` holds ${fmtHype(g.balance)}.` : '.'}
          </P>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: space.l, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontFamily: font.display, fontSize: size.huge, lineHeight: size.huge, color: color.text },
  pitch: { fontSize: size.lead, lineHeight: 25, marginTop: space.s },
  fan: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginVertical: space.xl },
  footer: { marginTop: space.xl, gap: space.s },
  small: { fontSize: size.small, lineHeight: 19 },
});
