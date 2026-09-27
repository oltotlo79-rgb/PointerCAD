/**
 * MC-27c: 構造入力で「\」と命令の名前を打って補完するとき(Enter・Esc・候補を押す)の後始末。
 * - 候補の一覧(MathLive が document.body の直下に作る)を、欄のある開いた画面(dialog)の中へ移す。
 *   モーダルの画面の外は操作できず画面の下に隠れるため(e2e で elementFromPoint を確かめる)。
 * - 引数のある命令(\sqrt 等)の補完の直後は、命令の全体が選ばれて次の入力で置き換わっていたので、最初の引数へ入る。
 * 代役の値(位置の番号・深さ・LaTeX・選択)は、MathLive 0.110.0 の実物を Chromium・Firefox で動かして読んだ値
 * (「1+2+」の後ろで補完した場合)をそのまま使う。実際の画面は e2e/tests/math-keyboard.spec.ts で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMathField, type MathFieldHostOptions, type StructuredMathField } from './mathFieldHost.js';
import {
  enterFirstArgument, followCommandCompletion, keepSuggestionListInDialog, SUGGESTION_LIST_ID, type CompletedField,
} from './mathCommandCompletion.js';

interface Atom { readonly depth: number; readonly latex: string }
type Ranges = readonly (readonly [number, number])[];
const SQRT = String.raw`\sqrt`, PLACEHOLDER = String.raw`\placeholder{}`, FRAC = String.raw`\frac{\placeholder{}}{\placeholder{}}`;
/** 引数の欄の始まりの印(MathLive の first)。LaTeX は空。 */
const marker = (depth: number): Atom => ({ depth, latex: '' });
/** 「1+2+」: 0 は式の始まりの印、1〜4 が 1 + 2 +。補完はここ(位置 4)の後ろへ入る。 */
const PREFIX: readonly Atom[] = [marker(0), { depth: 0, latex: '1' }, { depth: 0, latex: '+' }, { depth: 0, latex: '2' }, { depth: 0, latex: '+' }];
const START = 4, BEFORE = 4;
/** 補完の後の並び(位置 5 以降)。MathLive は命令の引数の原子を命令より前に番号付けする。 */
const INSERTED = {
  sqrt: [marker(1), { depth: 0, latex: String.raw`\sqrt{}` }],
  sqrtClicked: [marker(1), { depth: 0, latex: SQRT }],
  frac: [marker(1), { depth: 1, latex: PLACEHOLDER }, marker(1), { depth: 1, latex: PLACEHOLDER }, { depth: 0, latex: FRAC }],
  pi: [{ depth: 0, latex: String.raw`\pi` }],
  typedSqrt: [marker(1), { depth: 1, latex: '2' }, { depth: 0, latex: String.raw`\sqrt2` }],
  typedFrac: [marker(1), { depth: 1, latex: '1' }, marker(1), { depth: 1, latex: '2' }, { depth: 0, latex: String.raw`\frac12` }],
  typedPower: [marker(1), marker(2), { depth: 2, latex: '2' }, { depth: 1, latex: 'x^2' }, { depth: 0, latex: String.raw`\sqrt{x^2}` }],
  twoEmpty: [marker(1), marker(1), { depth: 0, latex: String.raw`\overset{}{}` }],
  twoItems: [{ depth: 0, latex: String.raw`\alpha` }, { depth: 0, latex: String.raw`\beta` }],
} satisfies Record<string, readonly Atom[]>;

/** enterFirstArgument が読む MathLive の欄の代役。書き込みを順に記録する。 */
function completed(inserted: readonly Atom[], selection: readonly [number, number], mode: CompletedField['mode'] = 'math') {
  const atoms = [...PREFIX, ...inserted], writes: string[] = [];
  let ranges: Ranges = [selection];
  const field: CompletedField = {
    mode,
    get position(): number { return ranges[0]?.[1] ?? 0; },
    set position(offset: number) { writes.push(`position ${String(offset)}`); ranges = [[offset, offset]]; },
    get selection(): CompletedField['selection'] { return { ranges }; },
    set selection(value: CompletedField['selection']) { writes.push(`selection ${JSON.stringify(value.ranges)}`); ranges = value.ranges; },
    lastOffset: atoms.length - 1,
    getElementInfo: offset => atoms[offset],
  };
  return { field, writes, ranges: () => ranges, setRanges: (value: Ranges): void => { ranges = value; } };
}

