import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { phantomBrowseLink, phantomEthereum, tradeHash } from '../chain/phantom';
import { config } from '../config';
import { DEFAULT_MARKETS, liquidationPrice, marketByCoin, type Card } from '../engine';
import { useGame } from '../game/store';
import { openRealTrade, type RealTradeResult, type StepState, type TradeStep } from '../hl/trade';
import { fmtPrice, shortAddress } from '../ui/format';
import { Button, Notice, P } from '../ui/kit';
import { PerpCard, Pip } from '../ui/PerpCard';
import { color, font, size, space } from '../ui/theme';

type Stage = 'review' | 'confirm' | 'filled';
type RowState = StepState | 'waiting' | 'failed';
const MARGINS = [10, 25, 50];

const STEP_COPY: Record<TradeStep, { title: string; hint: string }> = {
  connect: { title: 'Connect your wallet', hint: 'Phantom shares your address' },
  funds: { title: 'Check your perps balance', hint: 'Nothing is moved' },
  builder: { title: 'Approve the builder fee', hint: 'One signature, first time only' },
  agent: { title: 'Approve this device to trade', hint: 'One signature, first time only. It can trade, never withdraw' },
  order: { title: 'Place the order', hint: 'No signature needed' },
};

/** The public web address a card can be handed to Phantom through, if there is one. */
function shareableUrl(sandboxed: boolean): string | null {
  if (config.webUrl) return config.webUrl;
  if (Platform.OS !== 'web' || sandboxed) return null;
  const { protocol, origin, pathname } = globalThis.location;
  return protocol === 'https:' ? origin + pathname : null;
}

/** Three segments: review the card, confirm in Phantom, filled. */
function Progress({ stage }: { stage: Stage }) {
  const at = stage === 'review' ? 0 : stage === 'confirm' ? 1 : 2;
  const names = ['Review', 'Confirm', 'Filled'];
  return (
    <View style={styles.progress} accessibilityLabel={`Step ${at + 1} of 3: ${names[at]}`}>
      {names.map((name, i) => (
        <View key={name} style={{ flex: 1, gap: 6 }}>
          <View style={[styles.segment, i <= at && { backgroundColor: color.lilac }]} />
          <Text style={[styles.segmentLabel, i === at && { color: color.text }]}>{name}</Text>
        </View>
      ))}
    </View>
  );
}

function Fact({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint?: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, tint ? { color: tint } : null]}>{value}</Text>
      {sub ? <Text style={styles.factSub}>{sub}</Text> : null}
    </View>
  );
}

