import {
  COMMAND_DEFINITIONS, shortcutMatches, type CommandDefinition, type CommandDocumentKind, type CommandId,
  type CommandKeyContext, type CommandKeyInput, type ShortcutBinding,
} from './commandDefinitions.js';
import {
  codeChordBrowserWarning, codeChordLabel, isReservedCodeChord, readCodeChord, type CodeChord,
} from './commandInputSettings.js';

export interface AssignedChord {
  readonly key: string;
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}
/** 1 つの組。英数字と F キーは見えた文字(AssignedChord)、それ以外のキーは物理の位置(CodeChord)で合わせる。 */
export type CommandChord = AssignedChord | CodeChord;
/**
 * 無い = 既定のキー、null = 割当なし、組 1 つか 1〜2 個の配列。
 * 組 1 つの形は v1(1 命令 1 キー)の保存と同じ。検査を通した値と読み込んだ値は配列にそろえる。
 */
export type ShortcutAssignments = Readonly<Partial<Record<CommandId, CommandChord | readonly CommandChord[] | null>>>;
export const EMPTY_SHORTCUT_ASSIGNMENTS: ShortcutAssignments = Object.freeze({});
type RegisteredDefinition = CommandDefinition & { readonly id: CommandId };
export type AssignmentProblem =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unknown-command'; readonly commandId: string }
  | { readonly kind: 'fixed-command'; readonly commandId: CommandId }
  | { readonly kind: 'reserved'; readonly commandId: CommandId }
  | { readonly kind: 'too-many-chords'; readonly commandId: CommandId }
  | { readonly kind: 'conflict'; readonly commandId: CommandId; readonly otherCommandId: CommandId };
export type AssignmentValidation =
  | { readonly ok: true; readonly assignments: ShortcutAssignments }
  | { readonly ok: false; readonly problem: AssignmentProblem };

/** Keep universal help, cancellation, field confirmation, and Ctrl/Cmd+S available. */
const FIXED_COMMANDS: ReadonlySet<CommandId> = new Set([
  'help.contextual', 'workspace.closeStrength', 'workspace.clearMeasurement', 'file.save',
  'drawing.cancelTool', 'drawing.commitDimension', 'drawing.deleteSelection', 'commandLine.focus',
]);
const MAX_ASSIGNMENTS = 512;
const MAX_JSON_LENGTH = 32_768;
const MAX_CHORDS_PER_COMMAND = 2;
const CHORD_KEYS = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u;
/** 位置で合わせるキーのうち、押した時の key が配列によらず決まるもの(既定の key の組と同じ入力になる)。 */
const NAMED_CODE_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert', Delete: 'delete', Backspace: 'backspace', Space: ' ',
};

export function canAssignShortcut(commandId: CommandId): boolean {
  return !FIXED_COMMANDS.has(commandId);
}

function isCodeChord(chord: CommandChord): chord is CodeChord {
  return 'code' in chord;
}

function isChordList(entry: CommandChord | readonly CommandChord[]): entry is readonly CommandChord[] {
  return Array.isArray(entry);
}

/** 1 命令の割当を組の並びにそろえる(無い・null は空)。 */
export function chordsOf(entry: CommandChord | readonly CommandChord[] | null | undefined): readonly CommandChord[] {
  if (entry === undefined || entry === null) return [];
  return isChordList(entry) ? entry : [entry];
}

function readKeyChord(raw: object): AssignedChord | null {
  if (!('key' in raw) || typeof raw.key !== 'string' || !CHORD_KEYS.test(raw.key)
    || !('primary' in raw) || typeof raw.primary !== 'boolean'
    || !('shift' in raw) || typeof raw.shift !== 'boolean'
    || !('alt' in raw) || typeof raw.alt !== 'boolean') return null;
  if (Object.keys(raw).some(key => !['key', 'primary', 'shift', 'alt'].includes(key))) return null;
  return Object.freeze({ key: raw.key, primary: raw.primary, shift: raw.shift, alt: raw.alt });
}

