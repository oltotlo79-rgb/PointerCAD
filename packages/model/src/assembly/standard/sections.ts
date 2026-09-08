import type {
  ChannelRow, EqualAngleRow, HBeamRow, StandardTableSource,
} from './types.js';

export const STRUCTURAL_SECTION_SOURCE = {
  standard: 'JIS G 3192',
  edition: '2024 (dimension values checked against the JISF 2020 amendment draft)',
  title: '熱間圧延形鋼の形状・寸法・質量及びその許容差',
  scope: '等辺山形鋼26種・溝形鋼8種・H形鋼広幅系列7種',
  sourceUrls: [
    'https://www.jisf.or.jp/business/standard/jis/documents/docs_kouzai004_jis02G3192_20201202.pdf',
    'https://ranoblog.org/angle-yamagata-steel-%E2%85%BC-standard-size-cross-section-weight/',
    'https://ranoblog.org/channel-steel-material-c-standard-size-cross-sectional-area-weight-jis-g-3192/',
    'https://hayamihyou.net/h-beam/',
  ],
  verified: false,
} as const satisfies StandardTableSource;

export const EQUAL_ANGLE_TABLE = [
  { key: 'JIS-G-3192:2024:L 25\u00d725\u00d73', size: 'L 25\u00d725\u00d73', a: 25, b: 25, thickness: 3, innerRadius: 4, tipRadius: 2, areaCm2: 1.427, massKgPerM: 1.12, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 30\u00d730\u00d73', size: 'L 30\u00d730\u00d73', a: 30, b: 30, thickness: 3, innerRadius: 4, tipRadius: 2, areaCm2: 1.727, massKgPerM: 1.36, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 40\u00d740\u00d73', size: 'L 40\u00d740\u00d73', a: 40, b: 40, thickness: 3, innerRadius: 4.5, tipRadius: 2, areaCm2: 2.336, massKgPerM: 1.83, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 40\u00d740\u00d75', size: 'L 40\u00d740\u00d75', a: 40, b: 40, thickness: 5, innerRadius: 4.5, tipRadius: 3, areaCm2: 3.755, massKgPerM: 2.95, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 45\u00d745\u00d74', size: 'L 45\u00d745\u00d74', a: 45, b: 45, thickness: 4, innerRadius: 6.5, tipRadius: 3, areaCm2: 3.492, massKgPerM: 2.74, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 45\u00d745\u00d75', size: 'L 45\u00d745\u00d75', a: 45, b: 45, thickness: 5, innerRadius: 6.5, tipRadius: 3, areaCm2: 4.302, massKgPerM: 3.38, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 50\u00d750\u00d74', size: 'L 50\u00d750\u00d74', a: 50, b: 50, thickness: 4, innerRadius: 6.5, tipRadius: 3, areaCm2: 3.892, massKgPerM: 3.06, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 50\u00d750\u00d75', size: 'L 50\u00d750\u00d75', a: 50, b: 50, thickness: 5, innerRadius: 6.5, tipRadius: 3, areaCm2: 4.802, massKgPerM: 3.77, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 50\u00d750\u00d76', size: 'L 50\u00d750\u00d76', a: 50, b: 50, thickness: 6, innerRadius: 6.5, tipRadius: 4.5, areaCm2: 5.644, massKgPerM: 4.43, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 60\u00d760\u00d74', size: 'L 60\u00d760\u00d74', a: 60, b: 60, thickness: 4, innerRadius: 6.5, tipRadius: 3, areaCm2: 4.692, massKgPerM: 3.68, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 60\u00d760\u00d75', size: 'L 60\u00d760\u00d75', a: 60, b: 60, thickness: 5, innerRadius: 6.5, tipRadius: 3, areaCm2: 5.802, massKgPerM: 4.55, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 65\u00d765\u00d75', size: 'L 65\u00d765\u00d75', a: 65, b: 65, thickness: 5, innerRadius: 8.5, tipRadius: 3, areaCm2: 6.367, massKgPerM: 5.0, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 65\u00d765\u00d76', size: 'L 65\u00d765\u00d76', a: 65, b: 65, thickness: 6, innerRadius: 8.5, tipRadius: 4, areaCm2: 7.527, massKgPerM: 5.91, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 65\u00d765\u00d78', size: 'L 65\u00d765\u00d78', a: 65, b: 65, thickness: 8, innerRadius: 8.5, tipRadius: 6, areaCm2: 9.761, massKgPerM: 7.66, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 70\u00d770\u00d76', size: 'L 70\u00d770\u00d76', a: 70, b: 70, thickness: 6, innerRadius: 8.5, tipRadius: 4, areaCm2: 8.127, massKgPerM: 6.38, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 75\u00d775\u00d76', size: 'L 75\u00d775\u00d76', a: 75, b: 75, thickness: 6, innerRadius: 8.5, tipRadius: 4, areaCm2: 8.727, massKgPerM: 6.85, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 75\u00d775\u00d79', size: 'L 75\u00d775\u00d79', a: 75, b: 75, thickness: 9, innerRadius: 8.5, tipRadius: 6, areaCm2: 12.69, massKgPerM: 9.96, verified: false, note: 'r1: JISF \u306f 8.5\u3001ranoblog \u306f 9\u3002\u65ad\u9762\u7a4d\u3068\u5358\u4f4d\u8cea\u91cf\u306f\u4e00\u81f4' },
  { key: 'JIS-G-3192:2024:L 75\u00d775\u00d712', size: 'L 75\u00d775\u00d712', a: 75, b: 75, thickness: 12, innerRadius: 8.5, tipRadius: 6, areaCm2: 16.56, massKgPerM: 13.0, verified: false, note: 'r1: JISF \u306f 8.5\u3001ranoblog \u306f 9\u3002\u65ad\u9762\u7a4d\u3068\u5358\u4f4d\u8cea\u91cf\u306f\u4e00\u81f4' },
  { key: 'JIS-G-3192:2024:L 80\u00d780\u00d76', size: 'L 80\u00d780\u00d76', a: 80, b: 80, thickness: 6, innerRadius: 8.5, tipRadius: 4, areaCm2: 9.327, massKgPerM: 7.32, verified: false, note: 'r1: JISF \u306f 8.5\u3001ranoblog \u306f 9\u3002\u65ad\u9762\u7a4d\u3068\u5358\u4f4d\u8cea\u91cf\u306f\u4e00\u81f4' },
  { key: 'JIS-G-3192:2024:L 90\u00d790\u00d76', size: 'L 90\u00d790\u00d76', a: 90, b: 90, thickness: 6, innerRadius: 10, tipRadius: 5, areaCm2: 10.55, massKgPerM: 8.28, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 90\u00d790\u00d77', size: 'L 90\u00d790\u00d77', a: 90, b: 90, thickness: 7, innerRadius: 10, tipRadius: 5, areaCm2: 12.22, massKgPerM: 9.59, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 90\u00d790\u00d710', size: 'L 90\u00d790\u00d710', a: 90, b: 90, thickness: 10, innerRadius: 10, tipRadius: 7, areaCm2: 17.0, massKgPerM: 13.3, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 90\u00d790\u00d713', size: 'L 90\u00d790\u00d713', a: 90, b: 90, thickness: 13, innerRadius: 10, tipRadius: 7, areaCm2: 21.71, massKgPerM: 17.0, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 100\u00d7100\u00d77', size: 'L 100\u00d7100\u00d77', a: 100, b: 100, thickness: 7, innerRadius: 10, tipRadius: 5, areaCm2: 13.62, massKgPerM: 10.7, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 100\u00d7100\u00d710', size: 'L 100\u00d7100\u00d710', a: 100, b: 100, thickness: 10, innerRadius: 10, tipRadius: 7, areaCm2: 19.0, massKgPerM: 14.9, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:L 100\u00d7100\u00d713', size: 'L 100\u00d7100\u00d713', a: 100, b: 100, thickness: 13, innerRadius: 10, tipRadius: 7, areaCm2: 24.31, massKgPerM: 19.1, verified: false, note: 'r2: JISF \u306f 7\u3001ranoblog \u306f 9\u3002\u65ad\u9762\u7a4d\u3068\u5358\u4f4d\u8cea\u91cf\u306f\u4e00\u81f4' },
] as const satisfies readonly EqualAngleRow[];

