/**
 * 構造入力の欄の端から出るときの焦点の移動先(MC-27b)。
 * 文字入力の欄で Tab・Shift+Tab を押したときと同じく、文書順で前後の部品へ移ることを確かめる。
 * ブラウザーを起動せず、実際の focusAdjacentControl へ数式の画面の部品の並びを縮めた代役を渡す。
 * 代役は focusAdjacentControl が読む DOM の項目(包含・文書順・属性・閉じた details・表示)だけを持つ。
 * 実際のブラウザーと MathLive での移動先は e2e/tests/math-keyboard.spec.ts で文字入力の欄の Tab と照合する。
 */
import { describe, expect, it } from 'vitest';
import { focusAdjacentControl, SEQUENTIAL_FOCUS_SELECTOR, type FocusScope } from './mathFieldHost.js';

type Tag = 'button' | 'select' | 'input' | 'summary' | 'details' | 'div' | 'p' | 'math-field';
interface Part { readonly id: string; readonly tag: Tag; readonly children?: readonly Part[] }
interface PartState {
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly open?: boolean;
  readonly tabindex?: string;
}
interface FakeNode {
  readonly part: Part;
  readonly state: PartState;
  readonly order: number;
  readonly parent: FakeNode | null;
  readonly element: HTMLElement;
  readonly details: HTMLDetailsElement | null;
  last: number;
}

/** 数式の画面(MathExpressionDialog)の部品を文書順に縮めたもの。記号の宣言と記号一覧は既定で閉じている。 */
const FIELD = '構造入力の欄';
const DIALOG: readonly Part[] = [
  { id: '記号の宣言', tag: 'details', children: [
    { id: '記号の宣言の見出し', tag: 'summary' }, { id: '記号の名前', tag: 'input' }, { id: '記号の種類', tag: 'select' },
  ] },
  { id: 'ヘルプ', tag: 'button' },
  { id: 'テキスト入力', tag: 'button' },
  { id: '構造入力', tag: 'button' },
  { id: '角度の単位', tag: 'select' },
  { id: '式の欄', tag: 'div', children: [{ id: FIELD, tag: 'math-field' }] },
  { id: '操作の案内', tag: 'p' },
  { id: 'π', tag: 'button' },
  { id: 'e', tag: 'button' },
  { id: '記号一覧', tag: 'details', children: [
    { id: '記号一覧の見出し', tag: 'summary' }, { id: '分野', tag: 'select' }, { id: '検索', tag: 'input' }, { id: '平方根', tag: 'button' },
  ] },
  { id: '取消', tag: 'button' },
  { id: 'この式を使う', tag: 'button' },
];
/** SEQUENTIAL_FOCUS_SELECTOR に当たる要素。MathLive の欄も tabindex を持つものとして候補に入れ、起点として除かれることを確かめる。 */
const SELECTED_TAGS: ReadonlySet<Tag> = new Set(['button', 'select', 'input', 'summary']);
const DOCUMENT_POSITION_PRECEDING = 2, DOCUMENT_POSITION_FOLLOWING = 4;
const DOCUMENT_POSITION_CONTAINS = 8, DOCUMENT_POSITION_CONTAINED_BY = 16;

function buildDialog(states: Readonly<Record<string, PartState>> = {}) {
  const nodes = new WeakMap<object, FakeNode>(), ordered: FakeNode[] = [], focused: string[] = [], queries: string[] = [];
  const nodeOf = (value: Node): FakeNode => {
    const found = nodes.get(value);
    if (found === undefined) throw new Error('代役の画面の外の要素です');
    return found;
  };
  const within = (node: FakeNode, ancestor: FakeNode): boolean => node.order >= ancestor.order && node.order <= ancestor.last;
  function add(part: Part, parent: FakeNode | null): void {
    const state: PartState = { ...(part.tag === 'math-field' ? { tabindex: '0' } : {}), ...states[part.id] };
    const order = ordered.length;
    // The methods run only after `node` below is created, as the product calls them on finished elements.
    const members = {
      parentElement: parent?.element ?? null,
      getAttribute: (name: string): string | null => name === 'tabindex' ? state.tabindex ?? null : null,
      matches: (selectors: string): boolean => {
        if (selectors === ':disabled') return state.disabled === true;
        if (selectors === 'summary') return part.tag === 'summary';
        throw new Error(`代役が扱わない選択子です: ${selectors}`);
      },
      closest: (selectors: string): HTMLDetailsElement | null => {
        if (selectors !== 'details') throw new Error(`代役が扱わない選択子です: ${selectors}`);
        for (let current: FakeNode | null = node; current !== null; current = current.parent) {
          if (current.details !== null) return current.details;
        }
        return null;
      },
      contains: (other: Node | null): boolean => other !== null && within(nodeOf(other), node),
      compareDocumentPosition: (other: Node): number => {
        const target = nodeOf(other);
        if (target === node) return 0;
        return target.order > node.order
          ? DOCUMENT_POSITION_FOLLOWING | (within(target, node) ? DOCUMENT_POSITION_CONTAINED_BY : 0)
          : DOCUMENT_POSITION_PRECEDING | (within(node, target) ? DOCUMENT_POSITION_CONTAINS : 0);
      },
      checkVisibility: (): boolean => {
        for (let current: FakeNode | null = node; current !== null; current = current.parent) {
          if (current.state.hidden === true) return false;
        }
        return true;
      },
      focus: (): void => { focused.push(part.id); },
    };
    const details = part.tag === 'details' ? Object.assign(members, { open: state.open === true }) as HTMLDetailsElement : null;
    const node: FakeNode = { part, state, order, parent, element: details ?? (members as HTMLElement), details, last: order };
    nodes.set(node.element, node);
    ordered.push(node);
    for (const child of part.children ?? []) add(child, node);
    node.last = ordered.length - 1;
  }
  for (const part of DIALOG) add(part, null);
  const scope: FocusScope = {
    contains: other => other !== null && nodes.has(other),
    querySelectorAll: selectors => {
      queries.push(selectors);
      return ordered.filter(node => SELECTED_TAGS.has(node.part.tag) || node.state.tabindex !== undefined).map(node => node.element);
    },
  };
  const element = (id: string): HTMLElement => {
    const found = ordered.find(node => node.part.id === id);
    if (found === undefined) throw new Error(`代役の画面に ${id} がありません`);
    return found.element;
  };
  return { scope, field: element(FIELD), element, focused, queries };
}

