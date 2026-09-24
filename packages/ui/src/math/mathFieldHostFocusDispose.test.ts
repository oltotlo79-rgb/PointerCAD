import { describe, expect, it, vi } from 'vitest';
import { attachMathField, type MathFieldHostOptions, type StructuredMathField } from './mathFieldHost.js';

/**
 * MC-27d: dispose() must blur the field before removing it from the document. Firefox does not fire a
 * `blur` event when a focused element is detached (Chromium does), so without an explicit blur first,
 * MathLive's internal "currently focused mathfield" reference stays stale, and the next math-field
 * anywhere in the app to receive focus throws inside MathLive's own onFocus/onBlur handling while
 * trying to blur that already torn-down field. This is a separate file (not an edit of the existing
 * mathFieldHost.test.ts) because that file's shared fixture has no `blur` method.
 */
class BrowserEventTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

function fixture(withBlur: boolean) {
  const calls: string[] = [];
  const members: Partial<StructuredMathField> = {
    value: 'x',
    readOnly: false,
    mathVirtualKeyboardPolicy: 'auto',
    menuItems: [] as readonly unknown[],
    setAttribute(): void { /* not exercised by these tests */ },
    setValue(): void { /* not exercised by these tests */ },
    getValue(): string { return 'x'; },
    insert(): boolean { return true; },
    remove(): void { calls.push('remove'); },
    ...(withBlur ? { blur(): void { calls.push('blur'); } } : {}),
  };
  const field = Object.assign(new BrowserEventTarget(), members) as StructuredMathField;
  const container = Object.assign(new EventTarget(), {
    append(): void { /* The fixture field has no real DOM parent. */ },
  } satisfies Partial<HTMLElement>) as HTMLElement;
  const options = {
    label: 'math', describedBy: 'message', initialSource: 'x', maximumSourceLength: 16,
    onInput: vi.fn(), isCurrent: () => true, onSourceLimit: vi.fn(),
    onApply: vi.fn(), onCancel: vi.fn(), onMoveOut: vi.fn(),
  } satisfies MathFieldHostOptions;
  return { host: attachMathField(container, () => field, options), calls };
}

describe('取り外し時の焦点の後始末(MC-27d)', () => {
  it('dispose()は欄を取り除く(remove)前にblurを呼ぶ', () => {
    const f = fixture(true);
    f.host.dispose();
    expect(f.calls).toEqual(['blur', 'remove']);
  });

  it('2回dispose()を呼んでもblur・removeは1回ずつ(後始末は冪等)', () => {
    const f = fixture(true);
    f.host.dispose();
    f.host.dispose();
    expect(f.calls).toEqual(['blur', 'remove']);
  });

  it('blurを実装しない欄でも例外にせず取り除く(既存の検査二重の欄を壊さない)', () => {
    const f = fixture(false);
    expect(() => { f.host.dispose(); }).not.toThrow();
    expect(f.calls).toEqual(['remove']);
  });
});