function readChord(raw: unknown): CommandChord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return 'code' in raw ? readCodeChord(raw) : readKeyChord(raw);
}

function sameChord(a: CommandChord, b: CommandChord): boolean {
  const place = isCodeChord(a) ? (isCodeChord(b) && a.code === b.code) : (!isCodeChord(b) && a.key === b.key);
  return place && a.primary === b.primary && a.shift === b.shift && a.alt === b.alt;
}

/** 1 命令の保存の値を読む。null は割当なし。 */
function readEntry(raw: unknown): readonly CommandChord[] | null | 'invalid' | 'too-many' {
  if (raw === null) return null;
  const items: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return 'invalid';
  if (items.length > MAX_CHORDS_PER_COMMAND) return 'too-many';
  const chords: CommandChord[] = [];
  for (const item of items) {
    const chord = readChord(item);
    if (chord === null || chords.some(other => sameChord(other, chord))) return 'invalid';
    chords.push(chord);
  }
  return Object.freeze(chords);
}

/** Browser/window controls remain available; AltGr input is never assignable. */
function isReservedChord(chord: AssignedChord): boolean {
  if (chord.primary && chord.alt) return true;
  if (['f1', 'f5', 'f6', 'f11', 'f12'].includes(chord.key)) return true;
  if (chord.alt && chord.key === 'f4') return true;
  if (chord.shift && chord.key === 'f10') return true;
  if (chord.primary && ['l', 'r', 't', 'w', 'p', 'q'].includes(chord.key)) return true;
  if (chord.primary && chord.shift && ['n', 'j', 'i'].includes(chord.key)) return true;
  return false;
}

export function isReservedCommandChord(chord: CommandChord): boolean {
  return isCodeChord(chord) ? isReservedCodeChord(chord) : isReservedChord(chord);
}

/** Web 版をブラウザーのタブで使う時に届かないことがある組(断らずに知らせる。設計 §5 の「警告だけ」)。 */
export function chordBrowserWarning(chord: CommandChord): boolean {
  if (isCodeChord(chord)) return codeChordBrowserWarning(chord);
  if (chord.primary && !chord.shift && (chord.key === 'n' || chord.key === '0')) return true;
  if (chord.primary && chord.shift && chord.key === 't') return true;
  return chord.alt && !chord.primary && /^[a-z]$/u.test(chord.key);
}

function assignedChordLabel(chord: AssignedChord): string {
  return [chord.primary ? 'Ctrl/Cmd' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '',
    chord.key.toUpperCase()].filter(Boolean).join('+');
}

export function commandChordLabel(chord: CommandChord): string {
  return isCodeChord(chord) ? codeChordLabel(chord) : assignedChordLabel(chord);
}

/** Custom keys never take over typing or IME. The fixed Ctrl/Cmd+S keeps its existing exception. */
export function assignedBindings(definition: CommandDefinition, chord: CommandChord): readonly ShortcutBinding[] {
  const bases: readonly ShortcutBinding[] = definition.shortcuts.length > 0 ? definition.shortcuts : [{
    key: '', display: '', contextLabelKey: 'command.context.all', phase: 'bubble', primary: 'none',
    shift: 'forbidden', documentKinds: definition.documentKinds, preventDefault: true, rejectRepeat: true,
  }];
  return bases.map(binding => ({
    ...binding,
    key: isCodeChord(chord) ? '' : chord.key, code: isCodeChord(chord) ? chord.code : undefined,
    display: commandChordLabel(chord),
    contextLabelKey: 'command.context.assigned',
    primary: chord.primary ? 'ctrl-or-meta' : 'none',
    shift: chord.shift ? 'required' : 'forbidden',
    allowAlt: chord.alt,
    allowInTextEntry: false,
    allowDuringComposition: false,
    allowInMenu: false,
  }));
}

