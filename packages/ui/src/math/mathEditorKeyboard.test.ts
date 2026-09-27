/**
 * 数式画面のキーボード・IME・読み上げの受入(MC-27。docs/plans/追加-数学入力.md §2-6
 * 「IME変換中のEnter、上下添字移動、Tab/ShiftTab、Esc、読み上げとキーボード操作を受入に含める」)。
 * ブラウザーを起動せず、画面が実際に使う処理を呼ぶ。
 * - 文字入力欄: 描画中に MathEditorSurface を呼び、返った要素木の textarea の onKeyDown(製品の実物)を呼ぶ。
 *   判定を検査側で書き直さないため、画面のキー処理が変われば検査が失敗する。
 * - 構造入力欄: attachMathField へ EventTarget の代役を渡し、実際の keydown・変換・move-out の処理を動かす。
 *   MathLive 内部の添字・プレースホルダーの移動そのものは実画面の検査で扱い、ここでは横取りしないことを確かめる。
 * - 読み上げと Tab 順: サーバー描画した要素の属性と文書順を確かめる。
 * Enter・Space・Tab と保存・開くのキーを横取りしないこと(rules/06 §10.244)も同じ表で確かめる。
 */
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachMathField, type MathFieldHostOptions, type StructuredMathField } from './mathFieldHost.js';
import { mathEditorLabels } from './mathEditorLabels.js';
import type { MathEditorInput } from './mathEditorSession.js';
import {
  MathEditorSurface, type MathEditorSurfaceProps, type MathEditorViewController, type MathInsertGroup,
} from './MathEditorSurface.js';
import type { MathPaletteItem } from './mathPalette.js';

interface KeyModifiers {
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}
interface KeyCase extends KeyModifiers { readonly name: string; readonly key: string }
interface KeyOutcome { readonly prevented: boolean; readonly stopped: boolean }

/** 変換中を示す2つの印。keyCode 229 は変換確定の Enter で isComposing が偽になる環境の印。 */
const COMPOSING_MARKS: readonly (KeyModifiers & { readonly name: string })[] = [
  { name: 'isComposing', isComposing: true },
  { name: 'keyCode 229', keyCode: 229 },
];
const CONFIRM_AND_CANCEL_KEYS: readonly KeyCase[] = [
  { name: 'Enter', key: 'Enter' },
  { name: 'Ctrl+Enter', key: 'Enter', ctrlKey: true },
  { name: 'Meta+Enter', key: 'Enter', metaKey: true },
  { name: 'Esc', key: 'Escape' },
];
/** 焦点移動・添字の移動・ボタンの押下・保存と開くのキー。数式の欄はどれも横取りしない。 */
const PASS_THROUGH_KEYS: readonly KeyCase[] = [
  { name: 'Tab', key: 'Tab' },
  { name: 'Shift+Tab', key: 'Tab', shiftKey: true },
  { name: 'Space', key: ' ' },
  { name: 'Ctrl+S', key: 's', ctrlKey: true },
  { name: 'Ctrl+O', key: 'o', ctrlKey: true },
  { name: 'ArrowUp', key: 'ArrowUp' },
  { name: 'ArrowDown', key: 'ArrowDown' },
];

// ---- 文字入力欄と画面の構造 ----

