import { followCommandCompletion } from './mathCommandCompletion.js';

/** Framework-neutral MathLive adapter draft. Product setup must supply a locally configured factory. */
export interface StructuredMathField extends HTMLElement {
  value: string;
  readOnly: boolean;
  /** MathLive switches to 'latex' while a command typed after "\" shows its suggestions. */
  readonly mode: 'math' | 'text' | 'latex';
  /** Caret offset. MathLive numbers the atoms of an item's arguments before the item itself. */
  position: number;
  selection: { readonly ranges: readonly (readonly [number, number])[] };
  readonly lastOffset: number;
  /** Tree depth (0 at the top level) and LaTeX of the atom at an offset. */
  getElementInfo(offset: number): { readonly depth?: number; readonly latex?: string } | undefined;
  mathVirtualKeyboardPolicy: 'auto' | 'manual' | 'sandboxed';
  menuItems: readonly unknown[];
  getValue(format?: 'latex'): string;
  setValue(value: string, options: { silenceNotifications: boolean }): void;
  insert(value: string, options: { insertionMode: 'replaceSelection'; selectionMode: 'placeholder'; format: 'latex' }): boolean;
}

export interface MathFieldHostOptions {
  readonly label: string;
  readonly describedBy: string;
  readonly initialSource: string;
  readonly maximumSourceLength: number;
  readonly onInput: (source: string) => void;
  readonly isCurrent: () => boolean;
  readonly onSourceLimit: () => void;
  readonly onApply: (source: string) => void;
  readonly onCancel: () => void;
  readonly onMoveOut: (direction: 'forward' | 'backward') => void;
}

export function attachMathField(
  container: HTMLElement,
  createField: () => StructuredMathField,
  options: MathFieldHostOptions,
): {
  readonly element: StructuredMathField;
  readonly updateSource: (source: string) => void;
  readonly setReadOnly: (value: boolean) => void;
  readonly insertTemplate: (latex: string) => boolean;
  readonly dispose: () => void;
} {
  if (!Number.isSafeInteger(options.maximumSourceLength) || options.maximumSourceLength < 1
    || options.initialSource.length > options.maximumSourceLength) {
    throw new Error('数式入力の長さの指定を確認してください。');
  }
  const field = createField();
  field.setAttribute('aria-label', options.label);
  field.setAttribute('aria-describedby', options.describedBy);
  field.mathVirtualKeyboardPolicy = 'manual';
  field.setValue(options.initialSource, { silenceNotifications: true });
  let composing = false;
  let disposed = false;
  let pendingSource: string | null = null;
  let lastPublished = options.initialSource;
  function publish(): void {
    if (disposed || composing || !options.isCurrent()) return;
    const source = field.getValue('latex');
    if (source.length > options.maximumSourceLength) {
      // Keep the entered text for correction. Never send oversized input to the parser/worker.
      options.onSourceLimit();
      return;
    }
    if (source !== lastPublished) {
      lastPublished = source;
      options.onInput(source);
    }
  }
  const compositionStart = (): void => { composing = true; };
  const compositionEnd = (): void => {
    composing = false;
    if (pendingSource !== null) {
      field.setValue(pendingSource, { silenceNotifications: true });
      lastPublished = pendingSource;
      pendingSource = null;
    } else publish();
  };
  function paste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (data === null) return;
    // MathLive prefers its own atoms, then LaTeX, then plain text. Its atom clipboard
    // also carries the LaTeX source; HTML and serialized atoms are not inserted as text.
    const source = data.getData('application/x-latex') || data.getData('text/plain');
    if (source.length > options.maximumSourceLength) {
      event.preventDefault();
      event.stopPropagation();
      options.onSourceLimit();
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing || composing || event.keyCode === 229) return;
    // This capture listener runs before MathLive's own key handling inside the field. While a command
    // typed after "\" shows its suggestions, Enter accepts the suggestion and Esc closes only the list:
    // MathLive handles both and prevents the default action, so the dialog neither confirms nor closes.
    // Ctrl/Meta+Enter keeps confirming the expression.
    if ((event.key === 'Enter' || event.key === 'Escape') && field.mode === 'latex'
      && !event.ctrlKey && !event.metaKey) return;
    if (event.key === 'Enter') {
      // Plain Enter stays inside expression editing; it cannot also confirm the CAD dialog.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && !field.readOnly && options.isCurrent()) {
        event.preventDefault();
        publish();
        const source = field.getValue('latex');
        if (source.length <= options.maximumSourceLength) options.onApply(source);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      options.onCancel();
    }
  }
  function moveOut(event: Event): void {
    if (composing || !('detail' in event) || event.detail === null || typeof event.detail !== 'object'
      || !('direction' in event.detail)) return;
    const direction = event.detail.direction;
    if (direction === 'forward' || direction === 'backward') {
      event.preventDefault();
      options.onMoveOut(direction);
    }
  }
  field.addEventListener('input', publish);
  field.addEventListener('paste', paste, true);
  field.addEventListener('compositionstart', compositionStart);
  field.addEventListener('compositionend', compositionEnd);
  field.addEventListener('keydown', keydown, true);
  field.addEventListener('move-out', moveOut);
  // Keeps MathLive's command suggestions visible in a modal dialog and puts the caret into the first argument.
  const stopCompletion = followCommandCompletion(field);
  container.append(field);
  // MathLive creates its menu controller only in connectedCallback.
  // Keep initialization atomic if a mounted-only setting fails.
  try { field.menuItems = []; } catch (error) { field.remove(); throw error; }
  return {
    element: field,
    updateSource(source) {
      if (disposed) return;
      if (source.length > options.maximumSourceLength) { options.onSourceLimit(); return; }
      if (composing) { pendingSource = source; return; }
      if (field.getValue('latex') !== source) field.setValue(source, { silenceNotifications: true });
      lastPublished = source;
    },
    setReadOnly(value) { if (!disposed) field.readOnly = value; },
    insertTemplate(latex) {
      if (disposed || field.readOnly || composing || !options.isCurrent()) return false;
      field.focus();
      return field.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'placeholder', format: 'latex' });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      field.removeEventListener('input', publish);
      field.removeEventListener('paste', paste, true);
      field.removeEventListener('compositionstart', compositionStart);
      field.removeEventListener('compositionend', compositionEnd);
      field.removeEventListener('keydown', keydown, true);
      field.removeEventListener('move-out', moveOut);
      stopCompletion();
      // Firefox does not fire a `blur` event when the focused element is removed from the document
      // (Chromium does), so MathLive's own onBlur - which clears its internal, module-global
      // "currently focused mathfield" reference - never runs for this field. The next math-field
      // anywhere in the app to receive focus then finds that stale reference still marked focused and
      // calls back into it, throwing inside MathLive's torn-down internals (MC-27d). Blurring here,
      // while the field is still connected, runs MathLive's normal blur handling first so its
      // bookkeeping stays correct regardless of the browser's removal quirk. Callers must dispose before the
      // field leaves the document (MathEditorSurface disposes in a layout-effect cleanup): once MathLive's
      // disconnectedCallback has run, `blur` no longer reaches its internals. `blur` is a safe no-op
      // when the field is not focused, so this runs unconditionally; `?.` only keeps lightweight test
      // doubles that omit the method (a production StructuredMathField always has it) working unchanged.
      field.blur?.();
      field.remove();
    },
  };
}

