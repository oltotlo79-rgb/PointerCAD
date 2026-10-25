/**
 * 2穴と合わせ面からボルト締結を計画する純関数(追加要件6、EX-06 の中核)。
 *
 * 文書は変えない。断る時は理由の一覧だけを返す。計画は `applyBoltedJoint` が
 * 出どころと配置を照合し直してから、1回の新しい文書として足す(Undo 1段)。
 *
 * 扱う組合せ:
 * - 通し穴＋通し穴: 六角ボルト＋同じ呼び・系列・寸法系列の六角ナットで共締めする。
 * - 通し穴＋ねじ穴(貫通・止まり): 頭を通し穴の側に置き、ナットは足さない。
 * - ねじ穴＋ねじ穴: 頭の側の板もねじに掛かって板を引き寄せられないため断る(植込みボルト等は未対応)。
 */

import type { AssemblyDocument } from '../types.js';
import { scaleVec3 } from '../../sketch/vec3.js';
import { planAlignment, type AlignmentPlan } from './alignment.js';
import { placementOnAxis } from './fastenerPlacements.js';
import {
  contactRejections, localSelectionRejections, placementFingerprint, resolveWorldHole, type WorldHole,
} from './frames.js';
import {
  boltRowFor, explicitThreadChoice, isRejection, nutRowFor, selectBoltLength, threadChoiceFor,
  type ThreadChoice, washerFor, type WasherChoice,
} from './selectFastener.js';
import {
  type BoltedJointPlan, type BoltedJointPlanResult, type BoltedJointRejection, type BoltedJointRequest,
  FASTENING_LENGTH_TOLERANCE_MM, type FastenerOperation, type FasteningMissingFact,
} from './types.js';
import { clearanceRejections, lengthLimits } from './planChecks.js';

function failed(rejections: readonly BoltedJointRejection[]): BoltedJointPlanResult {
  return { ok: false, rejections };
}

/** 頭の側を通し穴にそろえる。ねじ穴どうしは断る。 */
function orderHoles(
  a: WorldHole, b: WorldHole,
): { readonly head: WorldHole; readonly far: WorldHole } | BoltedJointRejection {
  const aClear = a.selection.hole.kind === 'clearance';
  const bClear = b.selection.hole.kind === 'clearance';
  if (!aClear && !bClear) {
    return { code: 'bothHolesThreaded', detail: { first: a.component.id, second: b.component.id } };
  }
  return aClear ? { head: a, far: b } : { head: b, far: a };
}

function threadFor(request: BoltedJointRequest, head: WorldHole, far: WorldHole): ThreadChoice | BoltedJointRejection {
  const hole = far.selection.hole;
  if (hole.kind !== 'clearance') {
    const thread = threadChoiceFor(hole.nominal, hole.pitch);
    if (isRejection(thread) || request.explicitBolt === undefined) return thread;
    const explicit = explicitThreadChoice(request.explicitBolt.nominal, request.explicitBolt.threadSeries);
    if (isRejection(explicit)) return explicit;
    if (explicit.nominal !== thread.nominal) {
      return { code: 'nominalMismatch', detail: { hole: thread.nominal, bolt: explicit.nominal } };
    }
    if (Math.abs(explicit.pitch - thread.pitch) > FASTENING_LENGTH_TOLERANCE_MM) {
      return { code: 'pitchMismatch', detail: { hole: thread.pitch, bolt: explicit.pitch } };
    }
    return thread;
  }
  if (request.explicitBolt !== undefined) {
    return explicitThreadChoice(request.explicitBolt.nominal, request.explicitBolt.threadSeries);
  }
  const headHole = head.selection.hole;
  const diameters = [headHole.kind === 'clearance' ? headHole.diameter : NaN, hole.diameter];
  const matches = (request.clearanceEvidence ?? []).filter((row) => row.verified
    && diameters.every((value) => value >= row.minimumHoleDiameter - FASTENING_LENGTH_TOLERANCE_MM
      && value <= row.maximumHoleDiameter + FASTENING_LENGTH_TOLERANCE_MM));
  const only = matches[0];
  if (matches.length !== 1 || only === undefined) {
    return { code: 'boltSizeUnspecified', detail: { matches: matches.length, first: diameters[0] ?? NaN, second: hole.diameter } };
  }
  // 根拠の行は呼びだけを決める。ねじの系列は既存の規格部品の既定(並目)と同じにする。
  return explicitThreadChoice(only.nominal, 'coarse');
}

