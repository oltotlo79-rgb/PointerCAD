/**
 * 合致の連立の入口で、互いに固定した部品の組(`rigidGroups.ts`)を代表の剛体 1 つへ畳む(追加要件6)。
 *
 * 畳んだ文書・配置・ジョイントの局所枠・一時の固定(anchors)を作り、解いた配置を戻す。
 * 世界座標の合致の対象(targets)は部品ごとに求めた値のままでよい——準備で代表の配置から
 * 局所へ直すので、代表から見た位置として読まれる。ジョイントの枠だけは部品の局所で渡されるため、
 * 代表の局所へ写し直す。
 */

import { transformJointFrame, type JointFramePair } from '../joints/jointFrames.js';
import type { RigidPlacement } from '../placementMath.js';
import {
  collapseRigidGroupPlacements, collapseRigidGroups, expandRigidGroupPlacements, type RigidGroupCollapse,
} from '../rigidGroups.js';
import type { AssemblyDocument } from '../types.js';
import type { PreparedMateDrag } from './mateDrag.js';

interface CollapsibleOptions {
  readonly jointFrames?: ReadonlyMap<string, JointFramePair>;
  readonly anchors?: ReadonlyMap<string, 'origin' | 'driver'>;
}

export interface CollapsedSolveInput<Options extends CollapsibleOptions> {
  readonly collapse: RigidGroupCollapse;
  readonly assembly: AssemblyDocument;
  readonly initial: Map<string, RigidPlacement>;
  readonly options: Options;
}

function collapsedJointFrames(
  document: AssemblyDocument, collapse: RigidGroupCollapse, frames: ReadonlyMap<string, JointFramePair>,
): Map<string, JointFramePair> {
  const result = new Map(frames);
  for (const joint of document.joints) {
    const pair = frames.get(joint.id);
    if (pair === undefined) continue;
    const toAnchor = (componentId: string, frame: JointFramePair['a']) => {
      const relative = collapse.relative.get(componentId);
      return relative === undefined ? frame : transformJointFrame(frame, relative);
    };
    const a = toAnchor(joint.a.componentId, pair.a);
    const b = toAnchor(joint.b.componentId, pair.b);
    // 写せない枠は元の枠のまま残さず消す(古い局所枠で解かない)。準備側が欠けた枠として断る。
    if (a === null || b === null) result.delete(joint.id); else result.set(joint.id, { a, b });
  }
  return result;
}

/** 組が無ければ `null`(呼び出し側は元の入力で解く)。 */
export function collapseSolveInput<Options extends CollapsibleOptions>(
  assembly: AssemblyDocument, initial: ReadonlyMap<string, RigidPlacement>, options: Options,
): CollapsedSolveInput<Options> | null {
  const collapse = collapseRigidGroups(assembly, initial);
  if (collapse === null) return null;
  const anchors = options.anchors === undefined ? undefined
    : new Map([...options.anchors].map(([id, kind]) => [collapse.anchorOf.get(id) ?? id, kind] as const));
  return {
    collapse, assembly: collapse.document, initial: collapseRigidGroupPlacements(collapse, initial),
    options: {
      ...options,
      ...(options.jointFrames === undefined ? {} : { jointFrames: collapsedJointFrames(assembly, collapse, options.jointFrames) }),
      ...(anchors === undefined ? {} : { anchors }),
    },
  };
}

/** 診断用に文書だけを畳む(配置が要らない読み替え)。組が無ければ元の文書。 */
export function collapsedDiagnosisDocument(assembly: AssemblyDocument): AssemblyDocument {
  const saved = new Map(assembly.components.map((component): [string, RigidPlacement] => [component.id, {
    position: [component.placement.position[0].value, component.placement.position[1].value, component.placement.position[2].value],
    rotation: component.placement.rotation,
  }]));
  return collapseRigidGroups(assembly, saved)?.document ?? assembly;
}

/**
 * 代表で準備した引っ張りを、引いた部品の id と全部品の配置で扱えるように包む。
 * 引く点の変数は代表(`variableComponentId`)、誤差は引いた部品の位置で測る。
 */
export function rigidGroupDrag(drag: PreparedMateDrag, collapse: RigidGroupCollapse, componentId: string): PreparedMateDrag {
  const expand = (base: ReadonlyMap<string, RigidPlacement>) => expandRigidGroupPlacements(collapse, base);
  const shrink = (base: ReadonlyMap<string, RigidPlacement>) => collapseRigidGroupPlacements(collapse, base);
  const movable = new Set(drag.variableSet.movableComponentIds);
  const followers = [...collapse.anchorOf].filter(([, anchor]) => movable.has(anchor)).map(([member]) => member);
  return {
    ...drag, componentId, variableComponentId: drag.componentId,
    initial: expand(drag.initial),
    variableSet: { ...drag.variableSet, movableComponentIds: [...drag.variableSet.movableComponentIds, ...followers] },
    evaluate: (base, increments) => drag.evaluate(shrink(base), increments),
    retract: (base, increments) => expand(drag.retract(shrink(base), increments)),
    branchCandidates: (base, violations) => drag.branchCandidates(shrink(base), violations),
  };
}
