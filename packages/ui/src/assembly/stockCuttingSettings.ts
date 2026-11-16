/**
 * 定尺・切断代の設定(J-01 包み 7)。文書には保存せず、端末の表示の設定(DisplaySettings の stockCutting)に持つ
 * (統括の決定 2026-11-16)。初めは 定尺 なし(指定しない)・切断代 0 で、推測の定尺を初めの値にしない。
 * 利用者が定尺を入れた時だけ、切断の一覧の下に定尺への割り付けと歩留まりを出す。
 */

export interface StockCuttingSettings {
  /** 定尺(mm)。null は指定しない(歩留まりを出さない)。 */
  readonly stockLengthMm: number | null;
  /** 切断代(mm)。1 本の棒の中で、部材と部材の間ごとに 1 回差し引く。 */
  readonly kerfMm: number;
}

export const DEFAULT_STOCK_CUTTING: StockCuttingSettings = Object.freeze({ stockLengthMm: null, kerfMm: 0 });

/** 保存された値を読む。無い・壊れている・範囲の外の欄は、欄ごとに初めの値へ戻す(ほかの設定には触れない)。 */
export function readStockCuttingSettings(value: unknown): StockCuttingSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_STOCK_CUTTING;
  const stock: unknown = 'stockLengthMm' in value ? value.stockLengthMm : null;
  const kerf: unknown = 'kerfMm' in value ? value.kerfMm : 0;
  return {
    stockLengthMm: typeof stock === 'number' && Number.isFinite(stock) && stock > 0 ? stock : null,
    kerfMm: typeof kerf === 'number' && Number.isFinite(kerf) && kerf >= 0 ? kerf : 0,
  };
}
