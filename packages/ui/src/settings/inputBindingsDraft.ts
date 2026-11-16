import { COMMAND_DEFINITIONS, type CommandId } from '../commands/commandDefinitions.js';
import {
  canAssignShortcut, chordsOf, commandChordLabel, commandsUsingChord, effectiveBindings,
  type CommandChord, type ShortcutAssignments, type ShortcutConflict,
} from '../commands/shortcutAssignments.js';
import type { CodeChord } from '../commands/commandInputSettings.js';
import {
  DEFAULT_VIEW_CONTROLS, VIEW_ACTIONS, viewTriggerKey, type ViewAction, type ViewControlSettings, type ViewKeyGroup, type ViewTrigger,
} from './viewControlSettings.js';

/*
 * 操作の割り当ての窓の下書きの計算(設計 1-4・§5・§6)。画面を持たない純関数だけを置く。
 * 衝突の判定は commands/shortcutAssignments.ts(キー)と viewControlSettings.ts(視点)の 1 か所に任せ、ここでは
 * 表の行・絞り込み・「入れ替える」「あちらを外して使う」「この操作だけ既定に戻す」の下書きの作り方だけを持つ。
 */

/** キーの表の 1 行。 */
export interface KeyBindingRow {
  readonly id: CommandId;
  /** 今の下書きで効くキーの表示(重なりを除いた並び)。空は割当なし。 */
  readonly keys: readonly string[];
  /** 固定の命令(変えられない)。 */
  readonly fixed: boolean;
  /** この命令の割当が、ほかの命令と同じ押し方になっている。 */
  readonly conflict: boolean;
}

/** 表の全ての行(全ての命令。並びは命令の定義の順)。 */
export function keyBindingRows(values: ShortcutAssignments, conflicts: readonly ShortcutConflict[]): readonly KeyBindingRow[] {
  const conflicted = new Set(conflicts.flatMap(conflict => [conflict.commandId, conflict.otherCommandId]));
  return COMMAND_DEFINITIONS.map(definition => ({
    id: definition.id,
    keys: values[definition.id] === null ? [] : [...new Set(effectiveBindings(definition, values).map(binding => binding.display))],
    fixed: !canAssignShortcut(definition.id),
    conflict: conflicted.has(definition.id),
  }));
}

/** 表の絞り込み。名前(使う場所を含む表示の文字)・押したキー・衝突と未割当だけ、をすべて満たす行を残す。 */
export function filterKeyBindingRows(rows: readonly KeyBindingRow[], filter: {
  readonly name: (id: CommandId) => string;
  readonly query: string;
  readonly usingKey: readonly CommandId[] | null;
  readonly problemsOnly: boolean;
}): readonly KeyBindingRow[] {
  const query = filter.query.trim();
  return rows.filter(row => (query === '' || filter.name(row.id).includes(query))
    && (filter.usingKey === null || filter.usingKey.includes(row.id))
    && (!filter.problemsOnly || row.conflict || row.keys.length === 0));
}

/** ↑↓ で移る先の行(表示している行の中で、前か次。端では null)。 */
export function adjacentRow(rows: readonly KeyBindingRow[], id: CommandId, step: 1 | -1): CommandId | null {
  const index = rows.findIndex(row => row.id === id);
  return index < 0 ? rows[0]?.id ?? null : rows[index + step]?.id ?? null;
}

/** 下書きの衝突のうち、その命令が関わる物(相手の命令と組)。 */
export function conflictsOfCommand(conflicts: readonly ShortcutConflict[], id: CommandId): readonly { readonly other: CommandId; readonly chord: string }[] {
  const found: { other: CommandId; chord: string }[] = [];
  for (const conflict of conflicts) {
    const other = conflict.commandId === id ? conflict.otherCommandId : conflict.otherCommandId === id ? conflict.commandId : null;
    if (other !== null && !found.some(item => item.other === other)) found.push({ other, chord: commandChordLabel(conflict.chord) });
  }
  return found;
}

/** 今の下書きでその命令が効かせている組(既定のままなら既定の組は持たないので空)。 */
function ownChords(values: ShortcutAssignments, id: CommandId): readonly CommandChord[] {
  return chordsOf(values[id]);
}

function sameLabel(a: CommandChord, b: CommandChord): boolean {
  return commandChordLabel(a) === commandChordLabel(b);
}

/**
 * 「あちらを外して使う」: 相手の命令から、ぶつかる組を外す。相手が既定のままなら、相手の既定を外す(相手は割当なし)。
 * 相手が固定の命令なら何もしない(固定の命令の割当は変えられない)。
 */
export function takeFromOther(values: ShortcutAssignments, other: CommandId, chord: CommandChord): ShortcutAssignments {
  if (!canAssignShortcut(other)) return values;
  const entry = values[other];
  if (entry === undefined) return { ...values, [other]: null };
  const rest = chordsOf(entry).filter(item => !sameLabel(item, chord));
  return { ...values, [other]: rest.length === 0 ? null : rest };
}

/**
 * 「入れ替える」: 相手の命令に、こちらが前に使っていた組を渡す(こちらが前に組を持っていなければ、あちらを外すのと同じ)。
 * previous は、こちらに新しい組を入れる前の下書き。
 */
