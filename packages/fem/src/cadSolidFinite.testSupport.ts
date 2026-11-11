import { createSubShapeReference, type AnalysisBoundaryMesh, type AnalysisBoundarySource, type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import type { CadTetraContext } from './cadTetraMesh.js';
import type { CadSolidFiniteSettings } from './cadSolidFinite.js';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import { decodeTetraMesh, tetraMeshInputSha256 } from './tetraMesh.js';
import { decodeSolidFinite } from './solidFiniteResults.js';
import { solidFiniteInputSha256, type SolidFiniteInput } from './solidFiniteTranslation.js';
import { SOLID_FINITE_KIND } from './solidFiniteBinding.js';
import { SOLID_FINITE_RESULT_SCHEMA, SOLID_FINITE_METHOD, SOLID_FINITE_SCOPE, SOLID_FINITE_FREE_RESIDUAL_BOUND,
  SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT } from './solidFinitePlan.js';
// CAD geometry copied from the existing linear CAD test; Worker replies below are synthetic ownership fixtures only.
const options = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
const coordinates = [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 2, 3, 4, 0, 3, 4];
const triangles = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const tags = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const roles = ['bottom', 'top', 'front', 'right', 'back', 'left'] as const;
const origins: readonly SubShapeOrigin[] = roles.map(role => ({ version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box', role } }));
export function context(): CadTetraContext {
  const body: SolidBody = { featureId: 'box', bodyKind: 'solid', isValid: true, volume: 24,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: roles.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: 'plane', area: index < 2 ? 6 : 12,
      centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: index * 2, triangleCount: 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique',
      current: { kind: 'face', index } })) } };
  return { documentId: 'part', revision: 7, body, steps: [{ featureId: 'box', key: 'box:7' }] };
}
export function boundaryMesh(): AnalysisBoundaryMesh {
  return { units: 'mm', boundary: 'closed', coordinates: Float64Array.from(coordinates),
    shells: [{ role: 'outer', triangles: Array.from({ length: 12 }, (_, i) => i) }],
    triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(tags), nodeKinds: new Uint8Array(8).fill(2),
    nodeCount: 8, triangleCount: 12, edges: [], faces: roles.map((_, index) => ({ index, triangleCount: 2,
      reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 }, metrics: {
      totalAreaMm2: 52, signedVolumeMm3: 24, minTriangleAreaMm2: 3, maxTriangleAreaMm2: 6,
      minAngleDeg: 30, maxAngleDeg: 90, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
}
export function kernel(beforeReply: () => void = () => undefined): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: request => {
    beforeReply(); return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() });
  } };
}
export function finiteSettings(current = context()): CadSolidFiniteSettings {
  const fixed = createSubShapeReference(current.body, 'face', 0), loaded = createSubShapeReference(current.body, 'face', 1);
  if (!fixed?.origin || !loaded?.origin) throw new Error('Missing fixture origins');
  return { yieldStressMPa: 250, hardeningModulusMPa: 1000, materialReference: 'Synthetic fixture constants, not a material specification',
    forceFactors: [0], prescribedDisplacementFactors: [0], referenceForceN: 1, fixedFaces: [fixed], loadedFaces: [loaded], material: { id: 'steel', youngMPa: 210000, poisson: 0 },
    tractionMPa: [0, 0, 2], numericBudgetBytes: 16 * 1024 * 1024, geometry: { kind: 'planar', boundary: options } };
}

function zeroNative(input: SolidFiniteInput) {
  if (input.plan.forcesN.some(force => force.valuesN.some(value => value !== 0))
    || input.plan.prescribedMm.some(item => item.valuesMm.some(value => value !== 0))) throw new Error('Only the explicit zero-state fixture is supported');
  const zeros = () => input.plan.nodes.map(() => [0, 0, 0]);
  return { schema: SOLID_FINITE_RESULT_SCHEMA, method: SOLID_FINITE_METHOD, units: 'N-mm-MPa', scope: SOLID_FINITE_SCOPE,
    structuralCertification: false, freeResidualBound: SOLID_FINITE_FREE_RESIDUAL_BOUND, refusedCommits: [], retainedNativeAnalyses: 1,
    runtimeAnalysisLimit: SOLID_FINITE_RUNTIME_ANALYSIS_LIMIT,
    records: Array.from({ length: input.plan.steps }, (_, index) => ({ step: index + 1, time: index + 1,
      // Existing free_force_balance uses max(1e-300, recorded forces), separate from NRSolver's referenceForceN.
      freeResidualRatio: 0, forceScaleN: 1e-300, displacementMm: zeros(), internalN: zeros(), externalN: zeros(),
      elements: input.plan.elements.map(() => ({ J: 1, tau: Array.from({ length: 9 }, () => 0), P: Array.from({ length: 9 }, () => 0), sigma: Array.from({ length: 9 }, () => 0),
        alpha: 0, plastic: false, dissipation: 0, q: 0, native: { F9: [1, 1, 1, 0, 0, 0, 0, 0, 0], S6: Array.from({ length: 6 }, () => 0) } })) })) };
}
export function ownedClient(beforeReply: (request: FemRequest) => void = () => undefined) {
  const requests: FemRequest[] = [], workers: { readonly port: FemWorkerPort; terminations: number }[] = [];
  const client = new FemClient(() => {
    const worker: { terminations: number; port: FemWorkerPort } = { terminations: 0, port: {
      onmessage: null, onerror: null, onmessageerror: null,
      terminate: () => { worker.terminations++; },
      postMessage: (request: FemRequest): void => {
        requests.push(request);
        const run = async (): Promise<void> => {
          let result: unknown;
          if (request.kind === 'mesh-cad-convex-tetra') {
            const input = request.input, hash = await tetraMeshInputSha256(input);
            const tetrahedra = input.triangles.flatMap((_, i, nodes) => i % 3 === 0 ? [8, nodes[i], nodes[i + 1], nodes[i + 2]] : []);
            result = decodeTetraMesh({ coordinates: [...input.coordinates, 1, 1.5, 2], tetrahedra,
              boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, hash);
          } else if (request.kind === 'analyze-solid-finite-j2') {
            result = { kind: SOLID_FINITE_KIND, result: await decodeSolidFinite(zeroNative(request.input), request.input,
              await solidFiniteInputSha256(request.input)) };
          } else return; // Other solver remains pending so cancellation tests can inspect its owner.
          beforeReply(request);
          worker.port.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result } }));
        };
        void run().catch((error: unknown) => { worker.port.onmessage?.(new MessageEvent<unknown>('message', { data: {
          protocol: FEM_PROTOCOL, kind: 'failure', identity: request.identity, failure: { code: 'solver-failed', message: String(error) } } })); });
      },
    } satisfies FemWorkerPort };
    workers.push(worker); return worker.port;
  });
  return { client, requests, workers };
}
