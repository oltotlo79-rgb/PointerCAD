import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import * as surfaces from './makeFunctionSurface.js';
import * as classification from './classifyFunctionSurface.js';
import * as documents from './xcafDocument.js';
import * as transforms from './transformShape.js';
import { makeFunctionSurfaceBodies } from './makeFunctionSurfaceBodies.js';
import { writeStepAssembly, type XcafAssemblySpec } from './xcafAssembly.js';
import { makeBox } from './makeBox.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';
import type { FunctionSurfaceGeometrySpec } from './functionSurfaceGeometrySpec.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { vi.restoreAllMocks(); });

const separated: FunctionSurfaceGeometrySpec = {
  vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [3, 0, 0], [4, 0, 0], [3, 1, 0]],
  triangles: [[0, 1, 2], [3, 4, 5]],
  bounds: { minimum: [-1, -1, -1], maximum: [5, 2, 1] },
};

function observeSurface(events: string[]): void {
  const original = surfaces.makeUnclassifiedFunctionSurface;
  vi.spyOn(surfaces, 'makeUnclassifiedFunctionSurface').mockImplementation((...args) => {
    const result = original(...args);
    if (result.status === 'shape') {
      const release = result.delete.bind(result);
      return { ...result, delete: () => { events.push('source'); release(); } };
    }
    return result;
  });
}

function observeBodies(events: string[], failure?: Error): void {
  const original = classification.classifyFunctionSurface;
  vi.spyOn(classification, 'classifyFunctionSurface').mockImplementation((...args) => {
    const result = original(...args);
    if (result.status === 'bodies') {
      const release = result.delete.bind(result);
      return { ...result, delete: () => {
        events.push('bodies'); release();
        if (failure !== undefined) throw failure;
      } };
    }
    return result;
  });
}

describe('function surface owned source and derived bodies', () => {
  it('keeps two real disconnected shells alive until one idempotent release', () => {
    const events: string[] = [];
    observeSurface(events); observeBodies(events);
    const result = makeFunctionSurfaceBodies(oc, separated);
    expect(result.status).toBe('bodies');
    if (result.status !== 'bodies') throw new Error('expected bodies');
    try {
      expect(result.bodies).toHaveLength(2);
      for (const body of result.bodies) {
        expect(isValidShape(oc, body.shape)).toBe(true);
        expect(measureArea(oc, body.shape)).toBeCloseTo(0.5, 8);
      }
      expect(events).toEqual([]);
    } finally { result.delete(); }
    expect(events).toEqual(['bodies', 'source']);
    result.delete();
    expect(events).toEqual(['bodies', 'source']);
  });

  it('releases the real generated source when classification cancels', () => {
    const events: string[] = []; observeSurface(events);
    vi.spyOn(classification, 'classifyFunctionSurface').mockReturnValueOnce({ status: 'cancelled' });
    expect(makeFunctionSurfaceBodies(oc, separated)).toEqual({ status: 'cancelled' });
    expect(events).toEqual(['source']);
  });

  it('releases the real source on an intermediate classification exception', () => {
    const events: string[] = []; observeSurface(events);
    const failure = new Error('classification failure');
    vi.spyOn(classification, 'classifyFunctionSurface').mockImplementationOnce(() => { throw failure; });
    expect(() => makeFunctionSurfaceBodies(oc, separated)).toThrow(failure);
    expect(events).toEqual(['source']);
  });

  it('does not strand the source if derived-body deletion throws after native release', () => {
    const events: string[] = []; const failure = new Error('body release failure');
    observeSurface(events); observeBodies(events, failure);
    const result = makeFunctionSurfaceBodies(oc, separated);
    if (result.status !== 'bodies') throw new Error('expected bodies');
    expect(() => result.delete()).toThrow(failure);
    expect(events).toEqual(['bodies', 'source']);
    expect(() => result.delete()).not.toThrow();
  });

  it('does not classify a pre-cancelled source', () => {
    const classify = vi.spyOn(classification, 'classifyFunctionSurface');
    expect(makeFunctionSurfaceBodies(oc, separated, () => true)).toEqual({ status: 'cancelled' });
    expect(classify).not.toHaveBeenCalled();
  });
});

function assembly(shapes: readonly ReturnType<typeof makeBox>[]): XcafAssemblySpec {
  return {
    name: 'ownership assembly',
    definitions: ['a', 'b'].map((id) => ({
      id, name: id, bodies: shapes.map(({ shape }) => ({ shape, name: null, color: null })),
    })),
    children: ['a', 'b'].map((id) => ({
      kind: 'part', id: `${id}-instance`, name: id, definitionId: id,
      placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    })),
  };
}

function observeAssembly(events: string[], failDocumentDelete = false, secondFailure?: Error): void {
  const makeDocument = documents.createXcafDocumentBuilder;
  vi.spyOn(documents, 'createXcafDocumentBuilder').mockImplementation((...args) => {
    const builder = makeDocument(...args), release = builder.delete.bind(builder);
    builder.delete = () => {
      events.push('document'); release();
      if (failDocumentDelete) throw new Error('document release failure');
    };
    return builder;
  });
  const makeCompound = transforms.makeCompound; let number = 0;
  vi.spyOn(transforms, 'makeCompound').mockImplementation((...args) => {
    const index = ++number;
    if (index === 2 && secondFailure !== undefined) throw secondFailure;
    const compound = makeCompound(...args), release = compound.delete.bind(compound);
    compound.delete = () => { events.push(`compound-${index}`); release(); };
    return compound;
  });
}

describe('XCAF document borrows input shapes and generated compounds', () => {
  it.each([false, true])('closes the document before compounds (delete failure %s)', (failDelete) => {
    const a = makeBox(oc, { dx: 1, dy: 2, dz: 3 });
    const b = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    const events: string[] = []; observeAssembly(events, failDelete);
    try {
      const write = () => writeStepAssembly(oc, assembly([a, b]));
      if (failDelete) expect(write).toThrow('document release failure');
      else expect(new TextDecoder().decode(write().bytes)).toContain('ISO-10303-21;');
      expect(events).toEqual(['document', 'compound-2', 'compound-1']);
      expect(isValidShape(oc, a.shape)).toBe(true);
      expect(measureVolume(oc, b.shape)).toBeCloseTo(24, 8);
    } finally { b.delete(); a.delete(); }
  });

  it('releases a completed first compound when creating the second fails', () => {
    const a = makeBox(oc, { dx: 1, dy: 2, dz: 3 });
    const b = makeBox(oc, { dx: 2, dy: 3, dz: 4 });
    const events: string[] = [];
    const failure = new Error('second compound failure');
    observeAssembly(events, false, failure);
    try {
      expect(() => writeStepAssembly(oc, assembly([a, b]))).toThrow(failure);
      expect(events).toEqual(['document', 'compound-1']);
      expect(measureVolume(oc, a.shape)).toBeCloseTo(6, 8);
      expect(isValidShape(oc, b.shape)).toBe(true);
    } finally { b.delete(); a.delete(); }
  });
});
