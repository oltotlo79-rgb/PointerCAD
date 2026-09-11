/** 継ぎ目の保存参照を、加工で分割された実接続へ解決する。座標による推測はしない。 */
import type { SheetGeometryResult } from './panelGeometry.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';

export function resolveSheetSeams(body: ResolvedSheetBody, references: readonly string[]): SheetGeometryResult<readonly string[]> {
  const current = new Set(body.bends.map((bend) => bend.id)), result = new Set<string>();
  if (references.some((id) => id.trim() === '') || new Set(references).size !== references.length)
    return { ok: false, message: '継ぎ目を重複なく指定してください。' };
  for (const reference of references) {
    const mapped = current.has(reference) ? [reference] : body.connectionAliases?.get(reference);
    if (mapped === undefined || mapped.some((id) => !current.has(id)))
      return { ok: false, message: '指定した継ぎ目が見つかりません。元の接続を確認してください。' };
    for (const id of mapped) {
      if (result.has(id)) return { ok: false, message: '同じ接続を複数の継ぎ目から指定しています。継ぎ目を選び直してください。' };
      result.add(id);
    }
  }
  return { ok: true, value: [...result].sort() };
}

/** 直前の接続→新接続の写像を過去の保存参照まで合成する。空配列は加工で接触が消えた印。 */
export function composeSheetConnectionAliases(source: ResolvedSheetBody, changes: ReadonlyMap<string, readonly string[]>): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const [id, targets] of source.connectionAliases ?? [])
    result.set(id, [...new Set(targets.flatMap((target) => changes.get(target) ?? [target]))].sort());
  for (const [id, targets] of changes) result.set(id, [...new Set(targets)].sort());
  return result;
}
