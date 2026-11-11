import { writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPrimitiveFeature,
  embedPart, EMPTY_PART_LIBRARY, type AssemblyComponent, type AssemblyDocument, type Joint,
  type MechanismGearCoupling, type Placement,
} from '../../packages/model/src/index.js';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';

export const ORACLE_RATIOS = [2, -2, 0.5, -0.5] as const;
export const ORACLE_PHASE_DEG = 17;
export const ORACLE_START_DEG = 179;
export const ORACLE_TARGETS_DEG = [181, 179, 120, 60, 0, -60, -120, -179, -181, -179] as const;
export const ORACLE_POSITIONS: Readonly<Record<string, readonly [number, number, number]>> = {
  'ground-a': [-45, 0, 0], a: [-45, 0, 0], 'ground-b': [25, 0, 0], b: [25, 0, 0],
  'ground-c': [95, 0, 0], c: [95, 0, 0], loose: [0, -60, 0],
};
const SAVED_AT = '2026-09-01T00:00:00.000Z';
const value = expressionValueFromNumber;

function at(id: string, angle: number): Placement {
  const position = ORACLE_POSITIONS[id];
  if (position === undefined) throw new Error(`Missing oracle position ${id}`);
  // a is the moving frame, b the fixed support: the joint coordinate is minus its world Z rotation.
  const half = -angle * Math.PI / 360;
  return { position: [value(position[0]), value(position[1]), value(position[2])],
    rotation: [0, 0, Math.sin(half), Math.cos(half)] };
}
function joint(id: string): Joint {
  return { id: `drive-${id}`, name: `drive-${id}`, kind: 'revolute',
    a: { kind: 'origin', componentId: id, element: 'z' },
    b: { kind: 'origin', componentId: `ground-${id}`, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}
function gear(id: string, a: string, b: string, ratio: number, phase: number): MechanismGearCoupling {
  return { id, kind: 'gear', jointAId: `drive-${a}`, jointBId: `drive-${b}`,
    ratio: value(ratio), phaseDeg: value(phase), referenceAngleA: ORACLE_START_DEG, suppressed: false };
}

/** Plain authored inputs only. No solve, cached scene, or injected test result is used to construct the file. */
export async function assemblyMechanismOracleFile(ratio: number, negative?: 'contradictory-phase' | 'missing-reference'): Promise<Uint8Array> {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (const kind of ['box', 'cylinder', 'sphere'] as const) {
    const empty = { ...createEmptyPartDocument(), name: `oracle-${kind}` };
    const part = appendSolid(empty, createPrimitiveFeature(empty, kind));
    const embedded = await embedPart(library, part, `oracle-${kind}.pcad`, '', { importedAt: SAVED_AT });
    library = embedded.library;
    refs.push(embedded.partRef);
  }
  const components: AssemblyComponent[] = Object.keys(ORACLE_POSITIONS).map(id => {
    const fixed = id.startsWith('ground-'), index = fixed ? 0 : id === 'loose' ? 2 : 1;
    const partRef = refs[index];
    if (partRef === undefined) throw new Error('Missing oracle part');
    const angle = id === 'a' ? ORACLE_START_DEG : id === 'b' ? ratio * ORACLE_START_DEG + ORACLE_PHASE_DEG : id === 'c' ? 13 : 0;
    return { id, name: id, source: { kind: 'part', partRef }, placement: at(id, angle), fixed,
      visible: true, suppressed: false };
  });
  const ab = gear('oracle-ab', 'a', 'b', ratio, ORACLE_PHASE_DEG);
  // A closed affine loop: b=r*a+17, c=b, c=r*a+18. Its one-degree contradiction is independent of iteration.
  const couplings = negative === 'contradictory-phase'
    ? [ab, { ...gear('oracle-bc', 'b', 'c', 1, 0), referenceAngleA: ratio * ORACLE_START_DEG + ORACLE_PHASE_DEG },
      gear('oracle-ac', 'a', 'c', ratio, ORACLE_PHASE_DEG + 1)]
    : negative === 'missing-reference' ? [{ ...ab, jointBId: 'absent-joint' }] : [ab];
  const document: AssemblyDocument = { ...createAssemblyDocument(`mechanism-oracle-${String(ratio)}`), components,
    joints: ['a', 'b', 'c'].map(joint), mechanismCouplings: couplings };
  // The writer serializes independently authored invalid input too; the real reader must reject it.
  return writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: SAVED_AT });
}
