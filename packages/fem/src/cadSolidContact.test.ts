import { FemClient, type FemWorkerPort } from './client.js';
import { FEM_PROTOCOL, type FemRequest } from './protocol.js';
import { contactFixture as analysisFixture, zeroContactReply } from './solidContactBinding.testSupport.js';
import { cantilever } from './analysisCases.testSupport.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSubShapeReference, type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import { InputIssue, SOLID_CONTACT_ID, SOLID_CONTACT_SCHEMA, solidCadFaceKey,
  type SolidContactSavedInput } from '@pointercad/model/beam-analysis';
import { analyzeCadSolidContact, prepareCadSolidContact, type CadSolidContactBody } from './cadSolidContact.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256 } from './tetraMesh.js';

const CUBE_COORDINATES = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const CUBE_TRIANGLES = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const CUBE_TAGS = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const ROLES = ['bottom', 'top', 'front', 'right', 'back', 'left'] as const;
const OPTIONS = { searchDistanceMm: 0.01 };

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }
/** Analytic 1 mm cube with a centre fan: 9 nodes, 12 positive tetrahedra.
 * No native mesher or structural solve is performed or claimed by this fixture. */
async function box(bodyFeatureId: string, offsetX: number, centerX = 0.5): Promise<CadSolidContactBody> {
  const origins: readonly SubShapeOrigin[] = ROLES.map(role => ({ version: 1, shapeKind: 'face',
    identity: { kind: 'box-face', featureId: bodyFeatureId, role } }));
  const centers: readonly (readonly [number, number, number])[] = [[0.5, 0.5, 0], [0.5, 0.5, 1],
    [0.5, 0, 0.5], [1, 0.5, 0.5], [0.5, 1, 0.5], [0, 0.5, 0.5]];
  const normals: readonly (readonly [number, number, number])[] = [[0, 0, -1], [0, 0, 1],
    [0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
  const body: SolidBody = { featureId: bodyFeatureId, bodyKind: 'solid', isValid: true, volume: 1,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: ROLES.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: 'plane', area: 1,
      centroid: [centers[index][0] + offsetX, centers[index][1], centers[index][2]], axis: normals[index],
      radius: null, triangleOffset: index * 2, triangleCount: 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({
      origin, state: 'unique', current: { kind: 'face', index } })) } };
  const context = { documentId: 'part', revision: 7, body, steps: [{ featureId: bodyFeatureId, key: `${bodyFeatureId}:7` }] };
  const input = readTetraMeshInput({ schema: 'pointercad-convex-plc/1', units: 'mm',
    source: { documentId: 'part', revision: 7, featureId: bodyFeatureId, bodyKey: `${bodyFeatureId}:7` },
    coordinates: CUBE_COORDINATES.map((value, index) => value + (index % 3 === 0 ? offsetX : 0)),
    triangles: CUBE_TRIANGLES, tags: CUBE_TAGS, tagCount: 6 });
  const inputSha256 = await tetraMeshInputSha256(input), tetrahedra: number[] = [];
  for (let index = 0; index < CUBE_TRIANGLES.length; index += 3) {
    tetrahedra.push(8, CUBE_TRIANGLES[index], CUBE_TRIANGLES[index + 1], CUBE_TRIANGLES[index + 2]);
  }
  const mesh = decodeTetraMesh({ coordinates: [...input.coordinates, centerX + offsetX, 0.5, 0.5],
    tetrahedra, boundaryTriangles: CUBE_TRIANGLES, boundaryTags: CUBE_TAGS }, input, inputSha256);
  const regions = ROLES.map((_, tag) => {
    const reference = createSubShapeReference(body, 'face', tag);
    if (reference === null) throw new Error('Analytic fixture has no face origin');
    return { tag, reference, triangleIndices: [2 * tag, 2 * tag + 1] };
  });
  return { context, mesh, regions, labelFaces: [0, 1, 2, 3, 4, 5] };
}
async function fixture() {
  const bodies = [await box('A', 0), await box('B', 1)];
  const saved: SolidContactSavedInput = { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID,
    source: { documentId: 'part' }, contacts: [{ id: 'A-right-B-left', masterFace: solidCadFaceKey(bodies[0].regions[3].reference),
      slaveFace: solidCadFaceKey(bodies[1].regions[5].reference), normal: { kind: 'master-outward' },
      gapMm: 0.125, frictionCoefficient: 0.3, frictionSourceId: 'independent-unit-fixture', method: 'surface-to-surface' }] };
  return { bodies, saved };
}
async function refused(action: () => Promise<unknown>, code: string): Promise<void> {
  let failure: unknown, returned = false;
  try { await action(); returned = true; } catch (error) { failure = error; }
  expect(returned).toBe(false); expect(failure).toBeInstanceOf(InputIssue);
  if (!(failure instanceof InputIssue)) throw new Error('Expected a structured preparation refusal');
  expect(failure.code).toBe(code); expect(failure.path).toBe('cad-solid-contact');
}