/** その組を押した時の入力。位置の組の key は、配列によらず決まる名前のキーだけ(ほかは key の組に当たらない)。 */
function chordInput(chord: CommandChord, ctrl: boolean, meta: boolean): CommandKeyInput {
  const key = isCodeChord(chord) ? (NAMED_CODE_KEYS[chord.code] ?? '') : chord.key;
  return { key, code: isCodeChord(chord) ? chord.code : undefined, ctrl, meta, shift: chord.shift, alt: chord.alt, repeat: false };
}

/** 2 つの束が、同じ組の 1 回の押し方で両方とも動くか(同じ文書の種類・同じ段)。 */
function overlaps(a: ShortcutBinding, b: ShortcutBinding, chord: CommandChord): boolean {
  if (a.phase !== b.phase) return false;
  for (const documentKind of a.documentKinds) {
    if (!b.documentKinds.includes(documentKind)) continue;
    const context: CommandKeyContext = {
      documentKind, phase: a.phase, helpOpen: false, textEntry: false, composing: false,
      activatedBySpace: false, insideMenu: false, insideDialog: false,
    };
    for (const [ctrl, meta] of [[chord.primary, false], [false, chord.primary]] as const) {
      const input = chordInput(chord, ctrl, meta);
      if (shortcutMatches(a, input, context) && shortcutMatches(b, input, context)) return true;
    }
  }
  return false;
}

/** 利用者の割当(組)と、ほかの命令の既定の束が同じ押し方になるか。 */
function chordTakesDefault(chord: CommandChord, owner: RegisteredDefinition, binding: ShortcutBinding): boolean {
  return assignedBindings(owner, chord).some(assigned => overlaps(binding, assigned, chord));
}

/** 2 つの命令の利用者の割当が同じ押し方になるか(NumLock の入ったテンキーの数字は、同じ数字の文字の組と同じ)。 */
function chordsCollide(a: CommandChord, first: RegisteredDefinition, b: CommandChord, second: RegisteredDefinition): boolean {
  if (!first.documentKinds.some(kind => second.documentKinds.includes(kind))) return false;
  if (sameChord(a, b)) return true;
  const digit = (chord: CommandChord): string | null => isCodeChord(chord)
    ? (/^Numpad[0-9]$/u.test(chord.code) ? chord.code.slice('Numpad'.length) : null)
    : (/^[0-9]$/u.test(chord.key) ? chord.key : null);
  const left = digit(a), right = digit(b);
  return left !== null && left === right && isCodeChord(a) !== isCodeChord(b)
    && a.primary === b.primary && a.shift === b.shift && a.alt === b.alt;
}

/** 既定の束のうち、ほかの命令の利用者の割当が使っている物(利用者の割当を優先する。固定の命令の既定は譲らない)。 */
function defaultTaken(definition: RegisteredDefinition, binding: ShortcutBinding, assignments: ShortcutAssignments): boolean {
  if (FIXED_COMMANDS.has(definition.id)) return false;
  for (const [ownerId, entry] of Object.entries(assignments)) {
    const owner = ownerId === definition.id ? undefined : COMMAND_DEFINITIONS.find(candidate => candidate.id === ownerId);
    if (owner !== undefined && chordsOf(entry).some(chord => chordTakesDefault(chord, owner, binding))) return true;
  }
  return false;
}

export function effectiveBindings(definition: RegisteredDefinition, assignments: ShortcutAssignments): readonly ShortcutBinding[] {
  const assigned = assignments[definition.id];
  if (assigned === undefined) {
    if (Object.keys(assignments).length === 0) return definition.shortcuts;
    return definition.shortcuts.filter(binding => !defaultTaken(definition, binding, assignments));
  }
  return chordsOf(assigned).flatMap(chord => assignedBindings(definition, chord));
}

type ReadEntries = { readonly ok: true; readonly entries: ReadonlyMap<RegisteredDefinition, readonly CommandChord[] | null> }
  | { readonly ok: false; readonly problem: AssignmentProblem };

