import { describe, expect, it } from 'vitest';
import type { DrawingDocument, DrawingView } from '@pointercad/drawing';
import { createDrawingDocument } from './createDrawingDocument.js';
import { refreshDrawing, replaceSource } from './refreshDrawing.js';
import type { DrawingResolveKernel } from './resolveDrawing.js';
import type { SolidBody } from '../kernelBridge.js';
import { IDENTITY_PLACEMENT } from '../assembly/placementMath.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { embedDrawingSource, emptyDrawingSourceLibrary } from './sourceLibrary.js';

const source = { sourceRef: 'source', sourceKind: 'part' as const, fileName: 'part.pcad', path: 'part.pcad', contentHash: 'first', importedAt: '' };
const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: null,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
function document(): DrawingDocument {
  return { ...createDrawingDocument('板', source), views: [view], dimensions: [{ id: 'thickness', kind: 'length', measurement: 'trueDistance',
    targets: [{ kind: 'subShape', sourceRef: source.sourceRef, viewId: view.id, ref: { bodyFeatureId: 'body', index: 0,
      fingerprint: { kind: 'edge', curveKind: 'line', length: 3, position: [0, 0, 1.5], axis: [0, 0, 1], radius: null } } }],
    placement: { commonNormalCoordinate: 10, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' }] };
}
function body(length: number): SolidBody {
  return { featureId: 'body', isValid: true, volume: 1, mesh: { positions: new Float32Array(), normals: new Float32Array(),
    indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 }, faces: [], vertices: [], threadMarks: [],
    edges: length === 0 ? [] : [{ index: 0, curveKind: 'line', start: [0, 0, 0], end: [0, 0, length], midpoint: [0, 0, length / 2],
      axis: [0, 0, 1], radius: null, length, segmentOffset: 0, segmentCount: 1 }] };
}
function fake() {
  let length = 3, prepares = 0, projections = 0;
  const kernel: DrawingResolveKernel = {
    prepareDrawingSource: () => {
      prepares += 1;
      return Promise.resolve({ bodyIds: ['worker-body'], center: [0, 0, 0], dimensionInstances: [
        { sourceRef: source.sourceRef, bodyId: 'worker-body', body: body(length), placement: IDENTITY_PLACEMENT },
      ] });
    },
    hiddenLineViews: (request) => {
      projections += 1;
      return Promise.resolve({ views: request.views.map((item) => ({ viewId: item.id,
        visible: [{ curve: { kind: 'segment' as const, from: [0, 0] as const, to: [0, length] as const }, provenance: {} }], hidden: [] })),
        failures: [], cancelled: false });
    },
    sectionViews: () => Promise.reject(new Error('断面は呼ばない')),
  };
  return { kernel, setLength: (value: number) => { length = value; }, counts: () => ({ prepares, projections }) };
}

describe('同じ元形状から投影と寸法を更新する(P8-39)', () => {
  it('板厚3を5へ変えると寸法も投影線も5になる', async () => {
    const engine = fake(); const original = document();
    const first = await refreshDrawing(original, engine.kernel);
    expect(first.ok && first.dimensions[0].value).toBe(3);
    engine.setLength(5);
    const next = await refreshDrawing({ ...original, source: { ...original.source, contentHash: 'second' } }, engine.kernel);
    if (!next.ok) throw new Error(next.message);
    expect(next.dimensions[0].value).toBe(5);
    expect(next.projection.views[0].visible[0].curve).toMatchObject({ to: [100, 105] });
  });
  it('同じ元形状を寸法と投影のために2回再評価しない', async () => {
    const engine = fake(); await refreshDrawing(document(), engine.kernel);
    expect(engine.counts()).toEqual({ prepares: 1, projections: 1 });
  });
  it('変更のない図はHLRを呼び直さない', async () => {
    const engine = fake(); const doc = document();
    await refreshDrawing(doc, engine.kernel); await refreshDrawing(doc, engine.kernel);
    expect(engine.counts().projections).toBe(1);
  });
  it('縮尺だけ変えた図は投影を再利用する', async () => {
    const engine = fake(); const doc = document();
    await refreshDrawing(doc, engine.kernel);
    const next = await refreshDrawing({ ...doc, sheet: { ...doc.sheet, scale: 2 } }, engine.kernel);
    expect(engine.counts().projections).toBe(1);
    expect(next.ok && next.dimensions[0].value).toBe(3);
  });
  it('消えた辺の寸法を消さず未解決1件と返す', async () => {
    const engine = fake(); engine.setLength(0);
    const doc = document(); const next = await refreshDrawing(doc, engine.kernel);
    expect(next).toMatchObject({ ok: true, unresolvedCount: 1, dimensions: [{ value: null, text: '？', status: 'unresolved' }] });
    expect(next.ok && next.document.dimensions[0]).toBe(doc.dimensions[0]);
  });
  it('消した形を戻すと未解決が解ける', async () => {
    const engine = fake(); const doc = document(); engine.setLength(0);
    await refreshDrawing(doc, engine.kernel); engine.setLength(3);
    const next = await refreshDrawing({ ...doc, source: { ...doc.source, contentHash: 'restored' } }, engine.kernel);
    expect(next).toMatchObject({ ok: true, unresolvedCount: 0, dimensions: [{ value: 3, status: 'resolved' }] });
  });
  it('外部ファイルの変更を通知し、抱き込みを自動では差し替えない', async () => {
    const doc = document();
    const next = await refreshDrawing(doc, fake().kernel, { externalContentHash: 'external' });
    expect(next).toMatchObject({ ok: true, sourceChangedExternally: true, document: { source: { contentHash: 'first' } } });
  });
  it('同じ外部ハッシュでは取り込み直しを求めない', async () => {
    expect(await refreshDrawing(document(), fake().kernel, { externalContentHash: 'first' })).toMatchObject({ ok: true, sourceChangedExternally: false });
  });
  it('手動寸法を消す自動再生成結果を受け入れない', async () => {
    expect(await refreshDrawing(document(), fake().kernel, { regenerateAutoDimensions: (doc) => ({ ...doc, dimensions: [] }) })).toMatchObject({ ok: false });
  });
  it('自動寸法の再生成失敗を古い結果で成功と扱わない', async () => {
    expect(await refreshDrawing(document(), fake().kernel, { regenerateAutoDimensions: () => null })).toMatchObject({ ok: false });
  });
  it('元形状の準備失敗を読み取れる理由へ変える', async () => {
    const engine = fake(); engine.kernel.prepareDrawingSource = () => Promise.reject(new Error('参照元がありません。'));
    expect(await refreshDrawing(document(), engine.kernel)).toEqual({ ok: false, message: '参照元がありません。' });
  });
  it('同じ入力なら結果が決定的で文書を変更しない', async () => {
    const engine = fake(); const doc = document(); const before = JSON.stringify(doc);
    expect(await refreshDrawing(doc, engine.kernel)).toEqual(await refreshDrawing(doc, engine.kernel));
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('取り込み直す操作では参照鍵を維持し文書と内容ハッシュを差し替える', async () => {
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), { sourceKind: 'part', document: createEmptyPartDocument() }, 'part.pcad', 'part.pcad');
    const doc = { ...document(), source: embedded.source };
    const nextPart = { ...createEmptyPartDocument(), name: '新しい板' };
    const next = await replaceSource(doc, embedded.library, { sourceKind: 'part', document: nextPart }, '2026-09-09T00:00:00Z');
    expect(next?.document.source.sourceRef).toBe(embedded.source.sourceRef);
    expect(next?.document.source.contentHash).not.toBe(embedded.source.contentHash);
    expect(next?.library.sources[0].document).toBe(nextPart);
    expect(embedded.library.sources[0].document).not.toBe(nextPart);
  });
  it('知らない参照鍵の差し替えを断る', async () => {
    expect(await replaceSource(document(), emptyDrawingSourceLibrary(), { sourceKind: 'part', document: createEmptyPartDocument() })).toBeNull();
  });
});