/** 文字入力欄の onKeyDown が読む項目だけを持つ代役。名前は React の KeyboardEvent と同じ。 */
interface TextKeyDown {
  readonly key: string;
  readonly keyCode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface RenderedProps {
  readonly [name: string]: unknown;
  readonly children?: unknown;
  readonly onKeyDown?: (event: TextKeyDown) => void;
}
type RenderedElement = ReactElement<RenderedProps>;

const INPUT: MathEditorInput = {
  identity: { documentId: 'part', documentVersion: 1, editorId: 'keyboard', inputRevision: 0 },
  source: '1+2', notation: 'text', angleUnit: 'degree',
};
const GROUPS: readonly MathInsertGroup[] = [
  { id: 'axes', label: '軸', choices: [{ id: 'axis-x', label: 'X', meaning: 'X座標を入れる', template: 'X' }] },
];
const PALETTE: readonly MathPaletteItem[] = [{
  id: 'square-root', group: 'basic', label: '平方根', symbol: '√', template: String.raw`\sqrt{#0}`,
  keywords: ['sqrt'], requiredOperations: ['sqrt'], acceptanceIds: [], meaning: '平方根を入れる',
}];
const FOCUSABLE = new Set(['button', 'select', 'textarea', 'input', 'summary']);

interface SurfaceOptions {
  readonly notation?: MathEditorInput['notation'];
  readonly readOnly?: boolean;
  readonly hasError?: boolean;
  readonly busy?: boolean;
  readonly resultDetail?: string;
}

function renderSurface(options: SurfaceOptions = {}) {
  const input: MathEditorInput = { ...INPUT, notation: options.notation ?? 'text' };
  const apply = vi.fn<() => void>(), cancel = vi.fn<() => void>();
  const createField = vi.fn((): StructuredMathField => { throw new Error('Static rendering must not create a structured field'); });
  const controller: MathEditorViewController = {
    current: () => input, isCurrent: () => true, sourceChanged: vi.fn(), apply, cancel, sourceLimit: vi.fn(),
    moveOut: vi.fn(), bindInsertion: () => () => undefined, insert: vi.fn(), requestNotation: vi.fn(), changeAngleUnit: vi.fn(),
  };
  const labels = mathEditorLabels();
  const props: MathEditorSurfaceProps = {
    input, controller, createField, labels, groups: GROUPS, palette: PALETTE, query: '', onQuery: vi.fn(),
    resultMessage: '3', resultDetail: options.resultDetail ?? '', hasError: options.hasError ?? false,
    busy: options.busy ?? false, canApply: true, canChangeNotation: true, readOnly: options.readOnly ?? false,
    onHelp: vi.fn(), maximumSourceLength: 16,
  };
  const rendered: unknown[] = [];
  function Probe(): React.JSX.Element {
    // 描画中に画面の関数を呼ぶと hooks の規則を保ったまま、返した要素(実際の onKeyDown を含む)を受け取れる。
    const element = MathEditorSurface(props);
    rendered.push(element);
    return element;
  }
  const markup = renderToStaticMarkup(createElement(Probe));
  if (rendered.length !== 1) throw new Error(`Expected one render, got ${rendered.length}`);
  return { markup, tree: rendered[0], labels, apply, cancel, createField };
}

/** 要素木を文書順(前順)に並べる。map で入れ子になった配列も平らにし、関数の部品は展開せずその要素自体を返す。 */
function elementsOf(node: unknown): readonly RenderedElement[] {
  if (Array.isArray(node)) {
    const items: readonly unknown[] = node;
    return items.flatMap(item => elementsOf(item));
  }
  return isValidElement<RenderedProps>(node) ? [node, ...elementsOf(node.props.children)] : [];
}
function elementOf(tree: unknown, predicate: (element: RenderedElement) => boolean): RenderedElement {
  const found = elementsOf(tree).filter(predicate);
  if (found.length !== 1) throw new Error(`Expected one rendered element, found ${found.length}`);
  return found[0];
}
function textProp(element: RenderedElement, name: string): string {
  const value = element.props[name];
  if (typeof value !== 'string') throw new Error(`Expected a string ${name}`);
  return value;
}
function focusableElements(tree: unknown): readonly RenderedElement[] {
  return elementsOf(tree).filter(element => typeof element.type === 'string' && FOCUSABLE.has(element.type));
}
/** 文字入力欄の実際の onKeyDown を1回呼び、既定動作の停止と親への伝達停止の有無を返す。 */
function pressText(tree: unknown, key: string, modifiers: KeyModifiers = {}): KeyOutcome {
  const onKeyDown = elementOf(tree, element => element.type === 'textarea').props.onKeyDown;
  if (onKeyDown === undefined) throw new Error('The text input has no key handler');
  const outcome = { prevented: false, stopped: false };
  onKeyDown({
    key, keyCode: modifiers.keyCode ?? 0, ctrlKey: modifiers.ctrlKey ?? false, metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false, altKey: false, nativeEvent: { isComposing: modifiers.isComposing ?? false },
    preventDefault: () => { outcome.prevented = true; }, stopPropagation: () => { outcome.stopped = true; },
  });
  return outcome;
}

describe('MC-27 文字入力欄のキー操作(画面の実際の onKeyDown)', () => {
  it.each(COMPOSING_MARKS)('IME変換中の印($name)がある Enter・Ctrl+Enter・Meta+Enter・Esc は確定も取消もせず、変換の既定動作と伝達を妨げない', mark => {
    const view = renderSurface();
    for (const keyCase of CONFIRM_AND_CANCEL_KEYS) {
      expect(pressText(view.tree, keyCase.key, { ...keyCase, ...mark }), keyCase.name).toEqual({ prevented: false, stopped: false });
    }
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.cancel).not.toHaveBeenCalled();
  });

  it('通常の Enter は入力欄の改行として残し、座標や係数の画面の確定へは伝えない', () => {
    const view = renderSurface();
    expect(pressText(view.tree, 'Enter')).toEqual({ prevented: false, stopped: true });
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.cancel).not.toHaveBeenCalled();
  });

