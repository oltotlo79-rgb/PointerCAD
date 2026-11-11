/** One owner for generated faces and all derived open/closed components. */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { makeUnclassifiedFunctionSurface } from './makeFunctionSurface.js';
import { classifyFunctionSurface, type FunctionSurfaceBodies } from './classifyFunctionSurface.js';
import type { FunctionSurfaceInput } from './functionSurfaceGeometrySpec.js';

export function makeFunctionSurfaceBodies(oc: OpenCascadeInstance, input: FunctionSurfaceInput,
  isCancelled: () => boolean = () => false): FunctionSurfaceBodies | { readonly status: 'empty' } {
  const started = performance.now();
  console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'faces', event: 'start' }));
  const source = makeUnclassifiedFunctionSurface(oc, input, isCancelled);
  console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'faces', elapsedMs: performance.now() - started }));
  if (source.status !== 'shape') return source;
  const owner = createAllocations();
  owner.keep(source);
  try {
    const classifyStarted = performance.now();
    const result = classifyFunctionSurface(oc, source.shape, isCancelled, source.projection);
    if (result.status === 'bodies') owner.keep(result);
    console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'classify', elapsedMs: performance.now() - classifyStarted }));
    if (result.status === 'cancelled') { owner.release(); return result; }
    return { ...result, delete: owner.release };
  } catch (error) { owner.release(); throw error; }
}
