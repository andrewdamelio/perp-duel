import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { color, font, size, space } from './theme';

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'quiet';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' ? styles.primary : styles.quiet,
        off && styles.off,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={kind === 'primary' ? color.ink : color.lilac} style={{ marginRight: space.s }} /> : null}
      <Text style={[styles.buttonLabel, { color: kind === 'primary' ? color.ink : color.lilac }]}>{label}</Text>
    </Pressable>
  );
}

/** A single-choice row. */
export function Choice<T extends string | number | boolean>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly { value: T; label: string; note?: string | null }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={title} style={{ marginTop: space.l }}>
      <Text style={styles.choiceTitle}>{title}</Text>
      <View style={styles.choiceRow}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={String(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={() => onChange(o.value)}
              style={({ pressed }) => [styles.choice, on && styles.choiceOn, pressed && styles.pressed]}
            >
              <Text style={[styles.choiceLabel, on && { color: color.ink }]}>{o.label}</Text>
              {o.note ? <Text style={[styles.choiceNote, on && { color: color.inkSoft }]}>{o.note}</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Notice({ text, onDismiss, tone = 'error' }: { text: string; onDismiss?: () => void; tone?: 'error' | 'info' }) {
  return (
    <View accessibilityRole="alert" style={[styles.notice, tone === 'error' && { borderColor: color.short }]}>
      <Text style={styles.noticeText}>{text}</Text>
      {onDismiss ? (
        <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={12}>
          <Text style={styles.noticeDismiss}>Dismiss</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function P({ children, style, dim }: { children: ReactNode; style?: TextStyle; dim?: boolean }) {
  return <Text style={[styles.p, dim && { color: color.dim }, style]}>{children}</Text>;
}

/** The current time, refreshed on an interval. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub.remove();
  }, []);
  return reduced;
}

const styles = StyleSheet.create({
  button: { minHeight: 52, borderRadius: 14, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center', flexDirection: 'row' },
  primary: { backgroundColor: color.lilac },
  quiet: { borderWidth: 1.5, borderColor: color.line },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  buttonLabel: { fontFamily: font.semi, fontSize: size.lead },
  choiceTitle: { fontFamily: font.semi, fontSize: size.body, color: color.text, marginBottom: space.s },
  choiceRow: { flexDirection: 'row', gap: space.s },
  choice: { flex: 1, minHeight: 52, borderRadius: 12, borderWidth: 1.5, borderColor: color.line, alignItems: 'center', justifyContent: 'center', paddingVertical: space.s, paddingHorizontal: space.xs },
  choiceOn: { backgroundColor: color.stock, borderColor: color.stock },
  choiceLabel: { fontFamily: font.semi, fontSize: size.body, color: color.text, textAlign: 'center' },
  choiceNote: { fontFamily: font.body, fontSize: size.small, color: color.dim, textAlign: 'center' },
  notice: { borderWidth: 1.5, borderColor: color.line, borderRadius: 12, padding: space.m, backgroundColor: color.raised, flexDirection: 'row', alignItems: 'center', gap: space.m },
  noticeText: { flex: 1, fontFamily: font.medium, fontSize: size.body, lineHeight: 21, color: color.text },
  noticeDismiss: { fontFamily: font.semi, fontSize: size.body, color: color.lilac },
  p: { fontFamily: font.body, fontSize: size.body, lineHeight: 22, color: color.text },
});
