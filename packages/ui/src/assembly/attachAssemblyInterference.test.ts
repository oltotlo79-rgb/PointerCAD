/**
 * 2 部品を選んだ時の隙間の自動測定(attachAssemblyInterference)の検査: 測る中身(文書・選択・長さの単位・動きの配置・
 * 表示の解の sourceDocument・resolved・bodies・placements)が変わった時だけ測り直し、表示の所有だけの差し替えでは
 * 測り直さない事(測定 → 受領の世代 → 所有の取り直し → 表示の差し替え → 測り直し、のループを作らない)。測る頼みは同時に
 * 1 本で、測っている間の変化は最新の 1 件だけを控え、待ちの上限を超えたら文を出す事。
 */
import {
  appendSolid, createAssemblyDocument, createEmptyPartDocument, createPrimitiveFeature, resolveAssembly, resolvePart,
  DEFAULT_COMPONENT_PLACEMENT, EMPTY_PART_LIBRARY, IDENTITY_PLACEMENT, type AssemblyComponent, type AssemblyDocument,
  type InterferenceKernelBridge, type MeasureOutcome, type RigidPlacement,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInterference } from './attachAssemblyInterference.js';

type Measure = InterferenceKernelBridge['measure'];

const GAP: MeasureOutcome = { kind: 'distance', distance: 30, pointA: [20, 0, 0], pointB: [50, 0, 0], inner: false };

/** 返事を後から渡せる測定の偽物。呼ばれた回数と、まだ返していない頼みを持つ。 */
function deferredBridge() {
  const pending: ((outcome: MeasureOutcome) => void)[] = [];
  const measure = vi.fn<Measure>(() => new Promise<MeasureOutcome>((resolve) => { pending.push(resolve); }));
  const checkInterference = vi.fn<InterferenceKernelBridge['checkInterference']>(() => Promise.reject(new Error('unused')));
  return { bridge: { measure, checkInterference }, measure, answer: (outcome: MeasureOutcome = GAP): void => {
    const next = pending.shift();
    if (next === undefined) throw new Error('no pending measure');
    next(outcome);
  } };
}

/** 箱の部品 2 つ(a・b)と、ほかに 1 つ(c)を置いた組立と、その表示の解。 */
function openFixture(): AssemblyDocument {
  const empty = createEmptyPartDocument();
  const part = appendSolid(empty, createPrimitiveFeature(empty, 'box'));
  const components: AssemblyComponent[] = ['a', 'b', 'c'].map((id) => ({
    id, name: id, source: { kind: 'part', partRef: id }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true,
    suppressed: false,
  }));
  const document = { ...createAssemblyDocument('隙間'), components };
  const library = { ...EMPTY_PART_LIBRARY, parts: new Map(components.map((component) => [component.id, part])) };
  useAppStore.getState().openAssembly(document, library);
  publishView(document);
  return document;
}

/** 文書の表示の解を出す(attachAssembly が再計算の後に出すのと同じ形の欄)。 */
function publishView(document: AssemblyDocument): void {
  const part = useAppStore.getState().assemblyLibrary.parts.get('a');
  if (part === undefined) throw new Error('part');
  const resolved = resolveAssembly(document, { library: useAppStore.getState().assemblyLibrary,
    resolvedParts: new Map(document.components.map((component) => [component.id, resolvePart(part)])) });
  useAppStore.setState({ assembly: document, assemblyView: { sourceDocument: document, resolved, bodies: new Map(),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() }, isComputing: false });
}