describe('current CAD contact faces to actual volume-node preparation', () => {
  it('maps two adjacent analytic cubes without welding coincident nodes', async () => {
    const input = await fixture(), prepared = await prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS);
    expect(prepared.kind).toBe('cad-solid-contact-prepared');
    expect(prepared.source.documentId).toBe('part'); expect(prepared.source.revision).toBe(7);
    expect(prepared.nodesMm).toHaveLength(18); expect(prepared.tetrahedra).toHaveLength(24);
    expect(prepared.bodyMaps[0].localToGlobalNodes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(prepared.bodyMaps[1].localToGlobalNodes).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(prepared.bodyMaps[0]).toMatchObject({ bodyFeatureId: 'A', tetrahedronOffset: 0, tetrahedronCount: 12 });
    expect(prepared.bodyMaps[1]).toMatchObject({ bodyFeatureId: 'B', tetrahedronOffset: 12, tetrahedronCount: 12 });
    expect(prepared.tetrahedra[0]).toEqual([8, 0, 3, 2]); expect(prepared.tetrahedra[12]).toEqual([17, 9, 12, 11]);
    expect(prepared.nodesMm[1]).toEqual([1, 0, 0]); expect(prepared.nodesMm[9]).toEqual([1, 0, 0]);
    const leftNodes = new Set(prepared.bodyMaps[0].localToGlobalNodes);
    expect(prepared.bodyMaps[1].localToGlobalNodes.filter(node => leftNodes.has(node))).toEqual([]);
    expect(prepared.plan.contacts[0].master.triangleIndices).toEqual([6, 7]);
    expect(prepared.plan.contacts[0].slave.triangleIndices).toEqual([10, 11]);
    expect(prepared.plan.contacts[0].masterNormals).toEqual([[1, 0, 0], [1, 0, 0]]);
    const slaveFace = prepared.searchMeshes[1].boundaryIdentity.faces.find(face => face.faceIndex === 5);
    expect(slaveFace?.samples.map(sample => sample.normal)).toEqual([[-1, 0, 0], [-1, 0, 0]]);
    // The two different face diagonals create four facet-pair proximity candidates.
    expect(prepared.candidates).toHaveLength(4);
    for (const candidate of prepared.candidates) {
      expect(candidate.geometry.distanceMm).toBe(0); expect(candidate.geometry.declaredInitialGapMm).toBe(0.125);
      expect(candidate.masterGlobalNodes).toEqual(candidate.geometry.master.triangleIndex === 6 ? [1, 2, 6] : [1, 6, 5]);
      expect(candidate.slaveGlobalNodes).toEqual(candidate.geometry.slave.triangleIndex === 10 ? [12, 9, 13] : [12, 13, 16]);
    }
    expect(Object.hasOwn(prepared, 'result')).toBe(false); expect(Object.hasOwn(prepared, 'converged')).toBe(false);
    console.info('W23-A evidence', JSON.stringify({ nodes: prepared.nodesMm.length, tetrahedra: prepared.tetrahedra.length,
      bodyBNodes: prepared.bodyMaps[1].localToGlobalNodes, candidatePairs: prepared.candidates.length,
      distanceMm: prepared.candidates[0].geometry.distanceMm, initialGapMm: prepared.candidates[0].geometry.declaredInitialGapMm }));
  });

  it('hashes actual input and volume mesh independently with an independent SHA implementation', async () => {
    const input = await fixture(), prepared = await prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS);
    input.bodies.forEach((body, index) => {
      expect(prepared.source.bodies[index].inputSha256).toBe(hash(body.mesh.input));
      expect(prepared.source.bodies[index].meshSha256).toBe(hash({ coordinates: body.mesh.coordinates,
        tetrahedra: body.mesh.tetrahedra, boundaryTriangles: body.mesh.boundaryTriangles, boundaryTags: body.mesh.boundaryTags }));
    });
    const { preparationSha256, ...payload } = prepared;
    expect(preparationSha256).toBe(hash(payload)); expect(preparationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('keeps preparation identity invariant when body and region arrays are reordered', async () => {
    const input = await fixture(), first = await prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS);
    const reversed = [...input.bodies].reverse().map(body => ({ ...body,
      regions: [...body.regions].reverse().map(region => ({ ...region, triangleIndices: [...region.triangleIndices].reverse() })) }));
    const second = await prepareCadSolidContact(input.saved, () => reversed, OPTIONS);
    expect(second).toEqual(first); expect(second.preparationSha256).toBe(first.preparationSha256);
  });

  it('distinguishes valid volume meshes that have the same boundary input SHA', async () => {
    const input = await fixture(), first = await prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS);
    const changed = [await box('A', 0, 0.4), input.bodies[1]];
    const second = await prepareCadSolidContact(input.saved, () => changed, OPTIONS);
    expect(second.source.bodies[0].inputSha256).toBe(first.source.bodies[0].inputSha256);
    expect(second.source.bodies[0].meshSha256).not.toBe(first.source.bodies[0].meshSha256);
    expect(second.preparationSha256).not.toBe(first.preparationSha256);
    expect(second.nodesMm[8]).toEqual([0.4, 0.5, 0.5]);
  });

  it('owns its frozen data and never freezes or aliases the caller data', async () => {
    const input = await fixture(), before = structuredClone(input);
    const prepared = await prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS);
    expect(input).toEqual(before); expect(Object.isFrozen(input.bodies[0].mesh.coordinates)).toBe(false);
    expect(Reflect.set(prepared.nodesMm[0], 0, 99)).toBe(false);
    expect(Reflect.set(prepared.plan.contacts[0], 'gapMm', 99)).toBe(false);
    expect(Reflect.set(input.bodies[0].mesh.coordinates, 0, 99)).toBe(true);
    expect(Reflect.set(input.saved.contacts[0], 'gapMm', 99)).toBe(true);
    expect(prepared.nodesMm[0][0]).toBe(0); expect(prepared.plan.contacts[0].gapMm).toBe(0.125);
  });

  it('accepts fresh equivalent current snapshots without relying on object identity', async () => {
    const input = await fixture();
    const prepared = await prepareCadSolidContact(input.saved, () => structuredClone(input.bodies), OPTIONS);
    expect(prepared.nodesMm).toHaveLength(18);
  });
});

