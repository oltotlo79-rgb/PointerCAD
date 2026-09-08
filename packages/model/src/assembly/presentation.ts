/** P7 タスク21。保存したステップから任意時刻の表示配置を純関数で導く。 */
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { resolveRevolveAxis } from '../part/resolvePart.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';
import { WORLD_AXIS_DIRECTIONS } from '../sketch/planeMath.js';
import { type Vec3 } from '../sketch/vec3.js';
import { nonLengthVariables } from '../units/length.js';
import { type JointDriveRequest } from './joints/driveJoint.js';
import { jointCoordinateNames, validJointPlacement } from './joints/jointFrames.js';
import { rotateVector, type RigidPlacement } from './placementMath.js';
import { assemblyVariables, type ResolvedAssembly } from './resolveAssembly.js';
import type { AssemblyDocument, JointCoordinate, PresentationStep } from './types.js';

export type ExplodeStepBody = Extract<PresentationStep['body'], { readonly kind: 'explode' }>;
export type JointStepBody = Extract<PresentationStep['body'], { readonly kind: 'joint' }>;
export type PresentationFailureReason =
  | 'invalidTime'
  | 'invalidStep'
  | 'duplicateStep'
  | 'missingStep'
  | 'missingComponent'
  | 'missingDirection'
  | 'invalidPlacement'
  | 'invalidExpression'
  | 'missingJoint'
  | 'unsupportedCoordinate'
  | 'ambiguousCoordinate'
  | 'invalidReference'
  | 'overlappingDriver';
export type PresentationFailure = {
  readonly ok: false;
  readonly reason: PresentationFailureReason;
  readonly stepId?: string;
};
export type PresentationResult<T> = { readonly ok: true; readonly value: T } | PresentationFailure;

/** 区間外を0/1へ挟み、区間内だけ線形に進める。無効値は黙って補わない。 */
export function stepProgress(
  step: Pick<PresentationStep, 'start' | 'end'>,
  t: number,
): number | null {
  if (
    !Number.isFinite(t) || t < 0 || t > 1 ||
    !Number.isFinite(step.start) || !Number.isFinite(step.end) ||
    step.start < 0 || step.end > 1 || step.start >= step.end
  ) return null;
  return t <= step.start ? 0 : t >= step.end ? 1 : (t - step.start) / (step.end - step.start);
}

function unitDirection(vector: Vec3 | null): Vec3 | null {
  if (vector === null || vector.length !== 3 || !vector.every(Number.isFinite)) return null;
  const size = Math.hypot(...vector);
  return !Number.isFinite(size) || size <= 1e-12
    ? null
    : [vector[0] / size, vector[1] / size, vector[2] / size];
}

/**
 * `AxisSpec` の向きを世界座標へ解く。world は文字どおり世界軸、line/reference は
 * ステップの先頭部品に属する軸として解く。向きの保存型は P5 の `AxisSpec` だけを使う。
 */
export function resolvePresentationDirection(
  body: ExplodeStepBody,
  resolved: ResolvedAssembly,
  placements: ReadonlyMap<string, RigidPlacement>,
): Vec3 | null {
  if (body.direction.kind === 'world') return WORLD_AXIS_DIRECTIONS[body.direction.axis];
  const owner = body.componentIds[0];
  if (owner === undefined) return null;
  const key = resolved.partKeys.get(owner);
  const placement = placements.get(owner);
  const part = key === undefined ? undefined : resolved.parts.get(key);
  if (part === undefined || placement === undefined || !validJointPlacement(placement)) return null;
  const axes = new Map(part.references.axes.map((axis) => [
    axis.featureId,
    { origin: axis.origin, direction: axis.direction },
  ]));
  const axis = resolveRevolveAxis(body.direction, part.sketches, axes);
  return axis === null ? null : unitDirection(rotateVector(placement.rotation, axis.direction));
}

function evaluatedValue(
  source: ExpressionValue,
  document: AssemblyDocument,
  variables: ReadonlyMap<string, number>,
): number | null {
  const result = evaluateExpression(source.source, {
    variables,
    nonLengthVariables: nonLengthVariables(document.parameters),
  });
  return result.ok && Number.isFinite(result.value.value)
    ? result.value.value === 0 ? 0 : result.value.value
    : null;
}

