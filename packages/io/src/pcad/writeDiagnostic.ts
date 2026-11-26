/** Reasons for refusing to write data under an older .pcad schema. */
const REQUIRED_VERSION = {
  unresolvedMath: 16,
  mathGeometry: 17,
  referenceOrigin: 18,
  canvasRectification: 18,
  patternSlots: 18,
  steelStock: 19,
  beamInputs: 20,
  cylindricalHole: 20,
  jointOccurrence: 21,
  steelBend: 22,
  extendedConstraints: 22,
  planarHole: 22,
  sketchFaceHoles: 23,
  frameJoints: 23,
  accessorySets: 23,
  edgeDistanceHole: 24,
  sweepShape: 24,
  surfaceBlend: 24,
  thicken: 24,
  sheetConvert: 24,
  surfaceOffset: 24,
} as const;

export type PcadVersionField = keyof typeof REQUIRED_VERSION;
export type PcadWriteDiagnostic =
  | { readonly code: 'requiresVersion'; readonly field: PcadVersionField; readonly requiredVersion: number;
      readonly actualVersion: number; readonly documentName: string }
  | { readonly code: 'internal'; readonly field: string; readonly location?: string };

/** The original RangeError message remains available to callers and diagnostics. */
export class PcadWriteError extends RangeError {
  declare readonly diagnostic: PcadWriteDiagnostic;

  constructor(diagnostic: PcadWriteDiagnostic, message: string) {
    super(message);
    // Keep the RangeError's enumerable shape for callers comparing the original error.
    Object.defineProperty(this, 'diagnostic', {
      value: diagnostic,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

export function pcadVersionError(field: PcadVersionField,
  document: { readonly schemaVersion: number; readonly name: string | null }, message: string): PcadWriteError {
  return new PcadWriteError({ code: 'requiresVersion', field, requiredVersion: REQUIRED_VERSION[field],
    actualVersion: document.schemaVersion, documentName: document.name ?? '' }, message);
}

function isVersionField(value: unknown): value is PcadVersionField {
  return typeof value === 'string' && Object.hasOwn(REQUIRED_VERSION, value);
}

/** Validate plain data received from the save Worker, before using it to select a message. */
export function isPcadWriteDiagnostic(value: unknown): value is PcadWriteDiagnostic {
  if (typeof value !== 'object' || value === null || !('code' in value) || !('field' in value)) return false;
  if (value.code === 'internal') return typeof value.field === 'string'
    && (!('location' in value) || typeof value.location === 'string');
  return value.code === 'requiresVersion' && isVersionField(value.field)
    && 'requiredVersion' in value && value.requiredVersion === REQUIRED_VERSION[value.field]
    && 'actualVersion' in value && typeof value.actualVersion === 'number'
    && 'documentName' in value && typeof value.documentName === 'string';
}
