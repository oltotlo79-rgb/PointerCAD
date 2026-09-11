/** 接線上の実際の接触区間から指定線曲げの接続を作る。面番号や最寄りの面を使わない。 */
import type { ResolvedCurve } from '../sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';
import type { SheetGeometryResult, SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
import type { SheetLineBendPartition } from './partitionLineBend.js';
import type { ResolvedSheetBend } from './resolveSheetGeometry.js';
import { framePoint, rigidSheetCurve } from './rigidCurve.js';

interface Interval { readonly low: number; readonly high: number }
interface Contact { readonly panelId: string; readonly spans: readonly Interval[] }
const FLAT: SheetTangentFrame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
const TOLERANCE = 1e-7;

export function sheetTangentIntervals(curves: readonly ResolvedCurve[], frame: SheetTangentFrame, y: number): readonly Interval[] {
  return curves.flatMap((curve) => {
    if (curve.kind !== 'segment') return [];
    const a = framePoint(curve.from, frame, FLAT), b = framePoint(curve.to, frame, FLAT);
    if ([a, b].some((point) => Math.abs(point[1] - y) > TOLERANCE || Math.abs(point[2]) > TOLERANCE)) return [];
    const low = Math.min(a[0], b[0]), high = Math.max(a[0], b[0]);
    return high - low > TOLERANCE ? [{ low, high }] : [];
  });
}
function contacts(panels: readonly SheetPanelGeometry[], frame: SheetTangentFrame, y: number, band: readonly Interval[]): readonly Contact[] {
  return panels.flatMap((panel) => {
    const spans = sheetTangentIntervals(panel.outer, frame, y).flatMap((edge) => band.flatMap((cap) => {
      const low = Math.max(edge.low, cap.low), high = Math.min(edge.high, cap.high);
      return high - low > TOLERANCE ? [{ low, high }] : [];
    }));
    return spans.length === 0 ? [] : [{ panelId: panel.id, spans }];
  });
}
function contactEdges(contact: Contact, frame: SheetTangentFrame) {
  const point = (x: number): Vec3 => addVec3(frame.origin, scaleVec3(frame.xAxis, x));
  return contact.spans.map((span) => ({ from: point(span.low), to: point(span.high) }));
}

export function connectLineBendRegions(partition: SheetLineBendPartition, featureId: string, requireAllPanels = true): SheetGeometryResult<readonly ResolvedSheetBend[]> {
  const { rule, frame, movingSource, movingTarget, metrics } = partition;
  const bends: ResolvedSheetBend[] = [];
  for (const band of partition.bands) {
    const first = contacts(partition.fixed, frame, 0, sheetTangentIntervals(band.outer, FLAT, 0));
    const second = contacts(partition.flatMoving, movingSource, 0, sheetTangentIntervals(band.outer, FLAT, metrics.bendAllowance));
    if (first.length === 0 || second.length === 0)
      return { ok: false, message: '曲げ帯の両側に接するパネルがありません。指定線と輪郭を確認してください。' };
    const spans = [...first, ...second].flatMap((contact) => contact.spans);
    const low = Math.min(...spans.map((span) => span.low)), high = Math.max(...spans.map((span) => span.high));
    const offset: SheetTangentFrame = { ...FLAT, origin: [-low, 0, 0] };
    const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, FLAT, offset);
    const origin = addVec3(frame.origin, scaleVec3(frame.xAxis, low)), width = high - low;
    const childFrom = addVec3(movingTarget.origin, scaleVec3(frame.xAxis, low));
    // 同じ材料が複数の面をつなぐ場合、接続だけを複数にする。材料は一度だけ構築する。
    for (const parent of first) for (const child of second) {
      bends.push({ id: JSON.stringify(['sheet-line-bend', featureId, band.id, parent.panelId, child.panelId]),
        materialId: band.id, parallelGroupId: featureId, parentPanelId: parent.panelId, childPanelId: child.panelId,
        frame: { ...frame, origin }, width, angle: rule.angle, radius: rule.radius, kFactor: rule.kFactor,
        allowance: metrics.bendAllowance, flatProfile: { outer: band.outer.map(map), holes: band.holes.map((loop) => loop.map(map)) },
        parentEdge: { from: addVec3(origin, scaleVec3(frame.xAxis, width)), to: origin },
        childEdge: { from: childFrom, to: addVec3(childFrom, scaleVec3(frame.xAxis, width)) },
        parentContacts: contactEdges(parent, frame), childContacts: contactEdges(child, movingTarget) });
    }
  }
  const connected = new Set(bends.flatMap((bend) => [bend.parentPanelId, bend.childPanelId]));
  if (requireAllPanels && rule.angle !== 0 && [...partition.fixed, ...partition.moving].some((panel) => !connected.has(panel.id)))
    return { ok: false, message: '指定線曲げに接続していない材料があります。輪郭を確認してください。' };
  return { ok: true, value: bends };
}
