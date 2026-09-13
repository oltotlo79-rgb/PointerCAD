/** Framework-neutral MathLive adapter draft. Product setup must supply a locally configured factory. */
export interface StructuredMathField extends HTMLElement {
  value: string;
  readOnly: boolean;
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
    let length = 0;
    for (const type of event.clipboardData?.types ?? []) {
      length += event.clipboardData?.getData(type).length ?? 0;
      if (length > options.maximumSourceLength) {
        event.preventDefault();
        event.stopPropagation();
        options.onSourceLimit();
        return;
      }
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing || composing || event.keyCode === 229) return;
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
      field.remove();
    },
  };
}
