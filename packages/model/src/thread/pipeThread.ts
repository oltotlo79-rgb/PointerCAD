/**
 * 管用テーパねじ(JIS B 0203:1999。テーパおねじ R、テーパめねじ Rc、平行めねじ Rp)の基準寸法(mm)。ガス管の継手(K-28)のねじの呼びと、
 * ねじ穴の簡略形状(基準径の位置の谷の径の円柱)、管の端の差し込みの長さ(基準の長さ a)に使う。山は作らない。
 *
 * 出どころ(資料の番号・URL・発行元は担当の資料の記録だけに置く。製品には JIS の番号と版の年だけ):
 * - 呼び 1/16〜1 1/2: 2 つの公開の資料の JIS B 0203 の表で、全部の欄が一致した値。
 * - 呼び 2〜6: 基準径(外径)・ねじ山数・基準の長さ a は 2 つの公開の資料で一致した値。有効径・谷の径は規格の式(h = 0.640327P、
 *   d2 = d − h、d1 = d − 2h)で外径とピッチから 1 つに決まる値で、表の値とも一致する。
 * - ピッチは 25.4 ÷ ねじ山数(表の参考の値と同じ 4 桁)。照らす側の値は catalog/families/pipeFittingOracle.fixture.json。
 */

interface PipeTaperThread {
  /** 呼び(ねじの記号 R・Rc・Rp を除いた部分。例: '1/2'、'1 1/4')。 */
  readonly size: string;
  /** ねじ山数(25.4 mm につき)。 */
  readonly threadsPerInch: number;
  readonly pitch: number;
  /** 山の高さ h と丸み r。 */
  readonly height: number;
  readonly roundness: number;
  /** 基準径の位置の外径 d(めねじの谷の径 D)・有効径 d2・谷の径 d1(めねじの内径 D1)。 */
  readonly majorDiameter: number;
  readonly pitchDiameter: number;
  readonly minorDiameter: number;
  /** 管端からの基準径の位置までの基準の長さ a。 */
  readonly gaugeLength: number;
}

type Row = readonly [string, number, number, number, number, number, number, number, number];

/** [呼び, 山数, ピッチ, 山の高さ, 丸み, 外径, 有効径, 谷の径, 基準の長さ]。 */
const ROWS: readonly Row[] = [
  ['1/16', 28, 0.9071, 0.581, 0.12, 7.723, 7.142, 6.561, 3.97],
  ['1/8', 28, 0.9071, 0.581, 0.12, 9.728, 9.147, 8.566, 3.97],
  ['1/4', 19, 1.3368, 0.856, 0.18, 13.157, 12.301, 11.445, 6.01],
  ['3/8', 19, 1.3368, 0.856, 0.18, 16.662, 15.806, 14.95, 6.35],
  ['1/2', 14, 1.8143, 1.162, 0.25, 20.955, 19.793, 18.631, 8.16],
  ['3/4', 14, 1.8143, 1.162, 0.25, 26.441, 25.279, 24.117, 9.53],
  ['1', 11, 2.3091, 1.479, 0.32, 33.249, 31.77, 30.291, 10.39],
  ['1 1/4', 11, 2.3091, 1.479, 0.32, 41.91, 40.431, 38.952, 12.7],
  ['1 1/2', 11, 2.3091, 1.479, 0.32, 47.803, 46.324, 44.845, 12.7],
  ['2', 11, 2.3091, 1.479, 0.32, 59.614, 58.135, 56.656, 15.88],
  ['2 1/2', 11, 2.3091, 1.479, 0.32, 75.184, 73.705, 72.226, 17.46],
  ['3', 11, 2.3091, 1.479, 0.32, 87.884, 86.405, 84.926, 20.64],
  ['4', 11, 2.3091, 1.479, 0.32, 113.03, 111.551, 110.072, 25.4],
  ['5', 11, 2.3091, 1.479, 0.32, 138.43, 136.951, 135.472, 28.58],
  ['6', 11, 2.3091, 1.479, 0.32, 163.83, 162.351, 160.872, 28.58],
];

const PIPE_TAPER_THREADS: readonly PipeTaperThread[] = ROWS.map(
  ([size, threadsPerInch, pitch, height, roundness, majorDiameter, pitchDiameter, minorDiameter, gaugeLength]) =>
    ({ size, threadsPerInch, pitch, height, roundness, majorDiameter, pitchDiameter, minorDiameter, gaugeLength }));

/** 呼び(記号を除いた部分)の管用テーパねじ。表に無い呼びは undefined。 */
export function findPipeTaperThread(size: string): PipeTaperThread | undefined {
  return PIPE_TAPER_THREADS.find((thread) => thread.size === size);
}