describe('incorrect initial CAD and mesh binding never yields a preparation', () => {
  const invalid: readonly { name: string; mutate: (value: Awaited<ReturnType<typeof fixture>>) => void }[] = [
    { name: 'old revision', mutate: value => { Reflect.set(value.bodies[0].context, 'revision', 8); } },
    { name: 'different current body key', mutate: value => { Reflect.set(value.bodies[0].context.steps[0], 'key', 'new-shape'); } },
    { name: 'another document', mutate: value => { Reflect.set(value.bodies[1].context, 'documentId', 'other-part'); } },
    { name: 'saved source mismatch', mutate: value => { Reflect.set(value.saved.source, 'documentId', 'other-part'); } },
    { name: 'duplicate body identity', mutate: value => { value.bodies[1] = value.bodies[0]; } },
    { name: 'missing body', mutate: value => { value.bodies.length = 0; } },
    { name: 'invalid body', mutate: value => { Reflect.set(value.bodies[0].context.body, 'isValid', false); } },
    { name: 'different exact volume', mutate: value => { Reflect.set(value.bodies[0].context.body, 'volume', 2); } },
    { name: 'tampered input SHA', mutate: value => { Reflect.set(value.bodies[0].mesh, 'inputSha256', '0'.repeat(64)); } },
    { name: 'changed volume boundary node', mutate: value => { Reflect.set(value.bodies[0].mesh.coordinates, 0, 0.2); } },
    { name: 'invalid volume tetrahedron', mutate: value => { Reflect.set(value.bodies[0].mesh.tetrahedra, 0, 99); } },
    { name: 'missing CAD region', mutate: value => { Reflect.set(value.bodies[0], 'regions', value.bodies[0].regions.slice(1)); } },
    { name: 'repeated CAD region', mutate: value => { Reflect.set(value.bodies[0], 'regions', value.bodies[0].regions.map((region, i) => i === 1 ? value.bodies[0].regions[0] : region)); } },
    { name: 'missing region triangle', mutate: value => { Reflect.set(value.bodies[0].regions[0], 'triangleIndices', [0]); } },
    { name: 'repeated region triangle', mutate: value => { Reflect.set(value.bodies[0].regions[0], 'triangleIndices', [0, 0]); } },
    { name: 'wrong label-to-face mapping', mutate: value => { Reflect.set(value.bodies[0].labelFaces, 0, 1); } },
    { name: 'same-revision origin mismatch', mutate: value => { Reflect.set(value.bodies[0].regions[3].reference, 'origin', value.bodies[0].regions[4].reference.origin); } },
    { name: 'untracked CAD origins', mutate: value => { Reflect.set(value.bodies[0].context.body, 'origins', undefined); } },
    { name: 'unsupported occurrence placement', mutate: value => { Reflect.set(value.bodies[0], 'placement', { position: [1, 0, 0], rotation: [0, 0, 0, 1] }); } },
  ];
  it.each(invalid)('rejects $name and leaves the original data unchanged', async ({ mutate }) => {
    const input = await fixture(); mutate(input); const before = structuredClone(input);
    await refused(() => prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS), 'cad-contact-input');
    expect(input).toEqual(before);
  });

  it('refuses stale saved contact face keys rather than inferring another contact', async () => {
    const input = await fixture(); Reflect.set(input.saved.contacts[0], 'masterFace', 'missing-face');
    await expect(prepareCadSolidContact(input.saved, () => input.bodies, OPTIONS))
      .rejects.toMatchObject({ code: 'contact-face-missing' });
  });
});

