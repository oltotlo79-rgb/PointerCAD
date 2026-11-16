/**
 * 定尺の棒への切り出しの割り付けと歩留まり(J-01 包み 7)。切断の一覧の行(長さ・本数)を、利用者が入れた定尺の棒へ詰める。
 * 割り付けは長い順に詰める簡単な方法(先に入る棒へ入れる)で、最も少ない本数を保証する物ではない(画面の説明に書く)。
 * 切断代は 1 本の棒の中で、部材と部材の間ごとに 1 回差し引く(棒の端の切り落としは数えない)。
 * 歩留まり = 部材の長さの合計 ÷(使う棒の本数 × 定尺)。定尺・切断代は文書に保存しない(アプリの設定。統括の決定 2026-11-16)。
 */

/** 切る部材の 1 行(鍵は表示と照らし合わせのため。本数ぶん切る)。 */
export interface StockCut {
  readonly key: string;
  readonly lengthMm: number;
  readonly quantity: number;
}

/** 棒 1 本の割り付け(切る順は長い順)。 */
interface StockBar {
  readonly cuts: readonly { readonly key: string; readonly lengthMm: number }[];
  readonly usedMm: number;
  readonly offcutMm: number;
}

export type StockCuttingResult =
  | { readonly ok: true; readonly bars: readonly StockBar[]; readonly totalCutMm: number; readonly yieldRatio: number }
  | { readonly ok: false; readonly reason: 'invalidStock' | 'invalidKerf' | 'invalidCut' | 'tooLong'; readonly key: string | null };

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** 部材の行を定尺の棒へ長い順に詰める。部材が定尺より長い時・数でない時は割り付けない。 */
export function planStockCutting(cuts: readonly StockCut[], stockLengthMm: number, kerfMm: number): StockCuttingResult {
  if (!Number.isFinite(stockLengthMm) || !(stockLengthMm > 0)) return { ok: false, reason: 'invalidStock', key: null };
  if (!Number.isFinite(kerfMm) || kerfMm < 0) return { ok: false, reason: 'invalidKerf', key: null };
  const pieces: { readonly key: string; readonly lengthMm: number }[] = [];
  for (const cut of cuts) {
    if (!Number.isFinite(cut.lengthMm) || !(cut.lengthMm > 0) || !Number.isInteger(cut.quantity) || cut.quantity < 0) {
      return { ok: false, reason: 'invalidCut', key: cut.key };
    }
    if (cut.lengthMm > stockLengthMm) return { ok: false, reason: 'tooLong', key: cut.key };
    for (let index = 0; index < cut.quantity; index += 1) pieces.push({ key: cut.key, lengthMm: cut.lengthMm });
  }
  // 長い順(同じ長さは入れた順)。sort は安定なので入れた順が保たれる。
  pieces.sort((a, b) => b.lengthMm - a.lengthMm);
  const bars: { cuts: { readonly key: string; readonly lengthMm: number }[]; usedMm: number }[] = [];
  for (const piece of pieces) {
    const bar = bars.find((candidate) => candidate.usedMm + kerfMm + piece.lengthMm <= stockLengthMm + 1e-9);
    if (bar === undefined) bars.push({ cuts: [piece], usedMm: piece.lengthMm });
    else { bar.cuts.push(piece); bar.usedMm += kerfMm + piece.lengthMm; }
  }
  const totalCutMm = round(pieces.reduce((sum, piece) => sum + piece.lengthMm, 0));
  return {
    ok: true, totalCutMm,
    bars: bars.map((bar) => ({ cuts: bar.cuts, usedMm: round(bar.usedMm), offcutMm: round(stockLengthMm - bar.usedMm) })),
    yieldRatio: bars.length === 0 ? 0 : totalCutMm / (bars.length * stockLengthMm),
  };
}
