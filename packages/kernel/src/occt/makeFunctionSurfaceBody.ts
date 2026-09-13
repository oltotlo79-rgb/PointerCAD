/** Keep every clipped component under one history body, without treating its open faces as material. */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { makeFunctionSurfaceBodies } from './makeFunctionSurfaceBodies.js';
import { makeCompound } from './transformShape.js';
import type { FunctionSurfaceInput } from './functionSurfaceGeometrySpec.js';

export function makeFunctionSurfaceBody(oc: OpenCascadeInstance, input: FunctionSurfaceInput) {
  const { keep, release } = createAllocations();
  try {
    const result = makeFunctionSurfaceBodies(oc, input);
    if (result.status !== 'bodies') throw new Error('指定したXYZ範囲に関数の面がありません。式と範囲を確認してください。');
    keep(result);
    if (result.bodies.length === 0) throw new Error('指定したXYZ範囲に関数の面がありません。式と範囲を確認してください。');
    const shape = result.bodies.length === 1 ? result.bodies[0].shape
      : keep(makeCompound(oc, result.bodies.map(body => body.shape))).shape;
    return { shape, volume: result.bodies.reduce((sum, body) => sum + body.volume, 0),
      area: result.bodies.reduce((sum, body) => sum + body.area, 0), delete: release };
  } catch (error) { release(); throw error; }
}
