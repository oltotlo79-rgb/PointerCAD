/** 指定線曲げで移動する既存フランジの枝を剛体配置し、接続面の参照を更新する。 */
import { crossVec3, dotVec3, lengthVec3, normalizeVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import type { SheetGeometryResult, SheetPanelGeometry } from './panelGeometry.js';
import type { SheetLineBendPartition } from './partitionLineBend.js';
import type { ResolvedSheetBend, ResolvedSheetBody } from './resolveSheetGeometry.js';
import { frameDirection, framePoint, rigidSheetCurve } from './rigidCurve.js';

type Edge = ResolvedSheetBend['parentEdge'];
type Side = 'fixed' | 'moving';
interface Attachment { readonly panelId: string; readonly side: Side }
const TOLERANCE = 1e-7;

function containsContact(panel: SheetPanelGeometry, contact: Edge): boolean {
  const delta = subVec3(contact.to, contact.from), length = lengthVec3(delta);
  if (length <= TOLERANCE) return false;
  const axis = normalizeVec3(delta);
  const intervals = panel.outer.flatMap((curve) => {
    if (curve.kind !== 'segment') return [];
    const from = subVec3(curve.from, contact.from), to = subVec3(curve.to, contact.from);
    if ([from, to].some((point) => lengthVec3(crossVec3(point, axis)) > TOLERANCE)) return [];
    const a = dotVec3(from, axis), b = dotVec3(to, axis);
    return [{ low: Math.max(0, Math.min(a, b)), high: Math.min(length, Math.max(a, b)) }];
  }).filter((span) => span.high > span.low).sort((a, b) => a.low - b.low);
  let end = 0;
  for (const span of intervals) { if (span.low > end + TOLERANCE) return false; end = Math.max(end, span.high); }
  return end >= length - TOLERANCE;
}

export function rebaseSheetBranches(source: ResolvedSheetBody, panelId: string, partition: SheetLineBendPartition): SheetGeometryResult<ResolvedSheetBody> {
  if (partition.rule.angle === 0) return { ok: true, value: source };
  const attachments = new Map<string, Attachment>(), sideByPanel = new Map<string, Side>();
  const graph = new Map(source.panels.filter((panel) => panel.id !== panelId).map((panel) => [panel.id, new Set<string>()]));
  for (const bend of source.bends) {
    const parent = bend.parentPanelId === panelId, child = bend.childPanelId === panelId;
    if (!parent && !child) { graph.get(bend.parentPanelId)?.add(bend.childPanelId); graph.get(bend.childPanelId)?.add(bend.parentPanelId); continue; }
    const contacts = parent ? bend.parentContacts ?? [bend.parentEdge] : bend.childContacts ?? [bend.childEdge];
    const distances = contacts.flatMap((edge) => [edge.from, edge.to]).map((point) => dotVec3(subVec3(point, partition.frame.origin), partition.frame.yAxis));
    const side: Side | null = distances.every((distance) => distance <= TOLERANCE) ? 'fixed'
      : distances.every((distance) => distance >= partition.metrics.bendAllowance - TOLERANCE) ? 'moving' : null;
    if (side === null) return { ok: false, message: '新しい曲げ帯が既存の曲げとの接続に重なります。指定線か半径を変更してください。' };
    const candidates = (side === 'fixed' ? partition.fixed : partition.flatMoving)
      .filter((panel) => contacts.every((edge) => containsContact(panel, edge)));
    if (candidates.length !== 1) return { ok: false, message: '曲げ後の接続面を一意に決められません。接続する縁と指定線を確認してください。' };
    const neighbour = parent ? bend.childPanelId : bend.parentPanelId;
    if (sideByPanel.has(neighbour) && sideByPanel.get(neighbour) !== side)
      return { ok: false, message: '固定側と移動側が既存の曲げで閉じています。接続を開いてから曲げてください。' };
    sideByPanel.set(neighbour, side); attachments.set(bend.id, { panelId: candidates[0].id, side });
  }
  const queue = [...sideByPanel.keys()];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index], side = sideByPanel.get(current);
    if (side === undefined) return { ok: false, message: '既存の曲げの移動側を決められません。' };
    for (const neighbour of graph.get(current) ?? []) {
      if (sideByPanel.has(neighbour)) {
        if (sideByPanel.get(neighbour) !== side) return { ok: false, message: '固定側と移動側が既存の曲げで閉じています。接続を開いてから曲げてください。' };
      } else { sideByPanel.set(neighbour, side); queue.push(neighbour); }
    }
  }
  if (sideByPanel.size !== graph.size) return { ok: false, message: '元の板金に接続していないパネルがあります。' };
  const from = partition.movingSource, to = partition.movingTarget;
  const point = (value: Vec3) => framePoint(value, from, to);
  const direction = (value: Vec3) => frameDirection(value, from, to);
  const edge = (value: Edge): Edge => ({ from: point(value.from), to: point(value.to) });
  const panels = source.panels.flatMap((panel) => panel.id === panelId ? [...partition.fixed, ...partition.moving]
    : [sideByPanel.get(panel.id) !== 'moving' ? panel : { ...panel, normal: direction(panel.normal),
      outer: panel.outer.map((curve) => rigidSheetCurve(curve, from, to)),
      holes: panel.holes.map((loop) => loop.map((curve) => rigidSheetCurve(curve, from, to))) }]);
  const bends = source.bends.map((bend): ResolvedSheetBend => {
    const attachment = attachments.get(bend.id);
    const updated = { ...bend,
      parentPanelId: bend.parentPanelId === panelId && attachment !== undefined ? attachment.panelId : bend.parentPanelId,
      childPanelId: bend.childPanelId === panelId && attachment !== undefined ? attachment.panelId : bend.childPanelId };
    const move = attachment === undefined ? sideByPanel.get(bend.parentPanelId) === 'moving' : attachment.side === 'moving';
    return !move ? updated : { ...updated, parentEdge: edge(bend.parentEdge), childEdge: edge(bend.childEdge),
      ...(bend.parentContacts === undefined ? {} : { parentContacts: bend.parentContacts.map(edge) }),
      ...(bend.childContacts === undefined ? {} : { childContacts: bend.childContacts.map(edge) }),
      frame: { origin: point(bend.frame.origin), xAxis: direction(bend.frame.xAxis), yAxis: direction(bend.frame.yAxis), normal: direction(bend.frame.normal) } };
  });
  return { ok: true, value: { ...source, panels, bends } };
}
