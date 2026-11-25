type FunctionSamplingInputCode = 'worldRange' | 'parameterRange' | 'tolerance' | 'subdivisionLimit';

/** Preserve the public RangeError contract while identifying which option failed validation. */
export class FunctionSamplingInputError extends RangeError {
  constructor(readonly code: FunctionSamplingInputCode, message: string) {
    super(message);
  }
}
