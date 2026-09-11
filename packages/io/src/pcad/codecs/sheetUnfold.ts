/** 版12の展開参照。座標・メッシュ・表示モードを持ち込まない。 */
import type { SheetUnfoldDefinition } from '@pointercad/model';
import { checkRecord, fieldProblem, joinPath, readString, type Checked } from '../guards.js';
import { readList } from './fields.js';

function readNonEmptyId(record: Record<string, unknown>, key: string, path: string): Checked<string> {
  const value = readString(record, key, path);
  return !value.ok || value.value.trim() !== '' ? value : fieldProblem(joinPath(path, key), 'type');
}
function readDefinition(value: unknown, path: string): Checked<SheetUnfoldDefinition> {
  const record = checkRecord(value, path); if (!record.ok) return record;
  const source = readNonEmptyId(record.value, 'sourceFeatureId', path); if (!source.ok) return source;
  const fixed = readNonEmptyId(record.value, 'fixedPanelId', path); if (!fixed.ok) return fixed;
  const seams = readList(record.value, 'seamConnectionIds', path, (item, at): Checked<string> =>
    typeof item === 'string' && item.trim() !== '' ? { ok: true, value: item } : fieldProblem(at, 'type'));
  if (!seams.ok) return seams;
  if (new Set(seams.value).size !== seams.value.length) return fieldProblem(joinPath(path, 'seamConnectionIds'), 'type');
  return { ok: true, value: { sourceFeatureId: source.value, fixedPanelId: fixed.value, seamConnectionIds: seams.value } };
}
export function readSheetUnfolds(record: Record<string, unknown>, path: string): Checked<readonly SheetUnfoldDefinition[]> {
  const values = readList(record, 'sheetUnfolds', path, readDefinition); if (!values.ok) return values;
  return new Set(values.value.map((item) => item.sourceFeatureId)).size === values.value.length
    ? values : fieldProblem(joinPath(path, 'sheetUnfolds'), 'type');
}
export function serializeSheetUnfold(definition: SheetUnfoldDefinition): SheetUnfoldDefinition {
  return { sourceFeatureId: definition.sourceFeatureId, fixedPanelId: definition.fixedPanelId,
    seamConnectionIds: [...definition.seamConnectionIds].sort() };
}
