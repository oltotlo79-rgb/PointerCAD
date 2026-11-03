import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { absoluteCoordinate, appendSolid, createDirectKernelBridge, createEmptyPartDocument, createPrimitiveFeature,
  createSubShapeReference, recomputePart } from '../../packages/model/src/index.js';
import { NETGEN_ASSETS } from '../../packages/fem/src/assets.js';
import { analyzeCadSolidFinite } from '../../packages/fem/src/cadSolidFinite.js';
import type { CadTetraContext } from '../../packages/fem/src/cadTetraMesh.js';
import { writeFile } from 'node:fs/promises';
import { isLocalFiniteRequest, observeFiniteAssets } from './solidFiniteWorkerEvidence.js';
import { expect, test as baseTest, type Page, type TestInfo } from '@playwright/test';
import { FemClient, type FemWorkerPort } from '../../packages/fem/src/client.js';
import { FEM_ASSETS } from '../../packages/fem/src/assets.js';
import { SOLID_FINITE_ASSETS } from '../../packages/fem/src/solidFiniteAssets.js';
import { solidFiniteInputSha256, translateSolidFinite } from '../../packages/fem/src/solidFiniteTranslation.js';
import type { FemPhase, FemRequest } from '../../packages/fem/src/protocol.js';

// Existing browser bridge forwards the real Worker and records actual responses; no runtime or reply is replaced.
declare global {
  interface Window {
    pcadFemReply?: (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => Promise<void>;
    pcadFemWorkers?: Map<number, Worker>;
  }
}

/** Bridges FemWorkerPort to page Workers. terminate() really terminates the browser Worker. */
async function browserWorkers(page: Page) {
  const ports = new Map<number, BrowserWorker>();
  const errors: string[] = [];
  const raw: { id: number; kind: string; data: unknown }[] = [];
  await page.exposeFunction('pcadFemReply', (id: number, kind: 'message' | 'error' | 'messageerror', data: unknown) => {
    raw.push({ id, kind, data });
    if (kind !== 'message') errors.push(`${kind}: ${String(data)}`);
    ports.get(id)?.deliver(kind, data);
  });
  await page.evaluate(() => { window.pcadFemWorkers = new Map(); });
  class BrowserWorker implements FemWorkerPort {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
    private readonly ready: Promise<void>;
    constructor(readonly id: number) {
      ports.set(id, this);
      this.ready = page.evaluate(workerId => {
        const worker = new Worker(new URL('./fem/worker.js', document.baseURI), { name: 'pointercad-linear-beam' });
        worker.onmessage = event => { void window.pcadFemReply?.(workerId, 'message', event.data); };
        worker.onerror = event => { void window.pcadFemReply?.(workerId, 'error', event.message); };
        worker.onmessageerror = () => { void window.pcadFemReply?.(workerId, 'messageerror', null); };
        window.pcadFemWorkers?.set(workerId, worker);
      }, id);
    }
    postMessage(message: FemRequest): void {
      void this.ready.then(() => page.evaluate(([workerId, request]) => {
        window.pcadFemWorkers?.get(workerId)?.postMessage(request);
      }, [this.id, message] as const));
    }
    terminate(): void {
      ports.delete(this.id);
      void this.ready.then(() => page.evaluate(workerId => {
        window.pcadFemWorkers?.get(workerId)?.terminate();
        window.pcadFemWorkers?.delete(workerId);
      }, this.id));
    }
    deliver(kind: 'message' | 'error' | 'messageerror', data: unknown): void {
      if (kind === 'message') this.onmessage?.(new MessageEvent('message', { data }));
      else if (kind === 'messageerror') this.onmessageerror?.(new MessageEvent('messageerror', { data: null }));
      else if (typeof ErrorEvent === 'function') this.onerror?.(new ErrorEvent('error', { message: String(data) }));
      else this.onmessage?.(new MessageEvent('message', { data: { browserWorkerError: String(data) } }));
    }
  }
  let next = 0;
  return {
    errors, raw,
    create: (): FemWorkerPort => new BrowserWorker(++next),
    live: (): Promise<number> => page.evaluate(() => window.pcadFemWorkers?.size ?? -1),
  };
}

/** Observe the bytes actually delivered by the existing runtime asset requests; never replace or inject responses. */
function observeAssets(page: Page) {
  return observeFiniteAssets(page, [...FEM_ASSETS, ...SOLID_FINITE_ASSETS].map(asset => asset.file));
}
async function attachJson(info: TestInfo, name: string, value: unknown): Promise<void> {
  const file = info.outputPath(name);
  await writeFile(file, JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'wx' });
  await info.attach(name, { path: file, contentType: 'application/json' });
}
async function finishEvidence(info: TestInfo, bridge: Awaited<ReturnType<typeof browserWorkers>>, client: FemClient,
  assets: ReturnType<typeof observeAssets>, pageErrors: readonly string[]): Promise<void> {
  client.dispose();
  let cleanupError: string | null = null, live: number | null = null;
  try { await expect.poll(bridge.live).toBe(0); live = await bridge.live(); } catch (error) { cleanupError = String(error); }
  await Promise.all(assets.pending);
  await attachJson(info, 'finite-actual-evidence.json', { rawReplies: bridge.raw, workerErrors: bridge.errors,
    pageErrors, assets: assets.responses, assetReadErrors: assets.errors, assetValidationErrors: assets.validationErrors(),
    expectedAssetPins: [...FEM_ASSETS, ...SOLID_FINITE_ASSETS], cleanup: { live, cleanupError } });
  if (cleanupError !== null) throw new Error(cleanupError);
}

