/** P10-5/14/16。パネル接線境界の向きは各面の反時計回り外周に揃える。 */
export type PanelPoint = readonly [number, number];
export interface SheetPanelEdge { readonly panelId: string; readonly from: PanelPoint; readonly to: PanelPoint }
export interface SheetPanelConnection {
  readonly id: string; readonly first: SheetPanelEdge; readonly second: SheetPanelEdge; readonly allowance: number;
  /** 同じ指定線で穴の左右に分かれた帯。既存経路も同じ群で座標が一致した場合だけ重複接続を許す。 */
  readonly parallelGroupId?: string;
}
export interface SheetPanelGraph {
  readonly panelIds: readonly string[]; readonly connections: readonly SheetPanelConnection[];
  readonly fixedPanelId: string; readonly seamConnectionIds: readonly string[];
}
export interface PanelTransform {
  /** 列ベクトル。スケールを含めない2D剛体変換。 */
  readonly x: PanelPoint; readonly y: PanelPoint; readonly origin: PanelPoint;
}
export interface SheetPanelTraversal {
  readonly order: readonly string[];
  readonly transforms: ReadonlyMap<string, PanelTransform>;
  readonly connections: readonly { readonly id: string; readonly parentId: string; readonly childId: string }[];
  readonly redundantConnections?: readonly string[];
}
export type SheetPanelGraphResult = { readonly ok: true; readonly traversal: SheetPanelTraversal }
  | { readonly ok: false; readonly error: 'duplicateId' | 'unknownPanel' | 'invalidEdge' | 'unknownSeam' | 'cycle' | 'disconnected'; readonly ids: readonly string[] };

export function transformPanelPoint(point: PanelPoint, transform: PanelTransform): PanelPoint {
  return [transform.origin[0] + point[0] * transform.x[0] + point[1] * transform.y[0],
    transform.origin[1] + point[0] * transform.x[1] + point[1] * transform.y[1]];
}

/** 継ぎ目だけを切り、残るすべてのパネルを一度ずつ配置する。閉周回を勝手に切らない。 */
export function flattenSheetPanelGraph(graph: SheetPanelGraph): SheetPanelGraphResult {
  const panels = new Set(graph.panelIds), ids = new Set<string>(), seams = new Set(graph.seamConnectionIds);
  if (panels.size !== graph.panelIds.length || seams.size !== graph.seamConnectionIds.length) return { ok: false, error: 'duplicateId', ids: [] };
  if (!panels.has(graph.fixedPanelId)) return { ok: false, error: 'unknownPanel', ids: [graph.fixedPanelId] };
  const adjacency = new Map<string, SheetPanelConnection[]>(graph.panelIds.map((id) => [id, []]));
  for (const connection of graph.connections) {
    if (ids.has(connection.id)) return { ok: false, error: 'duplicateId', ids: [connection.id] };
    ids.add(connection.id);
    const { first, second } = connection;
    for (const edge of [first, second]) if (!panels.has(edge.panelId)) return { ok: false, error: 'unknownPanel', ids: [edge.panelId] };
    if (first.panelId === second.panelId) return { ok: false, error: 'cycle', ids: [connection.id] };
    const firstLength = Math.hypot(first.to[0] - first.from[0], first.to[1] - first.from[1]);
    const secondLength = Math.hypot(second.to[0] - second.from[0], second.to[1] - second.from[1]);
    if (![...first.from, ...first.to, ...second.from, ...second.to, connection.allowance, firstLength, secondLength].every(Number.isFinite)
      || Math.min(firstLength, secondLength) <= 1e-7 || Math.abs(firstLength - secondLength) > 1e-7 || connection.allowance < 0)
      return { ok: false, error: 'invalidEdge', ids: [connection.id] };
    adjacency.get(first.panelId)?.push(connection); adjacency.get(second.panelId)?.push(connection);
  }
  for (const seam of seams) if (!ids.has(seam)) return { ok: false, error: 'unknownSeam', ids: [seam] };
  for (const neighbours of adjacency.values()) neighbours.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const identity: PanelTransform = { x: [1, 0], y: [0, 1], origin: [0, 0] };
  const transforms = new Map<string, PanelTransform>([[graph.fixedPanelId, identity]]), order = [graph.fixedPanelId];
  const used = new Set<string>(), connections: { id: string; parentId: string; childId: string }[] = [];
  const groups = new Map<string, Map<string, string>>(), redundant: string[] = [];
  const groupRoot = (group: string, panel: string): string => {
    let roots = groups.get(group); if (roots === undefined) { roots = new Map(); groups.set(group, roots); }
    let root = panel;
    while (roots.has(root) && roots.get(root) !== root) root = roots.get(root) ?? root;
    roots.set(panel, root); return root;
  };
  for (let cursor = 0; cursor < order.length; cursor++) {
    const parentId = order[cursor], parentTransform = transforms.get(parentId);
    if (parentTransform === undefined) return { ok: false, error: 'disconnected', ids: [parentId] };
    for (const connection of adjacency.get(parentId) ?? []) {
      if (used.has(connection.id) || seams.has(connection.id)) continue;
      used.add(connection.id);
      const [parent, child] = connection.first.panelId === parentId ? [connection.first, connection.second] : [connection.second, connection.first];
      const from = transformPanelPoint(parent.from, parentTransform), to = transformPanelPoint(parent.to, parentTransform);
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const along: PanelPoint = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
      const childLength = Math.hypot(child.to[0] - child.from[0], child.to[1] - child.from[1]);
      const childAlong: PanelPoint = [(child.to[0] - child.from[0]) / childLength, (child.to[1] - child.from[1]) / childLength];
      const c = -along[0] * childAlong[0] - along[1] * childAlong[1];
      const s = -along[1] * childAlong[0] + along[0] * childAlong[1];
      // 共有境界の向きは反対。親の外向き（右側）へ中立面の帯幅を挟む。
      const anchor: PanelPoint = [to[0] + along[1] * connection.allowance, to[1] - along[0] * connection.allowance];
      const transform: PanelTransform = { x: [c, s], y: [-s, c],
        origin: [anchor[0] - c * child.from[0] + s * child.from[1], anchor[1] - s * child.from[0] - c * child.from[1]] };
      if (![...transform.x, ...transform.y, ...transform.origin].every(Number.isFinite)) return { ok: false, error: 'invalidEdge', ids: [connection.id] };
      const existing = transforms.get(child.panelId), group = connection.parallelGroupId;
      if (existing !== undefined) {
        if (group === undefined || group.length === 0 || groupRoot(group, parentId) !== groupRoot(group, child.panelId)
          || Math.hypot(existing.origin[0] - transform.origin[0], existing.origin[1] - transform.origin[1]) > 1e-7
          || Math.hypot(existing.x[0] - transform.x[0], existing.x[1] - transform.x[1]) > 1e-10)
          return { ok: false, error: 'cycle', ids: [connection.id, parentId, child.panelId] };
        redundant.push(connection.id); continue;
      }
      if (group !== undefined && group.length > 0) {
        const parentRoot = groupRoot(group, parentId), childRoot = groupRoot(group, child.panelId);
        groups.get(group)?.set(childRoot, parentRoot);
      }
      transforms.set(child.panelId, transform); order.push(child.panelId);
      connections.push({ id: connection.id, parentId, childId: child.panelId });
    }
  }
  if (transforms.size !== panels.size) return { ok: false, error: 'disconnected', ids: graph.panelIds.filter((id) => !transforms.has(id)).sort() };
  return { ok: true, traversal: { order, transforms, connections, ...(redundant.length === 0 ? {} : { redundantConnections: redundant }) } };
}
