import { InputIssue, readSolidContactInput, SOLID_CONTACT_LIMITS, solidCadFaceKey,
  type SolidContactMethod, type SolidContactNormal, type SolidContactSavedInput, type Vector3 } from '@pointercad/model/beam-analysis';
import type { CadAnalysisBoundaryIdentity, CadBoundaryFaceIdentity } from './cadTetraMesh.js';

/** Each index belongs to that body's oriented boundary mesh, not to volume elements or another body's mesh.
 * The caller must supply the current W05 identity and the corresponding triangle count in one coordinate frame.
 * Repeated occurrences of the same body need a future occurrence-aware identity; ambiguous keys are refused. */
interface SolidContactMeshBoundary {
  readonly boundaryIdentity: CadAnalysisBoundaryIdentity;
  readonly triangleCount: number;
}
interface SolidContactMeshContext {
  readonly documentId: string;
  readonly boundaries: readonly SolidContactMeshBoundary[];
  /** Assembly constraints are deliberately outside the physical contact definition. Never inspected. */
  readonly mates?: readonly unknown[];
}
export interface SolidContactPlanFace {
  readonly bodyFeatureId: string;
  readonly faceKey: string;
  readonly triangleIndices: readonly number[];
}
export interface SolidContactPlanPair {
  readonly id: string;
  readonly master: SolidContactPlanFace;
  readonly slave: SolidContactPlanFace;
  readonly normal: SolidContactNormal;
  /** One resolved direction for each master triangle, in the same order as master.triangleIndices.
   * Curved-face outward normals remain separate; an explicit direction is repeated without normalization. */
  readonly masterNormals: readonly Vector3[];
  readonly gapMm: number;
  readonly frictionCoefficient: number | null;
  readonly frictionSourceId: string | null;
  readonly method: SolidContactMethod;
}
export interface SolidContactPlan {
  readonly documentId: string;
  readonly contacts: readonly SolidContactPlanPair[];
}
interface BoundFace {
  readonly boundary: SolidContactMeshBoundary;
  readonly face: CadBoundaryFaceIdentity;
}

function finiteVector(value: readonly number[]): value is Vector3 {
  return Array.isArray(value) && value.length === 3
    && [0, 1, 2].every(axis => Object.hasOwn(value, axis) && Number.isFinite(value[axis]));
}
const copyVector = (value: Vector3): Vector3 => [value[0], value[1], value[2]];

function resolveFace(bound: BoundFace, path: string): { face: SolidContactPlanFace; normals: Vector3[] } {
  const { boundary, face } = bound, identity = boundary.boundaryIdentity;
  if (identity.outward !== true) throw new InputIssue('contact-boundary', path, 'W05 outward boundary evidence is required');
  let currentKey: string;
  try { currentKey = solidCadFaceKey(face.reference); }
  catch { throw new InputIssue('contact-face-identity', path, 'The mesh face requires a persistent face origin'); }
  if (currentKey !== face.key || face.reference.bodyFeatureId !== identity.bodyFeatureId) {
    throw new InputIssue('contact-face-identity', path, 'The semantic face key and body must match the W05 reference');
  }
  if (!Number.isSafeInteger(boundary.triangleCount) || boundary.triangleCount < 1
    || face.samples.length === 0 || face.samples.length > boundary.triangleCount) {
    throw new InputIssue('contact-triangles', path, 'A face needs triangles in the declared boundary mesh');
  }
  const indices: number[] = [], normals: Vector3[] = [], seen = new Set<number>();
  for (let index = 0; index < face.samples.length; index++) {
    const sample = face.samples[index], samplePath = `${path}.samples[${index}]`;
    if (sample === undefined || !Number.isSafeInteger(sample.triangleIndex) || sample.triangleIndex < 0
      || sample.triangleIndex >= boundary.triangleCount || seen.has(sample.triangleIndex)) {
      throw new InputIssue('contact-triangles', samplePath, 'Expected a unique existing boundary triangle');
    }
    if (!finiteVector(sample.point) || !finiteVector(sample.normal)
      || Math.abs(Math.hypot(...sample.normal) - 1) > SOLID_CONTACT_LIMITS.unitNormalTolerance) {
      throw new InputIssue('contact-boundary-normal', samplePath, 'Expected a finite sample point and outward unit normal');
    }
    seen.add(sample.triangleIndex); indices.push(sample.triangleIndex); normals.push(copyVector(sample.normal));
  }
  return { face: { bodyFeatureId: identity.bodyFeatureId, faceKey: face.key, triangleIndices: indices }, normals };
}

