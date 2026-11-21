import type { ExpressionValue } from '@pointercad/expression';
import { appendSolid, isSameSubShape, liveBodyIds, nextSolidId, nextSolidName, type SubShapeRef } from '@pointercad/model';
import type { SolidInputCommit } from '../sketch/numericInput.js';
import type { MachiningContext } from './machiningCommands.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import { subShapeRefOf, type SubShapeBody } from './subShapeSelection.js';

/** 面の一覧が不完全なときと周期面の継ぎ目は、計算部が実際の境界を調べる。 */
function mayBeBoundary(body: SubShapeBody, edge: SubShapeRef): boolean {
  let owners = 0;
  let incomplete = false;
  for (const face of body.faces) {
    if (face.boundaryEdgeIndices === undefined) incomplete = true;
    else if (face.boundaryEdgeIndices.includes(edge.index)) owners++;
  }
  return owners === 1 || (owners === 0 && incomplete);
}

function boundaryPair({ document, selection, bodies }: MachiningContext): readonly [SubShapeRef, SubShapeRef] | null {
  if (selection.length !== 2) return null;
  const live = new Set(liveBodyIds(document));
  const resolve = (id: string): SubShapeRef | null => {
    const ref = subShapeRefOf(bodies, id);
    if (ref?.fingerprint.kind !== 'edge' || !live.has(ref.bodyFeatureId)) return null;
    const body = bodies.find(candidate => candidate.featureId === ref.bodyFeatureId);
    return body && mayBeBoundary(body, ref) ? ref : null;
  };
  const a = resolve(selection[0]);
  const b = resolve(selection[1]);
  return a && b && !isSameSubShape(a, b) ? [a, b] : null;
}

export function blendReadiness(context: MachiningContext): SolidToolReadiness {
  return boundaryPair(context) === null
    ? { ready: false, reasonKey: 'surfaceBlend.select' }
    : { ready: true, reasonKey: null };
}

function positiveWeight(value: ExpressionValue | undefined): value is ExpressionValue {
  return value !== undefined && Number.isFinite(value.value) && value.value > 0;
}

export function commitBlend(context: MachiningContext, commit: SolidInputCommit): SolidCommandOutcome {
  const pair = boundaryPair(context);
  if (pair === null) return { ok: false, reasonKey: 'surfaceBlend.select' };
  const { weightA, weightB } = commit.values;
  if (!positiveWeight(weightA) || !positiveWeight(weightB)) return { ok: false, reasonKey: 'surfaceBlend.positive' };
  const { document } = context;
  const id = nextSolidId(document, 'surface');
  const [a, b] = pair;
  return {
    ok: true, featureId: id,
    document: appendSolid(document, {
      id, name: nextSolidName(document, 'surface'), kind: 'surface', suppressed: false,
      operation: { kind: 'blend', a, b, weightA, weightB, flipB: commit.flags.flipB ?? false },
    }),
  };
}
