import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { cardFromHash } from './src/chain/phantom';
import type { Card } from './src/engine';
import { useGame } from './src/game/store';
import { Deal } from './src/screens/Deal';
import { Duel } from './src/screens/Duel';
import { Lobby } from './src/screens/Lobby';
import { Matching } from './src/screens/Matching';
import { Result } from './src/screens/Result';
import { TradeSheet } from './src/screens/TradeSheet';
import { color } from './src/ui/theme';

export default function App() {
  // Required file by file so only the five weights in use are bundled.
  const [fontsLoaded] = useFonts({
    BigShouldersDisplay_700Bold: require('@expo-google-fonts/big-shoulders-display/BigShouldersDisplay_700Bold.ttf'),
    BigShouldersDisplay_800ExtraBold: require('@expo-google-fonts/big-shoulders-display/BigShouldersDisplay_800ExtraBold.ttf'),
    InstrumentSans_400Regular: require('@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf'),
    InstrumentSans_500Medium: require('@expo-google-fonts/instrument-sans/500Medium/InstrumentSans_500Medium.ttf'),
    InstrumentSans_600SemiBold: require('@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf'),
  });
  const init = useGame((s) => s.init);
  const screen = useGame((s) => s.screen);
  const view = useGame((s) => s.view);
  // A card handed over from another device or browser arrives in the address, e.g. #trade-BTC-long-1000.
  const [handedCard, setHandedCard] = useState<Card | null>(() => (Platform.OS === 'web' ? cardFromHash(globalThis.location?.hash ?? '') : null));

  useEffect(() => {
    void init();
  }, [init]);

  // The match itself decides which table view is showing, so a resumed duel lands in the right place.
  let body = <Lobby />;
  if (screen === 'matching') body = <Matching />;
  if (screen === 'table' && view) {
    body = view.phase === 'picking' ? <Deal view={view} /> : view.phase === 'live' ? <Duel view={view} /> : <Result view={view} />;
  }

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: color.table }}>
        <StatusBar style="light" />
        {fontsLoaded ? body : null}
        {fontsLoaded && handedCard ? <TradeSheet card={handedCard} onClose={() => setHandedCard(null)} /> : null}
      </View>
    </SafeAreaProvider>
  );
}