function washers(kinds: BoltedJointRequest['headWashers'], nominal: string): WasherChoice[] | BoltedJointRejection {
  const out: WasherChoice[] = [];
  for (const kind of kinds) {
    const washer = washerFor(kind, nominal);
    if (isRejection(washer)) return washer;
    out.push(washer);
  }
  return out;
}

function sumThickness(stack: readonly WasherChoice[]): number {
  return stack.reduce((total, washer) => total + washer.thickness, 0);
}

function washerOperations(
  role: 'headWasher' | 'nutWasher', hole: WorldHole, plateLength: number, stack: readonly WasherChoice[], nominal: string,
): FastenerOperation[] {
  let offset = plateLength;
  return stack.map((washer) => {
    const operation: FastenerOperation = {
      role, catalog: washer.kind, size: nominal, options: {}, rowKey: washer.rowKey, rowVerified: washer.verified,
      placement: placementOnAxis(hole.matingPoint, hole.into, offset, hole.into),
    };
    offset += washer.thickness;
    return operation;
  });
}

/**
 * 先端の位置から測る量。ねじ穴では、ボルトのねじ部(先端から b の範囲)と穴の有効なねじ部の
 * 重なりだけを掛かり長さとし、穴を突き抜けた分は外への突き出しとして別に返す。
 */
function tipMeasures(
  far: WorldHole, grip: number, length: number, boltThread: number, nutHeight: number | null,
): Pick<BoltedJointPlan, 'engagedLength' | 'penetration' | 'protrusion'> {
  const hole = far.selection.hole;
  if (hole.kind === 'clearance') {
    return { engagedLength: null, penetration: null, protrusion: nutHeight === null ? null : length - grip - nutHeight };
  }
  const tip = length - grip;
  const [start, end] = hole.kind === 'throughThreaded'
    ? [hole.threadStart, hole.threadStart + hole.threadLength] : [0, hole.usableThreadDepth];
  const engaged = Math.max(0, Math.min(tip, end) - Math.max(tip - boltThread, start));
  return {
    engagedLength: engaged, penetration: tip,
    protrusion: hole.kind === 'throughThreaded' ? Math.max(0, tip - hole.length) : null,
  };
}

function plateLength(hole: WorldHole): number {
  const spec = hole.selection.hole;
  return spec.kind === 'blindThreaded' ? 0 : spec.length;
}

/** 計画を作る。`partRevisions` は抱き込んだ部品の内容の版(出どころの鍵に入れる)。 */
export function planBoltedJoint(
  document: AssemblyDocument,
  request: BoltedJointRequest,
  partRevisions: ReadonlyMap<string, string> = new Map(),
): BoltedJointPlanResult {
  const local = [...localSelectionRejections(request.first), ...localSelectionRejections(request.second)];
  if (local.length > 0) return failed(local);
  if (request.first.componentId === request.second.componentId) {
    return failed([{ code: 'sameComponent', detail: { componentId: request.first.componentId } }]);
  }
  const resolved = [request.first, request.second].map((selection) => resolveWorldHole(document, selection, partRevisions));
  const resolvedRejections = resolved.flatMap((entry) => ('rejection' in entry ? [entry.rejection] : []));
  if (resolvedRejections.length > 0) return failed(resolvedRejections);
  const [current1, current2] = resolved.flatMap((entry) => ('hole' in entry ? [entry.hole] : []));
  if (current1 === undefined || current2 === undefined) return failed([]);
  // 動かせる側(とその組)を、軸と合わせ面が一致する位置へ写してから寸法を決める。
  const alignment = planAlignment(document, current1, current2);
  const moves = alignment.movedComponentIds.length > 0;
  const first = moves && alignment.moved.component.id === current1.component.id ? alignment.moved : current1;
  const second = moves && alignment.moved.component.id === current2.component.id ? alignment.moved : current2;
  const contact = contactRejections(first, second);
  if (contact.length > 0) {
    return failed(moves ? contact : [{ code: 'alignmentBlocked', detail: { first: first.component.id, second: second.component.id } }, ...contact]);
  }
  const ordered = orderHoles(first, second);
  if (isRejection(ordered)) return failed([ordered]);
  return planOrdered(request, ordered.head, ordered.far, document, alignment);
}

