/**
 * ケガキの位置(E-14)の窓の中身と CSV。部材と接続の見分け(model の `placedFrameMembers`・`classifyFrameJoints`)と溝のナット
 * (`slotFastenerParts`)から model の `frameScribeMarks` で位置を求め、部材ごとの 1 行の文字と、1 行 = 1 つの位置の CSV を作る。
 * CSV には製造元の名前・型番・資料の発行元を出さない(部品名は置いた時の一般の語と寸法。統括の決定 2026-11-18 15:1x)。
 */
import {
  classifyFrameJoints, frameScribeMarks, placedFrameMembers, slotFastenerParts, type AssemblyDocument, type FrameScribeMember,
  type RigidPlacement,
} from '@pointercad/model';

import { serializeCsvReport } from '../file/csvReport.js';
import { t, type MessageKey } from '../i18n/t.js';

type ScribeMark = FrameScribeMember['marks'][number];

const FACE_KEYS: Readonly<Record<NonNullable<ScribeMark['face']>, MessageKey>> = {
  top: 'catalog.scribe.face.top', left: 'catalog.scribe.face.left', bottom: 'catalog.scribe.face.bottom', right: 'catalog.scribe.face.right',
};

const faceText = (face: ScribeMark['face']): string => face === null ? t('catalog.scribe.face.none') : t(FACE_KEYS[face]);
const nameOf = (assembly: AssemblyDocument, componentId: string): string =>
  assembly.components.find((component) => component.id === componentId)?.name ?? componentId;
const mm = (value: number): string => value.toFixed(1);

/** 表示中の配置から、部材ごとのケガキの位置を求める。 */
export function scribeMarksOf(assembly: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>): readonly FrameScribeMember[] {
  const members = placedFrameMembers(assembly, placements);
  const nuts = slotFastenerParts(assembly, placements).filter((part) => part.kind === 'nut');
  return frameScribeMarks(members, classifyFrameJoints(members), nuts);
}

/** 部材 1 本の 1 行: 「部品名(長さ 1000): 上 120.0, 140.0 / 右 500.0」。 */
export function scribeMemberText(assembly: AssemblyDocument, entry: FrameScribeMember): string {
  const groups: { readonly face: ScribeMark['face']; readonly positions: string[] }[] = [];
  for (const mark of entry.marks) {
    const last = groups.at(-1);
    if (last?.face === mark.face) last.positions.push(mm(mark.positionMm));
    else groups.push({ face: mark.face, positions: [mm(mark.positionMm)] });
  }
  return t('catalog.scribe.row').replace('{name}', nameOf(assembly, entry.componentId)).replace('{length}', mm(entry.lengthMm))
    .replace('{marks}', groups.map((group) => `${faceText(group.face)} ${group.positions.join(', ')}`).join(' / '));
}

/** CSV(UTF-8 の BOM つき)。1 行 = 1 つの位置: 部品名・部品の id・長さ・面・始点の端からの距離・取り付く物の種類・その部品名。 */
export function serializeScribeMarksCsv(assembly: AssemblyDocument, entries: readonly FrameScribeMember[]): Uint8Array {
  const rows: (string | number)[][] = [[t('catalog.scribe.csv.name'), t('catalog.scribe.csv.componentId'),
    `${t('catalog.scribe.csv.length')} (mm)`, t('catalog.scribe.csv.face'), `${t('catalog.scribe.csv.position')} (mm)`,
    t('catalog.scribe.csv.kind'), t('catalog.scribe.csv.other')]];
  for (const entry of entries) {
    for (const mark of entry.marks) {
      rows.push([nameOf(assembly, entry.componentId), entry.componentId, mm(entry.lengthMm), faceText(mark.face), mm(mark.positionMm),
        t(mark.kind === 'member' ? 'catalog.scribe.kind.member' : 'catalog.scribe.kind.nut'), nameOf(assembly, mark.otherComponentId)]);
    }
  }
  return serializeCsvReport(rows);
}