function readEntries(raw: unknown): ReadEntries {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: { kind: 'invalid' } };
  const values = Object.entries(raw);
  if (values.length > MAX_ASSIGNMENTS) return { ok: false, problem: { kind: 'invalid' } };
  const entries = new Map<RegisteredDefinition, readonly CommandChord[] | null>();
  for (const [id, value] of values) {
    const definition = COMMAND_DEFINITIONS.find(item => item.id === id);
    if (definition === undefined) return { ok: false, problem: { kind: 'unknown-command', commandId: id } };
    if (!canAssignShortcut(definition.id)) return { ok: false, problem: { kind: 'fixed-command', commandId: definition.id } };
    const entry = readEntry(value);
    if (entry === 'invalid') return { ok: false, problem: { kind: 'invalid' } };
    if (entry === 'too-many') return { ok: false, problem: { kind: 'too-many-chords', commandId: definition.id } };
    if (entry?.some(isReservedCommandChord) === true) return { ok: false, problem: { kind: 'reserved', commandId: definition.id } };
    entries.set(definition, entry);
  }
  return { ok: true, entries };
}

/**
 * Validate the whole proposed map, allowing atomic swaps while rejecting partial acceptance.
 * 新しく選んだ組は、ほかの命令の既定のキーとも重ねない(今どおり)。適用済みの割当にある組だけは、新しい版で同じキーが
 * ほかの命令の既定になっても利用者の割当を優先して残す(設計 R7)。固定の命令の既定とは常に重ねない。
 */
export function validateShortcutAssignments(raw: unknown, applied: ShortcutAssignments = EMPTY_SHORTCUT_ASSIGNMENTS): AssignmentValidation {
  const read = readEntries(raw);
  if (!read.ok) return read;
  const assignments = entryMap(read.entries);
  const first = conflictsOf(read.entries, assignments, applied).next();
  if (first.done !== true) {
    return { ok: false, problem: { kind: 'conflict', commandId: first.value.commandId, otherCommandId: first.value.otherCommandId } };
  }
  return { ok: true, assignments: Object.freeze(assignments) };
}

/** 下書きの衝突の 1 件。chord は commandId の側の組。 */
export interface ShortcutConflict { readonly commandId: CommandId; readonly otherCommandId: CommandId; readonly chord: CommandChord }

/** 割当(組)と命令の対応。 */
function entryMap(entries: ReadonlyMap<RegisteredDefinition, readonly CommandChord[] | null>): Partial<Record<CommandId, readonly CommandChord[] | null>> {
  const assignments: Partial<Record<CommandId, readonly CommandChord[] | null>> = {};
  for (const [definition, entry] of entries) assignments[definition.id] = entry;
  return assignments;
}

/** 衝突を 1 件ずつ出す(validateShortcutAssignments は最初の 1 件、shortcutConflicts は全部)。判定はここ 1 か所。 */
function* conflictsOf(entries: ReadonlyMap<RegisteredDefinition, readonly CommandChord[] | null>,
  assignments: Partial<Record<CommandId, readonly CommandChord[] | null>>, applied: ShortcutAssignments): Generator<ShortcutConflict> {
  for (const [definition, entry] of entries) {
    for (const chord of entry ?? []) {
      const kept = chordsOf(applied[definition.id]).some(previous => sameChord(previous, chord));
      for (const other of COMMAND_DEFINITIONS) {
        if (other.id === definition.id) continue;
        const otherEntry = assignments[other.id];
        const collides = otherEntry === undefined
          ? (!kept || FIXED_COMMANDS.has(other.id)) && other.shortcuts.some(binding => chordTakesDefault(chord, definition, binding))
          : chordsOf(otherEntry).some(otherChord => chordsCollide(chord, definition, otherChord, other));
        if (collides) yield { commandId: definition.id, otherCommandId: other.id, chord };
      }
    }
  }
}

/**
 * 下書きの全ての衝突(操作の割り当ての窓の表の印と件数)。validateShortcutAssignments と同じ判定で、最初の 1 件で止めずに集める。
 * 2 つの命令の利用者の割当どうしの衝突は、両方の向きで出る。形が読めない下書きは空(適用の検査が断る)。
 */
