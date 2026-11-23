import { expressionValueFromNumber } from '@pointercad/expression';
import type { SheetMetalRecognition, SheetMetalRecognizedRim } from '@pointercad/kernel';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOriginIndex } from '../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { KernelBridge } from '../kernelBridge/bridgeContracts.js';
import type { MaterialComparisonBridge, MaterialComparisonResult, MaterialDifferenceRegion } from '../kernelBridge/materialComparisonContracts.js';
import type { SheetRecognitionReply, SheetRecognitionRequestItem } from '../kernelBridge/sheetRecognition.js';
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { SheetConvertFeature } from '../sheetMetal/types.js';
import { appendSolid, createEmptyPartDocument, DEFAULT_PRIMITIVE_AXIS } from './createPartDocument.js';
import { resolvePart, type ResolvedPart } from './resolvePart.js';
import { createSheetRecognitionPass, sheetConvertOrigins, type SheetRecognitionPass } from './sheetRecognitionPass.js';
import type { PartDocument, PrimitiveFeature } from './types.js';

const top = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'plate', role: 'top' } } as const;
const bottom = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'plate', role: 'bottom' } } as const;
const edge = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'plate', role: 'top-front' } } as const;

// 50×30×2 の平板 1 枚を基準の面 z=0 から読んだ答え(計算部の代わり)。
const corners: readonly Vec3[] = [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]];
const rims: SheetMetalRecognizedRim[] = corners.map((from, i) => ({ edgeIndex: i, curve: { kind: 'segment', from, to: corners[(i + 1) % 4] } }));
const PLATE: SheetMetalRecognition = { ok: true, thickness: 2, bends: [],
  panels: [{ faceIndex: 4, oppositeFaceIndex: 5, inward: [0, 0, 1], outer: rims, holes: [] }] };
const reference: SubShapeRef = { bodyFeatureId: 'box-1', index: 4,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1500, position: [25, 15, 0], axis: [0, 0, -1], radius: null } };

function box(sizeZ: number): PrimitiveFeature {
  return { id: 'box-1', name: 'box', kind: 'primitive', suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: DEFAULT_PRIMITIVE_AXIS, shape: { kind: 'box', sizeX: expressionValueFromNumber(50), sizeY: expressionValueFromNumber(30),
      sizeZ: expressionValueFromNumber(sizeZ) } };
}
const convert: SheetConvertFeature = { kind: 'sheetConvert', id: 'convert-1', name: '板金へ変換', suppressed: false, sourceFeatureId: 'box-1',
  referenceFace: reference, rule: { innerRadius: expressionValueFromNumber(1), kFactor: expressionValueFromNumber(0.4) } };
function documentWith(sizeZ: number): PartDocument {
  return appendSolid(appendSolid(createEmptyPartDocument(), box(sizeZ)), convert);
}
/** 元の立体の段の形(認識を頼む巡で、まだ消費されていないので見えている)。 */
const SOURCE: SolidBody = { featureId: 'box-1', faces: [], edges: [], vertices: [], threadMarks: [], volume: 3000, isValid: true,
  mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 } };

function region(volume: number): MaterialDifferenceRegion {
  return volume === 0 ? { kind: 'empty', volume: 0, mesh: null }
    : { kind: 'material', volume, mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), triangleCount: 0 } };
}
/** 元にだけある体積 removed と、組み直しにだけある体積 added の比べの結果(元の体積 3000)。 */
function compared(removed: number, added: number): MaterialComparisonResult {
  return { kind: 'compared', result: { beforeVolume: 3000, afterVolume: 3000 - removed + added, removed: region(removed), added: region(added),
    common: region(3000 - removed) } };
}
/** 平板の答えを返す認識だけの橋(体積の比べの口が無い)。 */
function recognizerOnly() {
  return { recognizeSheetMetal: vi.fn<NonNullable<KernelBridge['recognizeSheetMetal']>>((requests: readonly SheetRecognitionRequestItem[]) =>
    Promise.resolve(requests.map((request): SheetRecognitionReply => ({ id: request.id, kind: 'recognized', recognition: PLATE })))) };
}
function fakeBridge(comparison: MaterialComparisonResult) {
  return { ...recognizerOnly(), compareMaterials: vi.fn<MaterialComparisonBridge['compareMaterials']>(() => Promise.resolve(comparison)) };
}
const resolve = (document: PartDocument, pass: SheetRecognitionPass): ResolvedPart => resolvePart(document, { sheetRecognition: pass.lookup });
const convertErrors = (resolved: ResolvedPart): string[] => resolved.errors.filter(error => error.featureId === 'convert-1').map(error => error.text.key);

