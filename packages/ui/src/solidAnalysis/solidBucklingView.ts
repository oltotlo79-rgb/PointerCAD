import type { SolidBucklingInput, SolidBucklingResult, SolidSource } from '@pointercad/fem';
import { sameSolidModeSource, solidModeBoundaryTriangles, type SolidModeDisplay, type SolidModeVector } from './solidModeView.js';

/**
 * Display-only view of one buckling mode of a completed linear prestress buckling result (never saved, never a new
 * analysis). A buckling eigenvector has no physical amplitude: the solver scales it to a largest nodal translation of
 * exactly 1 (dimensionless). It is therefore never shown as a displacement and never related to the load factor. Each
 * mode is divided by its own largest nodal vector length (recomputed here, not trusted) and multiplied by an explicitly
 * labelled display amplitude in mm with a phase sign. The geometry is the analysed reference mesh of the SAME request:
 * `reference.nodes[i]`, the restraint of node i and shape row i belong to the same node.
 */
export type SolidBucklingNoPreviewReason = 'stale' | 'mode' | 'amplitude' | 'mesh' | 'shape';
export type SolidBucklingPreview =
  | {
    readonly kind: 'preview';
    readonly source: SolidSource;
    readonly modeNumber: number;
    /** Dimensionless multiplier of the whole reference load set (shown as-is; not an allowable load or a safety factor). */
    readonly loadFactor: number;
    readonly amplitudeMm: number;
    readonly phase: 1 | -1;
    /** Displaced position of every node in mm (display only). */
    readonly nodePositions: readonly SolidModeVector[];
    /** xyz per boundary-triangle corner in mm, same face order and orientation as the modal preview. */
    readonly positions: readonly number[];
    readonly triangleElements: readonly number[];
  }
  | { readonly kind: 'none'; readonly reason: SolidBucklingNoPreviewReason };

const none = (reason: SolidBucklingNoPreviewReason): SolidBucklingPreview => ({ kind: 'none', reason });
const finite = (value: readonly number[] | undefined): value is SolidModeVector =>
  value !== undefined && value.length === 3 && value.every(component => Number.isFinite(component));

/** Restrained x/y/z components per node of the reference input (a restrained component is drawn at its coordinate). */
export function solidBucklingRestraints(input: SolidBucklingInput): readonly (readonly [boolean, boolean, boolean])[] | null {
  const rows = input.reference.nodes.map((): [boolean, boolean, boolean] => [false, false, false]);
  for (const constraint of input.reference.constraints) {
    const row = rows.at(constraint.node);
    if (!Number.isInteger(constraint.node) || constraint.node < 0 || row === undefined) return null;
    for (const axis of [0, 1, 2] as const) row[axis] = row[axis] || constraint.fixed[axis];
  }
  return rows;
}

/**
 * Pure display projection. `none` (the caller clears the drawing) for a result of another document, revision or mesh
 * than the request or the current source; an unknown mode; a nonfinite or negative amplitude or a bad phase; shapes
 * that do not match the reference nodes; or an all-zero or nonfinite shape. Inputs are never mutated.
 */
export function projectSolidBucklingMode(input: SolidBucklingInput, result: SolidBucklingResult, current: SolidSource,
  display: SolidModeDisplay): SolidBucklingPreview {
  if (!sameSolidModeSource(result.source, input.reference.source) || !sameSolidModeSource(result.source, current)) return none('stale');
  const matches = result.modes.filter(mode => mode.number === display.modeNumber);
  if (matches.length !== 1) return none('mode');
  if (!Number.isFinite(display.amplitudeMm) || display.amplitudeMm < 0 || (display.phase !== 1 && display.phase !== -1)) return none('amplitude');
  const mode = matches[0], nodes = input.reference.nodes, shape = mode.shape;
  const restraints = solidBucklingRestraints(input);
  if (restraints === null || nodes.length === 0 || shape.length !== nodes.length || !nodes.every(finite)) return none('mesh');
  if (!shape.every(finite)) return none('shape');
  const largest = shape.reduce((maximum, vector) => Math.max(maximum, Math.hypot(vector[0], vector[1], vector[2])), 0);
  if (!(largest > 0) || !Number.isFinite(largest)) return none('shape');
  const boundary = solidModeBoundaryTriangles(input.reference.elements, nodes.length);
  if (boundary === null || boundary.triangleElements.length === 0) return none('mesh');
  const factor = display.phase * display.amplitudeMm / largest;
  const nodePositions = nodes.map((point, node): SolidModeVector => {
    const vector = shape[node], restrained = restraints[node];
    const moved = (axis: 0 | 1 | 2): number => restrained[axis] ? point[axis] : point[axis] + factor * vector[axis];
    return [moved(0), moved(1), moved(2)];
  });
  const positions: number[] = [];
  for (const node of boundary.corners) positions.push(...nodePositions[node]);
  if (positions.some(value => !Number.isFinite(value))) return none('shape');
  return { kind: 'preview', source: result.source, modeNumber: mode.number, loadFactor: mode.loadFactor,
    amplitudeMm: display.amplitudeMm, phase: display.phase, nodePositions, positions, triangleElements: boundary.triangleElements };
}