export function shortcutConflicts(raw: unknown, applied: ShortcutAssignments = EMPTY_SHORTCUT_ASSIGNMENTS): readonly ShortcutConflict[] {
  const read = readEntries(raw);
  return read.ok ? [...conflictsOf(read.entries, entryMap(read.entries), applied)] : [];
}

/** NumLock を切ったテンキーが届ける key(ブラウザーと Electron。テンキーの 5 は Clear、小数点は Delete)。 */
const NUMPAD_NAVIGATION_KEYS: Readonly<Record<string, string>> = {
  Numpad0: 'insert', Numpad1: 'end', Numpad2: 'arrowdown', Numpad3: 'pagedown', Numpad4: 'arrowleft', Numpad5: 'clear',
  Numpad6: 'arrowright', Numpad7: 'home', Numpad8: 'arrowup', Numpad9: 'pageup', NumpadDecimal: 'delete',
};
const DOCUMENT_KINDS: readonly CommandDocumentKind[] = ['part', 'assembly', 'drawing'];

/**
 * その組を押した時に届きうる入力。位置の組のテンキーは、NumLock が入っている時(数字)と切れている時(移動のキーの名前)の
 * 両方(受け口の shortcutMatches は、位置の束は code で、文字の束は届いた key で合わせる)。
 */
function pressedInputs(chord: CommandChord, ctrl: boolean, meta: boolean): readonly CommandKeyInput[] {
  const base = chordInput(chord, ctrl, meta);
  if (!isCodeChord(chord)) return [base];
  const keys = [/^Numpad([0-9])$/u.exec(chord.code)?.[1], NUMPAD_NAVIGATION_KEYS[chord.code]];
  return [base, ...keys.filter((key): key is string => key !== undefined).map(key => ({ ...base, key }))];
}

/** 1 つの入力で動く命令。実行(resolveAssignedShortcut)と同じく、利用者の割当に当たればそれだけ、無ければ既定の束。 */
function commandsForInput(input: CommandKeyInput, context: CommandKeyContext, assignments: ShortcutAssignments): readonly CommandId[] {
  const assigned = COMMAND_DEFINITIONS.filter(definition => chordsOf(assignments[definition.id]).some(chord => chord.alt === input.alt
    && assignedBindings(definition, chord).some(binding => shortcutMatches(binding, input, context))));
  if (assigned.length > 0) return assigned.map(definition => definition.id);
  return COMMAND_DEFINITIONS.filter(definition => assignments[definition.id] === undefined
    && effectiveBindings(definition, assignments).some(binding => shortcutMatches(binding, input, context))).map(definition => definition.id);
}

/**
 * その組を押した時に動く命令(キーで探す)。実行と同じ順(利用者の割当が既定より先に勝つ)で、どれかの文書の種類・段・
 * NumLock の入切で動く物。探した結果は、そのキーを押した時に実際に動く命令と一致する。
 */
export function commandsUsingChord(chord: CommandChord, assignments: ShortcutAssignments): readonly CommandId[] {
  const contexts = DOCUMENT_KINDS.flatMap(documentKind => (['capture', 'bubble'] as const).map((phase): CommandKeyContext => ({
    documentKind, phase, helpOpen: false, textEntry: false, composing: false, activatedBySpace: false, insideMenu: false, insideDialog: false })));
  const inputs = ([[chord.primary, false], [false, chord.primary]] as const).flatMap(([ctrl, meta]) => pressedInputs(chord, ctrl, meta));
  const found = new Set(contexts.flatMap(context => inputs.flatMap(input => commandsForInput(input, context, assignments))));
  return COMMAND_DEFINITIONS.filter(definition => found.has(definition.id)).map(definition => definition.id);
}

/**
 * 保存されていた割当を 1 件ずつ読み、読めない 1 件だけを捨てる(設計 R6・R7)。知らない命令名・固定の命令・壊れた形・
 * 断るキー・3 つ目以降の組・先に読んだ割当と同じ押し方の組・固定の命令の既定と同じ押し方の組を捨て、捨てた数を返す。
 * ほかの命令の既定とだけ重なる組は残す(利用者の割当を優先する)。
 */
