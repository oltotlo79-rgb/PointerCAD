import type {
  BearingSeries, DeepGrooveBallBearingRow, StandardTableSource,
} from './types.js';

export const DEEP_GROOVE_BALL_BEARING_SOURCE = {
  standard: 'JIS B 1521 / JIS B 1513',
  edition: '2012 / 1995',
  title: '転がり軸受―深溝玉軸受 / 転がり軸受の呼び番号',
  scope: '6000・6200・6300系列、内径10〜50mm',
  sourceUrls: [
    'https://www.nsk.com/jp-ja/engineering/6000-apn.html',
    'https://hayamihyou.net/bearing/',
    'https://webdesk.jsa.or.jp/books/W11M0090/index/?bunsyo_id=JIS+B+1521:2012',
  ],
  verified: true,
} as const satisfies StandardTableSource;

/** docs/standards/jis/deep-groove-ball-bearing-jis-b-1521.json の確認済み行から採った15行。 */
export const DEEP_GROOVE_BALL_BEARINGS = [
  { key: 'JIS-B-1521:2012:6000', size: '6000', series: '6000', boreDiameter: 10, outsideDiameter: 26, width: 8, minimumChamfer: 0.3, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6004', size: '6004', series: '6000', boreDiameter: 20, outsideDiameter: 42, width: 12, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6006', size: '6006', series: '6000', boreDiameter: 30, outsideDiameter: 55, width: 13, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6008', size: '6008', series: '6000', boreDiameter: 40, outsideDiameter: 68, width: 15, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6010', size: '6010', series: '6000', boreDiameter: 50, outsideDiameter: 80, width: 16, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6200', size: '6200', series: '6200', boreDiameter: 10, outsideDiameter: 30, width: 9, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6204', size: '6204', series: '6200', boreDiameter: 20, outsideDiameter: 47, width: 14, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6206', size: '6206', series: '6200', boreDiameter: 30, outsideDiameter: 62, width: 16, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6208', size: '6208', series: '6200', boreDiameter: 40, outsideDiameter: 80, width: 18, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6210', size: '6210', series: '6200', boreDiameter: 50, outsideDiameter: 90, width: 20, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6300', size: '6300', series: '6300', boreDiameter: 10, outsideDiameter: 35, width: 11, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6304', size: '6304', series: '6300', boreDiameter: 20, outsideDiameter: 52, width: 15, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6306', size: '6306', series: '6300', boreDiameter: 30, outsideDiameter: 72, width: 19, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6308', size: '6308', series: '6300', boreDiameter: 40, outsideDiameter: 90, width: 23, minimumChamfer: 1.5, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6310', size: '6310', series: '6300', boreDiameter: 50, outsideDiameter: 110, width: 27, minimumChamfer: 2, verified: true, note: '' },
] as const satisfies readonly DeepGrooveBallBearingRow[];

export function bearingBoreFromDesignation(designation: string): number | null {
  if (!/^[0-9]{4}$/.test(designation)) return null;
  const code = Number(designation.slice(-2));
  if (code === 0) return 10;
  if (code === 1) return 12;
  if (code === 2) return 15;
  if (code === 3) return 17;
  return code * 5;
}

export function bearingSizes(series?: BearingSeries): readonly string[] {
  return DEEP_GROOVE_BALL_BEARINGS
    .filter((row) => series === undefined || row.series === series)
    .map((row) => row.size);
}

export function findDeepGrooveBallBearing(
  designation: string,
): DeepGrooveBallBearingRow | undefined {
  return DEEP_GROOVE_BALL_BEARINGS.find((row) => row.size === designation);
}
