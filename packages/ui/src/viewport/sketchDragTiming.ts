import type { ResolvedSketch } from '@pointercad/model';

/** 検査専用。物理画面やOS compositorでなくscene.renderの正常終了を記録する。 */
export type SketchTimingStatus = 'queued' | 'solving' | 'adopted' | 'drawn' | 'coalesced'
  | 'superseded' | 'cancelled' | 'invalid-clock' | 'unobserved';
export interface SketchTimingContext {
  readonly canvas: object;
  readonly document: object;
  readonly documentVersion: number;
  readonly owner: object | null;
  readonly resolved: ResolvedSketch;
  readonly hidden: boolean;
}
interface TimingRecord {
  canvas: number;
  session: number;
  documentVersion: number;
  ordinal: number;
  kind: 'pointermove' | 'pointerup' | 'escape' | 'pointercancel' | 'internal';
  status: SketchTimingStatus;
  rawEventAtMs: number | null;
  eventAtMs: number | null;
  acceptedAtMs: number;
  adoptedAtMs: number | null;
  cancelledAtMs: number | null;
  renderedAtMs: number | null;
  target: readonly [number, number] | null;
  point: Readonly<{ id: string; x: number; y: number; z: number }> | null;
}
export interface SketchTimingSnapshot {
  readonly boundary: 'scene-render-return';
  readonly timeOrigin: number;
  readonly clockValid: boolean;
  readonly overflow: number;
  readonly records: readonly Readonly<TimingRecord>[];
}
export interface SketchDragTiming {
  begin(owner: object, document: object, version: number, session: number, baseline: ResolvedSketch, pointKey: string): void;
  target(pointer: readonly [number, number], stamp?: number, kind?: 'pointermove' | 'pointerup'): number | null;
  solving(): void;
  adopt(resolved: ResolvedSketch, ordinal: number): void;
  cancel(stamp?: number, kind?: 'escape' | 'pointercancel'): void;
  end(committed: boolean): void;
  setSketch(resolved: ResolvedSketch, write: () => void, read: () => SketchTimingContext): void;
  render(write: () => void, read: () => SketchTimingContext): void;
  invalidateScene(): void;
  snapshot(): SketchTimingSnapshot;
  dispose(): void;
}
/** E2Eの所有切替だけが再setを必要とする。offでは追加の描画仕事を要求しない。 */
export function sketchDragTimingOwnerChanged(timing: SketchDragTiming | undefined, owner: object | null, previousOwner: object | null): boolean {
  return timing !== undefined && owner !== previousOwner;
}
let nextCanvas = 0;
/** offではcollectorもclock読取も生成しない。通常製品の処理量を増やさない入口。 */
export function sketchDragTimingForE2E(enabled: boolean, canvas: object, now?: () => number, timeOrigin?: number): SketchDragTiming | undefined {
  return enabled ? createSketchDragTiming(canvas, now, timeOrigin) : undefined;
}
/** 呼出し元がE2E時だけ生成する。off経路はnullで、追加clock/配列確保を行わない。 */
export function createSketchDragTiming(
  canvas: object,
  now: () => number = () => performance.now(),
  timeOrigin = performance.timeOrigin,
): SketchDragTiming {
  const canvasOrdinal = ++nextCanvas;
  const records: TimingRecord[] = [];
  const capacity = 128;
  let live = true, overflow = 0, session = 0, ordinal = 0, version = 0;
  let owner: object | null = null, document: object | null = null;
  let baseline: ResolvedSketch | null = null, adopted: ResolvedSketch | null = null;
  let pointKey = '';
  let target: TimingRecord | null = null, cancellation: TimingRecord | null = null;
  let bound: { context: SketchTimingContext } | null = null;
  let lastClock = Number.NEGATIVE_INFINITY;
  let clockValid = Number.isFinite(timeOrigin) && timeOrigin > 0;
  function readClock(): number {
    const value = now();
    if (!Number.isFinite(value) || value < lastClock) clockValid = false;
    lastClock = value;
    return value;
  }
  function same(a: SketchTimingContext, b: SketchTimingContext): boolean {
    return a.canvas === canvas && b.canvas === canvas && a.document === b.document
      && a.documentVersion === b.documentVersion && a.owner === b.owner && a.resolved === b.resolved
      && !a.hidden && !b.hidden && a.resolved.points.length + a.resolved.segments.length + a.resolved.arcs.length > 0;
  }
  function pending(record: TimingRecord | null): record is TimingRecord {
    return record !== null && (record.status === 'queued' || record.status === 'solving' || record.status === 'adopted');
  }
  function record(stamp: number | undefined, kind: TimingRecord['kind'], pointer: readonly [number, number] | null): TimingRecord {
    const accepted = readClock();
    // epochのtimestamp・未来・非有限をnow/0へ補正しない。値が不正なら未確定として残す。
    const valid = stamp !== undefined && clockValid
      && Number.isFinite(accepted) && Number.isFinite(stamp) && stamp >= 0 && stamp <= accepted;
    const result: TimingRecord = { canvas: canvasOrdinal, session, documentVersion: version, ordinal: ++ordinal,
      kind: stamp === undefined ? 'internal' : kind, status: stamp !== undefined && !valid ? 'invalid-clock' : 'queued',
      rawEventAtMs: stamp !== undefined && Number.isFinite(stamp) ? stamp : null,
      eventAtMs: valid ? stamp : null, acceptedAtMs: accepted, adoptedAtMs: null, cancelledAtMs: null,
      renderedAtMs: null, target: pointer === null ? null : Object.freeze([pointer[0], pointer[1]]), point: null };
    if (records.length === capacity) { records.shift(); overflow += 1; }
    records.push(result);
    return result;
  }
  function capturePoint(resolved: ResolvedSketch): TimingRecord['point'] {
    const point = resolved.points.find(candidate => candidate.id === pointKey);
    return point === undefined ? null : Object.freeze({ id: point.id,
      x: point.position[0], y: point.position[1], z: point.position[2] });
  }
  return {
    begin(nextOwner, nextDocument, nextVersion, nextSession, nextBaseline, nextPointKey) {
      if (!live) return;
      if (pending(target)) target.status = 'superseded';
      if (pending(cancellation)) cancellation.status = 'unobserved';
      owner = nextOwner; document = nextDocument; version = nextVersion; session = nextSession;
      baseline = nextBaseline; pointKey = nextPointKey; target = null; cancellation = null; adopted = null;
    },
    target(pointer, stamp, kind = 'pointermove') {
      if (!live || owner === null) return null;
      if (pending(target)) target.status = target.status === 'queued' ? 'coalesced' : 'superseded';
      target = record(stamp, kind, pointer); adopted = null;
      return target.ordinal;
    },
    solving() { if (live && target?.status === 'queued') target.status = 'solving'; },
    adopt(resolved, ordinal) {
      if (!live || !pending(target) || target.ordinal !== ordinal) return;
      target.adoptedAtMs = readClock();
      target.status = clockValid ? 'adopted' : 'invalid-clock'; adopted = resolved;
    },
    cancel(stamp, kind = 'escape') {
      if (!live || owner === null) return;
      if (pending(target)) target.status = 'cancelled';
      cancellation = record(stamp, kind, null); adopted = null;
    },
    end(committed) {
      if (!live) return;
      if (pending(target)) target.status = committed ? 'unobserved' : 'cancelled';
      if (!committed && cancellation !== null) {
        cancellation.cancelledAtMs = readClock();
        if (!clockValid) cancellation.status = 'invalid-clock';
      }
      owner = null;
    },
    setSketch(resolved, write, read) {
      const before = read();
      bound = null;
      write(); // 例外なら新しいreceiptは作らない。
      const after = read();
      if (live && before.resolved === resolved && same(before, after)) bound = { context: after };
    },
    render(write, read) {
      const receipt = bound, before = read();
      try { write(); } catch (error) { bound = null; throw error; }
      const after = read();
      if (!live || receipt === null || bound !== receipt || !same(receipt.context, before) || !same(before, after)
        || after.document !== document || after.documentVersion !== version) return;
      const at = readClock();
      if (!clockValid) return;
      if (target?.status === 'adopted' && after.owner === owner && owner !== null && after.resolved === adopted
        && target.eventAtMs !== null && at >= (target.adoptedAtMs ?? Number.POSITIVE_INFINITY)) {
        target.point = capturePoint(after.resolved); target.renderedAtMs = at; target.status = 'drawn';
      }
      if (cancellation?.status === 'queued' && after.owner === null && owner === null && after.resolved === baseline
        && cancellation.eventAtMs !== null && cancellation.cancelledAtMs !== null && at >= cancellation.cancelledAtMs) {
        cancellation.point = capturePoint(after.resolved); cancellation.renderedAtMs = at; cancellation.status = 'drawn';
      }
    },
    invalidateScene() { bound = null; },
    snapshot: () => Object.freeze({ boundary: 'scene-render-return', timeOrigin, clockValid, overflow,
      records: Object.freeze(records.map(entry => Object.freeze({ ...entry }))) }),
    dispose() {
      if (pending(target)) target.status = 'unobserved';
      if (pending(cancellation)) cancellation.status = 'unobserved';
      live = false; owner = null; document = null; baseline = null; adopted = null; bound = null;
    },
  };
}
