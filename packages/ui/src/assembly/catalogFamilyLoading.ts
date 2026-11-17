/**
 * 規格部品の族(保存の catalog が `catalogItem`)の表を、登録口から読み込んで待つ(設計 案 C §5.4)。
 *
 * model の組み立ては同期なので、族の表は組む前に読み込んでおく。読み込むのは、文書を開いて組む道
 * (`attachAssembly.ts` の calculate、図面の `prepareAssemblyDrawingSource.ts`)と、選ぶ画面を開いた時の 3 か所。
 * 読み込みが断られても文書は変えない。その族の部品は model の型付きの拒否(読み込み中)のまま残り、帯に
 * 150 字以内の文を 1 つ出す(開き直すと、登録口がもう一度読み込む)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry, type ComponentSource } from '@pointercad/model';

import { t } from '../i18n/t.js';

type StandardPartSource = Extract<ComponentSource, { readonly kind: 'standardPart' }>;

/** 族の部品の族の id(重なりなし・出てきた順)。族の id を持たない保存は飛ばす(組む時に型付きの拒否になる)。 */
export function catalogFamilyIdsOf(sources: Iterable<StandardPartSource>): readonly string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    const family = source.catalog === 'catalogItem' ? source.options.family : undefined;
    if (family !== undefined && family.trim() !== '') ids.add(family);
  }
  return [...ids];
}

/**
 * 文書の族の部品の族を読み込む。族の部品が無い時は登録口を呼ばない。断られた時は帯に出す文を 1 つ返す
 * (文書・保存はここでは触らない)。
 */
export async function ensureDocumentCatalogFamilies(sources: Iterable<StandardPartSource>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): Promise<readonly string[]> {
  const ids = catalogFamilyIdsOf(sources);
  if (ids.length === 0) return [];
  try {
    await registry.ensure(ids);
    return [];
  } catch {
    return [t('catalog.loading.documentFailed')];
  }
}

/** 選ぶ画面の族の表の状態。'none' はその分類に登録された族が無い時(画面には何も出さない)。 */
export type CatalogLoadState = 'none' | 'loading' | 'ready' | 'failed';

/**
 * 選ぶ画面で選んだ族の分類(機械要素・アルミフレーム)の族だけを読み込み、状態を「読み込み中 → 済み／失敗」の順に知らせる。
 * 窓を開いた時に全部の族を読まない(族が増えても開く時が重くならないように。統括の決定 2026-11-17)。読み込み済みなら待たずに「済み」。
 * `alive()` が偽になった後(窓を閉じた・分類を替えた後)は、終わっても知らせない。
 */
export async function loadRegisteredCatalogFamilies(registry: CatalogRegistry,
  report: (state: CatalogLoadState) => void, alive: () => boolean, group: string): Promise<void> {
  const ids = registry.entries.filter((entry) => entry.group === group).map((entry) => entry.id);
  if (ids.length === 0) { report('none'); return; }
  if (ids.every((id) => registry.loaded(id) !== undefined)) { report('ready'); return; }
  report('loading');
  try {
    await registry.ensure(ids);
    if (alive()) report('ready');
  } catch {
    if (alive()) report('failed');
  }
}