export const CHANNEL_TABLE = [
  { key: 'JIS-G-3192:2024:[ 75\u00d740\u00d75\u00d77', size: '[ 75\u00d740\u00d75\u00d77', height: 75, width: 40, webThickness: 5, flangeThickness: 7, innerRadius: 8, tipRadius: 4, areaCm2: 8.818, massKgPerM: 6.92, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 100\u00d750\u00d75\u00d77.5', size: '[ 100\u00d750\u00d75\u00d77.5', height: 100, width: 50, webThickness: 5, flangeThickness: 7.5, innerRadius: 8, tipRadius: 4, areaCm2: 11.92, massKgPerM: 9.36, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 125\u00d765\u00d76\u00d78', size: '[ 125\u00d765\u00d76\u00d78', height: 125, width: 65, webThickness: 6, flangeThickness: 8, innerRadius: 8, tipRadius: 4, areaCm2: 17.11, massKgPerM: 13.4, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 150\u00d775\u00d76.5\u00d710', size: '[ 150\u00d775\u00d76.5\u00d710', height: 150, width: 75, webThickness: 6.5, flangeThickness: 10, innerRadius: 10, tipRadius: 5, areaCm2: 23.71, massKgPerM: 18.6, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 150\u00d775\u00d79\u00d712.5', size: '[ 150\u00d775\u00d79\u00d712.5', height: 150, width: 75, webThickness: 9, flangeThickness: 12.5, innerRadius: 15, tipRadius: 7.5, areaCm2: 30.59, massKgPerM: 24.0, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 180\u00d775\u00d77\u00d710.5', size: '[ 180\u00d775\u00d77\u00d710.5', height: 180, width: 75, webThickness: 7, flangeThickness: 10.5, innerRadius: 11, tipRadius: 5.5, areaCm2: 27.2, massKgPerM: 21.4, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 200\u00d780\u00d77.5\u00d711', size: '[ 200\u00d780\u00d77.5\u00d711', height: 200, width: 80, webThickness: 7.5, flangeThickness: 11, innerRadius: 12, tipRadius: 6, areaCm2: 31.33, massKgPerM: 24.6, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:[ 200\u00d790\u00d78\u00d713.5', size: '[ 200\u00d790\u00d78\u00d713.5', height: 200, width: 90, webThickness: 8, flangeThickness: 13.5, innerRadius: 14, tipRadius: 7, areaCm2: 38.65, massKgPerM: 30.3, verified: true, note: '' },
] as const satisfies readonly ChannelRow[];

export const H_BEAM_TABLE = [
  { key: 'JIS-G-3192:2024:H 100\u00d7100\u00d76\u00d78', size: 'H 100\u00d7100\u00d76\u00d78', height: 100, width: 100, webThickness: 6, flangeThickness: 8, innerRadius: 8, areaCm2: 21.59, massKgPerM: 16.9, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:H 125\u00d7125\u00d76.5\u00d79', size: 'H 125\u00d7125\u00d76.5\u00d79', height: 125, width: 125, webThickness: 6.5, flangeThickness: 9, innerRadius: 8, areaCm2: 30.0, massKgPerM: 23.6, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:H 150\u00d7150\u00d77\u00d710', size: 'H 150\u00d7150\u00d77\u00d710', height: 150, width: 150, webThickness: 7, flangeThickness: 10, innerRadius: 8, areaCm2: 39.65, massKgPerM: 31.1, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:H 175\u00d7175\u00d77.5\u00d711', size: 'H 175\u00d7175\u00d77.5\u00d711', height: 175, width: 175, webThickness: 7.5, flangeThickness: 11, innerRadius: 13, areaCm2: 51.43, massKgPerM: 40.4, verified: false, note: 'JISF \u306e PDF 1 \u4ef6\u306e\u307f(2\u4ef6\u76ee\u306e\u4e00\u89a7\u306b\u884c\u304c\u7121\u3044)' },
  { key: 'JIS-G-3192:2024:H 200\u00d7200\u00d78\u00d712', size: 'H 200\u00d7200\u00d78\u00d712', height: 200, width: 200, webThickness: 8, flangeThickness: 12, innerRadius: 13, areaCm2: 63.53, massKgPerM: 49.9, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:H 250\u00d7250\u00d79\u00d714', size: 'H 250\u00d7250\u00d79\u00d714', height: 250, width: 250, webThickness: 9, flangeThickness: 14, innerRadius: 13, areaCm2: 91.43, massKgPerM: 71.8, verified: true, note: '' },
  { key: 'JIS-G-3192:2024:H 300\u00d7300\u00d710\u00d715', size: 'H 300\u00d7300\u00d710\u00d715', height: 300, width: 300, webThickness: 10, flangeThickness: 15, innerRadius: 13, areaCm2: 118.5, massKgPerM: 93.0, verified: true, note: '' },
] as const satisfies readonly HBeamRow[];

const STEEL_DENSITY_KG_PER_M3 = 7_850;

/** Convert a cross-sectional area in cm2 to steel mass per metre. */
export function sectionMassFromArea(areaCm2: number): number {
  return areaCm2 * 1e-4 * STEEL_DENSITY_KG_PER_M3;
}

export function findEqualAngle(size: string): EqualAngleRow | undefined {
  return EQUAL_ANGLE_TABLE.find((row) => row.size === size);
}

export function findChannel(size: string): ChannelRow | undefined {
  return CHANNEL_TABLE.find((row) => row.size === size);
}

export function findHBeam(size: string): HBeamRow | undefined {
  return H_BEAM_TABLE.find((row) => row.size === size);
}
