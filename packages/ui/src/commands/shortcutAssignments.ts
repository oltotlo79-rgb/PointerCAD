import {
  COMMAND_DEFINITIONS, shortcutMatches, type CommandDefinition, type CommandId,
  type CommandKeyContext, type CommandKeyInput, type ShortcutBinding,
} from './commandDefinitions.js';

export interface AssignedChord {
  readonly key: string;
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}
export type ShortcutAssignments = Readonly<Partial<Record<CommandId, AssignedChord | null>>>;
export const EMPTY_SHORTCUT_ASSIGNMENTS: ShortcutAssignments = Object.freeze({});
type RegisteredDefinition = CommandDefinition & { readonly id: CommandId };
export type AssignmentProblem =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unknown-command'; readonly commandId: string }
  | { readonly kind: 'fixed-command'; readonly commandId: CommandId }
  | { readonly kind: 'reserved'; readonly commandId: CommandId }
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
const CHORD_KEYS = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/u;

export function canAssignShortcut(commandId: CommandId): boolean {
  return !FIXED_COMMANDS.has(commandId);
}

function readChord(raw: unknown): AssignedChord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || !('key' in raw) || typeof raw.key !== 'string' || !CHORD_KEYS.test(raw.key)
    || !('primary' in raw) || typeof raw.primary !== 'boolean'
    || !('shift' in raw) || typeof raw.shift !== 'boolean'
    || !('alt' in raw) || typeof raw.alt !== 'boolean') return null;
  if (Object.keys(raw).some(key => !['key', 'primary', 'shift', 'alt'].includes(key))) return null;
  return Object.freeze({ key: raw.key, primary: raw.primary, shift: raw.shift, alt: raw.alt });
}

/** Browser/window controls remain available; AltGr input is never assignable. */
export function isReservedChord(chord: AssignedChord): boolean {
  if (chord.primary && chord.alt) return true;
  if (['f1', 'f5', 'f6', 'f11', 'f12'].includes(chord.key)) return true;
  if (chord.alt && chord.key === 'f4') return true;
  if (chord.shift && chord.key === 'f10') return true;
  if (chord.primary && ['l', 'r', 't', 'w', 'p', 'q'].includes(chord.key)) return true;
  if (chord.primary && chord.shift && ['n', 'j', 'i'].includes(chord.key)) return true;
  return false;
}

export function assignedChordLabel(chord: AssignedChord): string {
  return [chord.primary ? 'Ctrl/Cmd' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '',
    chord.key.toUpperCase()].filter(Boolean).join('+');
}

/** Custom keys never take over typing or IME. The fixed Ctrl/Cmd+S keeps its existing exception. */
export function assignedBindings(definition: CommandDefinition, chord: AssignedChord): readonly ShortcutBinding[] {
  const bases: readonly ShortcutBinding[] = definition.shortcuts.length > 0 ? definition.shortcuts : [{
    key: '', display: '', contextLabelKey: 'command.context.all', phase: 'bubble', primary: 'none',
    shift: 'forbidden', documentKinds: definition.documentKinds, preventDefault: true, rejectRepeat: true,
  }];
  return bases.map(binding => ({
    ...binding,
    key: chord.key, display: assignedChordLabel(chord),
    contextLabelKey: 'command.context.assigned',
    primary: chord.primary ? 'ctrl-or-meta' : 'none',
    shift: chord.shift ? 'required' : 'forbidden',
    allowAlt: chord.alt,
    allowInTextEntry: false,
    allowDuringComposition: false,
    allowInMenu: false,
  }));
}

export function effectiveBindings(definition: RegisteredDefinition, assignments: ShortcutAssignments): readonly ShortcutBinding[] {
  const assigned = assignments[definition.id];
  if (assigned === undefined) return definition.shortcuts;
  return assigned === null ? [] : assignedBindings(definition, assigned);
}

function overlaps(a: ShortcutBinding, b: ShortcutBinding, chord: AssignedChord): boolean {
  if (a.phase !== b.phase) return false;
  for (const documentKind of a.documentKinds) {
    if (!b.documentKinds.includes(documentKind)) continue;
    const context: CommandKeyContext = {
      documentKind, phase: a.phase, helpOpen: false, textEntry: false, composing: false,
      activatedBySpace: false, insideMenu: false, insideDialog: false,
    };
    for (const primary of [
      { ctrl: chord.primary, meta: false }, { ctrl: false, meta: chord.primary },
    ]) {
      const input: CommandKeyInput = { ...primary, key: chord.key, shift: chord.shift, alt: chord.alt, repeat: false };
      if (shortcutMatches(a, input, context) && shortcutMatches(b, input, context)) return true;
    }
  }
  return false;
}

/** Validate the whole proposed map, allowing atomic swaps while rejecting partial acceptance. */
export function validateShortcutAssignments(raw: unknown): AssignmentValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: { kind: 'invalid' } };
  const entries = Object.entries(raw);
  if (entries.length > MAX_ASSIGNMENTS) return { ok: false, problem: { kind: 'invalid' } };
  const assignments: Partial<Record<CommandId, AssignedChord | null>> = {};
  for (const [id, value] of entries) {
    const definition = COMMAND_DEFINITIONS.find(item => item.id === id);
    if (definition === undefined) return { ok: false, problem: { kind: 'unknown-command', commandId: id } };
    if (!canAssignShortcut(definition.id)) return { ok: false, problem: { kind: 'fixed-command', commandId: definition.id } };
    const chord = value === null ? null : readChord(value);
    if (value !== null && chord === null) return { ok: false, problem: { kind: 'invalid' } };
    if (chord !== null && isReservedChord(chord)) return { ok: false, problem: { kind: 'reserved', commandId: definition.id } };
    assignments[definition.id] = chord;
  }
  for (const definition of COMMAND_DEFINITIONS) {
    const chord = assignments[definition.id];
    if (chord === undefined || chord === null) continue;
    for (const other of COMMAND_DEFINITIONS) {
      if (other.id === definition.id) continue;
      const otherChord = assignments[other.id];
      // required Alt is checked here because legacy bindings permit Alt via an allow flag.
      if (otherChord !== undefined && otherChord !== null && otherChord.alt !== chord.alt) continue;
      if (effectiveBindings(definition, assignments).some(a => effectiveBindings(other, assignments).some(b => overlaps(a, b, chord)))) {
        return { ok: false, problem: { kind: 'conflict', commandId: definition.id, otherCommandId: other.id } };
      }
    }
  }
  return { ok: true, assignments: Object.freeze(assignments) };
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

export function resolveAssignedShortcut(
  input: CommandKeyInput,
  context: CommandKeyContext,
  assignments: ShortcutAssignments,
  eligible: (definition: CommandDefinition) => boolean,
): { readonly commandId: CommandId; readonly binding: ShortcutBinding } | null {
  for (const definition of COMMAND_DEFINITIONS) {
    if (!eligible(definition)) continue;
    const chord = assignments[definition.id];
    if (chord !== undefined && chord !== null && chord.alt !== input.alt) continue;
    for (const binding of effectiveBindings(definition, assignments)) {
      if (shortcutMatches(binding, input, context)) return { commandId: definition.id, binding };
    }
  }
  return null;
}
