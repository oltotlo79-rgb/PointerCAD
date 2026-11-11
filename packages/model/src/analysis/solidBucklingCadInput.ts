import { fields, InputIssue, number, text } from './analysisValidation.js';
import { readSolidCadSavedInput, type SolidCadSavedInput } from './solidCadInput.js';

/**
 * Saved linear prestress buckling input of one CAD solid (at most one per document). The reference load state is a
 * complete static CAD input (body, restrained and loaded faces, the one surface load, E, nu, meshing tolerances) read by
 * the static reader itself, so it can never hold a field the static analysis would refuse. Only the number of requested
 * load factors is added; meshes, load factors, shapes and display choices are never persisted.
 */
export const SOLID_BUCKLING_CAD_SCHEMA = 'pointercad-solid-buckling-cad-input/1';
/** Same bound as the FEM contract (SOLID_BUCKLING_MAX_MODES); model cannot import fem, a ui test pins the equality. */
export const SOLID_BUCKLING_CAD_MAX_MODES = 12;
export interface SolidBucklingCadSavedInput {
  readonly schema: typeof SOLID_BUCKLING_CAD_SCHEMA;
  readonly id: 'solid-buckling-cad';
  readonly source: { readonly documentId: string };
  readonly modeCount: number;
  readonly reference: SolidCadSavedInput;
}

export function readSolidBucklingCadSavedInput(value: unknown, path = 'solid-buckling-cad'): SolidBucklingCadSavedInput {
  const row = fields(value, ['schema', 'id', 'source', 'modeCount', 'reference'], path);
  if (row.schema !== SOLID_BUCKLING_CAD_SCHEMA || row.id !== 'solid-buckling-cad')
    throw new InputIssue('unsupported-schema', path, 'Unsupported solid buckling input version');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  const modeCount = number(row.modeCount, `${path}.modeCount`);
  if (!Number.isInteger(modeCount) || modeCount < 1 || modeCount > SOLID_BUCKLING_CAD_MAX_MODES)
    throw new InputIssue('invalid-input', path, `Load factor count must be 1 to ${String(SOLID_BUCKLING_CAD_MAX_MODES)}`);
  const reference = readSolidCadSavedInput(row.reference, `${path}.reference`);
  if (reference.source.documentId !== documentId)
    throw new InputIssue('wrong-document', `${path}.reference.source.documentId`, 'Reference load belongs to a different document');
  return { schema: SOLID_BUCKLING_CAD_SCHEMA, id: 'solid-buckling-cad', source: { documentId }, modeCount, reference };
}
