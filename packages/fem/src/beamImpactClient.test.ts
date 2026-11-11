import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, isReply, isRequest, type FemRequest } from './protocol.js';
import { bucklingFixture } from './buckling.testSupport.js';
import type { BeamImpactInput, BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact, impactOutputSteps } from './beamImpactResults.js';
import { impactInputSha256, translateBeamImpact } from './beamImpactTranslation.js';

// Successor of r131 7b7f05b5: the same routing, binding, cancellation and forged-reply regressions, plus the actual
// deployed native result (Sol147 fixture 1274f2e9, read unchanged) delivered through the client. Sol147's
// beamImpactNativeFixture.test.ts owns the native plan/decoder correspondence; here only request/reply behaviour.
function input(): BeamImpactInput {
  return {
    schema: 'pointercad-beam-impact/1', geometry: bucklingFixture({ segments: 2 }).geometry,
    supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'node-1', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'node-1', directionUnit: [1, 0, 0], gapM: 0.001 }],
    contactStiffnessNPerM: 1e7,
    history: { timeStepS: 1e-5, stepCount: 10, outputEvery: 5 },
  };
}
async function response(source: BeamImpactInput): Promise<BeamImpactResult> {
  const { plan } = translateBeamImpact(source);
  const h = plan.impact.timeStepS;
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  return decodeBeamImpact({
    schema: 'pointercad-oofem-impact-result/1',
    samples: impactOutputSteps(plan.impact.stepCount, plan.impact.outputEvery).map(step => ({
      step, timeS: step === 0 ? 0 : h * step, energyJ: 0.5,
      nodes: original.map((node, index) => ({ number: node.number, displacementM: [0, 0, 0], rotationRad: [0, 0, 0],
        velocityMPerS: plan.impact.initialVelocity[index].slice(0, 3), angularVelocityRadPerS: [0, 0, 0] })),
      contacts: plan.impact.contacts.map(contact => ({ gapM: contact.gapM, intervalForceN: step === 0 ? null : 0,
        impulseNs: step === 0 ? null : 0 })),
    })),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    initialEnergyJ: 0.5, maximumEnergyBalanceError: 0, maximumMomentumResidual: 0, factorizationsUsed: 10,
    contactPeaks: plan.impact.contacts.map(() => ({ intervalForceN: 0, timeS: h, totalImpulseNs: 0 })),
  }, source, await impactInputSha256(source));
}

// Actual native output, read byte for byte from the package-local fixture that Sol147's test pins by SHA-256.
const nativeFixture: unknown = JSON.parse(readFileSync(new URL('./fixtures/beamImpactNativeFixture.json', import.meta.url), 'utf8'));
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('native fixture record');
  return value;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('native fixture number');
  return value;
}
function first(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error('native fixture array');
  return record(value[0]);
}
const YOUNG = 210e9;
const materialEvidence = { kind: 'user-supplied', reference: 'Pinned native one-element axial benchmark',
  condition: 'Explicit isotropic elastic constants; no capacity or general impact claim' } as const;
/** The documented input of the native run: one 1 m member, E 210e9, G = E / 2.6, rho 7850, A 1e-4, Iy = Iz 1e-9,
 * J 2e-9, shear factor 5/6, one segment, native-1 fully and native-2 axially free; history and gap from the plan. */
