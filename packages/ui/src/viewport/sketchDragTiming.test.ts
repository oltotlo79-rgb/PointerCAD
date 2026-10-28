import type { ResolvedSketch } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';
import { createSketchDragTiming, sketchDragTimingForE2E, sketchDragTimingOwnerChanged, type SketchTimingContext } from './sketchDragTiming.js';

function shape(x: number): ResolvedSketch {
  return { points: [{ id: 'p', featureId: 'p', position: [x, -4, 0] }], segments: [], arcs: [], ellipses: [],
    splines: [], faces: [], errors: [], pendingOffsets: [], pendingProjections: [], curvesByFeature: new Map() };
}
function fixture() {
  const canvas = {}, owner = {}, document = {}, baseline = shape(0), preview = shape(6);
  let clock = 20;
  const timing = createSketchDragTiming(canvas, () => clock, 1_700_000_000_000);
  let context: SketchTimingContext = { canvas, owner, document, documentVersion: 7, resolved: preview, hidden: false };
  const read = () => context;
  timing.begin(owner, document, 7, 1, baseline, 'p');
  return { canvas, owner, document, baseline, preview, timing, read,
    clock: (value: number) => { clock = value; },
    context: (value: SketchTimingContext) => { context = value; },
    bind: () => { timing.setSketch(read().resolved, () => undefined, read); },
    render: () => { timing.render(() => undefined, read); } };
}
describe('実resolvedと入力を対応させるscene描画観測', () => {
  it('正targetだけ1回採用し、同じframeの座標と独立clockを凍結する', () => {
    const f = fixture();
    f.timing.target([6, -4], 10); f.timing.solving(); f.clock(30); f.timing.adopt(f.preview, 1);
    f.bind(); f.clock(45); f.render(); f.clock(60); f.render();
    const snapshot = f.timing.snapshot(), row = snapshot.records[0];
    expect(row).toMatchObject({ session: 1, documentVersion: 7, ordinal: 1, kind: 'pointermove', status: 'drawn',
      rawEventAtMs: 10, eventAtMs: 10, acceptedAtMs: 20, adoptedAtMs: 30, renderedAtMs: 45,
      point: { id: 'p', x: 6, y: -4, z: 0 }, target: [6, -4] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.target)).toBe(true);
    expect(Object.isFrozen(row.point)).toBe(true);
    expect(Reflect.set(row, 'renderedAtMs', 0)).toBe(false);
    expect(snapshot.boundary).toBe('scene-render-return');
  });
  it.each(['owner', 'document', 'canvas', 'version', 'hidden', 'resolved', 'empty'] as const)(
    '%s不一致のframeを採用しない', mismatch => {
      const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
      const original = f.read();
      const empty = { ...f.preview, points: [] };
      f.context({ ...original, owner: mismatch === 'owner' ? {} : original.owner,
        document: mismatch === 'document' ? {} : original.document, canvas: mismatch === 'canvas' ? {} : original.canvas,
        documentVersion: mismatch === 'version' ? 8 : 7, hidden: mismatch === 'hidden',
        resolved: mismatch === 'resolved' ? shape(9) : mismatch === 'empty' ? empty : original.resolved });
      f.render(); expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
    });
  it('描画前のtarget置換は旧targetをsupersededとし、別resolvedを採用しない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    f.timing.target([9, -4], 11); f.timing.adopt(shape(9), 2); f.render();
    expect(f.timing.snapshot().records.map(row => row.status)).toEqual(['superseded', 'adopted']);
    expect(f.timing.snapshot().records.every(row => row.renderedAtMs === null)).toBe(true);
  });
  it('setSketch中の文書変更と例外、render例外はreceiptを残さない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1);
    f.timing.setSketch(f.preview, () => { f.context({ ...f.read(), document: {} }); }, f.read);
    f.render(); expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
    f.context({ ...f.read(), document: f.document }); f.bind();
    expect(() => f.timing.setSketch(f.preview, () => { throw new Error('build'); }, f.read)).toThrow('build');
    f.render(); expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
    f.bind();
    expect(() => f.timing.render(() => { throw new Error('render'); }, f.read)).toThrow('render');
    f.render(); expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
  });
  it('render中のowner変更やsetSketch再入で前receiptを採用しない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    f.timing.render(() => { f.context({ ...f.read(), owner: {} }); }, f.read);
    expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
    f.context({ ...f.read(), owner: f.owner }); f.bind();
    f.timing.render(f.bind, f.read);
    expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
  });
  it('取消処理完了と元形の実renderを分け、取消前previewを表示成功としない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    f.clock(40); f.timing.cancel(35, 'escape'); f.clock(50); f.timing.end(false);
    f.context({ ...f.read(), owner: null }); f.bind(); f.render();
    expect(f.timing.snapshot().records[1]).toMatchObject({ cancelledAtMs: 50, renderedAtMs: null });
    f.context({ ...f.read(), resolved: f.baseline }); f.bind(); f.clock(80); f.render();
    expect(f.timing.snapshot().records[1]).toMatchObject({ kind: 'escape', eventAtMs: 35,
      acceptedAtMs: 40, cancelledAtMs: 50, renderedAtMs: 80, status: 'drawn', point: { x: 0, y: -4, z: 0 } });
    expect(f.timing.snapshot().records[0]).toMatchObject({ status: 'cancelled', renderedAtMs: null });
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 21, 1_700_000_000_010])('異時計%sを0/nowへ補正しない', stamp => {
    const f = fixture(); f.timing.target([6, -4], stamp); f.timing.adopt(f.preview, 1); f.bind(); f.render();
    expect(f.timing.snapshot().records[0]).toMatchObject({ status: 'invalid-clock', eventAtMs: null, renderedAtMs: null });
  });
  it('内部schedule、未描画、coalesced、overflowを最速0msとしない', () => {
    const f = fixture(); f.timing.target([6, -4]); f.timing.adopt(f.preview, 1); f.bind(); f.render();
    expect(f.timing.snapshot().records[0]).toMatchObject({ kind: 'internal', eventAtMs: null, renderedAtMs: null });
    f.timing.target([7, -4], 11); f.timing.target([8, -4], 12);
    expect(f.timing.snapshot().records[1].status).toBe('coalesced');
    for (let index = 0; index < 130; index += 1) f.timing.target([index, -4], 13);
    const snapshot = f.timing.snapshot();
    expect(snapshot.records).toHaveLength(128); expect(snapshot.overflow).toBe(5);
    expect(snapshot.records.every(row => row.renderedAtMs === null)).toBe(true);
  });
  it('新sessionとdispose後の旧canvasは取消や描画を新ownerへ流さない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    f.timing.begin({}, f.document, 7, 2, f.baseline, 'p'); f.render();
    expect(f.timing.snapshot().records[0].status).toBe('superseded');
    f.timing.target([9, -4], 12); f.timing.adopt(f.preview, 1); f.timing.dispose(); f.timing.dispose(); f.render();
    expect(f.timing.snapshot().records.every(row => row.renderedAtMs === null)).toBe(true);
  });
  it('E2E offはcollector/clockを生成せず記録0', () => {
    const clock = vi.fn(() => 20);
    expect(sketchDragTimingForE2E(false, {}, clock, 1000)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
  });
  it('時計逆行は明示的に無効とし、0msの描画成功へ補正しない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.clock(19); f.timing.adopt(f.preview, 1);
    f.bind(); f.clock(30); f.render();
    expect(f.timing.snapshot().clockValid).toBe(false);
    expect(f.timing.snapshot().records[0]).toMatchObject({ status: 'invalid-clock', renderedAtMs: null });
  });
  it('古いjobのtarget ordinalは最新入力の採用として受け取らない', () => {
    const f = fixture();
    expect(f.timing.target([6, -4], 10)).toBe(1);
    expect(f.timing.target([9, -4], 11)).toBe(2);
    f.timing.adopt(f.preview, 1); f.bind(); f.render();
    expect(f.timing.snapshot().records.map(row => row.status)).toEqual(['coalesced', 'queued']);
    expect(f.timing.snapshot().records.every(row => row.renderedAtMs === null)).toBe(true);
  });
  it('render中のowner ABAもstore側の世代失効で拒否する', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    const original = f.read();
    f.timing.render(() => {
      f.context({ ...original, owner: {} }); f.timing.invalidateScene();
      f.context(original); f.timing.invalidateScene();
    }, f.read);
    expect(f.timing.snapshot().records[0].renderedAtMs).toBeNull();
  });
  it('描画可能な最新targetのdispose後は同じcontextでも描画成功を発行しない', () => {
    const f = fixture(); f.timing.target([6, -4], 10); f.timing.adopt(f.preview, 1); f.bind();
    expect(f.timing.snapshot().records[0].status).toBe('adopted');
    f.timing.dispose(); f.timing.dispose(); f.render();
    expect(f.timing.snapshot().records[0]).toMatchObject({ status: 'unobserved', renderedAtMs: null });
  });
});

it('観測offとowner不変ではbaseline再setを要求しない', () => {
  const owner = {}, timing = createSketchDragTiming({});
  expect(sketchDragTimingOwnerChanged(undefined, null, owner)).toBe(false);
  expect(sketchDragTimingOwnerChanged(undefined, owner, null)).toBe(false);
  expect(sketchDragTimingOwnerChanged(timing, owner, owner)).toBe(false);
  expect(sketchDragTimingOwnerChanged(timing, null, owner)).toBe(true);
  timing.dispose();
});