describe('M-08 元の形の起源から板・縁の鍵の材料を引く', () => {
  it('一意に結び付いた面・辺だけ起源の文字を返し、分かれた・食い違う・無い物は null にする', () => {
    const origins: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [
      { origin: top, state: 'unique', current: { kind: 'face', index: 3 } },
      { origin: edge, state: 'unique', current: { kind: 'edge', index: 7 } },
      { origin: bottom, state: 'split', candidates: [{ kind: 'face', index: 4 }, { kind: 'face', index: 5 }] },
      { origin: top, state: 'unique', current: { kind: 'face', index: 6 } },
      { origin: bottom, state: 'unique', current: { kind: 'face', index: 6 } },
    ] };
    const lookup = sheetConvertOrigins(origins);
    expect(lookup.face(3)).toBe(JSON.stringify(top.identity));
    expect(lookup.edge(7)).toBe(JSON.stringify(edge.identity));
    expect([lookup.face(4), lookup.face(5), lookup.face(6), lookup.face(7), lookup.edge(3)]).toEqual([null, null, null, null, null]);
    const untracked = sheetConvertOrigins({ version: 1, state: 'untracked', reason: 'imported' });
    expect([untracked.face(3), untracked.edge(7), sheetConvertOrigins(undefined).face(3)]).toEqual([null, null, null]);
  });
});

describe('M-08 認識の覚え書き(再計算・測定・書き出し・画面の確かめで持ち回る)', () => {
  it('答えを覚えて次の解決で使い、組み直した板金を元の立体と 1 度だけ比べる。同じ形の再計算は頼み直さない', async () => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), settled = new Set<string>();
    const first = resolve(documentWith(2), pass);
    expect(first.sheetRecognitionRequests).toHaveLength(1);
    expect(convertErrors(first)).toEqual(['partError.sheetConvert.pending']);
    expect(await pass.fill(bridge, first, [SOURCE], settled)).toBe(true);
    const second = resolve(documentWith(2), pass);
    expect(convertErrors(second)).toEqual([]);
    const sourceKey = second.steps.find(step => step.featureId === 'box-1')?.key;
    const rebuilt = second.steps.find(step => step.featureId === 'convert-1');
    expect(rebuilt?.plan.kind).toBe('sheetBody');
    expect(await pass.fill(bridge, second, [], settled)).toBe(false);
    expect(bridge.compareMaterials).toHaveBeenCalledTimes(1);
    expect(bridge.compareMaterials).toHaveBeenCalledWith([sourceKey], [rebuilt?.key], expect.any(Function));
    // 文書が同じなら、次の再計算は 1 巡目から答えを使い、頼み直しも比べ直しもしない。
    const again = resolve(documentWith(2), pass);
    expect(convertErrors(again)).toEqual([]);
    expect(await pass.fill(bridge, again, [], settled)).toBe(false);
    expect([bridge.recognizeSheetMetal.mock.calls.length, bridge.compareMaterials.mock.calls.length]).toEqual([1, 1]);
  });

  it('元の形が変わると鍵が変わり、古い答えを使わずに頼み直す。clear の後は何も覚えていない', async () => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), settled = new Set<string>();
    const first = resolve(documentWith(2), pass);
    await pass.fill(bridge, first, [SOURCE], settled);
    const changed = resolve(documentWith(3), pass);
    expect(convertErrors(changed)).toEqual(['partError.sheetConvert.pending']);
    expect(changed.sheetRecognitionRequests?.[0].bodyKey).not.toBe(first.sheetRecognitionRequests?.[0].bodyKey);
    expect(await pass.fill(bridge, changed, [SOURCE], settled)).toBe(true);
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledTimes(2);
    expect(convertErrors(resolve(documentWith(3), pass))).toEqual([]);
    pass.clear();
    for (const sizeZ of [2, 3]) expect(convertErrors(resolve(documentWith(sizeZ), pass))).toEqual(['partError.sheetConvert.pending']);
  });

  it('両方向の差が公差を超えた・比べられなかった時は unsupportedBoundary に差し替えて元の立体を残し、比べる口が無ければ rpcFailed', async () => {
    const cases = [
      [compared(0.5, 0), 'partError.sheetConvert.unsupportedBoundary'],
      [compared(0, 0.5), 'partError.sheetConvert.unsupportedBoundary'],
      [{ kind: 'failed', message: '形の差を正しく計算できませんでした。' }, 'partError.sheetConvert.unsupportedBoundary'],
      [null, 'partError.sheetConvert.rpcFailed'],
    ] as const;
    for (const [comparison, key] of cases) {
      const pass = createSheetRecognitionPass(), bridge = comparison === null ? recognizerOnly() : fakeBridge(comparison), settled = new Set<string>();
      await pass.fill(bridge, resolve(documentWith(2), pass), [SOURCE], settled);
      const built = resolve(documentWith(2), pass);
      const before = settled.size;
      expect(await pass.fill(bridge, built, [], settled)).toBe(true);
      expect(settled.size).toBeGreaterThan(before);
      const refused = resolve(documentWith(2), pass);
      expect(convertErrors(refused)).toEqual([key]);
      expect(refused.steps.find(step => step.featureId === 'box-1')?.visible).toBe(true);
      expect(refused.steps.some(step => step.featureId === 'convert-1')).toBe(false);
    }
    // 公差(元の体積の 1e-6)の内の差は受け入れる。
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0.001, 0.001)), settled = new Set<string>();
    await pass.fill(bridge, resolve(documentWith(2), pass), [SOURCE], settled);
    expect(await pass.fill(bridge, resolve(documentWith(2), pass), [], settled)).toBe(false);
    expect(convertErrors(resolve(documentWith(2), pass))).toEqual([]);
  });
});

