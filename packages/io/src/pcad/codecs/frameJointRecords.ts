import type { AssemblyDocument, FrameJointRecord } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, isRecord, isUnknownArray, joinPath, readArray, readLiteral, readString, type Checked } from '../guards.js';

/*
 * フレームどうしの接続の記録(E-07 締結部品の自動判別。設計 wip/e07-e09-design.md §5.1)。利用者の選んだ値と、置いた板・溝用のナット・ボルトの
 * 部品の id だけを持ち、形と位置は今の部品と族の表から作り直す。記録を使ったファイルだけ保存形式の版 23 にし(穴つきの面と同じ V-b)、
 * 版 22 までの読み手は版の数で「新しい版で保存されています」と断る。版 23 より前の版に欄がある時は、読まずに断る(古い読み手が記録を捨てない)。
 * 部品の id が文書に無い記録は、ファイル全体を断らずに読む(作り直しの一覧が理由つきで扱う)。
 */

/** 記録を保存・読み込みできる最小の保存形式の版。 */
const FRAME_JOINTS_SCHEMA_VERSION = 23;

const KINDS: readonly FrameJointRecord['kind'][] = ['L', 'T', 'butt'];
const PARTS: readonly FrameJointRecord['members'][number]['part'][] = ['start', 'end', 'side'];
const ORIENTATIONS: readonly FrameJointRecord['bracket']['orientation'][] = ['aOnBase', 'aOnButting', 'plate'];
const FACES: readonly FrameJointRecord['bracket']['faces'][number]['face'][] = ['top', 'left', 'bottom', 'right'];

/** 文書(まだ型を確かめていない値)に、接続の記録の欄があるか。 */
export function hasFrameJointsField(document: unknown): boolean {
  return isRecord(document) && Object.hasOwn(document, 'frameJoints');
}

/** 記録を使った文書は、保存形式の版 23 以上でしか保存しない(古い読み手が記録を捨てないよう、保存の境界で断る)。 */
export function assertFrameJointsVersion(document: AssemblyDocument): void {
  if (document.schemaVersion >= FRAME_JOINTS_SCHEMA_VERSION || (document.frameJoints?.length ?? 0) === 0) return;
  throw new RangeError('フレームの接続の記録を保存するには保存形式の版23が必要です。');
}

/** 空でない文字列の並び。 */
function readIds(source: Record<string, unknown>, key: string, path: string): Checked<readonly string[]> {
  const list = readArray(source, key, path);
  if (!list.ok) return list;
  const ids: string[] = [];
  for (const [index, item] of list.value.entries()) {
    if (typeof item !== 'string' || item === '') return fieldProblem(indexPath(joinPath(path, key), index), 'type');
    ids.push(item);
  }
  return { ok: true, value: ids };
}

function readMembers(source: Record<string, unknown>, path: string): Checked<FrameJointRecord['members']> {
  const list = readArray(source, 'members', path);
  if (!list.ok) return list;
  const members: FrameJointRecord['members'][number][] = [];
  for (const [index, item] of list.value.entries()) {
    const itemPath = indexPath(joinPath(path, 'members'), index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const componentId = readString(record.value, 'componentId', itemPath);
    if (!componentId.ok) return componentId;
    const part = readLiteral(record.value, 'part', itemPath, PARTS);
    if (!part.ok) return part;
    if (componentId.value === '') return fieldProblem(itemPath, 'type');
    members.push({ componentId: componentId.value, part: part.value });
  }
  return members.length < 2 ? fieldProblem(joinPath(path, 'members'), 'type') : { ok: true, value: members };
}

function readBracket(value: unknown, path: string): Checked<FrameJointRecord['bracket']> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const componentId = readString(record.value, 'componentId', path);
  if (!componentId.ok) return componentId;
  const orientation = readLiteral(record.value, 'orientation', path, ORIENTATIONS);
  if (!orientation.ok) return orientation;
  const list = readArray(record.value, 'faces', path);
  if (!list.ok) return list;
  const faces: FrameJointRecord['bracket']['faces'][number][] = [];
  for (const [index, item] of list.value.entries()) {
    const itemPath = indexPath(joinPath(path, 'faces'), index);
    const face = checkRecord(item, itemPath);
    if (!face.ok) return face;
    const owner = readString(face.value, 'componentId', itemPath);
    if (!owner.ok) return owner;
    const name = readLiteral(face.value, 'face', itemPath, FACES);
    if (!name.ok) return name;
    faces.push({ componentId: owner.value, face: name.value });
  }
  if (componentId.value === '' || faces.length !== 2) return fieldProblem(path, 'type');
  return { ok: true, value: { componentId: componentId.value, orientation: orientation.value, faces } };
}

function readChoices(value: unknown, path: string): Checked<FrameJointRecord['choices']> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const nominal = readString(record.value, 'nominal', path);
  if (!nominal.ok) return nominal;
  const nutEntry = readString(record.value, 'nutEntry', path);
  if (!nutEntry.ok) return nutEntry;
  const nutMaterial = readString(record.value, 'nutMaterial', path);
  if (!nutMaterial.ok) return nutMaterial;
  return { ok: true, value: { nominal: nominal.value, nutEntry: nutEntry.value, nutMaterial: nutMaterial.value } };
}

/** 接続の記録の並び(型だけを確かめる。id は一意)。 */
export function readFrameJointRecords(value: unknown, path: string): Checked<readonly FrameJointRecord[]> {
  if (!isUnknownArray(value)) return fieldProblem(path, 'type');
  const records: FrameJointRecord[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = indexPath(path, index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const id = readString(record.value, 'id', itemPath);
    if (!id.ok) return id;
    if (id.value === '' || seen.has(id.value)) return fieldProblem(joinPath(itemPath, 'id'), 'type');
    const kind = readLiteral(record.value, 'kind', itemPath, KINDS);
    if (!kind.ok) return kind;
    const members = readMembers(record.value, itemPath);
    if (!members.ok) return members;
    const bracket = readBracket(record.value['bracket'], joinPath(itemPath, 'bracket'));
    if (!bracket.ok) return bracket;
    const fastenerIds = readIds(record.value, 'fastenerIds', itemPath);
    if (!fastenerIds.ok) return fastenerIds;
    const choices = readChoices(record.value['choices'], joinPath(itemPath, 'choices'));
    if (!choices.ok) return choices;
    seen.add(id.value);
    records.push({ id: id.value, kind: kind.value, members: members.value, bracket: bracket.value, fastenerIds: fastenerIds.value,
      choices: choices.value });
  }
  return { ok: true, value: records };
}

/** 保存の形(決まった順の写し。読み込みと同じ確かめを通す)。 */
export function serializeFrameJointRecords(records: readonly FrameJointRecord[]): readonly FrameJointRecord[] {
  const checked = readFrameJointRecords(records, 'document.frameJoints');
  if (!checked.ok) throw new RangeError(`Invalid frame joint record: ${checked.problem.path}`);
  return checked.value.map((record): FrameJointRecord => ({ id: record.id, kind: record.kind,
    members: record.members.map((member) => ({ componentId: member.componentId, part: member.part })),
    bracket: { componentId: record.bracket.componentId, orientation: record.bracket.orientation,
      faces: record.bracket.faces.map((face) => ({ componentId: face.componentId, face: face.face })) },
    fastenerIds: [...record.fastenerIds], choices: { ...record.choices } }));
}
