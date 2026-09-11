/** 展開面の工具を実接続に沿って伝え、切った輪郭を元の平面/円筒の局所座標へ戻す。 */
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { SheetGeometryResult, SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
import type { ReliefBoundary } from './reliefIntersections.js';
import { reliefReachesContact } from './reliefReach.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';
import { framePoint, rigidSheetCurve } from './rigidCurve.js';
import { subtractSheetRelief } from './subtractSheetRelief.js';
import type { SheetFlatGeometry } from './unfoldSheetBody.js';

interface Node { readonly id: string; readonly kind: 'panel' | 'band'; readonly flat: SheetPanelGeometry;
  readonly from: SheetTangentFrame; readonly to: SheetTangentFrame; readonly normal: Vec3 }
interface Link { readonly node: string; readonly contacts: readonly { readonly from: Vec3; readonly to: Vec3 }[] }
export interface SheetReliefCuts {
  /** 変更した材料だけ。元パネル/元材料IDをキーとし、分割後は複数、消失は空配列。 */
  readonly panels: ReadonlyMap<string, readonly SheetPanelGeometry[]>;
  readonly bands: ReadonlyMap<string, readonly SheetPanelGeometry[]>;
}
const FLAT: SheetTangentFrame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };
const key = (kind: Node['kind'], id: string) => JSON.stringify([kind, id]);

export function cutSheetGraph(body: ResolvedSheetBody, flat: SheetFlatGeometry, panelId: string,
  tool: readonly ReliefBoundary[], featureId: string): SheetGeometryResult<SheetReliefCuts> {
  const nodes = new Map<string, Node>(), links = new Map<string, Link[]>();
  for (const panel of body.panels) {
    const placement = flat.panelPlacements?.get(panel.id), geometry = flat.panels.find((item) => item.id === panel.id);
    if (placement === undefined || geometry === undefined) return { ok: false, message: '切欠きのパネル座標を解決できません。' };
    nodes.set(key('panel', panel.id), { id: panel.id, kind: 'panel', flat: geometry, from: placement.target, to: placement.source, normal: panel.normal });
  }
  for (const bend of body.bends) {
    if (bend.angle === 0) continue;
    const id = bend.materialId ?? bend.id, nodeKey = key('band', id);
    if (nodes.has(nodeKey)) continue;
    const identities = new Set(body.bends.filter((item) => (item.materialId ?? item.id) === id).map((item) => item.id));
    const geometry = flat.bends.find((item) => identities.has(item.id) && item.panel !== null);
    if (geometry?.panel === undefined || geometry.panel === null || geometry.profileFrame === undefined)
      return { ok: false, message: '切欠きの曲げ帯座標を解決できません。' };
    nodes.set(nodeKey, { id, kind: 'band', flat: geometry.panel, from: geometry.profileFrame, to: FLAT, normal: FLAT.normal });
  }
  const link = (first: string, second: string, contacts: Link['contacts']) => {
    const a = links.get(first) ?? [], b = links.get(second) ?? [];
    a.push({ node: second, contacts }); b.push({ node: first, contacts }); links.set(first, a); links.set(second, b);
  };
  for (const bend of body.bends) {
    const first = nodes.get(key('panel', bend.parentPanelId)), second = nodes.get(key('panel', bend.childPanelId));
    if (first === undefined || second === undefined) return { ok: false, message: '切欠きの接続先パネルが見つかりません。' };
    const contacts = (node: Node, edges: Link['contacts']) => edges.map((edge) => ({ from: framePoint(edge.from, node.to, node.from), to: framePoint(edge.to, node.to, node.from) }));
    const parent = contacts(first, bend.parentContacts ?? [bend.parentEdge]);
    const seam = flat.bends.some((item) => item.id === bend.id && item.seamPanelId !== undefined);
    if (bend.angle === 0) { if (!seam) link(key('panel', first.id), key('panel', second.id), parent); }
    else {
      const material = key('band', bend.materialId ?? bend.id);
      if (!seam) link(key('panel', first.id), material, parent);
      link(material, key('panel', second.id), contacts(second, bend.childContacts ?? [bend.childEdge]));
    }
  }
  const panels = new Map<string, readonly SheetPanelGeometry[]>(), bands = new Map<string, readonly SheetPanelGeometry[]>();
  const queue = [key('panel', panelId)], visited = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]; if (visited.has(current)) continue;
    visited.add(current);
    const node = nodes.get(current); if (node === undefined) return { ok: false, message: '切欠きの元パネルが見つかりません。' };
    const result = subtractSheetRelief(node.flat, tool, JSON.stringify([featureId, current])); if (!result.ok) return result;
    if (result.value.length === 1 && result.value[0] === node.flat) continue;
    const map = (curve: ResolvedCurve) => rigidSheetCurve(curve, node.from, node.to);
    const restored = result.value.map((panel, index) => ({ id: result.value.length === 1 ? node.id : JSON.stringify([node.id, featureId, index]),
      normal: node.normal, outer: panel.outer.map(map), holes: panel.holes.map((loop) => loop.map(map)) }));
    (node.kind === 'panel' ? panels : bands).set(node.id, restored);
    for (const next of links.get(current) ?? []) {
      if (visited.has(next.node)) continue;
      const reaches = reliefReachesContact(tool, next.contacts); if (!reaches.ok) return reaches;
      if (reaches.value) queue.push(next.node);
    }
  }
  return panels.size === 0 && bands.size === 0 ? { ok: false, message: '切欠きが板金の材料に届いていません。位置と寸法を確認してください。' }
    : { ok: true, value: { panels, bands } };
}