describe('M-08 文書の切替と計算中の認識・比較', () => {
  it.each([true, false])('認識待ちの失効で答えを保存せず、次の巡で認識を頼み直す(文書切替=%s)', async (switchDocument) => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), settled = new Set<string>();
    const recognize = bridge.recognizeSheetMetal.getMockImplementation();
    if (recognize === undefined) throw new Error('認識の口がありません');
    let cancelled = false;
    bridge.recognizeSheetMetal.mockImplementationOnce(async (requests) => {
      await Promise.resolve();
      if (switchDocument) pass.clear();
      else cancelled = true;
      return recognize(requests);
    });
    const document = documentWith(2);
    expect(await pass.fill(bridge, resolve(document, pass), [SOURCE], settled, () => cancelled)).toBeNull();
    expect(settled.size).toBe(0);
    expect(convertErrors(resolve(document, pass))).toEqual(['partError.sheetConvert.pending']);
    expect(await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set())).toBe(true);
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('比較待ちの失効で答えを保存せず、その巡の認識も始めない(文書切替=%s)', async (switchDocument) => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0.5, 0));
    const document = documentWith(2);
    await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set());
    const nextBox = { ...box(3), id: 'box-2' };
    const nextConvert = { ...convert, id: 'convert-2', sourceFeatureId: nextBox.id,
      referenceFace: { ...reference, bodyFeatureId: nextBox.id } };
    const both = resolve(appendSolid(appendSolid(document, nextBox), nextConvert), pass);
    expect(both.steps.some(step => step.featureId === 'convert-1' && step.plan.kind === 'sheetBody')).toBe(true);
    expect(both.sheetRecognitionRequests?.map(request => request.id)).toEqual(['convert-2']);
    let cancelled = false;
    bridge.compareMaterials.mockImplementationOnce(async (_before, _after, shouldCancel) => {
      await Promise.resolve();
      if (switchDocument) pass.clear();
      else cancelled = true;
      expect(shouldCancel?.()).toBe(true);
      return compared(0.5, 0);
    });
    const settled = new Set<string>();
    expect(await pass.fill(bridge, both, [{ ...SOURCE, featureId: nextBox.id }], settled, () => cancelled)).toBeNull();
    expect(bridge.compareMaterials).toHaveBeenCalledTimes(1);
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledTimes(1);
    expect(settled.size).toBe(0);
    expect(convertErrors(resolve(document, pass))).toEqual(switchDocument ? ['partError.sheetConvert.pending'] : []);
  });

  it('Workerが返す比較の取消は不一致として記憶せず、次の巡で比較し直す', async () => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), document = documentWith(2);
    await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set());
    bridge.compareMaterials.mockResolvedValueOnce({ kind: 'cancelled' });
    const settled = new Set<string>();
    expect(await pass.fill(bridge, resolve(document, pass), [], settled)).toBeNull();
    expect(settled.size).toBe(0);
    expect(convertErrors(resolve(document, pass))).toEqual([]);
    expect(await pass.fill(bridge, resolve(document, pass), [], settled)).toBe(false);
    expect(bridge.compareMaterials).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'cancelled'] as const)('同じ比較が先に成功しても後着の応答で上書きせず、明示取消を尊重する(%s)', async (kind) => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), document = documentWith(2);
    await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set());
    const signals: { started?: () => void; finish?: () => void } = {};
    const started = new Promise<void>(signal => { signals.started = signal; });
    const waiting = new Promise<void>(signal => { signals.finish = signal; });
    bridge.compareMaterials.mockImplementationOnce(async () => {
      signals.started?.();
      await waiting;
      return kind === 'cancelled' ? { kind } : { kind, message: '先発の比較の通信が失敗しました' };
    });
    const oldSettled = new Set<string>(), currentSettled = new Set<string>();
    const second = { ...box(3), id: 'box-2' };
    const oldDocument = kind === 'failed' ? document : appendSolid(appendSolid(document, second),
      { ...convert, id: 'convert-2', sourceFeatureId: second.id, referenceFace: { ...reference, bodyFeatureId: second.id } });
    const oldResolved = resolve(oldDocument, pass);
    expect(oldResolved.sheetRecognitionRequests?.map(item => item.id) ?? []).toEqual(kind === 'failed' ? [] : ['convert-2']);
    const first = pass.fill(bridge, oldResolved, [{ ...SOURCE, featureId: second.id }], oldSettled);
    await started;
    expect(await pass.fill(bridge, resolve(document, pass), [], currentSettled)).toBe(false);
    signals.finish?.();
    expect(await first).toBe(kind === 'cancelled' ? null : false);
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledOnce();
    expect([oldSettled.size, currentSettled.size]).toEqual([0, 0]);
    const current = resolve(document, pass);
    expect(convertErrors(current)).toEqual([]);
    expect(current.liveBodyIds).toEqual(['convert-1']);
    expect(await pass.fill(bridge, current, [], new Set())).toBe(false);
    expect(bridge.compareMaterials).toHaveBeenCalledTimes(2);
  });

  it('文書を替えた後に同じ依頼を認識し直しても、以前の解決は新しい答えを使って比較しない', async () => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), document = documentWith(2);
    await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set());
    const previous = resolve(document, pass);
    pass.clear();
    await pass.fill(bridge, resolve(document, pass), [SOURCE], new Set());
    const current = resolve(document, pass);
    expect(previous.sheetRecognitionComparisons?.[0].request).toEqual(current.sheetRecognitionComparisons?.[0].request);
    expect(previous.sheetRecognitionComparisons?.[0].answer).not.toBe(current.sheetRecognitionComparisons?.[0].answer);
    const settled = new Set<string>();
    expect(await pass.fill(bridge, previous, [], settled)).toBeNull();
    expect(bridge.compareMaterials).not.toHaveBeenCalled();
    expect(settled.size).toBe(0);
    expect(await pass.fill(bridge, current, [], settled)).toBe(false);
    expect(bridge.compareMaterials).toHaveBeenCalledOnce();
  });

  it('同じ認識を待つ別の巡が先に答えを入れた場合は、後着で上書きせず暫定結果を解き直す', async () => {
    const pass = createSheetRecognitionPass(), bridge = fakeBridge(compared(0, 0)), document = documentWith(2);
    const releases: (() => void)[] = [];
    const waiting = new Promise<void>(done => { releases.push(done); });
    bridge.recognizeSheetMetal.mockImplementationOnce(async requests => {
      await waiting;
      return requests.map(({ id }) => ({ id, kind: 'unavailable', code: 'rpcFailed' }));
    });
    const pending = resolve(document, pass), settled = new Set<string>();
    const last = pass.fill(bridge, pending, [SOURCE], settled);
    await Promise.resolve();
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledTimes(1);
    expect(await pass.fill(bridge, pending, [SOURCE], new Set())).toBe(true);
    releases[0]();
    expect(await last).toBe(true);
    expect(settled.size).toBe(1);
    expect(bridge.recognizeSheetMetal).toHaveBeenCalledTimes(2);
    expect(convertErrors(resolve(document, pass))).toEqual([]);
  });
});