describe('source and cancellation checks across real asynchronous hashing', () => {
  it('cancels before reading or preparing any CAD source', async () => {
    const input = await fixture(), controller = new AbortController(); controller.abort(); let reads = 0;
    await refused(() => prepareCadSolidContact(input.saved, () => { reads++; return input.bodies; },
      { ...OPTIONS, signal: controller.signal }), 'cad-contact-cancelled');
    expect(reads).toBe(0);
  });

  it('cancels during the actual digest await and publishes no preparation', async () => {
    const input = await fixture(), controller = new AbortController();
    const promise = prepareCadSolidContact(input.saved, () => input.bodies, { ...OPTIONS, signal: controller.signal });
    controller.abort();
    await refused(() => promise, 'cad-contact-cancelled');
  });

  const changes: readonly { name: string; mutate: (value: Awaited<ReturnType<typeof fixture>>) => void }[] = [
    { name: 'document revision', mutate: value => { Reflect.set(value.bodies[0].context, 'revision', 8); } },
    { name: 'same-revision body key', mutate: value => { Reflect.set(value.bodies[0].context.steps[0], 'key', 'replacement'); } },
    { name: 'same-revision face geometry', mutate: value => { Reflect.set(value.bodies[0].context.body.faces[3], 'area', 2); } },
    { name: 'same-revision origin table', mutate: value => { Reflect.set(value.bodies[0].context.body, 'origins', undefined); } },
    { name: 'region ownership', mutate: value => { Reflect.set(value.bodies[0].regions[3], 'triangleIndices', [8, 9]); } },
    { name: 'volume coordinates', mutate: value => { Reflect.set(value.bodies[0].mesh.coordinates, 24, 0.4); } },
    { name: 'mesh SHA', mutate: value => { Reflect.set(value.bodies[0].mesh, 'inputSha256', 'f'.repeat(64)); } },
  ];
  it.each(changes)('rejects changed $name after the actual first hash await', async ({ mutate }) => {
    const input = await fixture(); let reads = 0;
    const promise = prepareCadSolidContact(input.saved, () => { reads++; return input.bodies; }, OPTIONS);
    // The async function has reached its real crypto digest; no fake hash implementation is injected.
    expect(reads).toBeGreaterThanOrEqual(2); mutate(input);
    await refused(() => promise, 'cad-contact-stale');
  });

  it('rechecks immediately before publishing after all payload hashing', async () => {
    const input = await fixture(); let reads = 0;
    await refused(() => prepareCadSolidContact(input.saved, () => {
      reads++;
      // Initial read + three checks per body: the eighth observation is after the final payload digest.
      if (reads === 8) Reflect.set(input.bodies[1].context.body.faces[5], 'area', 2);
      return input.bodies;
    }, OPTIONS), 'cad-contact-stale');
    expect(reads).toBe(8);
  });
});