// One elastic step of the 4-tet affine patch in solidFiniteEquilibriumNative.test.ts.
// A linear tet reproduces F=diag(s,s^-1/2,s^-1/2); with no prior plasticity, tau=diag(t,-t/2,-t/2),
// t=2G ln(s), G=E/(2(1+nu)). The same native test supplies the absolute/relative tolerances below.
function affineInput() {
  const length = 10, stretch = 1.0005, transverse = stretch ** -0.5;
  const nodes = [[0, 0, 0], [length, 0, 0], [0, length, 0], [0, 0, length], [length / 4, length / 4, length / 4]];
  const diagonal = [stretch, transverse, transverse], dofs = ['x', 'y', 'z'] as const;
  return translateSolidFinite({ schema: 'pointercad-finite-j2-equilibrium-input/1',
    source: { documentId: 'browser-finite-affine', revision: 1 }, plan: {
      schema: 'pointercad-finite-j2-equilibrium-plan/1', units: 'N-mm-MPa', nodes,
      elements: [[4, 1, 2, 3], [0, 4, 2, 3], [0, 1, 4, 3], [0, 1, 2, 4]],
      material: { youngMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 1000 }, steps: 1,
      prescribedMm: [0, 1, 2, 3].flatMap(node => dofs.map((dof, axis) => ({ node, dof,
        valuesMm: [(diagonal[axis] - 1) * nodes[node][axis]] }))), forcesN: [], referenceForceN: 250 * length * length,
    } }).input;
}

