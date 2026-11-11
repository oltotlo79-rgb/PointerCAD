import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { absoluteCoordinate, appendFeature, appendSolid, createDirectKernelBridge, createEmptyPartDocument,
  createSubShapeReference, recomputePart, replaceSketch, requestAnalysisBoundary, resolvePart,
  type SketchArcFeature, type SolidBody, type SubShapeRef, type SurfaceFeature } from '@pointercad/model';
import { createShellCadSavedInput, solidCadFaceKey } from '@pointercad/model/beam-analysis';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '@pointercad/test-utils/testing/release-performance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCadShellAnalysis, prepareCadShellAnalysis, type CadShellSettings } from './cadShellAnalysis.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import { lumpedSurfaceLoads, SCORDELIS_LO } from './shellBenchmark.testSupport.js';
import { translateShellAnalysis } from './shellTranslation.js';

// This is the actual OCCT sheet and packaged OOFEM, not W10's synthetic union-jack mesh.
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const pins: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
function verified(name: string): Uint8Array {
  if (typeof pins !== 'object' || pins === null || !('files' in pins) || typeof pins.files !== 'object' || pins.files === null)
    throw new Error('Invalid runtime manifest');
  const row: unknown = Object.entries(pins.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof row !== 'object' || row === null || !('sha256' in row) || !('bytes' in row)) throw new Error(`Unpinned ${name}`);
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    .toEqual({ bytes: row.bytes, sha256: row.sha256 });
  return bytes;
}
let runtime: PyodideRuntime | undefined;
let denied = 0;
const previousFetch = globalThis.fetch;
beforeAll(async () => {
  await loadOcctForNode();
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel, 'shellAnalysis.py']) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('curved-shell: network denied')); };
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  runtime = loaded;
  await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/shellAnalysis.py', verified('shellAnalysis.py'));
  runtime.runPython("import sys\nsys.path.insert(0, '/pcad_fem')");
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = previousFetch; });

const expression = (number: number) => absoluteCoordinate(number, 0, 0).x;
function reference(body: SolidBody, kind: 'face' | 'edge' | 'vertex', index: number): SubShapeRef {
  const result = createSubShapeReference(body, kind, index);
  if (result === null) throw new Error(`No persistent ${kind} ${String(index)}`);
  return result;
}