describe('MC-27c 補完の直後に最初の引数へ入る(enterFirstArgument)', () => {
  it.each([
    { name: 'Enter(√ の全体が選ばれる)', inserted: INSERTED.sqrt, selection: [5, 6] as const },
    { name: 'Esc(入れた命令の全体が選ばれる)', inserted: INSERTED.sqrt, selection: [4, 6] as const },
    { name: '候補を押す(LaTeX が \\sqrt のまま)', inserted: INSERTED.sqrtClicked, selection: [5, 6] as const },
  ])('\\sqrt を $name で入れた直後は、√ の中の空の引数へ入力位置を移す', ({ inserted, selection }) => {
    const f = completed(inserted, selection);
    expect(enterFirstArgument(f.field, START, BEFORE)).toBe(true);
    expect(f.writes).toEqual(['position 5']);
    expect(f.ranges()).toEqual([[5, 5]]);
  });

  it('\\frac の Enter・候補を押す は MathLive が分子の空欄を選ぶので、そのままにする', () => {
    // 候補を押したときは、MathLive が命令の LaTeX を打った形(\frac)のまま持つ。
    for (const latex of [FRAC, String.raw`\frac`]) {
      const f = completed([...INSERTED.frac.slice(0, 4), { depth: 0, latex }], [5, 6]);
      expect(enterFirstArgument(f.field, START, BEFORE), latex).toBe(false);
      expect(f.writes).toEqual([]);
    }
  });

  it('\\frac の Esc は分数の全体が選ばれるので、最初の空欄(分子)を選び直す', () => {
    const f = completed(INSERTED.frac, [4, 9]);
    expect(enterFirstArgument(f.field, START, BEFORE)).toBe(true);
    expect(f.writes).toEqual(['selection [[5,6]]']);
  });

  it.each([
    { name: 'Enter・候補を押す', selection: [5, 5] as const },
    { name: 'Esc', selection: [4, 5] as const },
  ])('引数の無い命令(\\pi)の $name の後は入力位置も選択も変えない', ({ selection }) => {
    const f = completed(INSERTED.pi, selection);
    expect(enterFirstArgument(f.field, START, BEFORE)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ranges()).toEqual([selection]);
  });

  it.each([
    { name: '\\sqrt{2}', inserted: INSERTED.typedSqrt, end: 7 },
    { name: '\\frac12', inserted: INSERTED.typedFrac, end: 9 },
    { name: '\\sqrt{x^2}(最初の引数の中に添字の欄がある)', inserted: INSERTED.typedPower, end: 9 },
  ])('引数まで打った $name は命令の後ろのままにする', ({ inserted, end }) => {
    const f = completed(inserted, [end, end]);
    expect(enterFirstArgument(f.field, START, BEFORE)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('空欄の記号の無い引数が2つとも空なら、1つ目の引数へ入る', () => {
    const f = completed(INSERTED.twoEmpty, [7, 7]);
    expect(enterFirstArgument(f.field, START, BEFORE)).toBe(true);
    expect(f.writes).toEqual(['position 5']);
  });

  it('何も入らなかった補完・2つ以上の項目・math 以外の状態・複数の選択範囲では何もしない', () => {
    const nothing = completed([], [4, 4]);
    expect(enterFirstArgument(nothing.field, START, BEFORE)).toBe(false);
    const two = completed(INSERTED.twoItems, [6, 6]);
    expect(enterFirstArgument(two.field, START, BEFORE)).toBe(false);
    const text = completed(INSERTED.sqrt, [5, 6], 'text');
    expect(enterFirstArgument(text.field, START, BEFORE)).toBe(false);
    const split = completed(INSERTED.sqrt, [5, 6]);
    split.setRanges([[1, 2], [5, 6]]);
    expect(enterFirstArgument(split.field, START, BEFORE)).toBe(false);
    for (const f of [nothing, two, text, split]) expect(f.writes).toEqual([]);
  });

  it('分数の分子など、式の中の欄で補完しても同じく引数へ入る(深さは相対で比べる)', () => {
    // \frac{…}{3} の分子(位置 1)で \sqrt を補完した後: 0 式の始まり、1 分子の印、2 √ の中の印、3 √、4 分母の印、5 3、6 分数。
    const atoms: Atom[] = [marker(0), marker(1), marker(2), { depth: 1, latex: String.raw`\sqrt{}` }, marker(1),
      { depth: 1, latex: '3' }, { depth: 0, latex: String.raw`\frac{\sqrt{}}{3}` }];
    let ranges: Ranges = [[2, 3]];
    const field: CompletedField = {
      mode: 'math',
      get position(): number { return ranges[0]?.[1] ?? 0; },
      set position(offset: number) { ranges = [[offset, offset]]; },
      get selection(): CompletedField['selection'] { return { ranges }; },
      set selection(value: CompletedField['selection']) { ranges = value.ranges; },
      lastOffset: atoms.length - 1,
      getElementInfo: offset => atoms[offset],
    };
    expect(enterFirstArgument(field, 1, 4)).toBe(true);
    expect(ranges).toEqual([[2, 2]]);
  });
});

class BrowserEventTarget extends EventTarget {
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean): void {
    super.removeEventListener(type, callback, typeof options === 'boolean' ? { capture: options } : options);
  }
}

/** MutationObserver の代役。見張りの開始・終了と、MathLive が一覧を作り直したときの通知(notify)を扱う。 */
class FakeMutationObserver {
  static readonly created: FakeMutationObserver[] = [];
  readonly observed: { readonly target: unknown; readonly options: unknown }[] = [];
  disconnected = false;
  constructor(readonly notify: () => void) { FakeMutationObserver.created.push(this); }
  observe(target: unknown, options: unknown): void { this.observed.push({ target, options }); }
  disconnect(): void { this.disconnected = true; }
}

/**
 * 数式の画面の代役: document.body・開いた画面(dialog)・MathLive の欄。一覧の親は parents で持ち、
 * MathLive と同じく body へ新しい一覧を作り(createList)、画面の append で移す。
 */
function screen(options: { readonly inDialog: boolean } = { inDialog: true }) {
  const parents = new Map<object, HTMLElement>(), moves: string[] = [];
  const body = { id: 'body' } as HTMLElement;
  const dialog = { id: 'dialog', open: true, append: (...nodes: (Node | string)[]): void => {
    for (const node of nodes) {
      if (typeof node === 'string') throw new Error('文字列は移さない');
      parents.set(node, dialog);
      moves.push('dialog');
    }
  } } as HTMLDialogElement;
  let list: HTMLElement | null = null;
  function createList(): HTMLElement {
    const created = { id: SUGGESTION_LIST_ID } as HTMLElement;
    Object.defineProperty(created, 'parentElement', { get: () => parents.get(created) ?? null });
    parents.set(created, body);
    list = created;
    return created;
  }
  const ownerDocument = { body, getElementById: (id: string): HTMLElement | null => id === SUGGESTION_LIST_ID ? list : null } as Document;
  const state = { mode: 'math' as StructuredMathField['mode'], atoms: [...PREFIX] as Atom[], ranges: [[4, 4]] as Ranges };
  const field = Object.assign(new BrowserEventTarget(), {
    ownerDocument,
    closest: (selectors: string): HTMLElement | null => {
      if (selectors !== 'dialog[open]') throw new Error(`代役が扱わない選択子です: ${selectors}`);
      return options.inDialog ? dialog : null;
    },
    getElementInfo: (offset: number): { readonly depth?: number; readonly latex?: string } | undefined => state.atoms[offset],
  }) as StructuredMathField;
  Object.defineProperties(field, {
    mode: { get: () => state.mode, configurable: true },
    position: { get: () => state.ranges[0]?.[1] ?? 0, set: (offset: number) => { state.ranges = [[offset, offset]]; }, configurable: true },
    selection: { get: () => ({ ranges: state.ranges }), set: (value: { readonly ranges: Ranges }) => { state.ranges = value.ranges; }, configurable: true },
    lastOffset: { get: () => state.atoms.length - 1, configurable: true },
  });
  /** MathLive と同じく、新しい mode を読める状態で mode-change を出す。 */
  const switchMode = (mode: StructuredMathField['mode']): void => { state.mode = mode; field.dispatchEvent(new Event('mode-change')); };
  const parentOf = (element: HTMLElement): string => parents.get(element) === dialog ? 'dialog' : parents.get(element) === body ? 'body' : 'none';
  return { field, state, body, dialog, moves, createList, switchMode, parentOf };
}

beforeEach(() => {
  FakeMutationObserver.created.length = 0;
  vi.stubGlobal('MutationObserver', FakeMutationObserver);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('MC-27c 候補の一覧を欄のある画面の中へ移す(keepSuggestionListInDialog・followCommandCompletion)', () => {
  it('開いた画面の中の欄なら body の一覧を画面の中へ移し、既に画面の中なら移し直さない', () => {
    const s = screen(), list = s.createList();
    expect(keepSuggestionListInDialog(list, s.field)).toBe(true);
    expect(s.parentOf(list)).toBe('dialog');
    expect(keepSuggestionListInDialog(list, s.field)).toBe(false);
    expect(s.moves).toEqual(['dialog']);
  });

  it('画面の外の欄なら一覧を body に残す', () => {
    const s = screen({ inDialog: false }), list = s.createList();
    expect(keepSuggestionListInDialog(list, s.field)).toBe(false);
    expect(s.parentOf(list)).toBe('body');
    const stop = followCommandCompletion(s.field);
    s.switchMode('latex');
    FakeMutationObserver.created[0]?.notify();
    expect([s.parentOf(list), s.moves]).toEqual(['body', []]);
    stop();
  });

  it('欄が latex(命令の入力)に入るまでは見張らず、入ると body の子の変化を見張って既にある一覧をすぐ移す', () => {
    const s = screen(), stop = followCommandCompletion(s.field), first = s.createList();
    expect(FakeMutationObserver.created).toHaveLength(0);
    s.switchMode('latex');
    expect(FakeMutationObserver.created).toHaveLength(1);
    expect(FakeMutationObserver.created[0]?.observed).toEqual([{ target: s.body, options: { childList: true } }]);
    expect(s.parentOf(first)).toBe('dialog');
    // MathLive は打鍵ごとに一覧を消して body の直下へ作り直す。作り直した一覧も画面の中へ移す。
    const second = s.createList();
    FakeMutationObserver.created[0]?.notify();
    expect([s.parentOf(second), s.moves]).toEqual(['dialog', ['dialog', 'dialog']]);
    // latex の間に mode-change が重なっても見張りは1つだけ。
    s.switchMode('latex');
    expect(FakeMutationObserver.created).toHaveLength(1);
    stop();
  });

  it('latex から math へ戻ると見張りをやめ、MathLive が入れた \\sqrt の中へ入力位置を移す', async () => {
    const s = screen(), stop = followCommandCompletion(s.field);
    s.switchMode('latex');
    s.switchMode('math');
    expect(FakeMutationObserver.created[0]?.disconnected).toBe(true);
    // MathLive は mode-change を出した後、同じ処理の中で命令を入れて √ の全体を選ぶ。
    s.state.atoms.push(...INSERTED.sqrt);
    s.state.ranges = [[5, 6]];
    await Promise.resolve();
    expect(s.state.ranges).toEqual([[5, 5]]);
    stop();
  });

  it('\\pi の補完の後と、latex を経ない mode の変化では入力位置を変えない', async () => {
    const s = screen(), stop = followCommandCompletion(s.field);
    s.switchMode('latex');
    s.switchMode('math');
    s.state.atoms.push(...INSERTED.pi);
    s.state.ranges = [[5, 5]];
    await Promise.resolve();
    expect(s.state.ranges).toEqual([[5, 5]]);
    s.switchMode('text');
    s.switchMode('math');
    s.state.atoms.push(...INSERTED.sqrt);
    s.state.ranges = [[6, 7]];
    await Promise.resolve();
    expect(s.state.ranges).toEqual([[6, 7]]);
    stop();
  });

  it('止めた後は見張りを外し、補完の後始末もしない(閉じる直前の補完・閉じた後の mode-change)', async () => {
    const s = screen(), stop = followCommandCompletion(s.field);
    s.switchMode('latex');
    stop();
    expect(FakeMutationObserver.created[0]?.disconnected).toBe(true);
    const pending = screen(), stopPending = followCommandCompletion(pending.field);
    pending.switchMode('latex');
    pending.switchMode('math');
    pending.state.atoms.push(...INSERTED.sqrt);
    pending.state.ranges = [[5, 6]];
    stopPending();
    await Promise.resolve();
    expect(pending.state.ranges).toEqual([[5, 6]]);
    s.switchMode('latex');
    expect(FakeMutationObserver.created).toHaveLength(2);
  });
});

describe('MC-27c attachMathField は作った欄に補完の後始末を付け、閉じると外す', () => {
  function attach(s: ReturnType<typeof screen>) {
    const members = {
      readOnly: false, mathVirtualKeyboardPolicy: 'auto', menuItems: [] as readonly unknown[],
      setAttribute(): void { /* 属性は検査しない */ },
      setValue(): void { /* 値は検査しない */ },
      getValue(): string { return ''; },
      remove(): void { /* 代役の欄に親は無い */ },
    } satisfies Partial<StructuredMathField>;
    Object.assign(s.field, members);
    const container = Object.assign(new EventTarget(), { append(): void { /* 追加は検査しない */ } } satisfies Partial<HTMLElement>) as HTMLElement;
    const options = {
      label: '数式', describedBy: 'result hint', initialSource: '', maximumSourceLength: 16,
      onInput: vi.fn(), isCurrent: () => true, onSourceLimit: vi.fn(), onApply: vi.fn(), onCancel: vi.fn(), onMoveOut: vi.fn(),
    } satisfies MathFieldHostOptions;
    return attachMathField(container, () => s.field, options);
  }

  it('命令の入力中は一覧を画面の中へ移し、補完の後は引数へ入り、閉じた後の mode-change では何もしない', async () => {
    const s = screen(), host = attach(s), list = s.createList();
    s.switchMode('latex');
    expect(s.parentOf(list)).toBe('dialog');
    s.switchMode('math');
    s.state.atoms.push(...INSERTED.sqrt);
    s.state.ranges = [[5, 6]];
    await Promise.resolve();
    expect(s.state.ranges).toEqual([[5, 5]]);
    host.dispose();
    s.switchMode('latex');
    expect(FakeMutationObserver.created).toHaveLength(1);
    expect(FakeMutationObserver.created[0]?.disconnected).toBe(true);
  });
});
