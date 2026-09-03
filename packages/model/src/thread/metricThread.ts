/**
 * JIS メートル並目・細目ねじ(M2〜M64)の規格データ(計画書 docs/plans/P3-加工フィーチャー.md
 * §2.5、§0.a-0.13、§0.a-0.14、FR-406)。
 *
 * 表に持つのは呼び径 `d` とピッチ `P` の2列だけで、めねじ内径 `D1` と有効径 `d2` は
 * ISO 68-1 の基本山形(60°の三角形)の式から計算する。写し間違いの可能性を
 * 「呼び径・ピッチ」の2列だけに閉じ込め、残りは検算できる形にするため(§0.a-0.13)。
 *
 * 出典: 呼び径とピッチの組合せは JIS B 0205-4「一般用メートルねじ―第4部:基準寸法」
 * (ISO 261 / ISO 262 に対応)による。並目ピッチは ISO 261 の第1選択・第2選択の
 * 呼び径に対する値。細目ピッチは ISO 262 の「選択サイズ」のうち、1つの呼び径に
 * 複数定められている中から最も一般的な1つを選んだもの(§2.5.2)。
 *
 * タスク11 手順1 の照合: 並目ピッチ28行は担当(作業担当)が自分の知識で独立に
 * 検算し、計画書の値と一致することを確認した(食い違いなし)。細目ピッチは
 * ISO 262 が1呼び径に複数の値を許すため、「最も一般的な1つ」という選び方自体が
 * 統括の判断待ちの論点であり(§2.5.2)、担当は実物の規格表と1行ずつ完全に
 * 照合しきれていない。**要確認**: 統括が原典(JIS B 0205-4 または ISO 262)で
 * 細目ピッチの選び方(1つに絞る/複数を持つ)と各値を確かめること。
 */

/** JIS の呼びとピッチ。表に持つのはこの2列だけで、残りは基本山形から計算する。 */
export interface MetricThreadSize {
  /** 呼び(例 'M6')。 */
  readonly designation: string;
  /** 呼び径 d(mm)。 */
  readonly diameter: number;
  /** 並目のピッチ(mm)。 */
  readonly coarsePitch: number;
  /** 細目のピッチ(mm)。複数あるうち最も一般的な1つ(§2.5.2 の注記、要確認)。 */
  readonly finePitch: number;
}

/** ねじ山の系列。並目 / 細目。 */
export type ThreadSeries = 'coarse' | 'fine';

/**
 * 表(M2〜M64、28行)。`D1` / `d2` の列は持たない(計算で出す、§0.a-0.13)。
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
 * 下穴の径にも使う(§0.a-0.14)。工具のドリル径(JIS B 1004)とは別の値(§2.5.2)。
 */
export function threadMinorDiameter(diameter: number, pitch: number): number {
  return diameter - 2 * (5 / 8) * threadTriangleHeight(pitch);
}

/** 有効径 d2 = d − 2·(3/8)H = d − (3√3/8)·P(ISO 68-1 の基本山形)。P6 の図面で使う。 */
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

/** 既定の呼び。最も使われるサイズ(§0.a-0.13 の例にも使われている M6)。 */
export const DEFAULT_THREAD_DESIGNATION = 'M6';