export function salvageShortcutAssignments(raw: unknown): { readonly assignments: ShortcutAssignments; readonly dropped: number } {
  if (raw === undefined || raw === null) return { assignments: EMPTY_SHORTCUT_ASSIGNMENTS, dropped: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { assignments: EMPTY_SHORTCUT_ASSIGNMENTS, dropped: 1 };
  const assignments: Partial<Record<CommandId, readonly CommandChord[] | null>> = {};
  let dropped = 0;
  for (const [id, value] of Object.entries(raw).slice(0, MAX_ASSIGNMENTS)) {
    const definition = COMMAND_DEFINITIONS.find(candidate => candidate.id === id);
    const items: readonly unknown[] = Array.isArray(value) ? value : [value];
    if (definition === undefined || !canAssignShortcut(definition.id) || items.length === 0) { dropped += 1; continue; }
    if (value === null) { assignments[definition.id] = null; continue; }
    const kept: CommandChord[] = [];
    for (const item of items) {
      const chord = readChord(item);
      const usable = chord !== null && kept.length < MAX_CHORDS_PER_COMMAND && !isReservedCommandChord(chord)
        && !kept.some(other => sameChord(other, chord))
        && !Object.entries(assignments).some(([otherId, otherEntry]) => {
          const other = COMMAND_DEFINITIONS.find(candidate => candidate.id === otherId);
          return other !== undefined && chordsOf(otherEntry).some(otherChord => chordsCollide(chord, definition, otherChord, other));
        })
        && !COMMAND_DEFINITIONS.some(other => FIXED_COMMANDS.has(other.id)
          && other.shortcuts.some(binding => chordTakesDefault(chord, definition, binding)));
      if (usable) kept.push(chord); else dropped += 1;
    }
    if (kept.length > 0) assignments[definition.id] = Object.freeze(kept);
  }
  if (Object.keys(assignments).length === 0) return { assignments: EMPTY_SHORTCUT_ASSIGNMENTS, dropped };
  return { assignments: Object.freeze(assignments), dropped };
}

/** An old/malformed setting only resets key assignments; it must not reset other preferences. */
export function readShortcutAssignments(source: string | null): ShortcutAssignments {
  if (source === null || source.length > MAX_JSON_LENGTH) return EMPTY_SHORTCUT_ASSIGNMENTS;
  try {
    const parsed: unknown = JSON.parse(source);
    const result = validateShortcutAssignments(parsed);
    return result.ok ? result.assignments : EMPTY_SHORTCUT_ASSIGNMENTS;
  } catch { return EMPTY_SHORTCUT_ASSIGNMENTS; }
}

/**
 * 押したキーの命令。利用者の割当を既定のキーより先に見る(新しい版の既定と重なっても利用者の割当が勝つ)。
 * 割当の組は Alt の有無まで一致した時だけ当たる(束の allowAlt は Alt を許すだけなので、ここで確かめる)。
 */
export function resolveAssignedShortcut(
  input: CommandKeyInput,
  context: CommandKeyContext,
  assignments: ShortcutAssignments,
  eligible: (definition: CommandDefinition) => boolean,
): { readonly commandId: CommandId; readonly binding: ShortcutBinding } | null {
  for (const definition of COMMAND_DEFINITIONS) {
    if (!eligible(definition)) continue;
    for (const chord of chordsOf(assignments[definition.id])) {
      if (chord.alt !== input.alt) continue;
      for (const binding of assignedBindings(definition, chord)) {
        if (shortcutMatches(binding, input, context)) return { commandId: definition.id, binding };
      }
    }
  }
  for (const definition of COMMAND_DEFINITIONS) {
    if (!eligible(definition) || assignments[definition.id] !== undefined) continue;
    for (const binding of effectiveBindings(definition, assignments)) {
      if (shortcutMatches(binding, input, context)) return { commandId: definition.id, binding };
    }
  }
  return null;
}