  it.each(['ctrlKey', 'metaKey'] as const)('%s 付きの Enter で式を確定し、改行と親への伝達を止める', modifier => {
    const view = renderSurface();
    expect(pressText(view.tree, 'Enter', modifier === 'ctrlKey' ? { ctrlKey: true } : { metaKey: true }))
      .toEqual({ prevented: true, stopped: true });
    expect(view.apply).toHaveBeenCalledTimes(1);
    expect(view.cancel).not.toHaveBeenCalled();
  });

  it('確定の処理中(読取専用)は Ctrl+Enter でも確定を重ねず、改行と親への伝達だけを止める', () => {
    const view = renderSurface({ readOnly: true });
    expect(elementOf(view.tree, element => element.type === 'textarea').props.readOnly).toBe(true);
    expect(pressText(view.tree, 'Enter', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
    expect(view.apply).not.toHaveBeenCalled();
  });

  it('Esc で取消し、既定動作と親への伝達を止める', () => {
    const view = renderSurface();
    expect(pressText(view.tree, 'Escape')).toEqual({ prevented: true, stopped: true });
    expect(view.cancel).toHaveBeenCalledTimes(1);
    expect(view.apply).not.toHaveBeenCalled();
  });

  it.each(PASS_THROUGH_KEYS)('$name は横取りせず、焦点移動・保存・開く・文字入力に任せる', keyCase => {
    const view = renderSurface();
    expect(pressText(view.tree, keyCase.key, keyCase)).toEqual({ prevented: false, stopped: false });
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.cancel).not.toHaveBeenCalled();
  });
});

