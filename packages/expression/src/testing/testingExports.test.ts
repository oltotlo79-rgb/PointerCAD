import { describe, expect, it } from 'vitest';
import { smoothFunctionCurve, sameMathMeaning, type FunctionCurveSample } from './geometry.testSupport.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntime.testSupport.js';
import { smoothFunctionCurve as sourceSmooth } from '../math/smoothFunctionCurve.js';
import { sameMathMeaning as sourceMeaning } from '../math/mathNotationConversion.js';
import { exactRuntimeBatch as sourceBatch, sharedExactEngine as sourceEngine } from '../math/exactRuntime.testSupport.js';
import type { FunctionCurveSample as SourceSample } from '../math/adaptiveFunctionCurve.js';

describe('explicit expression testing entry points', () => {
  it('re-exports the original geometry/notation functions and sample type', () => {
    expect(smoothFunctionCurve).toBe(sourceSmooth);
    expect(sameMathMeaning).toBe(sourceMeaning);
    const sample: FunctionCurveSample = { parameter: 0, point: [1, 2, 3] };
    const original: SourceSample = sample;
    expect(original).toBe(sample);
  });

  it('retains the original counted runtime harness without launching another engine', () => {
    expect(exactRuntimeBatch).toBe(sourceBatch);
    expect(sharedExactEngine).toBe(sourceEngine);
  });
});