describe('real OCCT quarter-cylinder sheet to shell native benchmark', () => {
  it('keeps the CAD surface, support origins and real mesh for three refinements', async () => {
    const api = createKernelApi(loadOcctForNode), bridge = createDirectKernelBridge(api);
    const initial = createEmptyPartDocument(), sketch = initial.sketches[0];
    // Same x=0..L/2 roof: start at the far section and sweep -X so the actual native face points outward.
    const arc: SketchArcFeature = { id: 'roof-arc', name: 'roof-arc', kind: 'arc', planeId: 'yz',
      center: absoluteCoordinate(SCORDELIS_LO.lengthMm / 2, 0, 0), radius: expression(SCORDELIS_LO.radiusMm),
      startAngle: expression(50), endAngle: expression(90), construction: false };
    const sheet: SurfaceFeature = { id: 'roof-sheet', name: 'roof-sheet', kind: 'surface', suppressed: false,
      operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [arc.id] },
        distance: expression(SCORDELIS_LO.lengthMm / 2), reversed: true } };
    const part = appendSolid(replaceSketch(initial, appendFeature(sketch, arc)), sheet);
    try {
      const result = await recomputePart(part, bridge);
      expect(result.errors).toEqual([]);
      const body = result.bodies.find(row => row.featureId === sheet.id);
      if (body === undefined || body.bodyKind !== 'shell') throw new Error('Actual open OCCT sheet not produced');
      expect(body.faces).toHaveLength(1);
      expect(body.faces[0].surfaceKind).toBe('cylinder');
      const face = reference(body, 'face', body.faces[0].index), steps = resolvePart(part).steps;
      const context = { documentId: part.id, revision: 1, body, steps };
      const edgeAt = (predicate: (point: readonly number[]) => boolean): SubShapeRef => {
        const found = body.edges.filter(edge => predicate(edge.start) && predicate(edge.end));
        if (found.length !== 1) throw new Error(`Expected one actual CAD support edge, got ${String(found.length)}`);
        return reference(body, 'edge', found[0].index);
      };
      const near = (value: number, target: number): boolean => Math.abs(value - target) <= 1e-6;
      const x0 = edgeAt(p => near(p[0], 0));
      const crown = edgeAt(p => near(p[1], 0));
      const x25 = edgeAt(p => near(p[0], SCORDELIS_LO.lengthMm / 2));
      const values: { nodes: number; elements: number; displacementMm: number; relative: number }[] = [];
      for (const [linearDeflection, angularDeflection] of [[0.4, 0.35], [0.2, 0.2], [0.05, 0.1]] as const) {
        const surface = { nativeQuality: 'cylindrical-rectangle' as const, linearDeflection, angularDeflection, maximumNodes: 1000, maximumTriangles: 2000,
          minimumTriangleAreaMm2: 0.1, minimumAngleDeg: 20, maximumAspectRatio: 4 };
        const boundary = await requestAnalysisBoundary(api, steps, body, { boundary: 'open', linearDeflection, angularDeflection,
          shellQuality: { kind: 'cylindrical-rectangle', maximumNodes: surface.maximumNodes,
          maximumTriangles: surface.maximumTriangles, minimumTriangleAreaMm2: surface.minimumTriangleAreaMm2,
          minimumAngleDeg: surface.minimumAngleDeg, maximumAspectRatio: surface.maximumAspectRatio } });
        if (boundary.kind !== 'ready') throw new Error(`Actual OCCT boundary refused: ${boundary.message}`);
        const settings: CadShellSettings = { saved: createShellCadSavedInput({ documentId: part.id,
          bodyFeatureId: body.featureId, faces: [face], thicknessMm: SCORDELIS_LO.thicknessMm, offsetMm: 0 }),
        material: { id: 'benchmark', youngMPa: SCORDELIS_LO.youngMPa, poisson: SCORDELIS_LO.poisson }, surface, edgeLoads: [],
        supports: [{ kind: 'edge', edge: x0, fixed: [true, false, false, false, true, true] },
          { kind: 'edge', edge: crown, fixed: [false, true, false, true, false, true] },
          { kind: 'edge', edge: x25, fixed: [false, true, true, false, false, false] }] };
        const prepared = prepareCadShellAnalysis(boundary.boundary, context, settings);
        expect(prepared.midsurface).toEqual({ offsetMm: 0, shiftMm: [0, 0, 0] });
        expect(prepared.faces).toHaveLength(1);
        expect(prepared.faces[0]).toMatchObject({ faceKey: solidCadFaceKey(face), surfaceKind: 'cylinder', normal: null });
        expect(prepared.input.elements).toHaveLength(prepared.mesh.triangleFaces.length);
        expect(prepared.mesh.normals).toHaveLength(prepared.input.elements.length * 3);
        expect(prepared.faces[0].triangles).toHaveLength(prepared.input.elements.length);
        expect(prepared.faces[0].nodes).toHaveLength(prepared.input.nodes.length);
        prepared.input.elements.forEach((element, index) => {
          const normal = prepared.mesh.normals.slice(index * 3, index * 3 + 3);
          expect(Math.abs(Math.hypot(...normal) - 1)).toBeLessThanOrEqual(1e-6);
          const center = element.nodes.map(node => prepared.input.nodes[node]);
          const radialY = center.reduce((sum, node) => sum + node[1], 0) / 3;
          const radialZ = center.reduce((sum, node) => sum + node[2], 0) / 3;
          expect(normal[1] * radialY + normal[2] * radialZ).toBeGreaterThan(0);
        });
        const target = [0, SCORDELIS_LO.radiusMm * Math.sin(SCORDELIS_LO.halfAngleRad),
          SCORDELIS_LO.radiusMm * Math.cos(SCORDELIS_LO.halfAngleRad)];
        const matches = prepared.input.nodes.flatMap((point, index) =>
          Math.hypot(...point.map((value, axis) => value - target[axis])) <= 1e-6 ? [index] : []);
        if (matches.length !== 1) throw new Error('The exact free-edge probe is not a unique actual mesh vertex');
        // W10's same lumped self-weight is a test-applied load, not CAD UI gravity authoring.
        const triangles = prepared.input.elements.map(element => [...element.nodes] as [number, number, number]);
        const nodalLoads = lumpedSurfaceLoads({ cells: 0, nodes: prepared.input.nodes, triangles,
          at: () => { throw new Error('No synthetic grid indices on actual CAD mesh'); } }, [0, 0, -SCORDELIS_LO.weightMPa]);
        const input = { ...prepared.input, nodalLoads }, plan = translateShellAnalysis(input).plan;
        if (runtime === undefined) throw new Error('Missing native runtime');
        runtime.FS.writeFile('/pcad_fem/shell-input.json', JSON.stringify(plan));
        const encoded = runtime.runPython('from shellAnalysis import run_shell_analysis\nrun_shell_analysis()');
        if (typeof encoded !== 'string') throw new Error('Missing native shell output');
        const bound = decodeCadShellAnalysis({ ...prepared, input, plan }, JSON.parse(encoded) as unknown);
        expect(bound.shell.displacement).toHaveLength(input.nodes.length);
        expect(bound.elements).toHaveLength(input.elements.length);
        expect(bound.elements.every(element => element.faceKey === solidCadFaceKey(face))).toBe(true);
        const displacementMm = bound.shell.displacement[matches[0]][2];
        const relative = Math.abs((displacementMm - SCORDELIS_LO.referenceUzMm) / SCORDELIS_LO.referenceUzMm);
        values.push({ nodes: input.nodes.length, elements: input.elements.length, displacementMm, relative });
        process.stdout.write(`CURVED_SHELL_OCCT ${JSON.stringify(values.at(-1))}\n`);
      }
      expect(values).toHaveLength(3);
      expect(values[1].elements).toBeGreaterThan(values[0].elements);
      expect(values[2].elements).toBeGreaterThan(values[1].elements);
      expect(values[2].relative).toBeLessThanOrEqual(0.05);
      expect(denied).toBe(0);
    } finally { bridge.dispose(); }
  // Three native analyses share the existing finite per-analysis allowance.
  }, 3 * FUNCTIONAL_TEST_TIMEOUT_MS);
});
