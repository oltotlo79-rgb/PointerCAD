import { plainText, type FailureText } from '../failureText.js';
import type { SketchFaceFailure } from '../kernelBridge/sketchContracts.js';
import type { SketchError } from './types.js';

export function sketchConstraintText(
  name: string,
  parameters: FailureText['parameters'] = {},
): FailureText {
  return { key: 'partError.sketchConstraint.' + name, parameters };
}

/** Keep rendering depth logarithmic for long partner and conflict lists. */
export function joinSketchText(
  values: readonly (string | FailureText)[],
  separator: 'join' | 'joinNames' | 'joinPartners' | 'joinSummary',
): FailureText {
  if (values.length < 2) {
    const value = values[0] ?? '';
    return typeof value === 'string' ? sketchConstraintText('literal', { value }) : value;
  }
  const middle = Math.floor(values.length / 2);
  return sketchConstraintText(separator, {
    first: joinSketchText(values.slice(0, middle), separator),
    next: joinSketchText(values.slice(middle), separator),
  });
}

const INTERNAL_SKETCH_TEXT: FailureText = { key: 'assembly.error.internal', parameters: {} };
type SketchGeometryOperation = 'face' | 'offset';
const SHARED_HOLE_REASON_KEYS = {
  holeNotPlanar: 'partError.sketchFaceHole.notSamePlane',
  holeOutside: 'partError.sketchFaceHole.outsideOuter',
  holeNested: 'partError.sketchFaceHole.nested',
} as const;

export function sketchKernelFailure(operation: SketchGeometryOperation, failure: SketchFaceFailure): SketchError {
  const { featureId, code, reason } = failure;
  if (reason?.code === 'internal') return { featureId, code: 'kernelFailed', text: INTERNAL_SKETCH_TEXT };
  let text: FailureText;
  if (code === 'workerBroken') {
    text = { key: 'partError.sketchKernel.workerBroken', parameters: {} };
  } else if (reason === undefined) {
    text = plainText(failure.message); // Compatibility for message-only Worker replies.
  } else if (reason.code === 'holeNotPlanar' || reason.code === 'holeOutside' || reason.code === 'holeNested') {
    text = { key: SHARED_HOLE_REASON_KEYS[reason.code], parameters: {
      label: { key: 'partError.sketchKernel.holeLabel', parameters: { index: reason.index } },
    } };
  } else {
    const { code: reasonCode, ...parameters } = reason;
    text = { key: 'partError.sketchKernel.' + reasonCode, parameters };
  }
  return { featureId, code: code ?? 'kernelFailed', text: {
    key: 'partError.sketchKernel.' + operation, parameters: { reason: text },
  } };
}

/** A whole request rejected. Record the original value once, even for a batch of features. */
export function internalSketchFailures(
  operation: SketchGeometryOperation,
  items: readonly { readonly featureId: string }[],
  error: unknown,
): SketchError[] {
  console.error('PointerCAD sketch geometry', operation, error);
  return items.map(({ featureId }) => ({ featureId, code: 'kernelFailed', text: INTERNAL_SKETCH_TEXT }));
}