describe('MC-27 読み上げと Tab 順(画面の構造)', () => {
  it('結果欄は丁寧に読み上げる状態表示で、文字入力欄は名前・結果・操作案内を読む', () => {
    const view = renderSurface({ busy: true, resultDetail: '正確な値' });
    const status = elementOf(view.tree, element => element.props.role === 'status');
    expect([status.props['aria-live'], status.props['aria-atomic']]).toEqual(['polite', 'true']);
    expect(elementsOf(status.props.children).map(element => element.props.children)).toEqual(['3', '正確な値']);
    const hint = elementOf(view.tree, element => element.props.className === 'pcad-math-editor__hint');
    expect(hint.props.children).toBe(view.labels.keyboardHint);
    const input = elementOf(view.tree, element => element.type === 'textarea');
    expect(input.props['aria-describedby']).toBe(`${textProp(status, 'id')} ${textProp(hint, 'id')}`);
    expect([input.props.title, input.props['aria-invalid']]).toEqual([view.labels.keyboardHint, false]);
    const label = elementOf(view.tree, element => element.type === 'label'
      && elementsOf(element.props.children).some(child => child.type === 'textarea'));
    expect(label.props.children).toEqual([view.labels.input, input]);
    expect(elementOf(view.tree, element => element.props.className === 'pcad-math-editor__expression').props['aria-busy']).toBe(true);
    expect(view.markup).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });

  it('誤りのある結果は入力欄を不正と示し、同じ読み上げ領域で知らせる', () => {
    const view = renderSurface({ hasError: true });
    const status = elementOf(view.tree, element => element.props.role === 'status');
    expect([status.props.className, status.props['aria-live']])
      .toEqual(['pcad-math-editor__result pcad-math-editor__result--error', 'polite']);
    expect(elementOf(view.tree, element => element.type === 'textarea').props['aria-invalid']).toBe(true);
  });

  it('構造入力でも同じ名前・結果欄・操作案内を入力欄へ渡し、Tab 順の同じ位置に置き、描画だけでは入力欄を作らない', () => {
    const view = renderSurface({ notation: 'latex' });
    const status = elementOf(view.tree, element => element.props.role === 'status');
    const hint = elementOf(view.tree, element => element.props.className === 'pcad-math-editor__hint');
    const field = elementOf(view.tree, element => typeof element.props.descriptionId === 'string');
    expect([field.props.label, field.props.descriptionId, field.props.hint])
      .toEqual([view.labels.input, `${textProp(status, 'id')} ${textProp(hint, 'id')}`, view.labels.keyboardHint]);
    const order = elementsOf(view.tree);
    const angle = elementOf(view.tree, element => element.props.title === view.labels.hints.angleUnit);
    const firstChoice = elementOf(view.tree, element => element.props.title === GROUPS[0].choices[0].meaning);
    expect(order.indexOf(angle)).toBeLessThan(order.indexOf(field));
    expect(order.indexOf(field)).toBeLessThan(order.indexOf(firstChoice));
    expect(order.filter(element => element.type === 'textarea')).toEqual([]);
    expect(view.createField).not.toHaveBeenCalled();
  });

  it('Tab 順は文書の順で入力欄→挿入→記号一覧→取消→確定と進み、tabindex で順序を変えない(Shift+Tab はその逆順)', () => {
    const view = renderSurface();
    const { hints } = view.labels;
    expect(focusableElements(view.tree).map(element => element.props.title ?? element.type)).toEqual([
      hints.help, hints.text, hints.structured, hints.angleUnit, view.labels.keyboardHint,
      GROUPS[0].choices[0].meaning, 'summary', hints.category, hints.search, PALETTE[0].meaning, hints.cancel, hints.apply,
    ]);
    expect(elementsOf(view.tree).filter(element => element.props.tabIndex !== undefined)).toEqual([]);
    expect(view.markup).not.toMatch(/tabindex/iu);
  });

  it('確定の処理中は編集の操作を無効にして Tab で止まらず、説明・入力欄・一覧の検索・取消へは移れる', () => {
    const view = renderSurface({ readOnly: true });
    const { hints } = view.labels;
    expect(focusableElements(view.tree).filter(element => element.props.disabled !== true)
      .map(element => element.props.title ?? element.type))
      .toEqual([hints.help, view.labels.keyboardHint, 'summary', hints.category, hints.search, hints.cancel]);
  });
});

// ---- 構造入力欄 ----

