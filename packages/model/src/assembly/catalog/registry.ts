/**
 * 規格部品の族の登録口(設計 案 C)。
 *
 * 族の表は**必要な時だけ読む**。登録口が最初から持つのは各族の id・分類・種類の鍵と、表を読む入口(`load`)だけで、
 * 表そのものは `ensure` を待った後に `loaded` で引ける。model の組み立ては同期なので、文書を開く道と選ぶ画面は
 * `ensure` を待ってから解決する。読み込みの前に解決された部品は、黙って消さず「読み込み中」の型付きの拒否になる
 * (`catalog/source.ts`)。
 *
 * **族を足す包みは、このファイルを触らない。** 自分の包みの一覧 `catalog/registry/<包み>.ts` に 1 行を足し、
 * 族の本体は `catalog/families/<族>.ts` に置く(包みどうしが同じファイルを取り合わないため)。
 */
import { K4A_CATALOG_FAMILIES } from './registry/k4a.js';
import { K4B_CATALOG_FAMILIES } from './registry/k4b.js';
import { K6_CATALOG_FAMILIES } from './registry/k6.js';
import type { CatalogFamily, CatalogFamilyEntry } from './types.js';

/** 保存の形(`options.family`・`options.item`)が使う鍵。族の options の指定には使えない。 */
const RESERVED_OPTION_KEYS: ReadonlySet<string> = new Set(['family', 'item']);

export interface CatalogRegistry {
  readonly entries: readonly CatalogFamilyEntry[];
  /** 登録された族の入口。知らない id は undefined。 */
  entry(id: string): CatalogFamilyEntry | undefined;
  /** 読み込み済みの族。未登録か、まだ読んでいなければ undefined。 */
  loaded(id: string): CatalogFamily | undefined;
  /** 指定の族を読み込む。知らない id は飛ばす(その部品は「知らない種類」の拒否になる)。 */
  ensure(ids: Iterable<string>): Promise<void>;
}

/** 族の定義の誤り(作る側の誤り)。見つけた物を全て返す。 */
function catalogFamilyIssues(entry: CatalogFamilyEntry, family: CatalogFamily): readonly string[] {
  const issues: string[] = [];
  if (family.id !== entry.id || family.group !== entry.group || family.kindKey !== entry.kindKey) {
    issues.push(`entry and family disagree on id, group or kindKey (${entry.id})`);
  }
  if (family.catalogRevision.trim() === '' || family.generatorRevision.trim() === '') issues.push('empty revision');
  const optionKeys = family.options.map((spec) => spec.key);
  if (new Set(optionKeys).size !== optionKeys.length) issues.push('duplicate option key');
  for (const spec of family.options) {
    if (spec.key.trim() === '' || RESERVED_OPTION_KEYS.has(spec.key)) issues.push(`reserved or empty option key: ${spec.key}`);
    if (spec.kind === 'choice' && !(spec.choices ?? []).includes(spec.defaultValue)) {
      issues.push(`default is not a choice: ${spec.key}`);
    }
  }
  const rowKeys = family.rows.map((row) => row.key);
  if (rowKeys.some((key) => key.trim() === '') || new Set(rowKeys).size !== rowKeys.length) {
    issues.push('empty or duplicate row key');
  }
  return issues;
}

/** 登録口を作る。製品は下の `PRODUCT_CATALOG_REGISTRY` を使い、検査は自分の族だけの登録口を作れる。 */
export function createCatalogRegistry(entries: readonly CatalogFamilyEntry[]): CatalogRegistry {
  const byId = new Map<string, CatalogFamilyEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`規格部品の族の id が重なっています: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const loadedFamilies = new Map<string, CatalogFamily>();
  const pending = new Map<string, Promise<void>>();
  const loadOne = async (entry: CatalogFamilyEntry): Promise<void> => {
    const family = await entry.load();
    const issues = catalogFamilyIssues(entry, family);
    if (issues.length > 0) throw new Error(`規格部品の族の定義に誤りがあります(${entry.id}): ${issues.join(' / ')}`);
    loadedFamilies.set(entry.id, family);
  };
  return {
    entries: [...entries],
    entry: (id) => byId.get(id),
    loaded: (id) => loadedFamilies.get(id),
    ensure: async (ids) => {
      const waits: Promise<void>[] = [];
      for (const id of new Set(ids)) {
        const entry = byId.get(id);
        if (entry === undefined || loadedFamilies.has(id)) continue;
        // 同じ族を同時に 2 回読まない。失敗した時は次の ensure で読み直せるよう、待ちの記録を消す。
        const wait = pending.get(id) ?? loadOne(entry).finally(() => { pending.delete(id); });
        pending.set(id, wait);
        waits.push(wait);
      }
      await Promise.all(waits);
    },
  };
}

/** 製品の登録口。包みごとの一覧を合わせるだけで、族の表はここでは読まない。 */
export const PRODUCT_CATALOG_REGISTRY: CatalogRegistry = createCatalogRegistry([
  ...K4A_CATALOG_FAMILIES,
  ...K4B_CATALOG_FAMILIES,
  ...K6_CATALOG_FAMILIES,
]);
