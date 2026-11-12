/**
 * JIS メートル並目・細目ねじ(M2〜M64)の採用データ(FR-406)。
 *
 * 呼び径と並目ピッチ、および本アプリで採用する細目ピッチを保持する。
 * 細目は各径に複数ある組合せから1値を採用しており、使用頻度の順位を意味しない。
 * 既存の採用値・保存値は変更しない。
 *
 * 公開メーカー表による28行の照合:
 * - OSG「シリーズNo.5 ねじ」2016.05改訂、PDF20頁（§14）「メートルねじのピッチ系列」
 *   https://www.osg.co.jp/en/media_dl/technical/file/t_5.pdf
 *   M2〜M60の呼び径・並目・採用細目を照合。
 * - YAMAWA「Quick Guide」p.50「for Metric Threads」のSize列でM64×6 / M64×4を照合。
 *   https://www.yamawa.eu/wp-content/themes/yamawa/pdf/Quick-Guide-Yamawa_EN.pdf
 *
 * D1とd2は60°の基本山形から計算する。NBK「一般用メートルねじ」PDF1頁の
 * 基準山形・公式・基準寸法とも照合。D1は基本内径であり、工具の下穴ドリル径や
 * 公差付き内径の上限ではない。メーカー表のドリル径へ置換しない。
 */

/** JIS の呼びとピッチ。表に持つのはこの2列だけで、残りは基本山形から計算する。 */
export interface MetricThreadSize {
  /** 呼び(例 'M6')。 */
  readonly designation: string;
  /** 呼び径 d(mm)。 */
  readonly diameter: number;
  /** 並目のピッチ(mm)。 */
  readonly coarsePitch: number;
  /** 本アプリで採用する細目のピッチ(mm)。同じ呼び径にある複数の細目のうち1値。 */
  readonly finePitch: number;
}

/** ねじ山の系列。並目 / 細目。 */
export type ThreadSeries = 'coarse' | 'fine';

/**
 * 表(M2〜M64、28行)。`D1` / `d2` の列は持たない(計算で出す)。
 * 呼び径の昇順に並べる。
 */
export const METRIC_THREADS: readonly MetricThreadSize[] = [
  { designation: 'M2', diameter: 2, coarsePitch: 0.4, finePitch: 0.25 },
  { designation: 'M2.5', diameter: 2.5, coarsePitch: 0.45, finePitch: 0.35 },
  { designation: 'M3', diameter: 3, coarsePitch: 0.5, finePitch: 0.35 },
  { designation: 'M3.5', diameter: 3.5, coarsePitch: 0.6, finePitch: 0.35 },
  { designation: 'M4', diameter: 4, coarsePitch: 0.7, finePitch: 0.5 },
  { designation: 'M5', diameter: 5, coarsePitch: 0.8, finePitch: 0.5 },
  { designation: 'M6', diameter: 6, coarsePitch: 1, finePitch: 0.75 },
  { designation: 'M8', diameter: 8, coarsePitch: 1.25, finePitch: 1 },
  { designation: 'M10', diameter: 10, coarsePitch: 1.5, finePitch: 1.25 },
  { designation: 'M12', diameter: 12, coarsePitch: 1.75, finePitch: 1.25 },
  { designation: 'M14', diameter: 14, coarsePitch: 2, finePitch: 1.5 },
  { designation: 'M16', diameter: 16, coarsePitch: 2, finePitch: 1.5 },
  { designation: 'M18', diameter: 18, coarsePitch: 2.5, finePitch: 1.5 },
  { designation: 'M20', diameter: 20, coarsePitch: 2.5, finePitch: 1.5 },
  { designation: 'M22', diameter: 22, coarsePitch: 2.5, finePitch: 1.5 },
  { designation: 'M24', diameter: 24, coarsePitch: 3, finePitch: 2 },
  { designation: 'M27', diameter: 27, coarsePitch: 3, finePitch: 2 },
  { designation: 'M30', diameter: 30, coarsePitch: 3.5, finePitch: 2 },
  { designation: 'M33', diameter: 33, coarsePitch: 3.5, finePitch: 2 },
  { designation: 'M36', diameter: 36, coarsePitch: 4, finePitch: 3 },
  { designation: 'M39', diameter: 39, coarsePitch: 4, finePitch: 3 },
  { designation: 'M42', diameter: 42, coarsePitch: 4.5, finePitch: 3 },
  { designation: 'M45', diameter: 45, coarsePitch: 4.5, finePitch: 3 },
  { designation: 'M48', diameter: 48, coarsePitch: 5, finePitch: 3 },
  { designation: 'M52', diameter: 52, coarsePitch: 5, finePitch: 3 },
  { designation: 'M56', diameter: 56, coarsePitch: 5.5, finePitch: 4 },
  { designation: 'M60', diameter: 60, coarsePitch: 5.5, finePitch: 4 },
  { designation: 'M64', diameter: 64, coarsePitch: 6, finePitch: 4 },
];

/** `Math.sqrt(3)` を毎回計算しないための定数。基本山形(60°三角形)の高さの係数に使う。 */
const SQRT_3 = Math.sqrt(3);

/** 基本山形の高さ H = P·√3/2(ISO 68-1)。 */
export function threadTriangleHeight(pitch: number): number {
  return (pitch * SQRT_3) / 2;
}

/**
 * めねじ内径 D1 = d − 2·(5/8)H = d − (5√3/8)·P(ISO 68-1 の基本山形)。
 * 下穴の径にも使う。工具のドリル径(JIS B 1004)とは別の値(§2.5.2)。
 */
export function threadMinorDiameter(diameter: number, pitch: number): number {
  return diameter - 2 * (5 / 8) * threadTriangleHeight(pitch);
}

/** 有効径 d2 = d − 2·(3/8)H = d − (3√3/8)·P(ISO 68-1 の基本山形)。図面で使う。 */
export function threadPitchDiameter(diameter: number, pitch: number): number {
  return diameter - 2 * (3 / 8) * threadTriangleHeight(pitch);
}

/**
 * 呼びからサイズを探す。大文字小文字を区別する(表の `designation` は 'M6' のように
 * 大文字の M で始まるため、'm6' は見つからない扱いとする)。見つからなければ `undefined`。
 */
export function findMetricThread(designation: string): MetricThreadSize | undefined {
  return METRIC_THREADS.find((size) => size.designation === designation);
}

/** 指定した系列(並目/細目)のピッチを返す。 */
export function metricThreadPitch(size: MetricThreadSize, series: ThreadSeries): number {
  switch (series) {
    case 'coarse':
      return size.coarsePitch;
    case 'fine':
      return size.finePitch;
  }
}

/** 呼びの一覧(その場入力とプロパティの選択肢)。表の並びのまま(呼び径の昇順)。 */
export const METRIC_THREAD_DESIGNATIONS: readonly string[] =
  METRIC_THREADS.map((size) => size.designation);

/** 既定の呼び。最も使われるサイズ(M6)。 */
export const DEFAULT_THREAD_DESIGNATION = 'M6';
