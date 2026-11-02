import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bindSolidContactInput, readSolidContactAnalysisInput, verifySolidContactInput, decodeSolidContactResult,
  isSolidContactResult, readSolidContactFailureDiagnostics, type SolidContactInput, type SolidContactResult } from './solidContactBinding.js';
import { contactFixture, independentHash, zeroContactReply } from './solidContactBinding.testSupport.js';
import { FEM_PROTOCOL, isRequest, isReply } from './protocol.js';

const identity = { documentId: 'contact-shear-oracle', revision: 1, generation: 1, requestId: 'contact-1' };
const invalidInputs: readonly [string, (input: SolidContactInput) => void][] = [
  ['different source revision', input => { Reflect.set(input.source, 'revision', 2); }],
  ['different preparation nodes', input => { Reflect.set(input.nodes[0], 0, -1); }],
  ['different volume tetrahedra', input => { Reflect.set(input.elements[0], 0, 1); }],
  ['another body key', input => { Reflect.set(input.source.bodies[0], 'bodyKey', 'stale'); }],
  ['different mesh input hash', input => { Reflect.set(input.meshes[0].mesh, 'inputSha256', '0'.repeat(64)); }],
  ['missing body node', input => { Reflect.set(input.bodies[0], 'nodes', input.bodies[0].nodes.slice(1)); }],
  ['missing history step', input => { Reflect.set(input.prescribed[0], 'values', []); }],
  ['nonfinite material', input => { Reflect.set(input.material, 'youngMPa', Infinity); }],
  ['unknown degree of freedom', input => { Reflect.set(input.loads[0], 'axis', 3); }],
  ['repeated history', input => { Reflect.set(input, 'prescribed', [...input.prescribed, input.prescribed[0]]); }],
  ['force at prescribed DOF', input => { Reflect.set(input, 'loads', [{ ...input.prescribed[0] }]); }],
  ['missing slave facet', input => { Reflect.set(input, 'patches', input.patches.slice(1)); }],
  ['repeated patch', input => { Reflect.set(input, 'patches', [...input.patches, input.patches[0]]); }],
  ['duplicate coverage with new id', input => { Reflect.set(input, 'patches', [...input.patches, { ...input.patches[0], id: 'duplicate' }]); }],
  ['unrelated face', input => { Reflect.set(input.patches[0], 'masterFace', 'other'); }],
  ['different triangle', input => { Reflect.set(input.patches[0], 'masterTriangle', 4); }],
  ['changed normal', input => { Reflect.set(input.patches[0], 'normal', [1, 0, 0]); }],
  ['missing friction source', input => { Reflect.set(input.patches[0], 'sourceId', null); }],
  ['zero penalty', input => { Reflect.set(input.patches[0], 'knNPerMm3', 0); }],
  ['negative reference force', input => { Reflect.set(input.patches[0], 'referenceForceN', -1); }],
  ['invented extra option', input => { Reflect.set(input, 'converged', true); }],
];

describe('strict fixed-facet contact input and independent identity checks', () => {
  it('binds explicit current CAD faces, exact volume meshes and each facet once', async () => {
    const { input, prepared, bodies } = await contactFixture();
    expect(input.nodes).toHaveLength(16); expect(input.elements).toHaveLength(12); expect(input.patches).toHaveLength(2);
    expect(input.bodies).toEqual([{ id: 'bar', nodes: [0, 1, 2, 3, 4, 5, 6, 7] }, { id: 'stop', nodes: [8, 9, 10, 11, 12, 13, 14, 15] }]);
    expect(new Set(input.patches.map(patch => patch.slaveTriangle))).toEqual(new Set([2, 3]));
    expect(input.preparationSha256).toBe(prepared.preparationSha256);
    expect(input.preparationSha256).toBe(independentHash(JSON.parse(input.preparationJson)));
    for (const [index, source] of input.source.bodies.entries()) {
      const mesh = bodies[index].mesh;
      expect(source.meshSha256).toBe(independentHash({ coordinates: mesh.coordinates, tetrahedra: mesh.tetrahedra,
        boundaryTriangles: mesh.boundaryTriangles, boundaryTags: mesh.boundaryTags }));
    }
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-contact', identity, input })).toBe(true);
    await expect(verifySolidContactInput(input)).resolves.toEqual(input);
  });
  it.each(invalidInputs)('refuses %s before execution', async (_, change) => {
    const { input } = await contactFixture(); change(input);
    expect(() => readSolidContactAnalysisInput(input)).toThrow();
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-solid-contact', identity, input })).toBe(false);
  });
  it('checks the actual preparation bytes, not its declared hash label', async () => {
    const { input } = await contactFixture(); Reflect.set(input, 'preparationSha256', '0'.repeat(64));
    expect(() => readSolidContactAnalysisInput(input)).not.toThrow();
    await expect(verifySolidContactInput(input)).rejects.toThrow('Preparation SHA');
  });
  it('rejects mesh getters before evaluating them and rejects sparse arrays', async () => {
    const first = await contactFixture(); let reads = 0;
    Object.defineProperty(first.input.meshes[0].mesh, 'coordinates', { get() { reads++; throw new Error('must not execute'); } });
    expect(() => readSolidContactAnalysisInput(first.input)).toThrow(); expect(reads).toBe(0);
    const second = await contactFixture(); Reflect.deleteProperty(second.input.nodes, 0);
    expect(() => readSolidContactAnalysisInput(second.input)).toThrow();
  });
  it('owns the binding and never changes the caller preparation or mesh', async () => {
    const fixture = await contactFixture(), previous = structuredClone(fixture.input);
    Reflect.set(fixture.bodies[0].mesh.coordinates, 0, -99);
    Reflect.set(fixture.settings.material, 'youngMPa', 1);
    expect(fixture.input).toEqual(previous);
    await expect(bindSolidContactInput(fixture.prepared, fixture.bodies.map(body => ({ bodyFeatureId: body.context.body.featureId, mesh: body.mesh })), fixture.settings)).rejects.toThrow();
  });
  it('the fixed Python JSON reader validates the same real bytes without importing native OOFEM', async () => {
    const { input } = await contactFixture();
    const result = spawnSync('python', ['-B', '-X', 'utf8', '-c',
      "import sys,json; from solidContactDriver import read_input; value,plan,digest=read_input(sys.stdin.buffer.read()); print(json.dumps({'sha':digest,'nodes':len(plan['nodes']),'steps':plan['steps'],'patches':len(plan['contacts']),'nativeImported':'oofem' in sys.modules}))"],
    { cwd: fileURLToPath(new URL('./', import.meta.url)), input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sha: independentHash(input), nodes: 16, steps: 1, patches: 2, nativeImported: false });
  });
});

