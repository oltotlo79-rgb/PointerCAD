import type { AccessorySetRecord, AssemblyDocument } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, isRecord, isUnknownArray, joinPath, readArray, readLiteral, readString, type Checked } from '../guards.js';

/*
 * 付属の組の記録(設計 wip/auto-accessory-design.md §4。統括の決定 2026-11-19 02:08 の Q1・Q2)。利用者の選んだ値と、本体と付属の部品の id だけを持ち、
 * 形と位置は今の部品と族の表から作り直す。記録を使ったファイルだけ保存形式の版 23 にし(frameJoints・穴つきの面と同じ V-b)、版 22 までの読み手は
 * 版の数で「新しい版で保存されています」と断る。版 23 より前の版に欄がある時は、読まずに断る(古い読み手が記録を捨てない)。
 * 部品の id が文書に無い記録は、ファイル全体を断らずに読む(作り直しの一覧が理由つきで扱う。frameJointRecords.ts と同じ)。
 */

/** 記録を保存・読み込みできる最小の保存形式の版(model の ACCESSORY_SETS_SCHEMA_VERSION と同じ値)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;

const SET_IDS: readonly AccessorySetRecord['setId'][] = ['frame-end-caps', 'bolt-washer-nut'];
const ROLES: readonly AccessorySetRecord['accessories'][number]['role'][] = ['startCap', 'endCap', 'headWasher', 'nutWasher', 'springWasher', 'nut'];
const ENDS: readonly AccessorySetRecord['choices']['ends'][] = ['both', 'start', 'end'];
const END_REFERENCES: readonly AccessorySetRecord['choices']['endReference'][] = ['overall', 'member'];

/** 文書(まだ型を確かめていない値)に、付属の組の記録の欄があるか。 */
export function hasAccessorySetsField(document: unknown): boolean {
  return isRecord(document) && Object.hasOwn(document, 'accessorySets');
}

/** 記録を使った文書は、保存形式の版 23 以上でしか保存しない(古い読み手が記録を捨てないよう、保存の境界で断る)。 */
export function assertAccessorySetsVersion(document: AssemblyDocument): void {
  if (document.schemaVersion >= ACCESSORY_SETS_SCHEMA_VERSION || (document.accessorySets?.length ?? 0) === 0) return;
  throw new RangeError('付属の組の記録を保存するには保存形式の版23が必要です。');
}

function readAccessories(source: Record<string, unknown>, path: string): Checked<AccessorySetRecord['accessories']> {
  const list = readArray(source, 'accessories', path);
  if (!list.ok) return list;
  const accessories: AccessorySetRecord['accessories'][number][] = [];
  for (const [index, item] of list.value.entries()) {
    const itemPath = indexPath(joinPath(path, 'accessories'), index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const componentId = readString(record.value, 'componentId', itemPath);
    if (!componentId.ok) return componentId;
    const role = readLiteral(record.value, 'role', itemPath, ROLES);
    if (!role.ok) return role;
    if (componentId.value === '') return fieldProblem(itemPath, 'type');
    accessories.push({ componentId: componentId.value, role: role.value });
  }
  return accessories.length === 0 ? fieldProblem(joinPath(path, 'accessories'), 'type') : { ok: true, value: accessories };
}

function readChoices(value: unknown, path: string): Checked<AccessorySetRecord['choices']> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const ends = readLiteral(record.value, 'ends', path, ENDS);
  if (!ends.ok) return ends;
  const endReference = readLiteral(record.value, 'endReference', path, END_REFERENCES);
  if (!endReference.ok) return endReference;
  const itemKey = readString(record.value, 'itemKey', path);
  if (!itemKey.ok) return itemKey;
  if (itemKey.value === '') return fieldProblem(joinPath(path, 'itemKey'), 'type');
  // ボルトの組だけが持つ任意の欄(締め付ける厚さは正の有限の数、ばね座金は真偽)。
  const grip = record.value['gripMm'];
  const spring = record.value['springWasher'];
  if (grip !== undefined && !(typeof grip === 'number' && Number.isFinite(grip) && grip > 0)) return fieldProblem(joinPath(path, 'gripMm'), 'type');
  if (spring !== undefined && typeof spring !== 'boolean') return fieldProblem(joinPath(path, 'springWasher'), 'type');
  return { ok: true, value: { ends: ends.value, endReference: endReference.value, itemKey: itemKey.value,
    ...(grip === undefined ? {} : { gripMm: grip }), ...(spring === undefined ? {} : { springWasher: spring }) } };
}

/** 付属の組の記録の並び(型だけを確かめる。id は一意)。 */
export function readAccessorySetRecords(value: unknown, path: string): Checked<readonly AccessorySetRecord[]> {
  if (!isUnknownArray(value)) return fieldProblem(path, 'type');
  const records: AccessorySetRecord[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = indexPath(path, index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const id = readString(record.value, 'id', itemPath);
    if (!id.ok) return id;
    if (id.value === '' || seen.has(id.value)) return fieldProblem(joinPath(itemPath, 'id'), 'type');
    const setId = readLiteral(record.value, 'setId', itemPath, SET_IDS);
    if (!setId.ok) return setId;
    const hostComponentId = readString(record.value, 'hostComponentId', itemPath);
    if (!hostComponentId.ok) return hostComponentId;
    if (hostComponentId.value === '') return fieldProblem(joinPath(itemPath, 'hostComponentId'), 'type');
    const accessories = readAccessories(record.value, itemPath);
    if (!accessories.ok) return accessories;
    const choices = readChoices(record.value['choices'], joinPath(itemPath, 'choices'));
    if (!choices.ok) return choices;
    seen.add(id.value);
    records.push({ id: id.value, setId: setId.value, hostComponentId: hostComponentId.value, accessories: accessories.value, choices: choices.value });
  }
  return { ok: true, value: records };
}

/** 保存の形(決まった順の写し。読み込みと同じ確かめを通す)。 */
export function serializeAccessorySetRecords(records: readonly AccessorySetRecord[]): readonly AccessorySetRecord[] {
  const checked = readAccessorySetRecords(records, 'document.accessorySets');
  if (!checked.ok) throw new RangeError(`Invalid accessory set record: ${checked.problem.path}`);
  return checked.value.map((record): AccessorySetRecord => ({ id: record.id, setId: record.setId, hostComponentId: record.hostComponentId,
    accessories: record.accessories.map((item) => ({ componentId: item.componentId, role: item.role })),
    choices: { ends: record.choices.ends, endReference: record.choices.endReference, itemKey: record.choices.itemKey,
      ...(record.choices.gripMm === undefined ? {} : { gripMm: record.choices.gripMm }),
      ...(record.choices.springWasher === undefined ? {} : { springWasher: record.choices.springWasher }) } }));
}
