import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as allocations from './allocations.js';
import * as analytic from './makeAnalyticFunctionSurface.js';
import * as booleanModule from './booleanOp.js';
import * as mesh from './solidMesh.js';
import { editSolidFace } from './editSolidFace.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { makeSurfaceCut } from './makeSurfaceCut.js';
import { makeFunctionSurface } from './makeFunctionSurface.js';
import { readStl } from './readStl.js';
import { readStep } from './readStep.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

function observe() {
  const create = allocations.createAllocations;
  const entries: { item: allocations.OcctDeletable; deletes: number }[] = [];
  vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocations.OcctDeletable>(item: T): T {
      const entry = { item, deletes: 0 }, original = item.delete.bind(item);
      entries.push(entry);
      item.delete = () => { entry.deletes += 1; original(); };
      return group.keep(item);
    } };
  });
  return entries;
}

function oneTriangle(): Uint8Array {
  const bytes = new Uint8Array(134), view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  const values = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  values.forEach((value, index) => view.setFloat32(84 + 4 * index, value, true));
  return bytes;
}

describe('mixed P18 native ownership failures', () => {
  it('frees the STEP document if the owning handle constructor fails', () => {
    const Document = oc.TDocStd_Document;
    let created = 0, deleted = 0;
    vi.spyOn(oc, 'TDocStd_Document').mockImplementation(function (...args: ConstructorParameters<typeof Document>) {
      const doc = new Document(...args), original = doc.delete.bind(doc);
      created += 1;
      doc.delete = () => { deleted += 1; original(); };
      return doc;
    });
    vi.spyOn(oc, 'Handle_TDocStd_Document_2').mockImplementation(function () { throw new Error('injected document handle failure'); });
    expect(() => readStep(oc, new Uint8Array([1]))).toThrow('injected document handle failure');
    expect(created).toBe(1);
    expect(deleted).toBe(1);
  });

  it.each(['point', 'triangle'] as const)('releases STL %s wrapper when native access fails', kind => {
    const entries = observe();
    if (kind === 'point') vi.spyOn(oc.gp_Pnt.prototype, 'X').mockImplementation(() => { throw new Error('injected point read'); });
    else vi.spyOn(oc.Poly_Triangle.prototype, 'Value').mockImplementation(() => { throw new Error('injected triangle read'); });
    expect(() => readStl(oc, oneTriangle())).toThrow(kind === 'point' ? 'injected point read' : 'injected triangle read');
    const transient = entries.filter(entry => kind === 'point' ? entry.item instanceof oc.gp_Pnt : entry.item instanceof oc.Poly_Triangle);
    expect(transient.length).toBeGreaterThan(0);
    expect(transient.every(entry => entry.deletes === 1)).toBe(true);
    expect(entries.every(entry => entry.deletes === 1)).toBe(true);
  });

  it('does not retry a failing real surface release on cancellation', () => {
    const real = analytic.makeAnalyticFunctionSurface;
    let deletes = 0, cancel = false;
    vi.spyOn(analytic, 'makeAnalyticFunctionSurface').mockImplementation((...args) => {
      const result = real(...args);
      if (result.status !== 'shape') return result;
      const original = result.delete.bind(result);
      cancel = true;
      return { ...result, delete: () => { deletes += 1; original(); throw new Error('surface cleanup failure'); } };
    });
    const input = { primitive: { kind: 'sphere' as const, center: [0, 0, 0] as const, radius: 1 },
      bounds: { minimum: [-2, -2, -2] as const, maximum: [2, 2, 2] as const } };
    expect(() => makeFunctionSurface(oc, input, () => cancel)).toThrow('surface cleanup failure');
    expect(deletes).toBe(1);
  });

  it('attempts combined-result cleanup even when a copied owner fails during release', () => {
    const input = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const surface = tessellate(oc, input.shape), edges = extractEdges(oc, input.shape);
    const tables = collectSubShapes(oc, input.shape, surface.faceRanges, edges.edgeRanges);
    const face = tables.faces.find(value => value.surfaceKind === 'plane' && value.axis?.[2] === 1);
    if (face === undefined) throw new Error('expected top face');
    let combinedDeletes = 0, copyWrapped = false;
    const originalCreate = allocations.createAllocations, booleanOp = booleanModule.booleanOp;
    vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
      const group = originalCreate();
      return { release: group.release, keep<T extends allocations.OcctDeletable>(item: T): T {
        if (!copyWrapped && item instanceof oc.BRepBuilderAPI_Copy) {
          copyWrapped = true;
          const original = item.delete.bind(item);
          item.delete = () => { original(); throw new Error('copied owner cleanup failure'); };
        }
        return group.keep(item);
      } };
    });
    vi.spyOn(booleanModule, 'booleanOp').mockImplementation((...args) => {
      const result = booleanOp(...args), original = result.delete.bind(result);
      result.delete = () => { combinedDeletes += 1; original(); };
      return result;
    });
    try {
      const result = editSolidFace(oc, input.shape, tables, { offset: 1, face: { kind: 'face', index: face.index,
        surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } });
      expect(() => result.delete()).toThrow('copied owner cleanup failure');
      expect(combinedDeletes).toBe(1);
      expect(() => result.delete()).not.toThrow();
      expect(combinedDeletes).toBe(1);
      vi.restoreAllMocks();
      expect(mesh.measureVolume(oc, input.shape)).toBeCloseTo(6000, 6);
    } finally { vi.restoreAllMocks(); input.delete(); }
  });

  it('frees the output of a surface cut if work cleanup fails before transfer', () => {
    const input = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const create = allocations.createAllocations;
    let groupNumber = 0, failed = false;
    const outputs: { deletes: number }[] = [];
    vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
      const group = create(), index = groupNumber++;
      return {
        keep<T extends allocations.OcctDeletable>(item: T): T {
          if (index === 1) {
            const entry = { deletes: 0 }, original = item.delete.bind(item);
            outputs.push(entry);
            item.delete = () => { entry.deletes += 1; original(); };
          }
          return group.keep(item);
        },
        release: () => {
          group.release();
          if (index === 0 && !failed) { failed = true; throw new Error('cut work cleanup failure'); }
        },
      };
    });
    try {
      expect(() => makeSurfaceCut(oc, input.shape, { kind: 'plane', origin: [5, 0, 0], normal: [1, 0, 0] }))
        .toThrow('cut work cleanup failure');
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every(entry => entry.deletes === 1)).toBe(true);
      vi.restoreAllMocks();
      expect(mesh.measureVolume(oc, input.shape)).toBeCloseTo(1000, 6);
    } finally { vi.restoreAllMocks(); input.delete(); }
  });

  it('frees a conditioned history list if its local cleanup fails before transfer', () => {
    const owner = allocations.createAllocations();
    try {
      const box = owner.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const prism = owner.keep(makeExtrudeSolid(oc, { kind: 'extrude', direction: [0, 0, 1], distance: 20,
        profile: [{ kind: 'ellipse', center: [5, 5, -5], normal: [0, 0, 1],
          majorAxis: [1, 0, 0], majorRadius: 4, minorRadius: 2 }] }));
      let checked = false;
      const cut = owner.keep(booleanModule.booleanOp(oc, 'subtract', box.shape, prism.shape, undefined, history => {
        const create = allocations.createAllocations;
        let groupNumber = 0, failed = false;
        const outputs: { deletes: number }[] = [];
        vi.spyOn(allocations, 'createAllocations').mockImplementation(() => {
          const group = create(), index = groupNumber++;
          return {
            keep<T extends allocations.OcctDeletable>(item: T): T {
              if (index === 1) {
                const entry = { deletes: 0 }, original = item.delete.bind(item);
                outputs.push(entry);
                item.delete = () => { entry.deletes += 1; original(); };
              }
              return group.keep(item);
            },
            release: () => {
              group.release();
              if (index === 0 && !failed) { failed = true; throw new Error('history local cleanup failure'); }
            },
          };
        });
        try {
          expect(() => history.Modified(box.shape)).toThrow('history local cleanup failure');
          expect(outputs).toHaveLength(1);
          expect(outputs[0].deletes).toBe(1);
          checked = true;
        } finally { vi.restoreAllMocks(); }
      }, { requireRemoval: true }));
      expect(checked).toBe(true);
      expect(mesh.isValidShape(oc, cut.shape)).toBe(true);
      expect(mesh.measureVolume(oc, box.shape)).toBeCloseTo(1000, 6);
    } finally { vi.restoreAllMocks(); owner.release(); }
  });
});
