/** 保存入力から導出した面と接線境界を、中立長の帯でつないで平面へ配置する。 */
import { curveSamplePoints } from '../sketch/curvePlaneSamples.js';
import { curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, lengthVec3, normalizeVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { resolveSheetRule } from './featureInputs.js';
import { resolveSheetSeams } from './seamConnections.js';
import { flattenSheetPanelGraph, type PanelPoint, type PanelTransform, type SheetPanelConnection } from './panelGraph.js';
import type { SheetGeometryResult, SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import { frameDirection, framePoint, rigidSheetCurve } from './rigidCurve.js';

export interface SheetFlatBend {
  readonly id: string; readonly panel: SheetPanelGeometry | null;
  /** この曲げ帯の局所XY輪郭を展開面へ写す座標。リリーフ後の折曲げ復元に用いる。 */
  readonly profileFrame?: SheetTangentFrame;
  readonly from: Vec3; readonly to: Vec3;
  readonly angle: number; readonly radius: number; readonly allowance: number;
  /** 明示継ぎ目は親側の接線で切り、帯の全材料をこの子パネル側へ残す。 */
  readonly seamPanelId?: string;
  /** 同じ指定線の別の帯。配置済みのパネルへ、帯の材料を追加する。 */
  readonly extraPanelId?: string;
}
export interface SheetFlatJoin {
  readonly connectionId: string; readonly parentPanelId: string; readonly childPanelId: string;
}
export interface SheetFlatGeometry {
  readonly thickness: number; readonly fixedPanelId: string;
  readonly panels: readonly SheetPanelGeometry[]; readonly bends: readonly SheetFlatBend[];
  readonly joins: readonly SheetFlatJoin[];
  readonly panelPlacements?: ReadonlyMap<string, { readonly source: SheetTangentFrame; readonly target: SheetTangentFrame }>;
}
const FLAT_FRAME: SheetTangentFrame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };

function panelFrame(panel: SheetPanelGeometry): SheetTangentFrame | null {
  const first = panel.outer[0]; if (first === undefined) return null;
  const normal = panel.normal, origin = curveStart(first);
  if (!normal.every(Number.isFinite) || Math.abs(lengthVec3(normal) - 1) > 1e-10) return null;
  const points = panel.outer.flatMap(curveSamplePoints);
  const offset = points.map((point) => subVec3(point, origin)).find((vector) => lengthVec3(vector) > 1e-7);
  if (offset === undefined) return null;
  const xAxis = normalizeVec3(offset), yAxis = crossVec3(normal, xAxis);
  if (Math.abs(dotVec3(xAxis, normal)) > 1e-10 || Math.abs(lengthVec3(yAxis) - 1) > 1e-10) return null;
  for (const point of [...points, ...panel.holes.flatMap((loop) => loop.flatMap(curveSamplePoints))]) {
    if (!point.every(Number.isFinite) || Math.abs(dotVec3(subVec3(point, origin), normal)) > 1e-7) return null;
  }
  return { origin, xAxis, yAxis, normal };
}

function flatFrame(transform: PanelTransform): SheetTangentFrame {
  return { origin: [transform.origin[0], transform.origin[1], 0], xAxis: [transform.x[0], transform.x[1], 0],
    yAxis: [transform.y[0], transform.y[1], 0], normal: [0, 0, 1] };
}
function localEdge(panelId: string, edge: { readonly from: Vec3; readonly to: Vec3 }, source: SheetTangentFrame) {
  const point = (value: Vec3): PanelPoint => { const local = framePoint(value, source, FLAT_FRAME); return [local[0], local[1]]; };
  return { panelId, from: point(edge.from), to: point(edge.to) };
}

export function unfoldSheetBody(body: ResolvedSheetBody, fixedPanelId: string, seamConnectionIds: readonly string[]): SheetGeometryResult<SheetFlatGeometry> {
  const rule = resolveSheetRule(body.rule); if (!rule.ok) return rule;
  const seams = resolveSheetSeams(body, seamConnectionIds); if (!seams.ok) return seams;
  const frames = new Map<string, SheetTangentFrame>();
  for (const panel of body.panels) {
    const frame = panelFrame(panel);
    if (frame === null) return { ok: false, message: '展開するパネルに平面外の輪郭があります。元の輪郭を確認してください。' };
    frames.set(panel.id, frame);
  }
  const connections: SheetPanelConnection[] = [];
  for (const bend of body.bends) {
    const parent = frames.get(bend.parentPanelId), child = frames.get(bend.childPanelId);
    if (parent === undefined || child === undefined) return { ok: false, message: '曲げの接続先パネルが見つかりません。元の板金を確認してください。' };
    connections.push({ id: bend.id, first: localEdge(bend.parentPanelId, bend.parentEdge, parent),
      second: localEdge(bend.childPanelId, bend.childEdge, child), allowance: bend.allowance,
      ...(bend.parallelGroupId === undefined ? {} : { parallelGroupId: bend.parallelGroupId }) });
  }
  const flat = flattenSheetPanelGraph({ panelIds: body.panels.map((panel) => panel.id), connections, fixedPanelId, seamConnectionIds: seams.value });
  if (!flat.ok) {
    const reasons = { duplicateId: 'パネル・曲げ・継ぎ目に重複があります。', unknownPanel: '固定面か接続先が見つかりません。',
      invalidEdge: '曲げの接線境界か中立長が不正です。', unknownSeam: '指定した継ぎ目が見つかりません。',
      cycle: '曲げが周回しています。切り離す継ぎ目を指定してください。', disconnected: '展開が複数に分かれます。継ぎ目と接続を確認してください。' };
    return { ok: false, message: reasons[flat.error] };
  }
  const transforms = new Map([...flat.traversal.transforms].map(([id, transform]) => [id, flatFrame(transform)]));
  const panels: SheetPanelGeometry[] = [];
  for (const id of flat.traversal.order) {
    const panel = body.panels.find((item) => item.id === id), source = frames.get(id), target = transforms.get(id);
    if (panel === undefined || source === undefined || target === undefined) return { ok: false, message: '展開パネルの座標が見つかりません。' };
    const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, source, target);
    panels.push({ ...panel, normal: target.normal, outer: panel.outer.map(map), holes: panel.holes.map((loop) => loop.map(map)) });
  }
  const bends: SheetFlatBend[] = [], joins: SheetFlatJoin[] = [];
  const emittedMaterials = new Set<string>();
  const redundant = new Set(flat.traversal.redundantConnections ?? []);
  const materialConnections = [...flat.traversal.connections, ...body.bends.filter((bend) => redundant.has(bend.id))
    .map((bend) => ({ id: bend.id, parentId: bend.parentPanelId, childId: bend.childPanelId }))];
  for (const connection of materialConnections) {
    const bend = body.bends.find((item) => item.id === connection.id);
    if (bend === undefined) return { ok: false, message: '展開する曲げが見つかりません。' };
    const source = frames.get(bend.parentPanelId), target = transforms.get(bend.parentPanelId);
    const childSource = frames.get(bend.childPanelId), childTarget = transforms.get(bend.childPanelId);
    if (source === undefined || target === undefined || childSource === undefined || childTarget === undefined)
      return { ok: false, message: '展開する曲げの座標が見つかりません。' };
    const from = framePoint(bend.parentEdge.from, source, target), to = framePoint(bend.parentEdge.to, source, target);
    const childFrom = framePoint(bend.childEdge.from, childSource, childTarget), childTo = framePoint(bend.childEdge.to, childSource, childTarget);
    const points = [to, from, childTo, childFrom];
    const outer: ResolvedCurve[] = points.map((point, index) => ({ kind: 'segment', featureId: `${bend.id}:${index}`, from: point, to: points[(index + 1) % 4] }));
    const middle = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0];
    const bandFrame: SheetTangentFrame = { origin: framePoint(bend.frame.origin, source, target),
      xAxis: frameDirection(bend.frame.xAxis, source, target), yAxis: frameDirection(bend.frame.yAxis, source, target), normal: [0, 0, 1] };
    const profile = bend.flatProfile === undefined ? { outer, holes: [] }
      : { outer: bend.flatProfile.outer.map((curve) => rigidSheetCurve(curve, FLAT_FRAME, bandFrame)),
        holes: bend.flatProfile.holes.map((loop) => loop.map((curve) => rigidSheetCurve(curve, FLAT_FRAME, bandFrame))) };
    const materialId = bend.materialId ?? bend.id;
    const duplicateMaterial = emittedMaterials.has(materialId); emittedMaterials.add(materialId);
    bends.push({ id: bend.id, profileFrame: bandFrame, ...(redundant.has(bend.id) ? { extraPanelId: bend.parentPanelId } : {}),
      panel: bend.allowance === 0 || duplicateMaterial ? null : { id: bend.id, normal: [0, 0, 1], ...profile },
      from: middle(from, childTo), to: middle(to, childFrom), angle: bend.angle, radius: bend.radius, allowance: bend.allowance });
    if (!redundant.has(bend.id)) joins.push({ connectionId: connection.id, parentPanelId: connection.parentId, childPanelId: connection.childId });
  }
  // BFSから外した曲げも材料を持つ。親の接線だけを開放し、帯全体を子側に保持する。
  for (const id of seams.value) {
    const bend = body.bends.find((item) => item.id === id);
    if (bend === undefined) return { ok: false, message: '継ぎ目の曲げが見つかりません。' };
    const source = frames.get(bend.childPanelId), target = transforms.get(bend.childPanelId);
    if (source === undefined || target === undefined) return { ok: false, message: '継ぎ目の接続先が見つかりません。' };
    const from = framePoint(bend.childEdge.from, source, target), to = framePoint(bend.childEdge.to, source, target);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const dx = (to[1] - from[1]) / length * bend.allowance, dy = -(to[0] - from[0]) / length * bend.allowance;
    const farFrom: Vec3 = [from[0] + dx, from[1] + dy, 0], farTo: Vec3 = [to[0] + dx, to[1] + dy, 0];
    const points = [to, from, farFrom, farTo];
    const outer: ResolvedCurve[] = points.map((point, index) => ({ kind: 'segment', featureId: `${id}:${index}`, from: point, to: points[(index + 1) % 4] }));
    const xAxis: Vec3 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length, 0];
    const bandFrame: SheetTangentFrame = { origin: farFrom, xAxis, yAxis: [-xAxis[1], xAxis[0], 0], normal: [0, 0, 1] };
    const profile = bend.flatProfile === undefined ? { outer, holes: [] }
      : { outer: bend.flatProfile.outer.map((curve) => rigidSheetCurve(curve, FLAT_FRAME, bandFrame)),
        holes: bend.flatProfile.holes.map((loop) => loop.map((curve) => rigidSheetCurve(curve, FLAT_FRAME, bandFrame))) };
    const materialId = bend.materialId ?? bend.id;
    const duplicateMaterial = emittedMaterials.has(materialId); emittedMaterials.add(materialId);
    bends.push({ id, profileFrame: bandFrame, seamPanelId: bend.childPanelId, panel: bend.allowance === 0 || duplicateMaterial ? null : { id, normal: [0, 0, 1], ...profile },
      from: [to[0] + dx / 2, to[1] + dy / 2, 0], to: [from[0] + dx / 2, from[1] + dy / 2, 0],
      angle: bend.angle, radius: bend.radius, allowance: bend.allowance });
  }
  const panelPlacements = new Map<string, { readonly source: SheetTangentFrame; readonly target: SheetTangentFrame }>();
  for (const [id, source] of frames) {
    const target = transforms.get(id); if (target !== undefined) panelPlacements.set(id, { source, target });
  }
  return { ok: true, value: { thickness: rule.rule.thickness, fixedPanelId, panels, bends, joins, panelPlacements } };
}