type SetValueOptions = Parameters<StructuredMathField['setValue']>[1];
type InsertOptions = Parameters<StructuredMathField['insert']>[1];
const NO_MENU: readonly unknown[] = [];
const hosts: { dispose(): void }[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

/**
 * Node の EventTarget は removeEventListener の第3引数が真偽値のとき capture として照合せず、
 * 捕捉段の listener が外れない(ブラウザーは DOM の仕様どおり照合する)。代役の解除だけをブラウザーと同じ扱いにそろえる。
 */
class BrowserEventTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

/**
 * MathLive の要素は DOM なしで作れないため、attachMathField が使う項目だけを実装した代役を使う。
 * satisfies で各項目が実際の型と一致することを確かめ、渡すときの型の指定は StructuredMathField と HTMLElement の1回ずつだけにする。
 */
function structuredField(initialSource: string) {
  let latex = initialSource, focusCount = 0, removeCount = 0, mode: StructuredMathField['mode'] = 'math';
  const attributes = new Map<string, string>(), silentWrites: string[] = [], inserted: string[] = [], appended: unknown[] = [];
  const members = {
    readOnly: false,
    mathVirtualKeyboardPolicy: 'auto',
    menuItems: NO_MENU,
    setAttribute(name: string, value: string): void { attributes.set(name, value); },
    focus(): void { focusCount += 1; },
    remove(): void { removeCount += 1; },
    getValue(): string { return latex; },
    setValue(value: string, options: SetValueOptions): void {
      latex = value;
      if (options.silenceNotifications) silentWrites.push(value);
    },
    insert(value: string, options: InsertOptions): boolean {
      inserted.push(`${options.insertionMode}:${value}`);
      return true;
    },
  } satisfies Partial<StructuredMathField>;
  const field = Object.assign(new BrowserEventTarget(), members) as StructuredMathField;
  // MathLive の mode は読むたびに現在の状態を返す(「\」で命令を打ち始めると 'latex')。
  Object.defineProperty(field, 'mode', { get: () => mode, configurable: true });
  const container = Object.assign(new EventTarget(), {
    append(...nodes: (Node | string)[]): void { appended.push(...nodes); },
  } satisfies Partial<HTMLElement>) as HTMLElement;
  const options = {
    label: '数式', describedBy: 'result hint', initialSource, maximumSourceLength: 16,
    onInput: vi.fn<(source: string) => void>(), isCurrent: vi.fn<() => boolean>(() => true),
    onSourceLimit: vi.fn<() => void>(), onApply: vi.fn<(source: string) => void>(), onCancel: vi.fn<() => void>(),
    onMoveOut: vi.fn<(direction: 'forward' | 'backward') => void>(),
  } satisfies MathFieldHostOptions;
  const host = attachMathField(container, () => field, options);
  hosts.push(host);
  return {
    field, host, options, attributes, silentWrites, inserted, appended,
    focusCount: () => focusCount, removeCount: () => removeCount,
    /** MathLive の中で式が変わった状態を作る(input の通知は別に送る)。 */
    edit: (source: string): void => { latex = source; },
    /** MathLive の入力の状態を変える。'latex' は「\」で始めた命令の候補の一覧を出している間。 */
    setMode: (value: StructuredMathField['mode']): void => { mode = value; },
    send: (type: string): void => { field.dispatchEvent(new Event(type)); },
  };
}
function pressField(field: StructuredMathField, key: string, modifiers: KeyModifiers = {}): KeyOutcome {
  const event = Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), {
    key, keyCode: modifiers.keyCode ?? 0, ctrlKey: modifiers.ctrlKey ?? false, metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false, altKey: false, isComposing: modifiers.isComposing ?? false,
  });
  field.dispatchEvent(event);
  return { prevented: event.defaultPrevented, stopped: event.cancelBubble };
}
/** MathLive が Tab・矢印キーで式の端に達したときに出す通知。 */
function moveOut(field: StructuredMathField, detail: unknown): boolean {
  const event = new CustomEvent('move-out', { detail, bubbles: true, cancelable: true });
  field.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('MC-27 構造入力欄のキー操作(attachMathField の実際の処理)', () => {
  it('変換の開始から終了までは Enter・Ctrl+Enter・Esc を処理せず、終了後の Ctrl+Enter で変換済みの式を確定する', () => {
    const f = structuredField('x');
    f.send('compositionstart');
    f.edit('x+');
    f.send('input');
    // isComposing が偽で届く実装でも、変換の開始・終了の通知から変換中と判断する。
    for (const keyCase of CONFIRM_AND_CANCEL_KEYS) {
      expect(pressField(f.field, keyCase.key, keyCase), keyCase.name).toEqual({ prevented: false, stopped: false });
    }
    expect(f.options.onInput).not.toHaveBeenCalled();
    f.edit('x+1');
    f.send('compositionend');
    expect(f.options.onInput.mock.calls).toEqual([['x+1']]);
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
    expect(f.options.onApply.mock.calls).toEqual([['x+1']]);
    expect(f.options.onCancel).not.toHaveBeenCalled();
  });

  it.each(COMPOSING_MARKS)('変換中の印($name)がある Enter・Ctrl+Enter・Meta+Enter・Esc は確定・取消・伝達停止をしない', mark => {
    const f = structuredField('x');
    for (const keyCase of CONFIRM_AND_CANCEL_KEYS) {
      expect(pressField(f.field, keyCase.key, { ...keyCase, ...mark }), keyCase.name).toEqual({ prevented: false, stopped: false });
    }
    expect(f.options.onApply).not.toHaveBeenCalled();
    expect(f.options.onCancel).not.toHaveBeenCalled();
  });

  it('通常の Enter は捕捉段で止めて座標や係数の画面の確定へ伝えず、式も確定しない', () => {
    const f = structuredField('x');
    expect(pressField(f.field, 'Enter')).toEqual({ prevented: false, stopped: true });
    expect(f.options.onApply).not.toHaveBeenCalled();
  });

  it.each(['ctrlKey', 'metaKey'] as const)('%s 付きの Enter は入力の通知より先に押されても、最新の式を知らせてから確定する', modifier => {
    const f = structuredField('x');
    f.edit('x^2');
    expect(pressField(f.field, 'Enter', modifier === 'ctrlKey' ? { ctrlKey: true } : { metaKey: true }))
      .toEqual({ prevented: true, stopped: true });
    expect(f.options.onInput.mock.calls).toEqual([['x^2']]);
    expect(f.options.onApply.mock.calls).toEqual([['x^2']]);
    expect(f.options.onInput.mock.invocationCallOrder[0]).toBeLessThan(f.options.onApply.mock.invocationCallOrder[0]);
  });

  it.each(['readOnly', 'stale'] as const)('%s の入力欄では Ctrl+Enter で確定せず、親への伝達だけを止める', state => {
    const f = structuredField('x');
    if (state === 'readOnly') f.host.setReadOnly(true);
    else f.options.isCurrent.mockReturnValue(false);
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: false, stopped: true });
    expect(f.options.onApply).not.toHaveBeenCalled();
  });

  it('上限を超えた式は Ctrl+Enter でも確定せず、上限の案内を1回だけ出す', () => {
    const f = structuredField('x');
    f.edit('x'.repeat(17));
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
    expect(f.options.onSourceLimit).toHaveBeenCalledTimes(1);
    expect(f.options.onApply).not.toHaveBeenCalled();
    expect(f.options.onInput).not.toHaveBeenCalled();
  });

  it('Esc で取消し、既定動作と親への伝達を止める', () => {
    const f = structuredField('x');
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: true, stopped: true });
    expect(f.options.onCancel).toHaveBeenCalledTimes(1);
    expect(f.options.onApply).not.toHaveBeenCalled();
  });

  it.each(PASS_THROUGH_KEYS)('$name は捕捉段で止めず、MathLive のプレースホルダー・添字の移動や保存・開くへ渡す', keyCase => {
    const f = structuredField('x');
    expect(pressField(f.field, keyCase.key, keyCase)).toEqual({ prevented: false, stopped: false });
    for (const callback of [f.options.onApply, f.options.onCancel, f.options.onMoveOut, f.options.onInput]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it.each(['forward', 'backward'] as const)('Tab・Shift+Tab で式の端から出る %s の移動は、既定の移動を止めて画面内の焦点移動へ渡す', direction => {
    const f = structuredField('x');
    expect(moveOut(f.field, { direction })).toBe(true);
    expect(f.options.onMoveOut.mock.calls).toEqual([[direction]]);
  });

  it('上下の添字の端(upward・downward)・向きのない通知・変換中の移動は横取りしない', () => {
    const f = structuredField('x');
    expect(moveOut(f.field, { direction: 'upward' })).toBe(false);
    expect(moveOut(f.field, { direction: 'downward' })).toBe(false);
    expect(moveOut(f.field, null)).toBe(false);
    f.send('compositionstart');
    expect(moveOut(f.field, { direction: 'forward' })).toBe(false);
    expect(f.options.onMoveOut).not.toHaveBeenCalled();
  });

  it('変換中に届いた外部の式は変換が終わるまで書き込まず、終了時に1回だけ反映して入力の通知にしない', () => {
    const f = structuredField('x');
    expect(f.silentWrites).toEqual(['x']);
    f.send('compositionstart');
    f.host.updateSource('y+1');
    expect(f.silentWrites).toEqual(['x']);
    f.send('compositionend');
    expect(f.silentWrites).toEqual(['x', 'y+1']);
    expect(f.options.onInput).not.toHaveBeenCalled();
  });

  it('変換中は記号の挿入を拒否し、変換の終了後は入力欄へ焦点を戻して挿入する', () => {
    const f = structuredField('x');
    const template = String.raw`\sqrt{#0}`;
    f.send('compositionstart');
    expect(f.host.insertTemplate(template)).toBe(false);
    expect([f.inserted, f.focusCount()]).toEqual([[], 0]);
    f.send('compositionend');
    expect(f.host.insertTemplate(template)).toBe(true);
    expect([f.inserted, f.focusCount()]).toEqual([[`replaceSelection:${template}`], 1]);
  });

  it('読み上げ用の名前と説明を入力欄へ付け、画面上の仮想キーボードを自動では開かない', () => {
    const f = structuredField('x');
    expect(Object.fromEntries(f.attributes)).toEqual({ 'aria-label': '数式', 'aria-describedby': 'result hint' });
    expect(f.field.mathVirtualKeyboardPolicy).toBe('manual');
    expect(f.appended).toHaveLength(1);
    expect(f.appended[0]).toBe(f.field);
  });

  it('閉じた後の入力欄のキーと移動では、取消・確定・焦点移動を呼ばない', () => {
    const f = structuredField('x');
    f.host.dispose();
    expect(f.removeCount()).toBe(1);
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: false, stopped: false });
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: false, stopped: false });
    expect(moveOut(f.field, { direction: 'forward' })).toBe(false);
    for (const callback of [f.options.onApply, f.options.onCancel, f.options.onMoveOut]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });
});