/** Register the same real Worker cases for an HTTP(S) page or the launched desktop renderer. */
export function registerSolidFiniteWorkerTests(
  test: typeof baseTest, openPage: (page: Page) => Promise<void>,
): void {
  test.describe('finite-strain J2 on the actual browser Worker and packaged OOFEM', () => {
    test('the elastic affine patch matches the independent native oracle', async ({ page }, info) => {
      const pageErrors: string[] = [], requests: string[] = [], phases: FemPhase[] = [];
      const assets = observeAssets(page);
      page.on('pageerror', error => { pageErrors.push(error.message); });
      page.on('request', request => { requests.push(request.url()); });
      let closed = 0;
      page.on('worker', worker => { if (/\/fem\/worker\.js$/u.test(worker.url())) worker.once('close', () => { closed += 1; }); });
      await openPage(page);
      const origin = page.url();
      const bridge = await browserWorkers(page), client = new FemClient(bridge.create), input = affineInput();
      try {
        const completion = await client.analyzeSolidFinite(input, { onPhase: phase => { phases.push(phase); } });
        await attachJson(info, 'finite-completion.json', { input, completion, phases });
        expect(completion.kind, completion.kind === 'failed' ? completion.failure.message : '').toBe('result');
        if (completion.kind !== 'result') throw new Error('No actual finite native result');
        const result = completion.result.result;
        expect(result.input).toEqual(input); expect(result.inputSha256).toBe(await solidFiniteInputSha256(input));
        expect(result.retainedNativeAnalyses).toBe(1); expect(result.refusedCommits).toEqual([]);
        expect(result.records).toHaveLength(1);
        const record = result.records[0], stretch = 1.0005, transverse = stretch ** -0.5;
        const tau = 2 * (200000 / (2 * 1.3)) * Math.log(stretch);
        const expectedTau = [tau, 0, 0, 0, -tau / 2, 0, 0, 0, -tau / 2];
        expect(record.freeResidualRatio).toBeLessThanOrEqual(1e-8);
        [stretch, transverse, transverse].forEach((value, axis) => {
          expect(Math.abs(record.displacementMm[4][axis] - (value - 1) * 2.5)).toBeLessThanOrEqual(1e-9 * 10);
        });
        expect(record.elements).toHaveLength(4);
        for (const element of record.elements) {
          expect(Math.max(...element.tau.map((value, index) => Math.abs(value - expectedTau[index]))) / 250).toBeLessThanOrEqual(1e-8);
          expect(Math.abs(element.alpha)).toBeLessThanOrEqual(1e-10);
          expect(Math.abs(element.J - 1)).toBeLessThanOrEqual(1e-10);
        }
        expect(phases.slice(0, 4)).toEqual(['loading-assets', 'loading-runtime', 'loading-packages', 'solving']);
        await expect.poll(() => closed).toBe(1); await expect.poll(bridge.live).toBe(0);
        // Preserve the external-request check while recognizing same-origin runtime blob imports.
        expect(requests.filter(value => !isLocalFiniteRequest(value, origin))).toEqual([]);
        await Promise.all(assets.pending);
        for (const pin of [...FEM_ASSETS, ...SOLID_FINITE_ASSETS]) {
          const found = assets.responses.find(response => response.status === 200 && new URL(response.url).pathname.endsWith('/fem/assets/' + pin.file));
          expect(found, pin.file).toMatchObject({ status: 200, bytes: pin.bytes, sha256: pin.sha256 });
        }
        expect(assets.errors).toEqual([]); expect(assets.validationErrors()).toEqual([]); expect(bridge.errors).toEqual([]); expect(pageErrors).toEqual([]);
      } finally { await finishEvidence(info, bridge, client, assets, pageErrors); }
    });

    test('abort during solve terminates the actual Worker', async ({ page }, info) => {
      const pageErrors: string[] = [], assets = observeAssets(page);
      page.on('pageerror', error => { pageErrors.push(error.message); });
      let closed = 0;
      page.on('worker', worker => { if (/\/fem\/worker\.js$/u.test(worker.url())) worker.once('close', () => { closed += 1; }); });
      await openPage(page);
      const bridge = await browserWorkers(page), client = new FemClient(bridge.create), input = affineInput();
      try {
        const controller = new AbortController();
        const completion = await client.analyzeSolidFinite(input, { signal: controller.signal,
          onPhase: phase => { if (phase === 'solving') controller.abort(); } });
        await attachJson(info, 'finite-aborted-completion.json', { input, completion });
        expect(completion).toMatchObject({ kind: 'cancelled', reason: 'abort' });
        await expect.poll(() => closed).toBe(1); await expect.poll(bridge.live).toBe(0);
        expect(bridge.errors).toEqual([]); expect(pageErrors).toEqual([]);
      } finally { await finishEvidence(info, bridge, client, assets, pageErrors); }
    });
  });

  // CAD geometry is real OCCT; both the Netgen mesh and finite solve use separate real browser Workers.
  test('actual CAD box boundary and separate Workers preserve the elastic uniaxial solution and provenance', async ({ page }, info) => {
    const pageErrors: string[] = [], assets = observeAssets(page);
    const mesh = observeFiniteAssets(page, NETGEN_ASSETS.map(pin => pin.file));
    const meshAssets = mesh.responses, meshReads = mesh.pending, meshReadErrors = mesh.errors;
    page.on('pageerror', error => { pageErrors.push(error.message); });

    let closed = 0, created = 0;
    page.on('worker', worker => { if (/\/fem\/worker\.js$/u.test(worker.url())) worker.once('close', () => { closed += 1; }); });
    await openPage(page);
    const bridge = await browserWorkers(page), client = new FemClient(() => { created += 1; return bridge.create(); });
    const api = createKernelApi(loadOcctForNode), kernel = createDirectKernelBridge(api);
    const initial = createEmptyPartDocument();
    const primitive = createPrimitiveFeature(initial, 'box', { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) });
    if (primitive.shape.kind !== 'box') throw new Error('Expected box primitive');
    const part = appendSolid(initial, { ...primitive, shape: { ...primitive.shape, sizeX: number(10), sizeY: number(10), sizeZ: number(10) } });
    let steps: CadTetraContext['steps'] = [];
    try {
      const computed = await recomputePart(part, kernel, { onResolved: resolved => { steps = resolved.steps; } });
      expect(computed.errors).toEqual([]); expect(computed.cancelled).toBe(false); expect(computed.bodies).toHaveLength(1);
      const body = computed.bodies[0];
      const planes = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[0]) > 0.99)
        .sort((left, right) => left.centroid[0] - right.centroid[0]);
      expect(planes).toHaveLength(2);
      const fixed = createSubShapeReference(body, 'face', planes[0].index), loaded = createSubShapeReference(body, 'face', planes[1].index);
      if (fixed === null || loaded === null) throw new Error('Real box faces lack unique semantic references');
      const context: CadTetraContext = { documentId: part.id, revision: 1, body, steps };
      const materialReference = 'Independent elastic uniaxial finite-strain oracle, E=200000 MPa, nu=0';
      const settings = { material: { id: 'oracle', youngMPa: 200000, poisson: 0 }, fixedFaces: [fixed], loadedFaces: [loaded],
        tractionMPa: [50, 0, 0] as const, numericBudgetBytes: 16 * 1024 * 1024,
        geometry: { kind: 'planar' as const, boundary: { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 } },
        yieldStressMPa: 250, hardeningModulusMPa: 1000, materialReference, forceFactors: [1], prescribedDisplacementFactors: [1] };
      const outcome = await analyzeCadSolidFinite(client, api, () => context, settings);
      await attachJson(info, 'finite-cad-completion.json', { context: { documentId: part.id, revision: 1, steps, fixed, loaded }, settings, outcome });
      expect(outcome.kind, outcome.kind === 'failed' ? outcome.message : '').toBe('result');
      if (outcome.kind !== 'result') throw new Error('No actual CAD finite result');
      expect(outcome.input.source).toEqual({ documentId: part.id, revision: 1 });
      expect(outcome.materialReference).toBe(materialReference);
      expect(outcome.prepared.input.source.meshKey).toBe(outcome.mesh.inputSha256);
      expect(outcome.prepared.loadedAreaMm2).toBeCloseTo(100, 7);
      expect(outcome.prepared.totalForceN[0]).toBeCloseTo(5000, 6);
      // The selected fixed and loaded semantic faces must map to the opposite physical box planes.
      for (const constraint of outcome.prepared.input.constraints)
        expect(Math.abs(outcome.prepared.input.nodes[constraint.node][0] - planes[0].centroid[0])).toBeLessThanOrEqual(1e-8);
      for (const load of outcome.prepared.input.surfaceLoads) for (const node of load.nodes)
        expect(Math.abs(outcome.prepared.input.nodes[node][0] - planes[1].centroid[0])).toBeLessThanOrEqual(1e-8);
      expect(outcome.result.input).toEqual(outcome.input);
      expect(outcome.result.inputSha256).toBe(await solidFiniteInputSha256(outcome.input));
      expect(outcome.result.retainedNativeAnalyses).toBe(1); expect(outcome.result.refusedCommits).toEqual([]);
      expect(outcome.result.records).toHaveLength(1);
      // solidFiniteEquilibriumNative.test.ts: uniaxial dead-load oracle P=tau/lambda, tau=E ln(lambda) in elastic range.
      // Solve P=50 MPa, E=200000 MPa by bisection; nu=0 makes transverse stretch 1.
      // Native affine test tolerance: displacement <= 1e-9 L mm; tau error <= 1e-8 * yield stress MPa.
      let low = 1, high = 1.001;
      for (let i = 0; i < 60; i++) { const mid = (low + high) / 2; if (200000 * Math.log(mid) / mid < 50) low = mid; else high = mid; }
      const stretch = (low + high) / 2, tau = 200000 * Math.log(stretch), xmin = planes[0].centroid[0];
      const step = outcome.result.records[0]; expect(step.freeResidualRatio).toBeLessThanOrEqual(1e-8);
      outcome.input.plan.nodes.forEach((node, index) => {
        const expected = [(stretch - 1) * (node[0] - xmin), 0, 0];
        step.displacementMm[index].forEach((value, axis) => expect(Math.abs(value - expected[axis])).toBeLessThanOrEqual(1e-8));
      });
      for (const element of step.elements) {
        const expected = [tau, 0, 0, 0, 0, 0, 0, 0, 0];
        expect(Math.max(...element.tau.map((value, index) => Math.abs(value - expected[index]))) / 250).toBeLessThanOrEqual(1e-8);
        expect(element.alpha).toBeLessThanOrEqual(1e-10);
      }
      expect(created).toBe(2); await expect.poll(() => closed).toBe(2); await expect.poll(bridge.live).toBe(0);
      await Promise.all(meshReads); await Promise.all(assets.pending);
      for (const pin of NETGEN_ASSETS) {
        const found = meshAssets.find(row => row.status === 200 && new URL(row.url).pathname.endsWith('/fem/assets/' + pin.file));
        expect(found, pin.file).toMatchObject({ status: 200, bytes: pin.bytes, sha256: pin.sha256 });
      }
      for (const pin of [...FEM_ASSETS, ...SOLID_FINITE_ASSETS]) {
        const found = assets.responses.find(row => row.status === 200 && new URL(row.url).pathname.endsWith('/fem/assets/' + pin.file));
        expect(found, pin.file).toMatchObject({ status: 200, bytes: pin.bytes, sha256: pin.sha256 });
      }
      expect(meshReadErrors).toEqual([]); expect(mesh.validationErrors()).toEqual([]); expect(assets.errors).toEqual([]); expect(assets.validationErrors()).toEqual([]); expect(bridge.errors).toEqual([]); expect(pageErrors).toEqual([]);
    } finally {
      await Promise.all(meshReads);
      await attachJson(info, 'finite-cad-mesh-assets.json', { meshAssets, meshReadErrors, meshValidationErrors: mesh.validationErrors(), created, closed });
      try { await finishEvidence(info, bridge, client, assets, pageErrors); }
      finally { await api.releasePart('part:current'); kernel.dispose(); }
    }
  });
}
