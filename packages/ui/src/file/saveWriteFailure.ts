import { pcadWriteDiagnosticOf, type PcadDrawingWriteCode, type PcadWriteDiagnostic, type PcadVersionField } from '@pointercad/io';
import { messageText } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { FileMessage } from '../store/fileSlice.js';
import { hasSaveRecoveryCopy, saveEncodingFailureKey, saveFailureMessageKey } from './saveFailure.js';
import { PcadSaveWorkerError } from './pcadSaveWorker.js';

const FEATURE_KEYS = {
  unresolvedMath: 'file.saveFeature.unresolvedMath',
  mathGeometry: 'file.saveFeature.mathGeometry',
  referenceOrigin: 'file.saveFeature.referenceOrigin',
  canvasRectification: 'file.saveFeature.canvasRectification',
  patternSlots: 'file.saveFeature.patternSlots',
  steelStock: 'file.saveFeature.steelStock',
  beamInputs: 'file.saveFeature.beamInputs',
  cylindricalHole: 'file.saveFeature.cylindricalHole',
  jointOccurrence: 'file.saveFeature.jointOccurrence',
  steelBend: 'file.saveFeature.steelBend',
  extendedConstraints: 'file.saveFeature.extendedConstraints',
  planarHole: 'file.saveFeature.planarHole',
  sketchFaceHoles: 'file.saveFeature.sketchFaceHoles',
  frameJoints: 'file.saveFeature.frameJoints',
  accessorySets: 'file.saveFeature.accessorySets',
  edgeDistanceHole: 'file.saveFeature.edgeDistanceHole',
  sweepShape: 'file.saveFeature.sweepShape',
  surfaceBlend: 'file.saveFeature.surfaceBlend',
  thicken: 'file.saveFeature.thicken',
  sheetConvert: 'file.saveFeature.sheetConvert',
  surfaceOffset: 'file.saveFeature.surfaceOffset',
} as const satisfies Record<PcadVersionField, MessageKey>;

const DRAWING_INPUT_KEYS = {
  drawingNonFinite: 'file.saveDrawingNonFinite',
  drawingTemplateInvalid: 'drawing.template.invalid',
} as const satisfies Record<PcadDrawingWriteCode, MessageKey>;

function writeCause(error: unknown): unknown {
  return error instanceof PcadSaveWorkerError ? error.cause : error;
}

export function drawingSaveInputFailure(error: unknown): FileMessage | undefined {
  const code = pcadWriteDiagnosticOf(writeCause(error))?.code;
  if (code === 'drawingNonFinite' || code === 'drawingTemplateInvalid') return { key: DRAWING_INPUT_KEYS[code], failed: true };
  return undefined;
}

function writeFailure(diagnostic: Extract<PcadWriteDiagnostic, { code: 'internal' | 'requiresVersion' }>, error: unknown): FileMessage {
  if (diagnostic.code === 'internal') {
    if (import.meta.env.DEV) console.error('PointerCAD save encoding', error);
    return { key: 'assembly.error.internal', failed: true };
  }
  const { field, requiredVersion, actualVersion, documentName } = diagnostic;
  const actual = String(actualVersion);
  const document = documentName === ''
    ? messageText({ key: 'file.saveVersionUnnamedDocument', parameters: { actual } })
    : messageText({ key: 'file.saveVersionDocument', parameters: { actual, name: documentName } });
  return { key: 'file.saveRequiresVersion', failed: true,
    parameters: { feature: t(FEATURE_KEYS[field]), required: String(requiredVersion), document } };
}

/** Report one message for either preparation or writing. The Worker can also carry the old message-only reply. */
export function documentSaveFailure(error: unknown, kind?: 'drawing'): FileMessage {
  const cause = writeCause(error);
  const diagnostic = pcadWriteDiagnosticOf(cause);
  if (diagnostic?.code === 'internal' || diagnostic?.code === 'requiresVersion') return writeFailure(diagnostic, cause);
  const drawingInput = drawingSaveInputFailure(error);
  if (drawingInput !== undefined) return drawingInput;
  if (kind === 'drawing' && !hasSaveRecoveryCopy(error) && !(error instanceof PcadSaveWorkerError && error.internal)
    && import.meta.env.DEV) console.error('PointerCAD drawing save', error);
  if (!(error instanceof PcadSaveWorkerError)) return { key: saveFailureMessageKey(error), failed: true };
  const key = saveEncodingFailureKey(error);
  return { key, failed: true, ...(error.internal ? {} : { detail: error.message }) };
}
