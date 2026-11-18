/**
 * 接合チェック(E-09。設計 wip/e07-e09-design.md §3・§5.3)の画面の純関数。店の今の文書と表示(配置・ボディ)から model の判定の入力を作り、
 * 判定して、一覧の行・要約の数・3D の印を作る。計算は kernel を使わない(部品の箱は、表示のボディの形の外接箱を配置で写す)。
 */
import {
  applyPlacementToPoint, checkFrameJoints, classifyFrameJoints, placedFrameMembers, slotFastenerParts,
  type AssemblyDocument, type FrameJoint, type FrameJointCheckResult, type FrameJointFastening, type FrameJointKind, type PartBox, type SolidBody,
  type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';

/**
 * 1 回の自動の確かめにかけてよい時間(ms。統括の決定 2026-11-18 12:3x)。超えた時は、次からは手で起動するまで自動では調べない。
 */
export const FRAME_JOINT_CHECK_TIME_LIMIT_MS = 200;
/** 3D の印の 1 辺(mm。資料のフレームの断面 20〜40 mm より少し大きく、接続の点を囲む)。 */
const MARKER_SIZE_MM = 30;

/** 判定の結果と、どの文書・表示から作ったか。 */
export interface FrameJointCheckView {
  readonly sourceDocument: AssemblyDocument;
  readonly sourceView: AssemblyView;
  readonly result: FrameJointCheckResult;
  /** 手で起動した(上限・時間を超えても調べた)か。 */
  readonly forced: boolean;
  /** 1 回の判定にかかった時間(ms)。 */
  readonly elapsedMs: number;
  /** 自動の確かめを止めた後に、文書か表示が変わった(結果は古い。手で起動すると調べ直す)。 */
  readonly stale: boolean;
}

/** 自動の確かめを止めたか(上限を超えた、または時間を超えた。手で起動した結果は止めない)。 */
export function frameJointCheckStopped(view: FrameJointCheckView): boolean {
  return !view.forced && (!view.result.ok || view.elapsedMs > FRAME_JOINT_CHECK_TIME_LIMIT_MS);
}

/** 部品の形(ボディ)の、部品の座標の外接箱(形の無い部品は null)。 */
function localBox(bodies: readonly SolidBody[]): PartBox | null {
  let min: Vec3 | null = null, max: Vec3 | null = null;
  for (const body of bodies) {
    const [ox, oy, oz] = body.coordinateFrame?.origin ?? [0, 0, 0];
    const positions = body.mesh.positions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      const x = (positions[index] ?? 0) + ox, y = (positions[index + 1] ?? 0) + oy, z = (positions[index + 2] ?? 0) + oz;
      min = min === null ? [x, y, z] : [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
      max = max === null ? [x, y, z] : [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
    }
  }
  return min === null || max === null ? null : { min, max };
}

/**
 * 部品の世界の座標の外接箱(部品の座標の外接箱の 8 隅を配置で写して囲む。viewFit.ts の組立の箱と同じ作り方)。`exclude` の部品・抑制した部品・
 * 形の無い部品は入れない。接合チェック(部材でない部品)と伸縮(E-13。全部の部品)が使う。
 */
export function assemblyPartBoxes(document: AssemblyDocument, view: AssemblyView, exclude: ReadonlySet<string> = new Set()):
ReadonlyMap<string, PartBox> {
  const boxes = new Map<string, PartBox>();
  const local = new Map<string, PartBox | null>();
  for (const component of document.components) {
    const key = view.resolved.partKeys.get(component.id), placement = view.resolved.placements.get(component.id);
    if (exclude.has(component.id) || component.suppressed || key === undefined || placement === undefined) continue;
    if (!local.has(key)) local.set(key, localBox(view.bodies.get(key) ?? []));
    const box = local.get(key) ?? null;
    if (box === null) continue;
    const corners = [box.min[0], box.max[0]].flatMap((x) => [box.min[1], box.max[1]].flatMap((y) => [box.min[2], box.max[2]]
      .map((z): Vec3 => applyPlacementToPoint(placement, [x, y, z]))));
    boxes.set(component.id, { min: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.min(...corners.map((c) => c[2]))],
      max: [Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[2]))] });
  }
  return boxes;
}

/**
 * 今の文書と表示で判定する。上限を先に見て、超える時(手で起動していない時)は、接続を作らずに理由だけを返す。
 * `now` は時間の計り(ms)。
 */