/** 文書に保存する前にも、読み込んだ後にも使える意味検査。 */
export function validatePresentationSteps(
  document: AssemblyDocument,
): PresentationFailure | { readonly ok: true } {
  const ids = new Set<string>();
  const componentIds = new Set(document.components
    .filter((component) => !component.suppressed).map((component) => component.id));
  const jointIds = new Set(document.joints
    .filter((joint) => !joint.suppressed).map((joint) => joint.id));
  for (let index = 0; index < document.presentation.length; index += 1) {
    const step = document.presentation[index];
    if (!Object.hasOwn(document.presentation, index) || step === undefined ||
      step.id.trim() === '' || stepProgress(step, 0) === null) {
      return { ok: false, reason: 'invalidStep', stepId: step?.id };
    }
    if (ids.has(step.id)) return { ok: false, reason: 'duplicateStep', stepId: step.id };
    ids.add(step.id);
    if (step.body.kind === 'explode') {
      if (step.body.componentIds.length === 0 ||
        new Set(step.body.componentIds).size !== step.body.componentIds.length) {
        return { ok: false, reason: 'invalidStep', stepId: step.id };
      }
      for (let component = 0; component < step.body.componentIds.length; component += 1) {
        const id = step.body.componentIds[component];
        if (!Object.hasOwn(step.body.componentIds, component) || id === undefined || !componentIds.has(id)) {
          return { ok: false, reason: 'missingComponent', stepId: step.id };
        }
      }
    } else {
      if (!jointIds.has(step.body.jointId)) {
        return { ok: false, reason: 'missingJoint', stepId: step.id };
      }
      if (step.body.referenceAngle !== undefined && !Number.isFinite(step.body.referenceAngle)) {
        return { ok: false, reason: 'invalidReference', stepId: step.id };
      }
    }
  }
  return { ok: true };
}

/** 保存配置を変えず、分解の平行移動だけを重ねた表示配置を返す。 */
export function explodedPlacements(
  document: AssemblyDocument,
  resolved: ResolvedAssembly,
  placements: ReadonlyMap<string, RigidPlacement>,
  t: number,
): PresentationFailure | { readonly ok: true; readonly placements: ReadonlyMap<string, RigidPlacement> } {
  if (stepProgress({ start: 0, end: 1 }, t) === null) return { ok: false, reason: 'invalidTime' };
  const valid = validatePresentationSteps(document);
  if (!valid.ok) return valid;
  const variables = assemblyVariables(document);
  let result: Map<string, RigidPlacement> | null = null;
  for (const step of document.presentation) {
    if (step.body.kind !== 'explode') continue;
    const distance = evaluatedValue(step.body.distance, document, variables);
    if (distance === null) return { ok: false, reason: 'invalidExpression', stepId: step.id };
    const direction = resolvePresentationDirection(step.body, resolved, placements);
    if (direction === null) return { ok: false, reason: 'missingDirection', stepId: step.id };
    const amount = distance * (stepProgress(step, t) ?? 0);
    for (const id of step.body.componentIds) {
      const placement = (result ?? placements).get(id);
      if (placement === undefined) return { ok: false, reason: 'missingComponent', stepId: step.id };
      if (!validJointPlacement(placement)) return { ok: false, reason: 'invalidPlacement', stepId: step.id };
      if (amount === 0) continue;
      const position: Vec3 = [
        placement.position[0] + direction[0] * amount,
        placement.position[1] + direction[1] * amount,
        placement.position[2] + direction[2] * amount,
      ];
      if (!position.every(Number.isFinite)) return { ok: false, reason: 'invalidPlacement', stepId: step.id };
      result ??= new Map(placements);
      result.set(id, { position, rotation: placement.rotation });
    }
  }
  return { ok: true, placements: result ?? placements };
}

export function addExplodeStep(
  document: AssemblyDocument,
  input: Omit<PresentationStep, 'id' | 'body'> & { readonly body: ExplodeStepBody },
): PresentationResult<AssemblyDocument> {
  const step: PresentationStep = {
    ...input,
    id: nextSerialId(document.presentation.map((item) => item.id), 'step-'),
  };
  const value = { ...document, presentation: [...document.presentation, step] };
  const valid = validatePresentationSteps(value);
  if (!valid.ok) return valid;
  if (evaluatedValue(input.body.distance, document, assemblyVariables(document)) === null) {
    return { ok: false, reason: 'invalidExpression', stepId: step.id };
  }
  return { ok: true, value };
}

