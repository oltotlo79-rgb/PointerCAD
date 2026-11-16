import { commandDefinition, type CommandDocumentKind, type CommandId } from './commandDefinitions.js';

/*
 * 放射メニュー(右クリックの道具一覧)の中身を、文書の種類ごとに利用者が選ぶ設定(設計 2-4・B-08f)。
 * 8 つの並びは 上・右上・右・右下・下・左下・左・左上 の順。無い種類は既定の並び(radialCommandItems.ts)を使う。
 * ここは保存の値の読み取りと検査だけを持つ(既定の並びや表示は持たない。読み込みの循環を作らないため)。
 */

export type EightCommands = readonly [CommandId, CommandId, CommandId, CommandId, CommandId, CommandId, CommandId, CommandId];
export const RADIAL_DOCUMENT_KINDS: readonly CommandDocumentKind[] = ['part', 'assembly', 'drawing'];
/** 種類ごとの 8 つ。欄が無い種類は既定。 */
export type RadialCommands = Readonly<Partial<Record<CommandDocumentKind, EightCommands>>>;
export const EMPTY_RADIAL_COMMANDS: RadialCommands = Object.freeze({});
export const RADIAL_SLOT_COUNT = 8;

/**
 * 選択の文脈で右上に差し込む命令(点を選んだ時だけ出る)。利用者の並びには置かせない(差し込みと重なって
 * 同じ命令が 2 か所に出るのを防ぐ)。
 */
const CONTEXTUAL_RADIAL_COMMANDS: ReadonlySet<string> = new Set(['sketch.connectPoints', 'sketch.faceFromPoints',
  'sketch.pointAtReference']);

/** その種類の放射メニューに置ける命令か(登録があり、その文書の種類で使え、文脈の差し込みの命令でない)。 */
export function radialCommandFits(id: string, kind: CommandDocumentKind): id is CommandId {
  return !CONTEXTUAL_RADIAL_COMMANDS.has(id) && commandDefinition(id)?.documentKinds.includes(kind) === true;
}

/** 8 つの並びの検査。8 つちょうど・その種類で使える命令・重なり無しの時だけ並びを返す。 */
export function checkedRadialCommands(raw: unknown, kind: CommandDocumentKind): EightCommands | null {
  if (!Array.isArray(raw) || raw.length !== RADIAL_SLOT_COUNT) return null;
  const items: readonly unknown[] = raw;
  const ids = items.filter((item): item is CommandId => typeof item === 'string' && radialCommandFits(item, kind));
  if (ids.length !== RADIAL_SLOT_COUNT || new Set(ids).size !== RADIAL_SLOT_COUNT) return null;
  const [a, b, c, d, e, f, g, h] = ids;
  return a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined
    || g === undefined || h === undefined ? null : Object.freeze([a, b, c, d, e, f, g, h] as const);
}

/** 保存の値を読む。知らない種類・形の壊れた種類は、その種類だけ捨てて(既定に戻して)数える。 */
export function readRadialCommands(raw: unknown): { readonly commands: RadialCommands; readonly dropped: number } {
  if (raw === undefined) return { commands: EMPTY_RADIAL_COMMANDS, dropped: 0 };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { commands: EMPTY_RADIAL_COMMANDS, dropped: 1 };
  const commands: Partial<Record<CommandDocumentKind, EightCommands>> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(raw)) {
    const kind = RADIAL_DOCUMENT_KINDS.find(item => item === key);
    const checked = kind === undefined ? null : checkedRadialCommands(value, kind);
    if (kind === undefined || checked === null) { dropped += 1; continue; }
    commands[kind] = checked;
  }
  return { commands: Object.freeze(commands), dropped };
}
