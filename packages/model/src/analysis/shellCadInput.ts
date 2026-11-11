import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { fields, InputIssue, list, number, text } from './analysisValidation.js';
import { solidCadFaceKey } from './solidCadInput.js';

/**
 * Saved idealization of a thin CAD sheet for a shell analysis: exactly the three user inputs.
 * - midsurfaceFaces: the explicit midsurface, as solidCadFaceKey keys of the faces of one current CAD shell
 *   (sheet) body. A solid's midsurface is never inferred: the analysis refuses a face of a solid.
 * - thicknessMm: the plate thickness, finite and greater than 0. There is no default thickness.
 * - offsetMm: signed distance along the referenced face's oriented normal (its native triangle winding, the
 *   shell's top side) from the referenced faces to the analysis midsurface. 0 means the referenced faces are the
 *   midsurface. This is the same convention as the element offsetMm of the fem ShellAnalysisInput.
 * Same persistence rules as solidCadInput.ts: only semantic face-origin keys and user inputs are saved; mesh,
 * runtime indices, normals, materials, supports, loads and results are never persisted here. The reader never
 * supplies a value: the default offset 0 is given only when an input is created (createShellCadSavedInput).
 */
export const SHELL_CAD_SCHEMA = 'pointercad-shell-cad-input/1';
export const SHELL_CAD_LIMITS = { maximumFaces: 2048, maximumKeyLength: 16384 } as const;
export interface ShellCadSavedInput {
  readonly schema: typeof SHELL_CAD_SCHEMA;
  readonly id: 'shell-cad';
  readonly source: { readonly documentId: string };
  readonly bodyFeatureId: string;
  readonly midsurfaceFaces: readonly string[];
  readonly thicknessMm: number;
  readonly offsetMm: number;
}
const SHELL_CAD_FIELDS = ['schema', 'id', 'source', 'bodyFeatureId', 'midsurfaceFaces', 'thicknessMm', 'offsetMm'] as const;

/** Exactly the seven fields; unknown versions, extra or missing fields and non-finite values are refused with an
 * InputIssue (the same codes as readSolidCadSavedInput). The value read is never modified and the result owns its array. */
export function readShellCadInput(value: unknown, path = 'shell-cad'): ShellCadSavedInput {
  const row = fields(value, SHELL_CAD_FIELDS, path);
  if (row.schema !== SHELL_CAD_SCHEMA || row.id !== 'shell-cad')
    throw new InputIssue('unsupported-schema', path, 'Unsupported shell CAD input version');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const faces = row.midsurfaceFaces;
  if (Array.isArray(faces) && faces.length <= SHELL_CAD_LIMITS.maximumFaces) {
    for (let index = 0; index < faces.length; index++) if (!Object.hasOwn(faces, index))
      throw new InputIssue('invalid-input', path, 'Sparse face keys are not supported');
    if (Reflect.ownKeys(faces).length !== faces.length + 1)
      throw new InputIssue('invalid-input', path, 'Unexpected face-key property');
  }
  const midsurfaceFaces = list(faces, `${path}.midsurfaceFaces`, SHELL_CAD_LIMITS.maximumFaces,
    (entry, itemPath) => text(entry, itemPath, SHELL_CAD_LIMITS.maximumKeyLength));
  if (midsurfaceFaces.length === 0 || new Set(midsurfaceFaces).size !== midsurfaceFaces.length)
    throw new InputIssue('invalid-input', path, 'Select unique persistent midsurface faces');
  const thicknessMm = number(row.thicknessMm, `${path}.thicknessMm`);
  if (!(thicknessMm > 0)) throw new InputIssue('invalid-input', path, 'A shell thickness greater than 0 mm is required');
  const offsetMm = number(row.offsetMm, `${path}.offsetMm`);
  return { schema: SHELL_CAD_SCHEMA, id: 'shell-cad',
    source: { documentId: text(source.documentId, `${path}.source.documentId`) },
    bodyFeatureId: text(row.bodyFeatureId, `${path}.bodyFeatureId`), midsurfaceFaces, thicknessMm, offsetMm };
}

export interface ShellCadSavedInputRequest {
  readonly documentId: string;
  readonly bodyFeatureId: string;
  /** The faces the user selected as the midsurface; each needs a persistent face origin of this body. */
  readonly faces: readonly SubShapeRef[];
  readonly thicknessMm: number;
  /** Omitted means 0: the selected faces are the midsurface. */
  readonly offsetMm?: number;
}

/** Saved keys are generated with solidCadFaceKey (semantic origin, never an index, fingerprint or orientation). */
export function createShellCadSavedInput(request: ShellCadSavedInputRequest, path = 'shell-cad'): ShellCadSavedInput {
  const midsurfaceFaces = request.faces.map((reference, index) => {
    const itemPath = `${path}.midsurfaceFaces[${index}]`;
    if (reference.bodyFeatureId !== request.bodyFeatureId)
      throw new InputIssue('invalid-input', itemPath, 'Midsurface faces must belong to the selected body');
    if (reference.fingerprint.kind !== 'face' || reference.origin?.shapeKind !== 'face')
      throw new InputIssue('invalid-input', itemPath, 'A persistent face origin is required');
    return solidCadFaceKey(reference);
  });
  return readShellCadInput({ schema: SHELL_CAD_SCHEMA, id: 'shell-cad', source: { documentId: request.documentId },
    bodyFeatureId: request.bodyFeatureId, midsurfaceFaces, thicknessMm: request.thicknessMm,
    offsetMm: request.offsetMm ?? 0 }, path);
}
