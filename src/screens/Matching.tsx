import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useGame } from '../game/store';
import { fmtDuration, fmtHype } from '../ui/format';
import { Button, P } from '../ui/kit';
import { color, font, size, space } from '../ui/theme';

export function Matching() {
  const g = useGame();
  const waitingForHuman = Boolean(g.arena);
  return (
    <View style={styles.page}>
      <ActivityIndicator color={color.lilac} size="large" />
      <Text accessibilityRole="header" style={styles.title}>
        {waitingForHuman ? 'Waiting for another player' : 'Shuffling the deck'}
      </Text>
      <P dim style={{ textAlign: 'center' }}>
        {waitingForHuman
          ? (g.busy ?? `Your ${fmtHype(g.stake)} is staked for a ${fmtDuration(g.duration)} duel. The next player who picks the same terms sits down with you. Leaving takes your stake back.`)
          : 'Dealing as soon as prices arrive.'}
      </P>
      <Button label="Leave the table" kind="quiet" onPress={g.leave} style={{ marginTop: space.xl, alignSelf: 'stretch' }} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.m, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { fontFamily: font.display, fontSize: size.big, lineHeight: size.big + 4, color: color.text, textAlign: 'center', marginTop: space.l },
});