/** 表示の所有だけを取り直した差し替え(測る中身は同じで、assemblyView の同一性だけが変わる)。 */
function republishOwnerOnly(): void {
  const view = useAppStore.getState().assemblyView;
  if (view === null) throw new Error('view');
  useAppStore.setState({ assemblyView: { ...view } });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

let detach: (() => void) | null = null;
beforeEach(() => { resetTestStore(); });
afterEach(() => { detach?.(); detach = null; vi.useRealTimers(); });

describe('2 部品の隙間の自動測定', () => {
  it('所有だけの差し替えでは測り直さない(ループを作らない)。測っている間に差し替わっても結果を出す', async () => {
    openFixture();
    const kernel = deferredBridge();
    detach = attachAssemblyInterference(kernel.bridge);
    useAppStore.getState().setSelection(['a', 'b']);
    expect(kernel.measure).toHaveBeenCalledTimes(1);
    republishOwnerOnly();
    expect(kernel.measure).toHaveBeenCalledTimes(1);
    kernel.answer();
    await settle();
    expect(useAppStore.getState().measurement?.result.value).toBe(30);
    republishOwnerOnly();
    republishOwnerOnly();
    expect(kernel.measure).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().measurement?.result.value).toBe(30);
  });

  it('中身が変わると測り直す(動かした・形を直した・単位を替えた)。片方を消すと測らずに隙間を消す', async () => {
    const document = openFixture();
    const kernel = deferredBridge();
    detach = attachAssemblyInterference(kernel.bridge);
    useAppStore.getState().setSelection(['a', 'b']);
    kernel.answer();
    await settle();
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    // 動かした: 動きの配置が変わる。
    const moved = new Map<string, RigidPlacement>(view.resolved.placements);
    moved.set('b', { ...IDENTITY_PLACEMENT, position: [80, 0, 0] });
    useAppStore.setState({ assemblyMotionSourceDocument: document, assemblyMotionPlacements: moved });
    expect(kernel.measure).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().measurement).toBeNull();
    kernel.answer();
    await settle();
    // 形を直した: 同じ文書の解き直しで bodies と resolved が替わる。
    publishView(document);
    expect(kernel.measure).toHaveBeenCalledTimes(3);
    kernel.answer();
    await settle();
    // 単位を替えた。
    useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, lengthUnit: 'inch' } });
    expect(kernel.measure).toHaveBeenCalledTimes(4);
    kernel.answer();
    await settle();
    expect(useAppStore.getState().measurement).not.toBeNull();
    // 片方を消した: 2 部品の選択でなくなるので測らず、出していた隙間を消す。
    const without = { ...document, components: document.components.filter((component) => component.id !== 'b') };
    publishView(without);
    expect(kernel.measure).toHaveBeenCalledTimes(4);
    expect(useAppStore.getState().measurement).toBeNull();
  });

  it('測る頼みは同時に 1 本。測っている間の選び直しは最新の 1 件だけを控え、古い結果は出さない', async () => {
    openFixture();
    const kernel = deferredBridge();
    detach = attachAssemblyInterference(kernel.bridge);
    useAppStore.getState().setSelection(['a', 'b']);
    useAppStore.getState().setSelection(['a', 'c']);
    useAppStore.getState().setSelection(['b', 'c']);
    expect(kernel.measure).toHaveBeenCalledTimes(1);
    kernel.answer();
    await settle();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(kernel.measure).toHaveBeenCalledTimes(2);
    kernel.answer({ ...GAP, distance: 12 });
    await settle();
    expect(useAppStore.getState().measurement?.result.value).toBe(12);
  });

  it('待ちの上限(10 秒)を超えたら文を出し、前の測定が終わるまで次を流さない。組立を閉じた後の結果は出さない', async () => {
    vi.useFakeTimers();
    openFixture();
    const kernel = deferredBridge();
    detach = attachAssemblyInterference(kernel.bridge);
    useAppStore.getState().setSelection(['a', 'b']);
    // 上限の値は solid/measure.ts の MEASURE_TIMEOUT_MS(実測の最も遅い 0.47 秒の約 20 倍)。
    vi.advanceTimersByTime(9_999);
    expect(useAppStore.getState().measureErrorKey).toBeNull();
    vi.advanceTimersByTime(1);
    expect(useAppStore.getState().measureErrorKey).toBe('measureError.gapTimeout');
    expect(useAppStore.getState().assemblyGapRequestId).toBeNull();
    useAppStore.getState().setSelection(['a', 'c']);
    expect(kernel.measure).toHaveBeenCalledTimes(1);
    kernel.answer();
    await settle();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(kernel.measure).toHaveBeenCalledTimes(2);
    detach();
    detach = null;
    kernel.answer();
    await settle();
    expect(useAppStore.getState().measurement).toBeNull();
    expect(kernel.measure).toHaveBeenCalledTimes(2);
  });
});