/** Elements that the browser's Tab order can include. Each candidate is still checked by reachableByTab. */
export const SEQUENTIAL_FOCUS_SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
/** Node.DOCUMENT_POSITION_FOLLOWING, written as a value so this module does not need the DOM globals. */
const DOCUMENT_POSITION_FOLLOWING = 4;
/** The parts of the dialog that focusAdjacentControl reads. Every DOM element provides them. */
export interface FocusScope {
  contains(other: Node | null): boolean;
  querySelectorAll(selectors: string): Iterable<HTMLElement>;
}

/** Tab skips disabled controls, tabindex -1, hidden controls, and everything in a closed details except its summary. */
function reachableByTab(control: Element): boolean {
  const tabIndex = control.getAttribute('tabindex');
  if ((tabIndex !== null && Number.parseInt(tabIndex, 10) < 0) || control.matches(':disabled')) return false;
  for (let details = control.closest('details'); details !== null; details = details.parentElement?.closest('details') ?? null) {
    if (!details.open && !(control.parentElement === details && control.matches('summary'))) return false;
  }
  return control.checkVisibility({ visibilityProperty: true });
}

/**
 * Moves focus from the structured field at its edge to the neighbouring control in document order,
 * the same control that Tab or Shift+Tab reaches from the text input. Returns false and keeps focus
 * when `from` is outside `scope` or no control exists in that direction.
 */
export function focusAdjacentControl(scope: FocusScope, from: Element, direction: 'forward' | 'backward'): boolean {
  if (!scope.contains(from)) return false;
  let target: HTMLElement | undefined;
  for (const control of scope.querySelectorAll(SEQUENTIAL_FOCUS_SELECTOR)) {
    if (from.contains(control) || control.contains(from) || !reachableByTab(control)) continue;
    if ((from.compareDocumentPosition(control) & DOCUMENT_POSITION_FOLLOWING) === 0) {
      // The last control before the field is where Shift+Tab goes.
      if (direction === 'backward') target = control;
    } else {
      // The first control after the field is where Tab goes.
      if (direction === 'forward') target = control;
      break;
    }
  }
  target?.focus();
  return target !== undefined;
}