function nativeInput(plan: Record<string, unknown>): BeamImpactInput {
  const impact = record(plan.impact);
  return {
    schema: 'pointercad-beam-impact/1',
    geometry: {
      schema: 'pointercad-beam/2', id: 'native-axial-impact', revision: 1,
      source: { documentId: 'native-axial-benchmark', documentRevision: 1, geometryRevision: 'explicit-one-metre-member' },
      units: 'N-m', modal: { modeCount: 1, segmentsPerMember: 1 },
      nodes: [{ id: 'native-1', position: [0, 0, 0] }, { id: 'native-2', position: [1, 0, 0] }],
      members: [{ id: 'native-member', componentId: 'native-component', occurrencePath: ['native-component'],
        startNodeId: 'native-1', endNodeId: 'native-2', materialId: 'steel', sectionId: 'explicit-section', localYHint: [0, 1, 0] }],
      materials: [{ id: 'steel', youngModulus: YOUNG, shearModulus: YOUNG / 2.6, densityKgM3: 7850, source: materialEvidence }],
      sections: [{ id: 'explicit-section', area: 1e-4, iy: 1e-9, iz: 1e-9, torsionConstant: 2e-9,
        shearFactor: 0.8333333333333334, source: materialEvidence }],
      constraints: [], loads: [],
    },
    supports: [{ nodeId: 'native-1', restrained: [true, true, true, true, true, true] },
      { nodeId: 'native-2', restrained: [false, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'native-2', velocityMPerS: [0.01, 0, 0] }],
    contacts: [{ nodeId: 'native-2', directionUnit: [1, 0, 0], gapM: numeric(first(impact.contacts).gapM) }],
    contactStiffnessNPerM: 21e6,
    history: { timeStepS: numeric(impact.timeStepS), stepCount: numeric(impact.stepCount), outputEvery: numeric(impact.outputEvery) },
  };
}
async function nativeCase(): Promise<{ input: BeamImpactInput; result: BeamImpactResult; raw: Record<string, unknown> }> {
  const fixture = record(nativeFixture);
  const nativeRaw = record(fixture.result);
  const source = nativeInput(record(fixture.plan));
  return { input: source, raw: nativeRaw, result: decodeBeamImpact(nativeRaw, source, await impactInputSha256(source)) };
}

function rig() {
  const workers: { port: FemWorkerPort; sent: FemRequest[]; terminated: number }[] = [];
  const client = new FemClient(() => {
    const sent: FemRequest[] = [];
    const entry: { port: FemWorkerPort; sent: FemRequest[]; terminated: number } = { sent, terminated: 0, port: {
      postMessage: (request: FemRequest) => { sent.push(request); }, terminate: () => { entry.terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null,
    } };
    workers.push(entry); return entry.port;
  });
  return { client, workers };
}
function reply(worker: { port: FemWorkerPort; sent: FemRequest[] }, result: unknown): void {
  worker.port.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
    identity: worker.sent[0].identity, result } }));
}

describe('beam impact uses the existing owned worker lifecycle', () => {
  it('sends a validated request and accepts only the bound result', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const complete = client.analyzeBeamImpact(source), worker = workers[0], request = worker.sent[0];
    expect(request.kind).toBe('analyze-beam-impact-3d');
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, identity: { ...request.identity, revision: request.identity.revision + 1 } })).toBe(false);
    expect(isRequest({ ...request, extra: true })).toBe(false);
    reply(worker, result);
    await expect(complete).resolves.toMatchObject({ kind: 'result',
      result: { kind: 'oofem-beam-impact-3d', scope: 'elastic-frictionless-normal-fixed-plane', nativeImpactSolver: false } });
    expect(worker.terminated).toBe(1);
    client.dispose();
  });

  it('rejects invalid input before creating a worker', async () => {
    const { client, workers } = rig();
    await expect(client.analyzeBeamImpact({ ...input(), contactStiffnessNPerM: -1 })).rejects.toThrow('impact-stiffness');
    expect(workers).toHaveLength(0);
    client.dispose();
  });

  it('terminates superseded and aborted requests and ignores a saved late reply callback', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const firstRequest = client.analyzeBeamImpact(source), old = workers[0], late = old.port.onmessage;
    const controller = new AbortController(), second = client.analyzeBeamImpact(source, { signal: controller.signal });
    await expect(firstRequest).resolves.toMatchObject({ kind: 'cancelled', reason: 'superseded' });
    late?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: old.sent[0].identity, result } }));
    controller.abort();
    await expect(second).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
    expect(workers.map(worker => worker.terminated)).toEqual([1, 1]);
    client.dispose();
  });

  it('refuses a stale digest even with the current worker identity', async () => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const complete = client.analyzeBeamImpact({ ...source, contactStiffnessNPerM: 2e7 });
    reply(workers[0], result);
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });

  it.each([
    ['a nonfinite sample energy', (result: BeamImpactResult): unknown => ({ ...result,
      samples: result.samples.map((sample, index) => index === 1 ? { ...sample, energyJ: Number.NaN } : sample) })],
    ['an infinite impulse', (result: BeamImpactResult): unknown => ({ ...result,
      samples: result.samples.map((sample, index) => index === 1 ? { ...sample,
        contacts: sample.contacts.map(contact => ({ ...contact, impulseNs: Number.POSITIVE_INFINITY })) } : sample) })],
    ['an off-grid peak time', (result: BeamImpactResult): unknown => ({ ...result,
      contactPeaks: result.contactPeaks.map(peak => ({ ...peak, timeS: peak.timeS * 1.5 })) })],
    ['a 1e-6 energy drift', (result: BeamImpactResult): unknown => ({ ...result,
      samples: result.samples.map((sample, index) => index === 2 ? { ...sample, energyJ: sample.energyJ * (1 + 1e-6) } : sample) })],
    ['a claimed native impact solver', (result: BeamImpactResult): unknown => ({ ...result, nativeImpactSolver: true })],
    ['a broader scope', (result: BeamImpactResult): unknown => ({ ...result, scope: 'general-contact' })],
  ] as const)('refuses a forged reply with %s', async (_name, forge) => {
    const source = input(), result = await response(source), { client, workers } = rig();
    const complete = client.analyzeBeamImpact(source);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity: workers[0].sent[0].identity, result })).toBe(true);
    reply(workers[0], forge(result));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });
});

