/**
 * 外観の割り当て表の組み立て(FR-1106〜1110)。
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.2.2、タスク1。
 *
 * 割り当ては不変の配列として持ち、追加・差し替え・削除のたびに新しい配列を作る
 * (`part/createPartDocument.ts` の `appendSolid` / `replaceSolid` / `removeSolid` と
 * 同じ流儀。見つからない削除は元の表を同一参照のまま返し、無駄な作り直しをしない)。
 *
 * 同じ対象(立体 1 つ、または面 1 枚)に 2 つ以上の割り当てを重ねない。
 * `isSameAppearanceTarget` で既存の割り当てを探し、あれば差し替える(§2.2.2)。
 */

import { isSameSubShape } from '../geometry/subShapeRef.js';
import type { AppearanceEntry, AppearanceSpec, AppearanceTable, AppearanceTarget } from './types.js';

/** 割り当ての id の接頭辞。採番は「同じ接頭辞の既存 id の最大連番 + 1」(§0.a-0.19 と同じ規則)。 */
const APPEARANCE_ID_PREFIX = 'appearance-';

/** 空の表(§0.a-0.1)。起動時の文書(タスク2)がこれを入れる。 */
export function emptyAppearanceTable(): AppearanceTable {
  return { entries: [] };
}

/**
 * 同じ対象を指しているか(§2.2.2)。種類が違えば別対象。立体は id が一致するか、
 * 面は指紋の同一判定(`isSameSubShape`。ボディ・種類・通し番号が一致するか)で見る。
 */
export function isSameAppearanceTarget(a: AppearanceTarget, b: AppearanceTarget): boolean {
  if (a.kind === 'body' && b.kind === 'body') {
    return a.bodyFeatureId === b.bodyFeatureId;
  }
  if (a.kind === 'face' && b.kind === 'face') {
    return isSameSubShape(a.ref, b.ref);
  }
  return false;
}

function findEntry(table: AppearanceTable, target: AppearanceTarget): AppearanceEntry | undefined {
  return table.entries.find((entry) => isSameAppearanceTarget(entry.target, target));
}

/** 対象からボディの id を取り出す(立体はそのまま、面は参照先のボディの id)。 */
function targetBodyFeatureId(target: AppearanceTarget): string {
  return target.kind === 'body' ? target.bodyFeatureId : target.ref.bodyFeatureId;
}

/**
 * 既存の割り当ての id のうち `appearance-<n>` の形のものの最大連番 + 1 の id を作る
 * (`sketch/createSketchDocument.ts` の `nextSerialId` と同じ考え方)。1 つ消しても、
 * 残りの最大連番の次になるので他の割り当てと重複しない。
 */
export function nextAppearanceId(table: AppearanceTable): string {
  let max = 0;
  for (const entry of table.entries) {
    if (!entry.id.startsWith(APPEARANCE_ID_PREFIX)) {
      continue;
    }
    const serial = Number(entry.id.slice(APPEARANCE_ID_PREFIX.length));
    if (Number.isInteger(serial) && serial > max) {
      max = serial;
    }
  }
  return `${APPEARANCE_ID_PREFIX}${String(max + 1)}`;
}

/**
 * 割り当てを作る、または同じ対象の割り当てがあれば差し替える(§2.2.2「同じ対象に
 * 2 つ以上の割り当てがあってはならない」)。差し替えるときは id と対象を変えない。
 */
export function assignAppearance(
  table: AppearanceTable,
  target: AppearanceTarget,
  spec: AppearanceSpec,
): AppearanceTable {
  const existing = findEntry(table, target);
  if (existing !== undefined) {
    return {
      entries: table.entries.map((entry) =>
        entry === existing ? { ...entry, appearance: spec } : entry,
      ),
    };
  }
  const entry: AppearanceEntry = { id: nextAppearanceId(table), target, appearance: spec };
  return { entries: [...table.entries, entry] };
}

/**
 * 割り当てを 1 つ外す(FR-1110「割り当てを 1 つずつ…取り消せる」)。
 * 見つからなければ元の表を同一参照のまま返す(無駄な作り直しをしない)。
 */
export function removeAppearance(table: AppearanceTable, id: string): AppearanceTable {
  if (!table.entries.some((entry) => entry.id === id)) {
    return table;
  }
  return { entries: table.entries.filter((entry) => entry.id !== id) };
}

/** すべての割り当てを外し、既定の外観に戻す(FR-1110「すべて既定に戻す」)。 */
export function clearAppearance(table: AppearanceTable): AppearanceTable {
  if (table.entries.length === 0) {
    return table;
  }
  return { entries: [] };
}

/**
 * ボディの割り当てを引く。面の割り当ては、カーネルが指紋を選び直した結果(faceIndex)と
 * 突き合わせてから引く必要があるため、ここでは扱わない(§2.2.3、タスク3・4 の橋渡し)。
 */
export function bodyAppearanceOf(table: AppearanceTable, bodyFeatureId: string): AppearanceSpec | null {
  const entry = table.entries.find(
    (candidate) => candidate.target.kind === 'body' && candidate.target.bodyFeatureId === bodyFeatureId,
  );
  return entry?.appearance ?? null;
}

/**
 * 削除された・存在しなくなったボディを指す割り当てを落とす(掃除)。
 * `liveBodyIds` に無いボディ id を指す割り当て(立体そのもの、またはその面)を取り除く。
 * 何も変わらなければ元の表を同一参照のまま返す。
 */
export function pruneAppearance(
  table: AppearanceTable,
  liveBodyIds: readonly string[],
): AppearanceTable {
  const live = new Set(liveBodyIds);
  const kept = table.entries.filter((entry) => live.has(targetBodyFeatureId(entry.target)));
  if (kept.length === table.entries.length) {
    return table;
  }
  return { entries: kept };
}
