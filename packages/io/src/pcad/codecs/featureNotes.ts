import { FEATURE_NOTE_MAX_LENGTH, featureNoteTargetKey, type FeatureNote, type FeatureNoteTarget } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, joinPath, readLiteral, readString, type Checked } from '../guards.js';

export function readHistoryFeatureTarget(value: unknown, path: string): Checked<FeatureNoteTarget> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const kind = readLiteral(record.value, 'kind', path, ['solid', 'reference', 'sketch', 'sketch-feature']);
  if (!kind.ok) return kind;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  if (id.value === '') return fieldProblem(joinPath(path, 'id'), 'type');
  if (kind.value !== 'sketch-feature') return { ok: true, value: { kind: kind.value, id: id.value } };
  const sketchId = readString(record.value, 'sketchId', path);
  if (!sketchId.ok) return sketchId;
  if (sketchId.value === '') return fieldProblem(joinPath(path, 'sketchId'), 'type');
  return { ok: true, value: { kind: kind.value, id: id.value, sketchId: sketchId.value } };
}

export function readFeatureNotes(value: unknown, path: string): Checked<readonly FeatureNote[]> {
  if (!Array.isArray(value)) return fieldProblem(path, 'type');
  const result: FeatureNote[] = [], seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const location = indexPath(path, i), item: unknown = value[i];
    const record = checkRecord(item, location);
    if (!record.ok) return record;
    const target = readHistoryFeatureTarget(record.value.target, joinPath(location, 'target'));
    if (!target.ok) return target;
    const text = readString(record.value, 'text', location);
    if (!text.ok) return text;
    if (text.value.length > FEATURE_NOTE_MAX_LENGTH) return fieldProblem(joinPath(location, 'text'), 'type');
    const key = featureNoteTargetKey(target.value);
    if (seen.has(key)) return fieldProblem(joinPath(location, 'target'), 'type');
    seen.add(key); result.push({ target: target.value, text: text.value });
  }
  return { ok: true, value: result };
}

export function serializeFeatureNotes(notes: readonly FeatureNote[]): readonly FeatureNote[] {
  const checked = readFeatureNotes(notes, 'featureNotes');
  if (!checked.ok) throw new RangeError('設計メモの内容を保存できません。');
  return checked.value;
}
