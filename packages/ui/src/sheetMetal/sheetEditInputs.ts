/** 再編集は作成と同じ入力画面を使い、数値の原式と履歴の位置を保持する。 */
import type { PartDocument, SheetMetalFeature } from '@pointercad/model';
import { setSheetField, sheetFieldValues } from './sheetFields.js';

export function sheetInputDocument(document: PartDocument, editing: SheetMetalFeature | undefined): PartDocument {
  if (editing === undefined) return document;
  const index = document.solids.findIndex((feature) => feature.id === editing.id);
  return index < 0 ? document : { ...document, solids: document.solids.slice(0, index) };
}

/** 変更していない式を表示単位で評価し直さない。継承へ戻した欄も復活させない。 */
export function preserveSheetEditValues(candidate: SheetMetalFeature, editing: SheetMetalFeature | undefined): SheetMetalFeature {
  if (editing === undefined || candidate.kind !== editing.kind) return candidate;
  let result: SheetMetalFeature = { ...candidate, id: editing.id, name: editing.name, suppressed: editing.suppressed };
  const activeFields = new Set(sheetFieldValues(candidate).map(([key]) => key));
  for (const [key, value] of sheetFieldValues(editing)) if (activeFields.has(key)) result = setSheetField(result, key, value);
  return result;
}

export function sheetInitialProfile(editing: SheetMetalFeature | undefined) {
  if (editing?.kind === 'sheetBase') return { face: editing.profile, holes: editing.holes };
  if (editing?.kind === 'sheetFlange' && editing.profile !== null) return editing.profile;
  return undefined;
}