function planOrdered(
  request: BoltedJointRequest, head: WorldHole, far: WorldHole, document: AssemblyDocument, alignment: AlignmentPlan,
): BoltedJointPlanResult {
  const thread = threadFor(request, head, far);
  if (isRejection(thread)) return failed([thread]);
  const bolt = boltRowFor(thread, request.dimensionSeries);
  if (isRejection(bolt)) return failed([bolt]);
  const withNut = far.selection.hole.kind === 'clearance';
  const nut = withNut ? nutRowFor(thread, request.dimensionSeries) : null;
  if (nut !== null && isRejection(nut)) return failed([nut]);
  if (!withNut && request.nutWashers.length > 0) {
    return failed([{ code: 'washerOnTappedSide', detail: { componentId: far.component.id } }]);
  }
  const headStack = washers(request.headWashers, thread.nominal);
  const nutStack = washers(request.nutWashers, thread.nominal);
  if (isRejection(headStack)) return failed([headStack]);
  if (isRejection(nutStack)) return failed([nutStack]);
  const missing = new Set<FasteningMissingFact>();
  const clearance = clearanceRejections({ thread, bolt, nut, head, far, headStack, nutStack, missing });
  if (clearance.length > 0) return failed(clearance);
  const headLength = plateLength(head);
  const farLength = plateLength(far);
  const grip = headLength + sumThickness(headStack) + (withNut ? farLength + sumThickness(nutStack) : 0);
  const limits = lengthLimits(request, far, grip, nut);
  if (isRejection(limits)) return failed([limits]);
  const length = selectBoltLength(bolt, request.lengthAvailability, limits, thread.series);
  if (isRejection(length)) return failed([length]);
  for (const fact of length.missingFacts) missing.add(fact);
  if (!bolt.verified || (nut !== null && !nut.verified)) missing.add('catalogRowUnverified');
  if ([...headStack, ...nutStack].some((washer) => !washer.verified)) missing.add('washerTableUnverified');
  const towardFar = scaleVec3(head.into, -1);
  const operations: FastenerOperation[] = [
    ...washerOperations('headWasher', head, headLength, headStack, thread.nominal),
    {
      role: 'bolt', catalog: 'hexBolt', size: thread.nominal, rowKey: bolt.key, rowVerified: bolt.verified,
      options: { length: String(length.length), dimensionSeries: request.dimensionSeries, threadSeries: thread.series },
      placement: placementOnAxis(head.matingPoint, head.into, headLength + sumThickness(headStack), towardFar),
    },
    ...washerOperations('nutWasher', far, farLength, nutStack, thread.nominal),
    ...(nut === null ? [] : [{
      role: 'nut' as const, catalog: 'hexNut' as const, size: thread.nominal, rowKey: nut.key, rowVerified: nut.verified,
      options: { dimensionSeries: request.dimensionSeries, threadSeries: thread.series },
      placement: placementOnAxis(far.matingPoint, far.into, farLength + sumThickness(nutStack), far.into),
    }]),
  ];
  const identity = (hole: WorldHole): string => `${hole.selection.sourceKey}|${placementFingerprint(hole.component.placement)}`;
  // 動かす組の他の部品も、計画の後に動いていないことを足す前に確かめる。
  const placementFingerprints = Object.fromEntries(alignment.movedComponentIds.flatMap((id) => {
    const component = document.components.find((candidate) => candidate.id === id);
    return component === undefined ? [] : [[id, placementFingerprint(component.placement)]];
  }));
  return {
    ok: true,
    plan: {
      configuration: withNut ? 'throughBoltWithNut' : far.selection.hole.kind === 'blindThreaded' ? 'tappedBlind' : 'tappedThrough',
      headSideComponentId: head.component.id, farSideComponentId: far.component.id,
      nominal: thread.nominal, pitch: thread.pitch, threadSeries: thread.series,
      gripLength: grip, boltLength: length.length,
      ...tipMeasures(far, grip, length.length, length.threadLength, nut?.mMax ?? null),
      lengthBasis: length.basis, lengthVerified: length.verified,
      missingFacts: [...missing].sort(),
      sourceIdentities: { [head.component.id]: identity(head), [far.component.id]: identity(far) },
      alignment: { movedComponentIds: alignment.movedComponentIds, delta: alignment.delta, placementFingerprints },
      operations,
    },
  };
}
