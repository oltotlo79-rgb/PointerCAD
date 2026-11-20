/**
 * ねじ込み式可鍛鋳鉄製管継手(JIS B 2301)の呼びの対と継手の端部の寸法(K-28)。エルボ・チーズ・ソケット(束 1)と、キャップ・プラグ・
 * 六角ニップル・ブッシング(束 2)が同じ表を使う。
 *
 * 寸法(資料の番号・URL・発行元は担当の資料の記録だけに置く。製品には JIS の番号だけ):
 * - 合う管の呼び(A)とねじの呼び(B)の対: 2 つの公開の資料の呼びの欄で一致した対(6A＝1/8 … 150A＝6)。
 * - めねじ側の外径 A1・めねじ部の長さ l′・おねじ部の長さ l(どれも参考寸法): 2 つの公開の資料の継手の端部の寸法の表で一致した値。
 * 照らす側の値は pipeFittingOracle.fixture.json(A1・l′)と pipeFittingPartOracle.fixture.json(l)。
 */

interface PipeFittingEnd {
  /** ねじの呼び(B。記号 R・Rc を除いた部分。例 '1/2'、'1 1/4')。 */
  readonly thread: string;
  /** 合う管の呼び(A の数。例 15)。 */
  readonly pipeSize: number;
  /** めねじ側の外径 A1(mm)。 */
  readonly outerDiameter: number;
  /** めねじ部の長さ l′(mm)。 */
  readonly femaleThreadLength: number;
  /** おねじ部の長さ l(mm)。 */
  readonly maleThreadLength: number;
}

/** [B, A, A1, l′, l]。 */
type EndRecord = readonly [string, number, number, number, number];

const RECORDS: readonly EndRecord[] = [
  ['1/8', 6, 15, 6, 8], ['1/4', 8, 19, 8, 11], ['3/8', 10, 23, 9, 12], ['1/2', 15, 27, 11, 15], ['3/4', 20, 33, 13, 17],
  ['1', 25, 41, 15, 19], ['1 1/4', 32, 50, 17, 22], ['1 1/2', 40, 56, 18, 22], ['2', 50, 69, 20, 26], ['2 1/2', 65, 86, 23, 30],
  ['3', 80, 99, 25, 34], ['4', 100, 127, 28, 40], ['5', 125, 154, 30, 44], ['6', 150, 182, 33, 44],
];

const ENDS: readonly PipeFittingEnd[] = RECORDS.map(([thread, pipeSize, outerDiameter, femaleThreadLength, maleThreadLength]) =>
  ({ thread, pipeSize, outerDiameter, femaleThreadLength, maleThreadLength }));

/** ねじの呼び(B)の端部の寸法。表に無い呼びは undefined。 */
export function pipeFittingEnd(thread: string): PipeFittingEnd | undefined {
  return ENDS.find((end) => end.thread === thread);
}

/** 合う管の呼び(A の数)の端部の寸法(鋼管の端の継手の組が、管の呼びからねじの呼びを引く)。表に無い呼びは undefined。 */
export function pipeFittingEndForPipe(pipeSize: number): PipeFittingEnd | undefined {
  return ENDS.find((end) => end.pipeSize === pipeSize);
}