/** 端からの移動を1回行い、戻り値と焦点を受けた部品を返す。 */
function leave(dialog: ReturnType<typeof buildDialog>, direction: 'forward' | 'backward', from = dialog.field) {
  return { moved: focusAdjacentControl(dialog.scope, from, direction), focused: [...dialog.focused] };
}

describe('MC-27b 構造入力の欄の端から出るときの焦点の移動先(focusAdjacentControl の実際の処理)', () => {
  it('Tab・→ の向き(forward)は欄の直後の部品、Shift+Tab・← の向き(backward)は直前の部品へ移り、確定ボタンや先頭の部品へ飛ばない', () => {
    expect(leave(buildDialog(), 'forward')).toEqual({ moved: true, focused: ['π'] });
    expect(leave(buildDialog(), 'backward')).toEqual({ moved: true, focused: ['角度の単位'] });
  });

  it('文書の候補は Tab で届く部品の選択子で1回だけ集め、画面の外の欄からは移さない', () => {
    const dialog = buildDialog();
    expect(leave(dialog, 'forward')).toEqual({ moved: true, focused: ['π'] });
    expect(dialog.queries).toEqual([SEQUENTIAL_FOCUS_SELECTOR]);
    const other = buildDialog();
    expect(leave(dialog, 'backward', other.field)).toEqual({ moved: false, focused: ['π'] });
    expect(dialog.queries).toEqual([SEQUENTIAL_FOCUS_SELECTOR]);
    expect(other.focused).toEqual([]);
  });

  it('無効な部品は飛ばす(確定の処理中に挿入の記号・角度・入力方式が無効でも、次に届く部品へ移る)', () => {
    const busy = { disabled: true };
    const dialog = { π: busy, e: busy, 角度の単位: busy, テキスト入力: busy, 構造入力: busy };
    expect(leave(buildDialog(dialog), 'forward')).toEqual({ moved: true, focused: ['記号一覧の見出し'] });
    expect(leave(buildDialog(dialog), 'backward')).toEqual({ moved: true, focused: ['ヘルプ'] });
  });

  it('閉じた details の中は見出しだけに届き、開いた details の中の部品には届く', () => {
    const closed = { π: { disabled: true }, e: { disabled: true }, ヘルプ: { hidden: true }, テキスト入力: { disabled: true },
      構造入力: { disabled: true }, 角度の単位: { disabled: true } };
    expect(leave(buildDialog(closed), 'forward')).toEqual({ moved: true, focused: ['記号一覧の見出し'] });
    expect(leave(buildDialog(closed), 'backward')).toEqual({ moved: true, focused: ['記号の宣言の見出し'] });
    const opened = { ...closed, 記号一覧: { open: true }, 記号の宣言: { open: true } };
    expect(leave(buildDialog(opened), 'forward')).toEqual({ moved: true, focused: ['記号一覧の見出し'] });
    expect(leave(buildDialog(opened), 'backward')).toEqual({ moved: true, focused: ['記号の種類'] });
  });

  it('tabindex が負の部品と表示されていない部品は飛ばし、tabindex を持つ部品には届く', () => {
    expect(leave(buildDialog({ π: { tabindex: '-1' } }), 'forward')).toEqual({ moved: true, focused: ['e'] });
    expect(leave(buildDialog({ π: { hidden: true } }), 'forward')).toEqual({ moved: true, focused: ['e'] });
    expect(leave(buildDialog({ 操作の案内: { tabindex: '0' } }), 'forward')).toEqual({ moved: true, focused: ['操作の案内'] });
    expect(leave(buildDialog({ 角度の単位: { tabindex: '-1' } }), 'backward')).toEqual({ moved: true, focused: ['構造入力'] });
  });

  it('欄を囲む部品と欄そのものは移動先にしない', () => {
    const dialog = { 式の欄: { tabindex: '0' } };
    expect(leave(buildDialog(dialog), 'backward')).toEqual({ moved: true, focused: ['角度の単位'] });
    expect(leave(buildDialog(dialog), 'forward')).toEqual({ moved: true, focused: ['π'] });
  });

  it('その向きに届く部品が無ければ焦点を動かさず false を返す', () => {
    const after = { π: { disabled: true }, e: { disabled: true }, 記号一覧の見出し: { hidden: true }, 取消: { disabled: true },
      この式を使う: { hidden: true } };
    expect(leave(buildDialog(after), 'forward')).toEqual({ moved: false, focused: [] });
    const before = { 記号の宣言: { hidden: true }, ヘルプ: { disabled: true }, テキスト入力: { disabled: true },
      構造入力: { disabled: true }, 角度の単位: { tabindex: '-1' } };
    expect(leave(buildDialog(before), 'backward')).toEqual({ moved: false, focused: [] });
  });
});
