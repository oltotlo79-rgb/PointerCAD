import { PcadWriteError, type PcadVersionField } from '@pointercad/io';
import { messageText } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { FileMessage } from '../store/fileSlice.js';
import { saveEncodingFailureKey, saveFailureMessageKey } from './saveFailure.js';
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

function writeFailure(error: PcadWriteError): FileMessage {
  const diagnostic = error.diagnostic;
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
export function documentSaveFailure(error: unknown): FileMessage {
  if (error instanceof PcadWriteError) return writeFailure(error);
  if (!(error instanceof PcadSaveWorkerError)) return { key: saveFailureMessageKey(error), failed: true };
  if (error.cause instanceof PcadWriteError) return writeFailure(error.cause);
  const key = saveEncodingFailureKey(error);
  return { key, failed: true, ...(error.internal ? {} : { detail: error.message }) };
}
