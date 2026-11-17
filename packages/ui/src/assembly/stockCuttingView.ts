/**
 * 切断の一覧の下に出す、定尺への割り付けと歩留まりの文字(J-01 包み 7)。同じ断面の部材だけを同じ棒に詰めるので、
 * 行を組(鋼材の行・族の呼び)ごとに分けて model の `planStockCutting` で割り付ける。定尺が無い時は割り付けない。
 */
import { planStockCutting, type SteelStockList } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { StockCuttingSettings } from './stockCuttingSettings.js';

/** 割り付けの元にする行(同じ group の行だけを同じ棒に詰める)。 */
export interface StockCuttingRow {
  readonly group: string;
  readonly label: string;
  readonly lengthMm: number;
  readonly quantity: number;
}

/** 組ごとの要約(棒の本数・歩留まり、または割り付けられない理由)と、棒ごとの切り出し。 */
interface StockCuttingGroupView {
  readonly summary: string;
  readonly bars: readonly string[];
}

export type StockCuttingView =
  | { readonly kind: 'noStock' }
  | { readonly kind: 'groups'; readonly groups: readonly StockCuttingGroupView[] };

const fill = (key: MessageKey, values: Readonly<Record<string, string | number>>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));

const tidy = (value: number): string => String(Math.round(value * 1e6) / 1e6);

/** 鋼材の切断の一覧の行(同じ鋼材の行〔鋼種・断面・呼び〕を同じ組にする。長さ違いも同じ棒に詰める)。 */
export function steelStockCuttingRows(rows: SteelStockList['rows']): readonly StockCuttingRow[] {
  return rows.map((row) => ({ group: row.product.key, label: `${row.product.materialGrade} ${row.product.size}`,
    lengthMm: row.lengthMm, quantity: row.quantity }));
}

/**
 * 留めで 45° に切った族の部材の添え書き(J-01 包み 5。留めの無い行は空)。切断の一覧の表の呼びと、CSV の注記の列に同じ文字を使う。
 * 定尺の割り付けは長い側の長さ(行の長さ)で数える(切る前の棒の長さ)。
 */
export function catalogMiterNote(row: Pick<SteelStockList['catalogRows'][number], 'miterEnds'>): string {
  return row.miterEnds === 0 ? '' : t('catalog.stock.miterNote').split('{count}').join(String(row.miterEnds));
}

/** 族の切断の一覧の行(同じ族の同じ呼びを同じ組にする)。`kindLabel` は種類の名前。 */
export function catalogStockCuttingRows(rows: SteelStockList['catalogRows'], kindLabel: (kindKey: string) => string):
readonly StockCuttingRow[] {
  return rows.map((row) => ({ group: `${row.familyId}:${row.size}`, label: `${kindLabel(row.kindKey)} ${row.size}`,
    lengthMm: row.lengthMm, quantity: row.quantity }));
}

/** 行と設定から、組ごとの割り付けの文字を作る。定尺が無い時は noStock(「定尺を入れると出す」の案内を出す)。 */
export function stockCuttingView(rows: readonly StockCuttingRow[], settings: StockCuttingSettings): StockCuttingView {
  const stock = settings.stockLengthMm;
  if (stock === null) return { kind: 'noStock' };
  const groups = new Map<string, StockCuttingRow[]>();
  for (const row of rows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  return { kind: 'groups', groups: [...groups.values()].map((members) => {
    const label = members[0]?.label ?? '';
    const plan = planStockCutting(members.map((row) => ({ key: tidy(row.lengthMm), lengthMm: row.lengthMm, quantity: row.quantity })),
      stock, settings.kerfMm);
    if (!plan.ok) return { summary: fill('catalog.stockCutting.tooLong', { label, length: plan.key ?? '' }), bars: [] };
    return {
      summary: fill('catalog.stockCutting.summary', { label, count: plan.bars.length, yield: (plan.yieldRatio * 100).toFixed(1) }),
      bars: plan.bars.map((bar, index) => fill('catalog.stockCutting.bar', { n: index + 1,
        cuts: bar.cuts.map((cut) => tidy(cut.lengthMm)).join(' + '), offcut: tidy(bar.offcutMm) })),
    };
  }) };
}
