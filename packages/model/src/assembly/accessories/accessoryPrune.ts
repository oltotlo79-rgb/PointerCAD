/**
 * 部品を消す時の付属の組の記録の扱い(A3。統括の決定 2026-11-19 02:08 の Q5: 本体を消すと付属も消す)。removeComponent(assemblyEdit.ts)が読む。
 * 読み込みの輪を作らないよう、記録の型だけを読む(付ける側の accessorySets.ts は assemblyEdit.ts を読むため)。
 */
import type { AccessorySetRecord } from './accessoryRecord.js';

/** 消す部品の閉包に足す付属(本体を消す記録の付属の全部)。 */
export function accessoryDeletionClosure(records: readonly AccessorySetRecord[] | undefined, removed: ReadonlySet<string>): readonly string[] {
  return (records ?? []).flatMap((record) => removed.has(record.hostComponentId) ? record.accessories.map((item) => item.componentId) : []);
}

/** 消した後に残す記録(本体が消えた記録は消し、消えた付属は外し、付属が 0 の記録は消す)。空の並びは保存の時に書かれない。 */
export function prunedAccessorySets(records: readonly AccessorySetRecord[], removed: ReadonlySet<string>): readonly AccessorySetRecord[] {
  return records.flatMap((record): AccessorySetRecord[] => {
    if (removed.has(record.hostComponentId)) return [];
    const accessories = record.accessories.filter((item) => !removed.has(item.componentId));
    return accessories.length === 0 ? [] : [accessories.length === record.accessories.length ? record : { ...record, accessories }];
  });
}