describe('CAD contact preparation shares the actual client owner', () => {
  it.each(['beam', 'invalid', 'abort', 'disposed'] as const)('blocks an awaiting preparation after %s', async mode => {
    const data = await analysisFixture(), controller = new AbortController();
    let created = 0;
    const client = new FemClient(() => { created++; return { postMessage: () => undefined, terminate: () => undefined,
      onmessage: null, onerror: null, onmessageerror: null }; });
    try {
      const old = analyzeCadSolidContact(client, data.saved, () => data.bodies, data.settings, .01, { signal: controller.signal });
      const newer = mode === 'beam' ? client.analyze(cantilever()) : null;
      if (mode === 'invalid') await expect(client.analyzeSolidContact({})).rejects.toThrow();
      if (mode === 'abort') controller.abort();
      if (mode === 'disposed') client.dispose();
      await expect(old).resolves.toEqual({ kind: 'cancelled', reason: mode === 'beam' || mode === 'invalid' ? 'superseded' : mode });
      expect(created).toBe(mode === 'beam' ? 1 : 0);
      client.dispose();
      if (newer !== null) await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { client.dispose(); }
  });

  it.each(['decoding', 'repreparing'] as const)('does not publish or cancel a newer solver during result %s', async boundary => {
    const data = await analysisFixture();
    let replied = false, readsAfterReply = 0, created = 0, newer: ReturnType<FemClient['analyze']> | undefined;
    const client = new FemClient(() => {
      created++;
      const worker: FemWorkerPort = { postMessage(request) {
        if (request.kind === 'analyze-solid-contact') queueMicrotask(() => {
          replied = true;
          worker.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
            identity: request.identity, result: zeroContactReply(request.input) } }));
        });
      }, terminate: () => undefined, onmessage: null, onerror: null, onmessageerror: null };
      return worker;
    });
    try {
      const pending = analyzeCadSolidContact(client, data.saved, () => {
        if (replied && ++readsAfterReply === (boundary === 'decoding' ? 1 : 3)) {
          // The microtask runs while the real digest following this source check is awaiting.
          queueMicrotask(() => { newer = client.analyze(cantilever()); });
        }
        return data.bodies;
      }, data.settings, .01);
      await expect(pending).resolves.toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(created).toBe(2); expect(newer).toBeDefined();
      client.dispose();
      await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { client.dispose(); }
  });

  it('cannot replay a released reservation or let it cancel a newer request', async () => {
    const data = await analysisFixture(); let created = 0;
    const client = new FemClient(() => { created++; return { postMessage: () => undefined, terminate: () => undefined,
      onmessage: null, onerror: null, onmessageerror: null }; });
    try {
      const old = client.beginSolidContactPreparation(); old.release();
      const newer = client.analyze(cantilever());
      await expect(old.analyzeSolidContact(data.input)).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      old.release(); expect(created).toBe(1);
      client.dispose(); await expect(newer).resolves.toMatchObject({ kind: 'cancelled', reason: 'disposed' });
    } finally { client.dispose(); }
  });

  it('reserves CAD before hashing so a newer direct solve cannot be replaced', async () => {
    const data = await analysisFixture(), workers: { worker: FemWorkerPort; request?: FemRequest; terminated: number }[] = [];
    const client = new FemClient(() => {
      const item: { worker: FemWorkerPort; request?: FemRequest; terminated: number } = { terminated: 0, worker: {
        postMessage(request) {
          item.request = request;
          if (workers.length > 1 && request.kind === 'analyze-solid-contact') queueMicrotask(() => item.worker.onmessage?.(
            new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result', identity: request.identity, result: zeroContactReply(request.input) } })));
        }, terminate() { item.terminated++; }, onmessage: null, onerror: null, onmessageerror: null,
      } };
      workers.push(item); return item.worker;
    });
    try {
      const old = analyzeCadSolidContact(client, data.saved, () => data.bodies, data.settings, .01);
      const newer = client.analyzeSolidContact(data.input);
      await expect(old).resolves.toEqual({ kind: 'cancelled', reason: 'superseded' });
      expect(workers).toHaveLength(1); expect(workers[0].terminated).toBe(0);
      const request = workers[0].request;
      if (request?.kind !== 'analyze-solid-contact') throw new Error('Missing newer contact request');
      workers[0].worker.onmessage?.(new MessageEvent('message', { data: { protocol: FEM_PROTOCOL, kind: 'result',
        identity: request.identity, result: zeroContactReply(request.input) } }));
      await expect(newer).resolves.toMatchObject({ kind: 'result' });
    } finally { client.dispose(); }
  });
});
