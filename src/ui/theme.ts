import { Platform } from 'react-native';

/**
 * A card table at night: plum felt, ivory card stock, printed ink.
 * Long and short each get one ink on the card and a brighter twin for the felt.
 */
export const color = {
  table: '#191330',
  raised: '#251C45',
  line: '#3A2F63',
  text: '#EDE8FF',
  dim: '#A39BC9',
  lilac: '#BDAEFF',
  stock: '#F5EFE2',
  stockEdge: '#DDD2BA',
  ink: '#1B1630',
  inkSoft: '#625C78',
  longInk: '#0B7A5E',
  shortInk: '#C22D45',
  long: '#4FE0B5',
  short: '#FF7A8C',
  foil: '#D8A23A',
  foilDeep: '#8E6210',
} as const;

/** Big Shoulders for anything that reads like a card index or a scoreboard; Instrument Sans for sentences. */
export const font = {
  display: 'BigShouldersDisplay_800ExtraBold',
  displayBold: 'BigShouldersDisplay_700Bold',
  body: 'InstrumentSans_400Regular',
  medium: 'InstrumentSans_500Medium',
  semi: 'InstrumentSans_600SemiBold',
} as const;

export const size = { small: 13, body: 15, lead: 17, title: 22, big: 34, huge: 56 } as const;
export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 36 } as const;

export const nativeDriver = Platform.OS !== 'web';