const invalidResults: readonly [string, (result: SolidContactResult) => void][] = [
  ['input hash', result => { Reflect.set(result, 'inputSha256', '0'.repeat(64)); }],
  ['preparation hash', result => { Reflect.set(result, 'preparationSha256', '0'.repeat(64)); }],
  ['source revision', result => { Reflect.set(result.source, 'revision', 2); }],
  ['volume mesh hash', result => { Reflect.set(result.source.bodies[0], 'meshSha256', '0'.repeat(64)); }],
  ['units', result => { Reflect.set(result, 'units', 'N-m-Pa'); }],
  ['missing step', result => { Reflect.set(result, 'steps', []); }],
  ['noncontinuous step', result => { Reflect.set(result.steps[0], 'step', 2); }],
  ['missing node', result => { Reflect.set(result.steps[0], 'displacementMm', result.steps[0].displacementMm.slice(1)); }],
  ['missing patch', result => { Reflect.set(result.steps[0], 'patches', result.steps[0].patches.slice(1)); }],
  ['different patch', result => { Reflect.set(result.steps[0].patches[0], 'id', 'other'); }],
  ['duplicated point', result => { Reflect.set(result.steps[0].patches[0].points[1], 'point', 0); }],
  ['nonfinite displacement', result => { Reflect.set(result.steps[0].displacementMm[4], 1, NaN); }],
  ['invented iteration count', result => { Reflect.set(result, 'nativeIterationCount', 1); }],
  ['invented complementarity qualification', result => { Reflect.set(result, 'strictComplementarityQualified', true); }],
  ['nonzero open force', result => { Reflect.set(result.steps[0].patches[0].points[0], 'normalForceN', 1); }],
  ['wrong quadrature area', result => { Reflect.set(result.steps[0].patches[0].points[0], 'areaMm2', 1); }],
  ['negative dissipation', result => { Reflect.set(result.steps[0].patches[0].points[0], 'addedDissipationNmm', -1); }],
  ['invented accumulated dissipation', result => { Reflect.set(result.steps[0].patches[0].points[0], 'accumulatedDissipationNmm', 1); }],
  ['external load', result => { Reflect.set(result.steps[0].externalForcesN[4], 1, 1); }],
  ['prescribed motion', result => { Reflect.set(result.steps[0].displacementMm[0], 0, 1); }],
  ['free force imbalance', result => { Reflect.set(result.steps[0].internalForcesN[4], 1, 1); }],
];
describe('contact result decoding is bound to the complete captured input', () => {
  it('accepts an independent zero-load transport fixture without claiming native evidence', async () => {
    const { input } = await contactFixture(), result = zeroContactReply(input);
    expect(isSolidContactResult(result)).toBe(true);
    await expect(decodeSolidContactResult(result, input)).resolves.toEqual(result);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
  });
  it.each(invalidResults)('rejects a reply with %s', async (_, change) => {
    const { input } = await contactFixture(), result = zeroContactReply(input); change(result);
    await expect(decodeSolidContactResult(result, input)).rejects.toThrow();
  });
  it('bounds separate failure diagnostics and never accepts them as successful results', async () => {
    const { input } = await contactFixture();
    const diagnostic = { schema: input.schema, inputSha256: independentHash(input), preparationSha256: input.preparationSha256,
      source: input.source, step: 1, reason: 'independent trial failure', iterationLimit: 50, nativeIterationCount: null,
      nativeCallbacks: { tangent: 3, residual: 4, evaluations: 7 }, rawBeforeFailure: '{"success":false}', rawTruncated: false };
    expect(readSolidContactFailureDiagnostics(diagnostic)).toEqual(diagnostic);
    expect(isSolidContactResult(diagnostic)).toBe(false);
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'failure', identity, failure: { code: 'solver-failed', message: diagnostic.reason, contactDiagnostics: diagnostic } })).toBe(true);
    expect(() => readSolidContactFailureDiagnostics({ ...diagnostic, rawBeforeFailure: 'x'.repeat(32_769) })).toThrow();
    expect(() => readSolidContactFailureDiagnostics({ ...diagnostic, nativeIterationCount: 7 })).toThrow();
  });
});