/** Pure planning, with no native execution, search, projection or mate-derived defaults.
 * Undefined saved input (a document containing just CAD mates) yields zero physical contacts.
 * W05 indices and normals are boundary evidence, not an FE volume-face binding or a convergence certificate. */
export function buildSolidContactPlan(savedInput: SolidContactSavedInput | undefined,
  context: SolidContactMeshContext, path = 'solid-contact'): SolidContactPlan {
  if (savedInput === undefined) return { documentId: context.documentId, contacts: [] };
  const saved = readSolidContactInput(savedInput, path);
  if (saved.source.documentId !== context.documentId) {
    throw new InputIssue('contact-document', `${path}.source.documentId`, 'Contact definitions belong to a different document');
  }
  if (saved.contacts.length === 0) return { documentId: context.documentId, contacts: [] };
  const faces = new Map<string, BoundFace>();
  for (let index = 0; index < context.boundaries.length; index++) {
    const boundary = context.boundaries[index], boundaryPath = `${path}.boundaries[${index}]`;
    if (boundary === undefined || boundary.boundaryIdentity.documentId !== context.documentId) {
      throw new InputIssue('contact-document', boundaryPath, 'Every mesh boundary must belong to the contact document');
    }
    const owners = new Map<number, string>();
    for (const face of boundary.boundaryIdentity.faces) {
      if (face === undefined) throw new InputIssue('contact-face-identity', boundaryPath, 'Boundary faces must form a dense list');
      if (faces.has(face.key)) {
        throw new InputIssue('contact-face-ambiguous', boundaryPath, 'A semantic face must resolve to exactly one current mesh face');
      }
      faces.set(face.key, { boundary, face });
      for (const sample of face.samples) {
        if (sample === undefined) throw new InputIssue('contact-triangles', boundaryPath, 'Boundary samples must form a dense list');
        const owner = owners.get(sample.triangleIndex);
        if (owner !== undefined && owner !== face.key) {
          throw new InputIssue('contact-triangles', boundaryPath, 'A boundary triangle cannot belong to different semantic faces');
        }
        owners.set(sample.triangleIndex, face.key);
      }
    }
  }
  const contacts = saved.contacts.map((pair, index): SolidContactPlanPair => {
    const itemPath = `${path}.contacts[${index}]`;
    const resolve = (key: string, side: 'masterFace' | 'slaveFace') => {
      const bound = faces.get(key);
      if (bound === undefined) throw new InputIssue('contact-face-missing', `${itemPath}.${side}`, 'Saved face has no current boundary triangles');
      return resolveFace(bound, `${itemPath}.${side}`);
    };
    const master = resolve(pair.masterFace, 'masterFace'), slave = resolve(pair.slaveFace, 'slaveFace');
    const normal = pair.normal;
    return { id: pair.id, master: master.face, slave: slave.face, normal,
      masterNormals: normal.kind === 'explicit' ? master.face.triangleIndices.map(() => copyVector(normal.vector)) : master.normals,
      gapMm: pair.gapMm, frictionCoefficient: pair.frictionCoefficient, frictionSourceId: pair.frictionSourceId, method: pair.method };
  });
  return { documentId: context.documentId, contacts };
}