function StepRow({ step, state, detail }: { step: TradeStep; state: RowState; detail?: string }) {
  const copy = STEP_COPY[step];
  return (
    <View style={[styles.stepRow, state === 'waiting' && { opacity: 0.45 }]} accessibilityLabel={`${copy.title}: ${state}`}>
      <View
        style={[
          styles.stepDot,
          state === 'done' && { backgroundColor: color.long, borderColor: color.long },
          state === 'failed' && { backgroundColor: color.short, borderColor: color.short },
          state === 'active' && { borderColor: color.lilac },
        ]}
      >
        {state === 'active' ? <ActivityIndicator size="small" color={color.lilac} /> : null}
        {state === 'done' ? <Text style={styles.stepMark}>✓</Text> : null}
        {state === 'failed' ? <Text style={styles.stepMark}>!</Text> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{copy.title}</Text>
        <Text style={[styles.stepHint, state === 'done' && detail ? { color: color.long } : null]}>
          {state === 'done' && detail ? detail : state === 'active' && (step === 'agent' || step === 'builder') ? 'Waiting for you in Phantom' : copy.hint}
        </Text>
      </View>
    </View>
  );
}

/**
 * The bridge from the game to a real position, in three steps: review the card, confirm
 * in Phantom, filled. Inside Phantom the order lands on the user's Phantom perps account;
 * anywhere else, the first step hands the card over to Phantom's in-app browser.
 */
export function TradeSheet({ card, onClose }: { card: Card; onClose: () => void }) {
  const g = useGame();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [stage, setStage] = useState<Stage>('review');
  const [margin, setMargin] = useState(config.realTradeMarginUsd);
  const [rows, setRows] = useState<Partial<Record<TradeStep, { state: RowState; detail?: string }>>>({});
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState<RealTradeResult | null>(null);
  const running = useRef(false);

  const market = marketByCoin(g.markets, card.coin) ?? marketByCoin(DEFAULT_MARKETS, card.coin);
  const ticker = market?.ticker ?? card.coin;
  // Cards run to 1000x; a real order is capped at what Hyperliquid lists for the market.
  const leverage = Math.min(card.leverage, market?.maxLeverage ?? 1);
  const mid = g.mids[card.coin];
  const liq = mid ? liquidationPrice(mid, card.side, leverage) : null;
  const sideTint = card.side === 'long' ? color.long : color.short;
  const phantom = phantomEthereum();
  // A page that cannot reach Hyperliquid cannot reach Phantom either: it is a sandboxed preview.
  const url = shareableUrl(g.feedStatus === 'sim');
  const steps: TradeStep[] = ['connect', 'funds', ...(config.builder ? (['builder'] as const) : []), 'agent', 'order'];
  const feePercent = (config.builderFee / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const cardWidth = Math.min(168, Math.min(width, 480) * 0.4);
  const busy = stage === 'confirm' && !error;

  const run = async () => {
    const key = g.key();
    if (!key || !phantom || running.current) return;
    running.current = true;
    setError(null);
    setRows({});
    setStage('confirm');
    let current: TradeStep = 'connect';
    try {
      const result = await openRealTrade({
        card,
        leverage,
        marginUsd: margin,
        key,
        phantom,
        testnet: config.hlTestnet,
        builder: config.builder,
        builderFee: config.builderFee,
        onProgress: (step, state, detail) => {
          current = step;
          setRows((r) => ({ ...r, [step]: { state, detail } }));
        },
      });
      setFill(result);
      setStage('filled');
    } catch (e) {
      setRows((r) => ({ ...r, [current]: { state: 'failed' } }));
      setError((e as Error).message);
    } finally {
      running.current = false;
    }
  };

  const openInPhantom = () => {
    if (url) void Linking.openURL(phantomBrowseLink(url + tradeHash(card)));
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={busy ? undefined : onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { maxHeight: height - insets.top - space.l, paddingBottom: Math.max(insets.bottom, space.l) }]} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <Progress stage={stage} />

          <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
            {stage === 'review' ? (
              <>
                <Text accessibilityRole="header" style={styles.title}>
                  Play this card for real
                </Text>
                <View style={styles.hero}>
                  <PerpCard card={card} market={market} width={cardWidth} style={{ transform: [{ rotate: '-4deg' }] }} />
                  <View style={{ flex: 1, gap: space.s }}>
                    <View style={styles.sideRow}>
                      <Pip side={card.side} size={16} tint={sideTint} />
                      <Text style={[styles.sideText, { color: sideTint }]}>{card.side === 'long' ? 'Long' : 'Short'}</Text>
                    </View>
                    <Text style={styles.heroName}>{market?.name ?? ticker}</Text>
                    <View style={styles.leverage}>
                      {leverage < card.leverage ? <Text style={styles.leverageWas}>{card.leverage}×</Text> : null}
                      <Text style={styles.leverageNow}>{leverage}×</Text>
                    </View>
                    {leverage < card.leverage ? <Text style={styles.factSub}>The most Hyperliquid offers on {ticker}</Text> : null}
                  </View>
                </View>

                <Text style={styles.choiceTitle}>Margin</Text>
                <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Margin">
                  {MARGINS.map((m) => (
                    <Pressable
                      key={m}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: m === margin }}
                      onPress={() => setMargin(m)}
                      style={[styles.chip, m === margin && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, m === margin && { color: color.ink }]}>${m}</Text>
                    </Pressable>
                  ))}
                </View>

                <View style={styles.facts}>
                  <Fact label="Position size" value={`$${(margin * leverage).toLocaleString('en-US')}`} />
                  <Fact label={`${ticker} now`} value={fmtPrice(mid)} />
                  <Fact label="Wiped out near" value={fmtPrice(liq ?? undefined)} tint={color.short} />
                </View>
                <P dim style={styles.fine}>
                  A market order on Hyperliquid {config.hlTestnet ? 'testnet' : 'mainnet, with real money'}.{' '}
                  {config.builder ? `${feePercent}% of the fill goes to this app's builder code.` : 'No builder fee.'}
                </P>

                {!phantom && !url ? (
                  <Notice
                    tone="info"
                    text={
                      Platform.OS === 'web'
                        ? 'This preview is sandboxed, so it cannot reach Phantom or Hyperliquid. Real trades work from the hosted or installed app.'
                        : 'Set EXPO_PUBLIC_WEB_URL to where the web build is hosted, so this card can be opened inside Phantom.'
                    }
                  />
                ) : null}
              </>
            ) : null}

            {stage === 'confirm' ? (
              <>
                <Text accessibilityRole="header" style={styles.title}>
                  Confirm in Phantom
                </Text>
                <View style={styles.summary}>
                  <PerpCard card={card} market={market} width={64} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.summaryTitle}>
                      {card.side === 'long' ? 'Long' : 'Short'} {ticker} at {leverage}×
                    </Text>
                    <Text style={styles.factSub}>
                      ${margin} margin, ${(margin * leverage).toLocaleString('en-US')} position
                    </Text>
                  </View>
                </View>
                <View style={styles.steps}>
                  {steps.map((s) => (
                    <StepRow key={s} step={s} state={rows[s]?.state ?? 'waiting'} detail={rows[s]?.detail} />
                  ))}
                </View>
                {error ? <Notice text={error} /> : null}
              </>
            ) : null}

            {stage === 'filled' && fill ? (
              <>
                <Text accessibilityRole="header" style={styles.title}>
                  You're in
                </Text>
                <View style={styles.filledHero}>
                  <PerpCard card={card} market={market} width={cardWidth} />
                  <View style={styles.stamp}>
                    <Text style={styles.stampText}>Live</Text>
                  </View>
                </View>
                <View style={styles.facts}>
                  <Fact label="Filled" value={`${fill.filledSize} ${ticker}`} />
                  <Fact label="At" value={fill.averagePrice} />
                  <Fact label="Account" value={shortAddress(fill.account)} />
                </View>
                <P dim style={styles.fine}>
                  The position is in your Phantom perps tab. Close or manage it there.
                </P>
              </>
            ) : null}
          </ScrollView>

          <View style={styles.actions}>
            {stage === 'review' ? (
              <>
                {phantom ? (
                  <Button label={`Open ${card.side} with Phantom`} onPress={run} />
                ) : url ? (
                  <Button label="Continue in Phantom" onPress={openInPhantom} />
                ) : null}
                <Button label="Not now" kind="quiet" onPress={onClose} />
              </>
            ) : null}
            {stage === 'confirm' && error ? (
              <>
                <Button label="Try again" onPress={run} />
                <Button label="Back" kind="quiet" onPress={() => { setError(null); setStage('review'); }} />
              </>
            ) : null}
            {stage === 'filled' ? <Button label="Done" onPress={onClose} /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10, 7, 22, 0.78)' },
  sheet: {
    backgroundColor: color.table,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: space.xl,
    paddingTop: space.s,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.line, marginBottom: space.l },
  progress: { flexDirection: 'row', gap: space.s },
  segment: { height: 4, borderRadius: 2, backgroundColor: color.line },
  segmentLabel: { fontFamily: font.medium, fontSize: size.small, color: color.dim },
  body: { paddingTop: space.l, paddingBottom: space.m, gap: space.m },
  title: { fontFamily: font.display, fontSize: size.big, lineHeight: size.big + 2, color: color.text },
  hero: { flexDirection: 'row', alignItems: 'center', gap: space.xl, paddingVertical: space.s, paddingLeft: space.xs },
  sideRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  sideText: { fontFamily: font.semi, fontSize: size.lead },
  heroName: { fontFamily: font.semi, fontSize: size.title, color: color.text },
  leverage: { flexDirection: 'row', alignItems: 'baseline', gap: space.s },
  leverageWas: { fontFamily: font.displayBold, fontSize: size.title, color: color.dim, textDecorationLine: 'line-through' },
  leverageNow: { fontFamily: font.display, fontSize: 52, lineHeight: 54, color: color.text },
  choiceTitle: { fontFamily: font.semi, fontSize: size.body, color: color.text },
  chips: { flexDirection: 'row', gap: space.s },
  chip: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: color.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: color.stock, borderColor: color.stock },
  chipText: { fontFamily: font.displayBold, fontSize: size.title, color: color.text },
  facts: { flexDirection: 'row', backgroundColor: color.raised, borderRadius: 16, paddingVertical: space.m },
  fact: { flex: 1, alignItems: 'center', paddingHorizontal: space.xs, gap: 2 },
  factLabel: { fontFamily: font.medium, fontSize: size.small, color: color.dim, textAlign: 'center' },
  factValue: { fontFamily: font.displayBold, fontSize: size.title, color: color.text, fontVariant: ['tabular-nums'] },
  factSub: { fontFamily: font.body, fontSize: size.small, lineHeight: 18, color: color.dim },
  fine: { fontSize: size.small, lineHeight: 19 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space.l, backgroundColor: color.raised, borderRadius: 16, padding: space.m },
  summaryTitle: { fontFamily: font.semi, fontSize: size.lead, color: color.text },
  steps: { gap: space.l, paddingVertical: space.s },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  stepDot: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: color.line, alignItems: 'center', justifyContent: 'center' },
  stepMark: { fontFamily: font.semi, fontSize: size.lead, lineHeight: 20, color: color.ink },
  stepTitle: { fontFamily: font.semi, fontSize: size.lead, color: color.text },
  stepHint: { fontFamily: font.body, fontSize: size.small, lineHeight: 18, color: color.dim },
  filledHero: { alignItems: 'center', paddingVertical: space.m },
  stamp: {
    position: 'absolute',
    top: space.xs,
    right: '12%',
    borderWidth: 3,
    borderColor: color.long,
    borderRadius: 10,
    paddingHorizontal: space.m,
    paddingVertical: 2,
    backgroundColor: color.table,
    transform: [{ rotate: '12deg' }],
  },
  stampText: { fontFamily: font.display, fontSize: size.title, color: color.long },
  actions: { gap: space.s, paddingTop: space.s },
});
