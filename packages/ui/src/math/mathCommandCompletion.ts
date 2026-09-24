/**
 * Follow-up for MathLive 0.110.0's command completion in the structured field ("\" and a command name, then
 * Enter, Esc or a click on a suggestion). Both parts act only while or right after the field is in 'latex' mode.
 *
 * - MathLive recreates its suggestion list directly under document.body on every keystroke. A modal <dialog>
 *   makes everything outside it inert and covers it, so the list was hidden and could not be clicked. The list
 *   is moved into the field's open dialog, like KeyboardControlHint's tooltip. It keeps MathLive's fixed position.
 * - Completing a command whose first argument is empty (\sqrt, \overline) selects the whole command, so the next
 *   key replaced it. The caret is moved into the first argument instead. Commands without arguments (\pi) and
 *   commands whose arguments were typed (\sqrt{2}) keep MathLive's own caret.
 */
import type { StructuredMathField } from './mathFieldHost.js';

/** The id MathLive gives its shared suggestion list element. */
export const SUGGESTION_LIST_ID = 'mathlive-suggestion-popover';
/** MathLive's LaTeX for an empty placeholder atom. */
const PLACEHOLDER_LATEX = String.raw`\placeholder{}`;

/** The public MathLive members that the caret correction reads and sets. */
export type CompletedField = Pick<StructuredMathField, 'mode' | 'position' | 'selection' | 'lastOffset' | 'getElementInfo'>;

/**
 * Moves the list into the open dialog that contains the field, so it is drawn above the dialog and receives the
 * pointer. A field outside any open dialog leaves the list under document.body. Returns whether the list moved.
 */
export function keepSuggestionListInDialog(list: Element, field: Element): boolean {
  const dialog = field.closest('dialog[open]');
  if (dialog === null || list.parentElement === dialog) return false;
  dialog.append(list);
  return true;
}

/**
 * Called right after a completion inserted content at `start`, where `before` is `lastOffset` before the insertion.
 * MathLive numbers every argument slot before its command, and each slot begins with an empty marker atom that is
 * one level deeper than the command. When the inserted content is a single command and the caret is after it or
 * the whole command is selected, selects its first placeholder, or else puts the caret into its first argument if
 * that argument is empty. Returns whether the caret changed.
 */
export function enterFirstArgument(field: CompletedField, start: number, before: number): boolean {
  const end = start + field.lastOffset - before;
  // Nothing was inserted, or a command without arguments (one atom) such as \pi.
  if (field.mode !== 'math' || end - start < 2) return false;
  const command = field.getElementInfo(end);
  if (command?.depth === undefined) return false;
  let placeholder = -1;
  for (let offset = start + 1; offset < end; offset += 1) {
    const inner = field.getElementInfo(offset);
    // Everything before the command belongs to its arguments; otherwise several items were inserted.
    if (inner?.depth === undefined || inner.depth <= command.depth) return false;
    if (placeholder < 0 && inner.latex === PLACEHOLDER_LATEX) placeholder = offset;
  }
  const [range, ...others] = field.selection.ranges;
  if (range === undefined || others.length > 0) return false;
  // MathLive already selected an argument (the first placeholder of \frac after Enter): keep it.
  if (Math.max(...range) !== end || Math.min(...range) < start) return false;
  if (placeholder > 0) {
    field.selection = { ranges: [[placeholder - 1, placeholder]] };
    return true;
  }
  // The first argument is empty when its marker is followed by the command or by the next argument's marker.
  const marker = field.getElementInfo(start + 1), next = start + 2 < end ? field.getElementInfo(start + 2) : undefined;
  const empty = next === undefined || (next.depth === marker?.depth && (next.latex ?? '') === '');
  if (!empty) return false;
  field.position = start + 1;
  return true;
}

function followSuggestionList(field: StructuredMathField): () => void {
  const owner = field.ownerDocument;
  const place = (): void => {
    const list = owner.getElementById(SUGGESTION_LIST_ID);
    if (list !== null) keepSuggestionListInDialog(list, field);
  };
  const observer = new MutationObserver(place);
  observer.observe(owner.body, { childList: true });
  place();
  return () => { observer.disconnect(); };
}

/**
 * Watches the field's 'mode-change' events. While the field is in 'latex' mode its suggestion list is kept in the
 * field's dialog. When 'latex' mode ends in 'math' mode, MathLive inserts the completed command at the caret after
 * the event, so the caret is corrected in a microtask, before any further key reaches the field.
 * Returns the function that stops watching.
 */
export function followCommandCompletion(field: StructuredMathField): () => void {
  let mode = field.mode, disposed = false;
  let stopList: (() => void) | undefined;
  function modeChange(): void {
    // MathLive dispatches the event with the new mode already readable.
    const previous = mode;
    mode = field.mode;
    if (mode === 'latex') {
      stopList ??= followSuggestionList(field);
      return;
    }
    stopList?.();
    stopList = undefined;
    if (previous !== 'latex' || mode !== 'math') return;
    const start = field.position, before = field.lastOffset;
    queueMicrotask(() => { if (!disposed) enterFirstArgument(field, start, before); });
  }
  field.addEventListener('mode-change', modeChange);
  return () => {
    disposed = true;
    stopList?.();
    stopList = undefined;
    field.removeEventListener('mode-change', modeChange);
  };
}
