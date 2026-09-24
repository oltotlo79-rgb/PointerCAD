import { describe, expect, it, vi } from 'vitest';
import { attachMathField, type MathFieldHostOptions, type StructuredMathField } from './mathFieldHost.js';

class BrowserEventTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

function fixture(maximumSourceLength = 16) {
  let source = 'x';
  const attributes = new Map<string, string>();
  const members: Partial<StructuredMathField> = {
    value: 'x',
    readOnly: false,
    mathVirtualKeyboardPolicy: 'auto',
    menuItems: [] as readonly unknown[],
    setAttribute(name: string, value: string): void { attributes.set(name, value); },
    setValue(value: string): void { source = value; },
    getValue(): string { return source; },
    insert(): boolean { return true; },
    remove(): void { /* The test field has no DOM parent. */ },
  };
  const field = Object.assign(new BrowserEventTarget(), members) as StructuredMathField;
  const container = Object.assign(new EventTarget(), {
    append(...nodes: (Node | string)[]): void { expect(nodes).toEqual([field]); },
  } satisfies Partial<HTMLElement>) as HTMLElement;
  const options = {
    label: 'math', describedBy: 'message', initialSource: 'x', maximumSourceLength,
    onInput: vi.fn(), isCurrent: () => true, onSourceLimit: vi.fn(),
    onApply: vi.fn(), onCancel: vi.fn(), onMoveOut: vi.fn(),
  } satisfies MathFieldHostOptions;
  const host = attachMathField(container, () => field, options);
  function paste(formats: Readonly<Record<string, string>>) {
    const event = Object.assign(new Event('paste', { cancelable: true, bubbles: true }), {
      clipboardData: { types: Object.keys(formats), getData: (type: string) => formats[type] ?? '' },
    });
    field.dispatchEvent(event);
    // MathLive handles the default paste after the host's capture listener.
    if (!event.defaultPrevented) {
      source = formats['application/x-latex'] || formats['text/plain'] || source;
      field.dispatchEvent(new Event('input'));
    }
    return event;
  }
  return { field, host, options, paste, source: () => source };
}

describe('構造入力の貼付', () => {
  it('LaTeX の式を貼り付けて入力の変更を通知する', () => {
    const f = fixture();
    const latex = String.raw`\frac{1}{2}`;
    expect(f.paste({ 'application/x-latex': latex }).defaultPrevented).toBe(false);
    expect(f.source()).toBe(latex);
    expect(f.options.onInput).toHaveBeenCalledWith(latex);
    expect(f.options.onSourceLimit).not.toHaveBeenCalled();
    f.host.dispose();
  });

  it('上限を1文字超える式は貼付前に拒否し、欄を変えない', () => {
    const f = fixture(8);
    const event = f.paste({ 'text/plain': '1'.repeat(9) });
    expect(event.defaultPrevented).toBe(true);
    expect(event.cancelBubble).toBe(true);
    expect(f.source()).toBe('x');
    expect(f.options.onSourceLimit).toHaveBeenCalledTimes(1);
    expect(f.options.onInput).not.toHaveBeenCalled();
    f.host.dispose();
  });

  it('上限ちょうどの式を受け入れる', () => {
    const f = fixture(8);
    expect(f.paste({ 'text/plain': '1'.repeat(8) }).defaultPrevented).toBe(false);
    expect(f.source()).toBe('1'.repeat(8));
    expect(f.options.onInput).toHaveBeenCalledWith('1'.repeat(8));
    f.host.dispose();
  });

  it('長い HTML が同梱されても短い通常テキストを受け入れる', () => {
    const f = fixture(8);
    expect(f.paste({ 'text/html': '<span>1</span>'.repeat(20), 'text/plain': '1+2' }).defaultPrevented).toBe(false);
    expect(f.source()).toBe('1+2');
    expect(f.options.onSourceLimit).not.toHaveBeenCalled();
    f.host.dispose();
  });

  it('MathLive の長い内部形式を式の長さへ加算しない', () => {
    const f = fixture(8);
    expect(f.paste({ 'application/json+mathlive': '{"atoms":'.repeat(20),
      'application/x-latex': 'x+1', 'text/plain': '$$ x+1 $$' }).defaultPrevented).toBe(false);
    expect(f.source()).toBe('x+1');
    f.host.dispose();
  });

  it('LaTeX 形式があるときは、MathLive が使わない長い通常テキストを加算しない', () => {
    const f = fixture(8);
    expect(f.paste({ 'application/x-latex': 'x+1', 'text/plain': 'x'.repeat(20) }).defaultPrevented).toBe(false);
    expect(f.source()).toBe('x+1');
    f.host.dispose();
  });

  it('LaTeX 形式が上限超過なら、短い通常テキストがあっても拒否する', () => {
    const f = fixture(8);
    expect(f.paste({ 'application/x-latex': String.raw`\sqrt{123}`, 'text/plain': '1' }).defaultPrevented).toBe(true);
    expect(f.source()).toBe('x');
    expect(f.options.onSourceLimit).toHaveBeenCalledTimes(1);
    f.host.dispose();
  });

  it('日本語の変換中は貼付後の入力を通知せず、変換終了時に通知する', () => {
    const f = fixture();
    f.field.dispatchEvent(new Event('compositionstart'));
    expect(f.paste({ 'text/plain': 'π+1' }).defaultPrevented).toBe(false);
    expect(f.source()).toBe('π+1');
    expect(f.options.onInput).not.toHaveBeenCalled();
    f.field.dispatchEvent(new Event('compositionend'));
    expect(f.options.onInput).toHaveBeenCalledTimes(1);
    expect(f.options.onInput).toHaveBeenCalledWith('π+1');
    f.host.dispose();
  });
});
