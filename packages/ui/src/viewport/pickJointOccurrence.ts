import {
  applyPlacementToPoint, resolveJointOccurrence,
  type AssemblyDocument, type JointOccurrenceInputs, type JointOccurrenceResult, type PartLibrary, type SubShapeRef,
} from '@pointercad/model';

import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { flattenAssemblyGeometry, type AssemblyOccurrencePath } from './createAssemblyLayer.js';
import type { ViewportScene } from './createViewportScene.js';

/**
 * 締結・溶接の接合だけが使う選択。入れ子の組の葉の部品を、根からの配置の経路(分けない id の並び)と部品の中の
 * 面・辺の参照で指す。普通の合致・ドラッグの平らな `MateTarget` とは別の型で、その道へは流さない。
 */
export interface JointOccurrencePick {
  readonly kind: 'jointOccurrence';
  readonly path: AssemblyOccurrencePath;
  readonly partKey: string;
  readonly ref: SubShapeRef;
}

type JointPickScene = Pick<ViewportScene, 'pickAssemblyFace' | 'worldToScreen'>;

/** 一式が子の組を持たない時の、変わらない空の表(解いた時と押した時で同じ物を使い、同じ入力と分かるようにする)。 */
const NO_SUB_ASSEMBLIES: ReadonlyMap<string, AssemblyDocument> = new Map();

/** 解く所と選ぶ所が同じ形で作る、経路を解く入力(文書・一式・子の組の文書は渡された物そのもの)。 */
export function jointOccurrenceInputsOf(document: AssemblyDocument, library: PartLibrary): JointOccurrenceInputs {
  return { document, library, subAssemblies: library.assemblies ?? NO_SUB_ASSEMBLIES };
}

/**
 * 選んだ経路を、表示が持つ解いた時の入力で葉の部品へ解く。表示に入力が無い・今の文書や一式と違う物なら `stale-view`
 * (押した時に入力を作り直して古い解を今の物と見なさない)。
 */
export function resolveJointOccurrencePick(
  document: AssemblyDocument, library: PartLibrary, view: AssemblyView, pick: JointOccurrencePick,
): JointOccurrenceResult {
  if (view.source === undefined) return { ok: false, code: 'stale-view', index: 0 };
  return resolveJointOccurrence(jointOccurrenceInputsOf(document, library), pick.path, { source: view.source, resolved: view.resolved });
}

/**
 * 接合の面・辺を選ぶ。面は描いた一式が当たりに添えた経路だけを使い(行 ID を分けて作り直さない)、経路の無い当たり
 * (行 ID が別の配置と重なったもの)は選ばない。辺は解いた組立を葉の部品まで辿り、経路の決まる配置だけを的にする。
 */
export function pickJointOccurrenceTarget(
  document: AssemblyDocument, view: AssemblyView, scene: JointPickScene,
  pointer: readonly [number, number], kind: 'face' | 'edge',
): JointOccurrencePick | null {
  if (kind === 'face') {
    const hit = scene.pickAssemblyFace(pointer[0], pointer[1]);
    if (hit === null || hit.occurrencePath === undefined) return null;
    const ref = subShapeRefOf(view.bodies.get(hit.partKey) ?? [], subShapeElementId(hit.bodyFeatureId, 'face', hit.faceIndex));
    return ref === null ? null : { kind: 'jointOccurrence', path: hit.occurrencePath, partKey: hit.partKey, ref };
  }
  const flat = flattenAssemblyGeometry(document, view.resolved);
  let nearest: { readonly pick: JointOccurrencePick; readonly distance: number } | null = null;
  for (const component of flat.components) {
    if (!component.visible) continue;
    const path = flat.occurrencePaths?.get(component.id);
    const placement = flat.placements.get(component.id);
    const partKey = flat.partKeys.get(component.id);
    const bodies = partKey === undefined ? undefined : view.bodies.get(partKey);
    if (path === undefined || path === null || placement === undefined || partKey === undefined || bodies === undefined) continue;
    const hit = pickSolidSubShape(bodies, (local) => scene.worldToScreen(applyPlacementToPoint(placement, local)), pointer, 'edge');
    if (hit === null || hit.kind !== 'edge' || (nearest !== null && nearest.distance <= hit.distance)) continue;
    const ref = subShapeRefOf(bodies, hit.elementId);
    if (ref !== null) nearest = { pick: { kind: 'jointOccurrence', path, partKey, ref }, distance: hit.distance };
  }
  return nearest?.pick ?? null;
}