describe('the actual deployed native impact result through the client', () => {
  it('delivers the decoded native fixture to the request it was computed for', async () => {
    const { input: source, result } = await nativeCase(), { client, workers } = rig();
    const complete = client.analyzeBeamImpact(source);
    expect(isRequest(workers[0].sent[0])).toBe(true);
    reply(workers[0], result);
    const completion = await complete;
    expect(completion.kind).toBe('result');
    if (completion.kind !== 'result') throw new Error('native reply not accepted');
    expect(completion.result).toEqual(result);
    expect(completion.result.samples.some(sample => sample.contacts.some(contact => (contact.intervalForceN ?? 0) > 0))).toBe(true);
    client.dispose();
  });

  it.each([
    ['a displacement changed by one part in a million', (result: BeamImpactResult): unknown => ({ ...result,
      samples: result.samples.map((sample, index) => index !== 1 ? sample : { ...sample,
        nodes: sample.nodes.map((node, nodeIndex) => nodeIndex !== 1 ? node : { ...node,
          displacementM: [node.displacementM[0] * (1 + 1e-6), node.displacementM[1], node.displacementM[2]] }) }) })],
    ['an initial velocity changed by one part in a million', (result: BeamImpactResult): unknown => ({ ...result,
      samples: result.samples.map((sample, index) => index !== 0 ? sample : { ...sample,
        nodes: sample.nodes.map((node, nodeIndex) => nodeIndex !== 1 ? node : { ...node,
          velocityMPerS: [node.velocityMPerS[0] * (1 + 1e-6), node.velocityMPerS[1], node.velocityMPerS[2]] }) }) })],
    ['a foreign input digest', (result: BeamImpactResult): unknown => ({ ...result,
      inputSha256: result.inputSha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64) })],
  ] as const)('refuses the native result forged with %s', async (_name, forge) => {
    const { input: source, result } = await nativeCase(), { client, workers } = rig();
    const complete = client.analyzeBeamImpact(source);
    reply(workers[0], forge(result));
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });

  it('refuses the genuine native result for a request with a different contact gap', async () => {
    const { input: source, result } = await nativeCase(), { client, workers } = rig();
    const complete = client.analyzeBeamImpact({ ...source, contacts: [{ ...source.contacts[0], gapM: source.contacts[0].gapM + 1e-6 }] });
    reply(workers[0], result);
    await expect(complete).resolves.toMatchObject({ kind: 'failed', failure: { code: 'invalid-protocol' } });
    client.dispose();
  });
});
