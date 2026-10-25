/**
 * Display-only view of one completed Tet4 modal result (never saved, never a new analysis, no solver validation here).
 * A mass-normalised eigenvector (phi^T M phi = 1 with M in t, units 1/sqrt(t)) has no physical amplitude: a free vibration of that shape
 * can have any size. It is therefore never shown as a displacement. Each mode is divided by its largest nodal vector
 * length and multiplied by an explicitly labelled display amplitude in mm, with a phase sign (+1 or -1).
 * Indices are those of the analysed mesh: `nodes[i]`, `fixed[i]` and every shape row `i` belong to the same node.
 */
export type SolidModeVector = readonly [number, number, number];

/** Which document, revision and analysed mesh the result was computed for. */
export interface SolidModeSource {
  readonly documentId: string;
  readonly revision: number;
  readonly meshKey: string;
}

export interface SolidModeEntry {
  readonly number: number;
  readonly frequencyHz: number;
  readonly normalizedResidual: number;
  /** Mass-normalised mode shape per node (1/sqrt(t)); NOT a physical displacement. */
  readonly massNormalizedShapePerSqrtT: readonly SolidModeVector[];
}

export interface SolidModeResult {
  readonly source: SolidModeSource;
  readonly nodes: readonly SolidModeVector[];
  readonly elements: readonly { readonly nodes: readonly [number, number, number, number] }[];
  /** Restrained x/y/z components per node; a restrained component is drawn at its original coordinate. */
  readonly fixed: readonly (readonly [boolean, boolean, boolean])[];
  readonly modes: readonly SolidModeEntry[];
}

export type SolidModePhase = 1 | -1;

/** The user's display choice. Changing it never changes the result or any saved input. */
export interface SolidModeDisplay {
  readonly modeNumber: number;
  readonly amplitudeMm: number;
  readonly phase: SolidModePhase;
}

export type SolidModeNoPreviewReason = 'stale' | 'mode' | 'amplitude' | 'mesh' | 'shape';

export type SolidModePreview =
  | {
    readonly kind: 'preview';
    readonly source: SolidModeSource;
    readonly modeNumber: number;
    readonly frequencyHz: number;
    readonly amplitudeMm: number;
    readonly phase: SolidModePhase;
    /** Displaced position of every node in mm (display only). */
    readonly nodePositions: readonly SolidModeVector[];
    /** xyz per boundary-triangle corner in mm, same face order and orientation as buildSolidFieldMesh. */
    readonly positions: readonly number[];
    /** Owning element of each boundary triangle. */
    readonly triangleElements: readonly number[];
  }
  | { readonly kind: 'none'; readonly reason: SolidModeNoPreviewReason };

const none = (reason: SolidModeNoPreviewReason): SolidModePreview => ({ kind: 'none', reason });
const finiteVector = (value: SolidModeVector | undefined): value is SolidModeVector =>
  value !== undefined && value.length === 3 && value.every(component => Number.isFinite(component));

export function sameSolidModeSource(left: SolidModeSource, right: SolidModeSource): boolean {
  return left.documentId === right.documentId && left.revision === right.revision && left.meshKey === right.meshKey;
}

/**
 * Boundary triangles (faces used by exactly one tetrahedron) of the analysed connectivity, used as-is: the same face
 * corners and orientation as buildSolidFieldMesh (solidFieldView.ts), no remeshing. Null for an out-of-range node.
 */
export function solidModeBoundaryTriangles(elements: SolidModeResult['elements'], nodeCount: number):
  { readonly corners: readonly number[]; readonly triangleElements: readonly number[] } | null {
  const faces = new Map<string, { readonly element: number; readonly corners: readonly [number, number, number] } | null>();
  for (const [index, element] of elements.entries()) {
    if (element.nodes.length !== 4 || element.nodes.some(node => !Number.isInteger(node) || node < 0 || node >= nodeCount)) return null;
    const [a, b, c, d] = element.nodes;
    for (const corners of [[a, c, b], [a, b, d], [a, d, c], [b, c, d]] as const) {
      const key = [...corners].sort((left, right) => left - right).join(',');
      faces.set(key, faces.has(key) ? null : { element: index, corners });
    }
  }
  const corners: number[] = [], triangleElements: number[] = [];
  for (const face of faces.values()) {
    if (face === null) continue;
    corners.push(...face.corners);
    triangleElements.push(face.element);
  }
  return { corners, triangleElements };
}

/**
 * Pure display projection. Returns `none` (the caller clears the preview) for a result of another document, revision
 * or mesh; an unknown mode; a nonfinite or negative amplitude; arrays that do not match the nodes; or an all-zero or
 * nonfinite shape. Inputs are never mutated.
 */
export function projectSolidMode(result: SolidModeResult, current: SolidModeSource, display: SolidModeDisplay): SolidModePreview {
  if (!sameSolidModeSource(result.source, current)) return none('stale');
  const matches = result.modes.filter(mode => mode.number === display.modeNumber);
  if (matches.length !== 1) return none('mode');
  if (!Number.isFinite(display.amplitudeMm) || display.amplitudeMm < 0 || (display.phase !== 1 && display.phase !== -1)) return none('amplitude');
  const mode = matches[0];
  const { nodes, fixed } = result;
  const shape = mode.massNormalizedShapePerSqrtT;
  if (nodes.length === 0 || shape.length !== nodes.length || fixed.length !== nodes.length
    || !nodes.every(finiteVector) || fixed.some(row => row.length !== 3)) return none('mesh');
  if (!shape.every(finiteVector)) return none('shape');
  const largest = shape.reduce((maximum, vector) => Math.max(maximum, Math.hypot(vector[0], vector[1], vector[2])), 0);
  if (!(largest > 0) || !Number.isFinite(largest)) return none('shape');
  const boundary = solidModeBoundaryTriangles(result.elements, nodes.length);
  if (boundary === null || boundary.triangleElements.length === 0) return none('mesh');
  const factor = display.phase * display.amplitudeMm / largest;
  const nodePositions = nodes.map((point, node): SolidModeVector => {
    const vector = shape[node], restrained = fixed[node];
    const moved = (axis: 0 | 1 | 2): number => restrained[axis] ? point[axis] : point[axis] + factor * vector[axis];
    return [moved(0), moved(1), moved(2)];
  });
  const positions: number[] = [];
  for (const node of boundary.corners) positions.push(...nodePositions[node]);
  if (positions.some(value => !Number.isFinite(value))) return none('shape');
  return {
    kind: 'preview', source: result.source, modeNumber: mode.number, frequencyHz: mode.frequencyHz,
    amplitudeMm: display.amplitudeMm, phase: display.phase, nodePositions, positions, triangleElements: boundary.triangleElements,
  };
}