export function runFrameJointCheck(document: AssemblyDocument, view: AssemblyView, forced: boolean, now: () => number): FrameJointCheckView {
  const started = now();
  const placements = view.resolved.placements;
  const members = placedFrameMembers(document, placements);
  const limits = checkFrameJoints({ document, members, joints: [], fasteners: [], partBoxes: new Map(), force: forced });
  const result = !limits.ok ? limits : checkFrameJoints({ document, members, joints: classifyFrameJoints(members),
    fasteners: slotFastenerParts(document, placements),
    partBoxes: assemblyPartBoxes(document, view, new Set(members.map((member) => member.componentId))), force: forced });
  return { sourceDocument: document, sourceView: view, result, forced, elapsedMs: now() - started, stale: false };
}

/** 一覧の行(留めていない・片側だけの接続)。 */
interface FrameJointCheckRow {
  readonly key: string;
  readonly joint: FrameJoint;
  readonly kind: FrameJointKind;
  readonly fastening: Extract<FrameJointFastening, 'none' | 'oneSided'>;
  readonly memberIds: readonly string[];
  readonly names: readonly string[];
}

/** 一覧の行。留めていない接続を先に、片側だけを後に、同じ中は接続の id の順。 */
export function frameJointCheckRows(view: FrameJointCheckView, nameOf: (componentId: string) => string): readonly FrameJointCheckRow[] {
  if (!view.result.ok) return [];
  const rows = view.result.statuses.flatMap((status): FrameJointCheckRow[] => {
    const fastening = status.fastening;
    if (fastening !== 'none' && fastening !== 'oneSided') return [];
    const memberIds = status.joint.members.map((member) => member.componentId);
    return [{ key: status.joint.id, joint: status.joint, kind: status.joint.kind, fastening, memberIds, names: memberIds.map(nameOf) }];
  });
  const order = (row: FrameJointCheckRow): number => (row.fastening === 'none' ? 0 : 1);
  return [...rows].sort((left, right) => order(left) - order(right) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/** 部品が欠けた・部材が無い・接続が見つからない記録の行(E-13。作り直すか、記録を外す)。 */
export interface FrameJointBrokenRow {
  readonly id: string;
  readonly status: 'missingParts' | 'missingMember' | 'jointChanged';
  readonly kind: FrameJointKind;
  readonly names: readonly string[];
}

/** 欠けた・ずれた記録の行(記録の並びの順)。記録の部材の名前は、文書に無い部材は id のまま。 */
export function frameJointBrokenRows(view: FrameJointCheckView, nameOf: (componentId: string) => string): readonly FrameJointBrokenRow[] {
  if (!view.result.ok) return [];
  const records = new Map((view.sourceDocument.frameJoints ?? []).map((record) => [record.id, record]));
  return view.result.brokenRecords.flatMap((broken): FrameJointBrokenRow[] => {
    const record = records.get(broken.id);
    return record === undefined ? [] : [{ id: broken.id, status: broken.status, kind: record.kind,
      names: record.members.map((member) => nameOf(member.componentId)) }];
  });
}

/** 要約の数(留めていない接続・片側だけ・剛体のまとまりで固定・どこにも留められていない部材)。 */
interface FrameJointCheckSummary {
  readonly none: number;
  readonly oneSided: number;
  readonly rigidGroup: number;
  readonly unfastenedMembers: number;
}

export function frameJointCheckSummary(view: FrameJointCheckView): FrameJointCheckSummary | null {
  if (!view.result.ok) return null;
  const count = (kind: FrameJointFastening): number => view.result.ok ? view.result.statuses.filter((status) => status.fastening === kind).length : 0;
  return { none: count('none'), oneSided: count('oneSided'), rigidGroup: count('rigidGroup'), unfastenedMembers: view.result.unfastenedMembers.length };
}

/** 3D の印(留めていない・片側だけの接続の点を囲む立方体)。 */
export interface FrameJointMarker {
  readonly key: string;
  readonly center: Vec3;
  readonly size: number;
  readonly selected: boolean;
}

export function frameJointMarkers(view: FrameJointCheckView | null, selectedKey: string | null): readonly FrameJointMarker[] {
  if (view === null || !view.result.ok) return [];
  return view.result.statuses.filter((status) => status.fastening === 'none' || status.fastening === 'oneSided')
    .map((status) => ({ key: status.joint.id, center: status.joint.point, size: MARKER_SIZE_MM, selected: status.joint.id === selectedKey }));
}