export function removeStep(document: AssemblyDocument, id: string): AssemblyDocument {
  const presentation = document.presentation.filter((step) => step.id !== id);
  return presentation.length === document.presentation.length ? document : { ...document, presentation };
}

export function reorderSteps(
  document: AssemblyDocument,
  ids: readonly string[],
): PresentationResult<AssemblyDocument> {
  if (ids.length !== document.presentation.length || new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'invalidStep' };
  }
  const presentation: PresentationStep[] = [];
  for (const id of ids) {
    const step = document.presentation.find((item) => item.id === id);
    if (step === undefined) return { ok: false, reason: 'missingStep', stepId: id };
    presentation.push(step);
  }
  return { ok: true, value: presentation.every((step, index) => step === document.presentation[index])
    ? document : { ...document, presentation } };
}

interface JointEntry {
  readonly step: PresentationStep;
  readonly body: JointStepBody;
  readonly coordinate: JointCoordinate;
}

/** 同じ座標の重複駆動を断り、時刻 `t` の一時 driver を決定的な順で返す。 */
export function presentationJointRequests(
  document: AssemblyDocument,
  t: number,
): PresentationResult<readonly JointDriveRequest[]> {
  if (stepProgress({ start: 0, end: 1 }, t) === null) return { ok: false, reason: 'invalidTime' };
  const valid = validatePresentationSteps(document);
  if (!valid.ok) return valid;
  const groups = new Map<string, JointEntry[]>();
  for (const step of document.presentation) {
    if (step.body.kind !== 'joint') continue;
    const body = step.body;
    const joint = document.joints.find((item) => item.id === body.jointId && !item.suppressed);
    if (joint === undefined) return { ok: false, reason: 'missingJoint', stepId: step.id };
    const coordinates = jointCoordinateNames(joint.kind);
    const coordinate = body.coordinate ?? (coordinates.length === 1 ? coordinates[0] : undefined);
    if (coordinate === undefined) {
      return { ok: false, reason: coordinates.length === 0 ? 'unsupportedCoordinate' : 'ambiguousCoordinate', stepId: step.id };
    }
    if (!coordinates.includes(coordinate)) {
      return { ok: false, reason: 'unsupportedCoordinate', stepId: step.id };
    }
    const key = `${body.jointId}\u0000${coordinate}`;
    const group = groups.get(key) ?? [];
    group.push({ step, body, coordinate });
    groups.set(key, group);
  }
  const variables = assemblyVariables(document);
  const requests: JointDriveRequest[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.step.start - b.step.start || a.step.id.localeCompare(b.step.id));
    for (let index = 1; index < group.length; index += 1) {
      if (group[index].step.start < group[index - 1].step.end) {
        return { ok: false, reason: 'overlappingDriver', stepId: group[index].step.id };
      }
    }
    let active = group[0];
    if (active === undefined) continue;
    for (const entry of group) if (entry.step.start <= t) active = entry;
    const from = evaluatedValue(active.body.from, document, variables);
    const to = evaluatedValue(active.body.to, document, variables);
    if (from === null || to === null) {
      return { ok: false, reason: 'invalidExpression', stepId: active.step.id };
    }
    const progress = stepProgress(active.step, t) ?? 0;
    const value = progress === 0 ? from : progress === 1 ? to : from * (1 - progress) + to * progress;
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalidExpression', stepId: active.step.id };
    const joint = document.joints.find((item) => item.id === active.body.jointId);
    requests.push({
      jointId: active.body.jointId,
      coordinate: active.coordinate,
      value: value === 0 ? 0 : value,
      ...(active.coordinate === 'angle' ? { referenceAngle: active.body.referenceAngle ?? from } : {}),
      ...(joint?.kind === 'cylindrical' ? { bounds: { min: joint.minValue, max: joint.maxValue } } : {}),
    });
  }
  return { ok: true, value: requests };
}