/*
 * MC-27b: 「\」で始めた LaTeX の命令を打っている間(MathLive の mode が 'latex' で候補の一覧を出す間)の Enter・Esc。
 * 入力欄の捕捉段の処理は MathLive 自身のキー処理より先に動くため、ここで止めると MathLive の
 * 候補の確定(Enter)と候補を閉じる操作(Esc)が効かず、Esc は入力画面ごと閉じていた。
 * 横取りしない場合は MathLive が既定動作を止めるので、画面は確定も終了もしない(実際の画面は e2e/tests/math-keyboard.spec.ts)。
 */
describe('MC-27b 構造入力で LaTeX の命令の候補を出している間の Enter・Esc(attachMathField の実際の処理)', () => {
  const SILENT_CALLBACKS = ['onApply', 'onCancel', 'onInput', 'onMoveOut', 'onSourceLimit'] as const;

  it('補完中の Enter は横取りせず MathLive の候補の確定へ渡し、式の確定・取消・親への伝達停止をしない', () => {
    const f = structuredField('x');
    f.setMode('latex');
    expect(pressField(f.field, 'Enter')).toEqual({ prevented: false, stopped: false });
    for (const name of SILENT_CALLBACKS) expect(f.options[name], name).not.toHaveBeenCalled();
  });

  it.each([{ name: 'Esc', shiftKey: false }, { name: 'Shift+Esc', shiftKey: true }])(
    '補完中の $name は横取りせず MathLive へ渡して候補だけを閉じさせ、入力画面を閉じない', ({ shiftKey }) => {
      const f = structuredField('x');
      f.setMode('latex');
      expect(pressField(f.field, 'Escape', { shiftKey })).toEqual({ prevented: false, stopped: false });
      for (const name of SILENT_CALLBACKS) expect(f.options[name], name).not.toHaveBeenCalled();
    });

  it.each(['ctrlKey', 'metaKey'] as const)('補完中でも %s 付きの Enter は従来どおり最新の式を知らせてから確定する', modifier => {
    const f = structuredField('x');
    f.setMode('latex');
    const source = String.raw`x+\pi`;
    f.edit(source);
    expect(pressField(f.field, 'Enter', modifier === 'ctrlKey' ? { ctrlKey: true } : { metaKey: true }))
      .toEqual({ prevented: true, stopped: true });
    expect(f.options.onInput.mock.calls).toEqual([[source]]);
    expect(f.options.onApply.mock.calls).toEqual([[source]]);
    expect(f.options.onCancel).not.toHaveBeenCalled();
  });

  it('補完を終えて式の入力(mode math)へ戻った後は、従来どおり Enter は伝達だけ止めて確定せず、Esc で取り消す', () => {
    const f = structuredField('x');
    f.setMode('latex');
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: false, stopped: false });
    expect(f.options.onCancel).not.toHaveBeenCalled();
    f.setMode('math');
    expect(pressField(f.field, 'Enter')).toEqual({ prevented: false, stopped: true });
    expect(f.options.onApply).not.toHaveBeenCalled();
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: true, stopped: true });
    expect(f.options.onCancel).toHaveBeenCalledTimes(1);
  });

  it('文字を打つ状態(mode text)の Enter・Esc・Ctrl+Enter は補完ではないので従来どおりに扱う', () => {
    const f = structuredField('x');
    f.setMode('text');
    expect(pressField(f.field, 'Enter')).toEqual({ prevented: false, stopped: true });
    expect(f.options.onApply).not.toHaveBeenCalled();
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
    expect(f.options.onApply.mock.calls).toEqual([['x']]);
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: true, stopped: true });
    expect(f.options.onCancel).toHaveBeenCalledTimes(1);
  });

  it.each(COMPOSING_MARKS)('補完中に変換中の印($name)がある Enter・Ctrl+Enter・Meta+Enter・Esc は従来どおり何も処理しない', mark => {
    const f = structuredField('x');
    f.setMode('latex');
    for (const keyCase of CONFIRM_AND_CANCEL_KEYS) {
      expect(pressField(f.field, keyCase.key, { ...keyCase, ...mark }), keyCase.name).toEqual({ prevented: false, stopped: false });
    }
    for (const name of SILENT_CALLBACKS) expect(f.options[name], name).not.toHaveBeenCalled();
  });

  it('補完中に変換を始めてから終えるまでの Ctrl+Enter・Esc は処理せず、変換を終えた後の Ctrl+Enter は確定する', () => {
    const f = structuredField('x');
    f.setMode('latex');
    f.send('compositionstart');
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: false, stopped: false });
    expect(pressField(f.field, 'Escape')).toEqual({ prevented: false, stopped: false });
    expect(f.options.onApply).not.toHaveBeenCalled();
    expect(f.options.onCancel).not.toHaveBeenCalled();
    f.send('compositionend');
    expect(pressField(f.field, 'Enter', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
    expect(f.options.onApply.mock.calls).toEqual([['x']]);
  });

  it.each(PASS_THROUGH_KEYS)('補完中の $name も横取りせず、MathLive の候補の選択・移動と保存・開くへ渡す', keyCase => {
    const f = structuredField('x');
    f.setMode('latex');
    expect(pressField(f.field, keyCase.key, keyCase)).toEqual({ prevented: false, stopped: false });
    for (const name of SILENT_CALLBACKS) expect(f.options[name], name).not.toHaveBeenCalled();
  });
});