export function swapWithOther(values: ShortcutAssignments, previous: ShortcutAssignments, id: CommandId, other: CommandId,
  chord: CommandChord): ShortcutAssignments {
  const taken = takeFromOther(values, other, chord);
  const given = ownChords(previous, id).filter(item => !sameLabel(item, chord));
  if (taken === values || given.length === 0) return taken;
  const kept = chordsOf(taken[other]);
  return { ...taken, [other]: [...given.slice(0, 1), ...kept].slice(0, 2) };
}

/** 「この操作だけ既定に戻す」。 */
export function restoreCommand(values: ShortcutAssignments, id: CommandId): ShortcutAssignments {
  const next = { ...values };
  delete next[id];
  return next;
}

/* ---- 視点の操作 ---- */

const triggerKey = viewTriggerKey;

/** その入力を使っている操作(無ければ null)。except の操作は数えない。 */
export function viewTriggerOwner(value: ViewControlSettings, trigger: ViewTrigger, except: ViewAction | null = null): ViewAction | null {
  return VIEW_ACTIONS.find(action => action !== except && value.bindings[action].some(item => triggerKey(item) === triggerKey(trigger))) ?? null;
}

/** 操作の index 番目に入力を置く(index が数を超えれば足す)。 */
export function placeViewTrigger(value: ViewControlSettings, action: ViewAction, index: number, trigger: ViewTrigger): ViewControlSettings {
  const list = [...value.bindings[action]];
  if (index >= list.length) list.push(trigger);
  else list[index] = trigger;
  return { ...value, bindings: { ...value.bindings, [action]: list } };
}

/** 「あちらを外して使う」: ほかの操作からその入力を外して、こちらへ置く。 */
export function takeViewTrigger(value: ViewControlSettings, action: ViewAction, index: number, trigger: ViewTrigger): ViewControlSettings {
  const owner = viewTriggerOwner(value, trigger, action);
  const cleared = owner === null ? value : { ...value, bindings: { ...value.bindings,
    [owner]: value.bindings[owner].filter(item => triggerKey(item) !== triggerKey(trigger)) } };
  return placeViewTrigger(cleared, action, index, trigger);
}

/** 「入れ替える」: こちらの index 番目に前にあった入力を、相手の操作のその入力の場所へ渡す(前が無ければ外すのと同じ)。 */
export function swapViewTrigger(value: ViewControlSettings, action: ViewAction, index: number, trigger: ViewTrigger): ViewControlSettings {
  const owner = viewTriggerOwner(value, trigger, action), previous = value.bindings[action][index];
  if (owner === null || previous === undefined) return takeViewTrigger(value, action, index, trigger);
  const swapped = { ...value, bindings: { ...value.bindings,
    [owner]: value.bindings[owner].map(item => triggerKey(item) === triggerKey(trigger) ? previous : item) } };
  return placeViewTrigger(swapped, action, index, trigger);
}

/** キーの組の物理の位置(KeyboardEvent.code)。＋−はテンキーと、記号のキー(−と＝＋)の両方。 */
export const VIEW_KEY_CODES: Readonly<Record<ViewKeyGroup, readonly CodeChord['code'][]>> = {
  arrows: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  numpad: ['Numpad8', 'Numpad2', 'Numpad4', 'Numpad6'],
  plusMinus: ['NumpadAdd', 'NumpadSubtract', 'Equal', 'Minus'],
};

/** 視点のキーと命令のキーの重なり(設計 §5 の key-collision)。 */
export interface ViewKeyCollision {
  readonly action: ViewAction;
  readonly trigger: ViewTrigger;
  readonly commandId: CommandId;
}

/**
 * 視点のキーの割当が、命令のキー(利用者の割当と、利用者の割当が勝つ既定)と同じ押し方になる所。
 * 3D の上では視点のキーと命令のキーを同時に動かさないよう、どちらの窓の適用も断る。Meta は Ctrl と同じ「Ctrl/Cmd」として比べる。
 */
export function viewKeyCollisions(view: ViewControlSettings, assignments: ShortcutAssignments): readonly ViewKeyCollision[] {
  const found: ViewKeyCollision[] = [];
  for (const action of VIEW_ACTIONS) {
    for (const trigger of view.bindings[action]) {
      for (const commandId of commandsUsingViewKeys(trigger, assignments)) {
        if (!found.some(item => item.action === action && item.commandId === commandId)) found.push({ action, trigger, commandId });
      }
    }
  }
  return found;
}

/** キーの組のどれかの押し方で動く命令(キーでない入力は空)。 */
function commandsUsingViewKeys(trigger: ViewTrigger, assignments: ShortcutAssignments): readonly CommandId[] {
  if (trigger.kind !== 'keys') return [];
  const modifiers = { primary: trigger.ctrl || trigger.meta, shift: trigger.shift, alt: trigger.alt };
  return VIEW_KEY_CODES[trigger.keys].flatMap(code => {
    // NumLock の入ったテンキーの数字は、同じ数字の文字のキー(組立の 1〜4 など)としても届く。
    const digit = /^Numpad[0-9]$/u.test(code) ? [{ key: code.slice('Numpad'.length), ...modifiers }] : [];
    return [{ code, label: code, ...modifiers } satisfies CodeChord, ...digit].flatMap(chord => commandsUsingChord(chord, assignments));
  });
}

/** 「この操作だけ既定に戻す」。ほかの操作の割当と速さ・向きはそのまま(重なれば適用の検査が知らせる)。 */
export function restoreViewAction(value: ViewControlSettings, action: ViewAction): ViewControlSettings {
  return { ...value, bindings: { ...value.bindings, [action]: DEFAULT_VIEW_CONTROLS.bindings[action] } };
}
