/**
 * A cylinder joined with its own non-consuming mirror copy carries the same semantic identities at two addresses.
 * Such members must refuse persistent-reference capture (a saved reference could never resolve), while members of an
 * unrelated body joined into the same result stay referable and keep resolving through save, reopen and recompute.
 *
 * Same native method as cylindricalHolePlacementRegeneration.test.ts: the real OCCT kernel through
 * createDirectKernelBridge, recomputePart from the model and serializeDocument/parseDocument from this package.
 *
 * Fixture choice (kernel composeSubShapeOrigins.ts 125-175): identities are consolidated per input source, so the
 * target's and the tool's equal identities stay two bindings. When both sources claim ONE shared address, the whole
 * index becomes untracked instead. A mirror image that touches or overlaps its original across the mirror plane always
 * shares sub-shapes on that plane (or coplanar end faces perpendicular to it), so the cylinder and its image are kept
 * apart: every member survives unchanged at its own address and each cylinder identity appears exactly twice.
 * Join the unrelated box first, and the mirrored cylinder last. If another boolean followed the mirror union,
 * composeSubShapeOrigins would consolidate its duplicate identities from ONE source into split bindings; that valid
 * ambiguity would not exercise the duplicate-unique capture guard. The final union keeps the two sources distinct.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { PCAD_DOCUMENT_ENTRY, readPcadFile, writePcadFile } from './pcadFile.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import {
  absoluteCoordinate,
  appendSolid,
  createDirectKernelBridge,
  createEmptyPartDocument,
  createSubShapeReference,
  recomputePart,
  resolvePart,
  PART_SCHEMA_VERSION,
  resolveCurrentOrigin,
  type BooleanFeature,
  type MirrorFeature,
  type PartDocument,
  type PartRecomputeResult,
  type PrimitiveFeature,
  type SolidBody,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { parseDocument, serializeDocument } from './documentJson.js';

let bridge: ReturnType<typeof createDirectKernelBridge> | undefined;
beforeAll(async () => {
  await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
// The bridge owns kernel state; release it once, even when a test failed.
afterAll(() => { bridge?.dispose(); bridge = undefined; });
function ownedBridge(): ReturnType<typeof createDirectKernelBridge> {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}
function recompute(document: PartDocument): Promise<PartRecomputeResult> {
  return recomputePart(document, ownedBridge());
}

const number = (value: number) => ({ source: String(value), display: String(value), value });
const RADIUS = 10, HEIGHT = 40, BOX = 10;
/** Cylinder at x = 30 and its yz image at x = -30: 60 apart > 2 * RADIUS, so they share nothing. */
const CYLINDER_X = 30;
/** Box far from both cylinders (|y| <= RADIUS for the cylinders). */
const BOX_Y = 50;
/** Same relative volume tolerance as the cylinder IO tests (kernel makeHole.test.ts 1501-1505). */
const VOLUME_RELATIVE = 1e-5;
const CYLINDER_VOLUME = Math.PI * RADIUS ** 2 * HEIGHT;
const JOINED_VOLUME = 2 * CYLINDER_VOLUME + BOX ** 3;
/** Native members of one primitive: cylinder 3 faces / 3 edges / 2 vertices, box 6 / 12 / 8. */
const CYLINDER_MEMBERS = { face: 3, edge: 3, vertex: 2 } as const;
const BOX_MEMBERS = { face: 6, edge: 12, vertex: 8 } as const;
type Kind = keyof typeof BOX_MEMBERS;
const KINDS: readonly Kind[] = ['face', 'edge', 'vertex'];

function documentWithJoin(): PartDocument {
  const cylinder: PrimitiveFeature = { id: 'cylinder-1', name: 'cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(CYLINDER_X, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: number(RADIUS), height: number(HEIGHT) } };
  const mirror: MirrorFeature = { id: 'mirror-1', name: 'mirror', kind: 'mirror', suppressed: false,
    targetFeatureId: 'cylinder-1', plane: { kind: 'workPlane', planeId: 'yz' } };
  const box: PrimitiveFeature = { id: 'box-1', name: 'box', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, BOX_Y, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: number(BOX), sizeY: number(BOX), sizeZ: number(BOX) } };
  const joinBox: BooleanFeature = { id: 'union-1', name: 'union box', kind: 'boolean', suppressed: false,
    operation: 'union', targetFeatureId: 'cylinder-1', toolFeatureId: 'box-1' };
  const joinMirror: BooleanFeature = { id: 'union-2', name: 'union mirror', kind: 'boolean', suppressed: false,
    operation: 'union', targetFeatureId: 'union-1', toolFeatureId: 'mirror-1' };
  let document = createEmptyPartDocument();
  for (const feature of [cylinder, mirror, box, joinBox, joinMirror]) document = appendSolid(document, feature);
  return document;
}

function onlyBody(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const found = bodies.filter((body) => body.featureId === featureId);
  const body = found[0];
  if (found.length !== 1 || body === undefined) throw new Error(`Expected one body of ${featureId}, got ${String(found.length)}`);
  return body;
}

/** Order-independent identity text, written here (not imported) so the test does not reuse the product's key. */
function identityText(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

function indicesOf(body: SolidBody, kind: Kind): readonly number[] {
  return kind === 'face' ? body.faces.map((entry) => entry.index)
    : kind === 'edge' ? body.edges.map((entry) => entry.index) : body.vertices.map((entry) => entry.index);
}

interface Census {
  /** Addresses whose only claim is an identity of the mirrored cylinder that occurs twice in the index. */
  readonly duplicated: Readonly<Record<Kind, readonly number[]>>;
  /** Addresses whose only claim is a box identity that occurs once. */
  readonly unique: Readonly<Record<Kind, readonly number[]>>;
}

/** Classifies every current member from the actual product index (no fabricated origins). */
function census(body: SolidBody): Census {
  const origins = body.origins;
  if (origins?.state !== 'tracked') throw new Error(`Expected tracked origins on ${body.featureId}, got ${JSON.stringify(origins)}`);
  const occurrences = new Map<string, number>();
  for (const binding of origins.bindings) {
    const text = identityText(binding.origin);
    occurrences.set(text, (occurrences.get(text) ?? 0) + 1);
  }
  const duplicated: Record<Kind, number[]> = { face: [], edge: [], vertex: [] };
  const unique: Record<Kind, number[]> = { face: [], edge: [], vertex: [] };
  for (const kind of KINDS) {
    for (const index of indicesOf(body, kind)) {
      const claims = origins.bindings.filter((binding) => binding.state === 'unique'
        && binding.current.kind === kind && binding.current.index === index);
      const claim = claims[0];
      if (claims.length !== 1 || claim === undefined) throw new Error(`Expected one claim at ${kind}:${String(index)}`);
      const identity: unknown = claim.origin.identity;
      const featureId = typeof identity === 'object' && identity !== null && 'featureId' in identity ? identity.featureId : undefined;
      const count = occurrences.get(identityText(claim.origin));
      if (featureId === 'cylinder-1' && count === 2) duplicated[kind].push(index);
      else if (featureId === 'box-1' && count === 1) unique[kind].push(index);
      else throw new Error(`Unexpected claim at ${kind}:${String(index)}: ${identityText(claim.origin)} x${String(count)}`);
    }
  }
  return { duplicated, unique };
}

/** Every duplicated member refuses capture; every unique box member captures a reference that resolves to itself. */
function expectCapture(body: SolidBody): { readonly census: Census; readonly references: readonly unknown[] } {
  const found = census(body);
  const references: unknown[] = [];
  for (const kind of KINDS) {
    expect(found.duplicated[kind].length).toBe(2 * CYLINDER_MEMBERS[kind]);
    expect(found.unique[kind].length).toBe(BOX_MEMBERS[kind]);
    for (const index of found.duplicated[kind]) {
      expect(createSubShapeReference(body, kind, index)).toBeNull();
    }
    for (const index of found.unique[kind]) {
      const reference = createSubShapeReference(body, kind, index);
      if (reference === null) throw new Error(`Unique ${kind}:${String(index)} must be referable`);
      expect(resolveCurrentOrigin(body, reference)).toEqual({ status: 'matched', address: { kind, index }, basis: 'semantic' });
      references.push(reference);
    }
  }
  return { census: found, references };
}

function expectJoined(result: PartRecomputeResult): SolidBody {
  expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
  // Both unions consume their inputs: only the final joined body is left.
  expect(result.bodies.map((body) => body.featureId)).toEqual(['union-2']);
  const joined = onlyBody(result.bodies, 'union-2');
  expect(Math.abs(joined.volume - JOINED_VOLUME) / JOINED_VOLUME).toBeLessThan(VOLUME_RELATIVE);
  return joined;
}

async function saveAndReopen(document: PartDocument): Promise<PartRecomputeResult> {
  const reopened = parseDocument(serializeDocument(document));
  if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
  expect(reopened.document).toEqual(document);
  return recompute(reopened.document);
}

describe('a cylinder joined with its non-consuming mirror copy refuses ambiguous persistent references', () => {
  it('refuses every duplicated mirror-union member, keeps unrelated box references, and stays the same after save/reopen', async () => {
    const document = documentWithJoin();
    const first = expectCapture(expectJoined(await recompute(document)));
    // Deterministic: a second recompute and a true save/reopen classify and capture exactly the same members.
    const again = expectCapture(expectJoined(await recompute(document)));
    const reopenedJoined = expectJoined(await saveAndReopen(document));
    const reopened = expectCapture(reopenedJoined);
    expect(again).toEqual(first);
    expect(reopened).toEqual(first);

    // A captured box face is used as a saved mirror plane; after save/reopen it still resolves and mirrors the
    // joined body (a reflection keeps the volume). The ambiguous cylinder faces could not have been saved at all.
    const plane = createSubShapeReference(reopenedJoined, 'face', reopened.census.unique.face[0] ?? -1);
    if (plane === null) throw new Error('Box face reference missing');
    const mirrorJoined: MirrorFeature = { id: 'mirror-2', name: 'mirror joined', kind: 'mirror', suppressed: false,
      targetFeatureId: 'union-2', plane: { kind: 'face', face: plane } };
    const withPlane = appendSolid(document, mirrorJoined);
    for (const result of [await recompute(withPlane), await saveAndReopen(withPlane)]) {
      expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
      const image = onlyBody(result.bodies, 'mirror-2');
      expect(Math.abs(image.volume - JOINED_VOLUME) / JOINED_VOLUME).toBeLessThan(VOLUME_RELATIVE);
      // The mirror does not consume union-2; its duplicated members still refuse capture after reopen.
      expectCapture(onlyBody(result.bodies, 'union-2'));
    }
  }, 180_000);
});

describe('EX14 actual PCAD extrusion graph persistence', () => {
  it.each(['union', 'subtract'] as const)('%s survives legacy/current PCAD and an authored revision without stale geometry', async (operation) => {
    // Independent old-format input: neither the current document factory nor writer creates it.
    const legacy = {
      schema: 17, app: 'PointerCAD', kind: 'part', savedAt: '2026-10-23T00:00:00.000Z',
      document: {
        id: 'ex14-persist-part', name: 'EX14 persisted extrusion', schemaVersion: 17,
        sketches: [{ id: 'sketch-1', name: 'profile', constraints: [], features: [
          // Four independently saved producers are required for persistent extrusion identities.
          // A rectangle's four derived edges do not carry four independently saved line IDs.
          { id: 'profile-bottom', name: 'bottom', kind: 'line', planeId: 'xy', construction: false,
            from: { mode: 'absolute', x: number(0), y: number(0), z: number(0) },
            to: { mode: 'absolute', x: number(4), y: number(0), z: number(0) } },
          { id: 'profile-right', name: 'right', kind: 'line', planeId: 'xy', construction: false,
            from: { mode: 'absolute', x: number(4), y: number(0), z: number(0) },
            to: { mode: 'absolute', x: number(4), y: number(6), z: number(0) } },
          { id: 'profile-top', name: 'top', kind: 'line', planeId: 'xy', construction: false,
            from: { mode: 'absolute', x: number(4), y: number(6), z: number(0) },
            to: { mode: 'absolute', x: number(0), y: number(6), z: number(0) } },
          { id: 'profile-left', name: 'left', kind: 'line', planeId: 'xy', construction: false,
            from: { mode: 'absolute', x: number(0), y: number(6), z: number(0) },
            to: { mode: 'absolute', x: number(0), y: number(0), z: number(0) } },
          { id: 'profile', name: 'profile', kind: 'face', planeId: 'xy', color: '#7aa2f7',
            boundary: [{ featureId: 'profile-bottom' }, { featureId: 'profile-right' },
              { featureId: 'profile-top' }, { featureId: 'profile-left' }] },
        ] }],
        activeSketchId: 'sketch-1', references: [], parameters: [],
        solids: [
          { id: 'ex14-target', name: 'target', kind: 'extrude', suppressed: false,
            profile: { sketchId: 'sketch-1', faceFeatureId: 'profile' },
            distance: { source: '3+4', value: 7, display: '7' }, reversed: false, symmetric: false },
          { id: 'ex14-tool', name: 'tool', kind: 'extrude', suppressed: false,
            profile: { sketchId: 'sketch-1', faceFeatureId: 'profile' },
            distance: { source: '1+2', value: 3, display: '3' }, reversed: false, symmetric: false },
          { id: 'ex14-result', name: 'result', kind: 'boolean', suppressed: false, operation,
            targetFeatureId: 'ex14-target', toolFeatureId: 'ex14-tool' },
        ],
        sheetUnfolds: [], appearance: { entries: [] }, canvases: [], namedViews: [],
        configurations: [], activeConfigurationId: null, selectionSets: [],
      },
    };
    const legacyBytes = zipSync({ [PCAD_DOCUMENT_ENTRY]: strToU8(JSON.stringify(legacy)) });
    const opened = readPcadFile(legacyBytes);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.schemaVersion).toBe(PART_SCHEMA_VERSION);
    expect(opened.document.solids[0]).toMatchObject({ id: 'ex14-target', kind: 'extrude',
      profile: { sketchId: 'sketch-1', faceFeatureId: 'profile' },
      distance: { source: '3+4', value: 7, display: '7' } });
    expect(opened.document.solids[2]).toMatchObject({ kind: 'boolean', operation,
      targetFeatureId: 'ex14-target', toolFeatureId: 'ex14-tool' });
    const beforeGraph = resolvePart(opened.document);
    expect(beforeGraph.errors).toEqual([]);
    expect(beforeGraph.steps.map(step => step.featureId)).toEqual(['ex14-target', 'ex14-tool', 'ex14-result']);
    expect(beforeGraph.steps[0].plan).toMatchObject({ kind: 'extrude', distance: 7 });
    expect(beforeGraph.steps[1].plan).toMatchObject({ kind: 'extrude', distance: 3 });
    for (const step of beforeGraph.steps.slice(0, 2)) {
      expect(step.plan).toMatchObject({ kind: 'extrude', profileOrigin: {
        sketchId: 'sketch-1', faceFeatureId: 'profile',
        lineFeatureIds: ['profile-bottom', 'profile-right', 'profile-top', 'profile-left'],
      } });
    }
    expect(beforeGraph.steps[2].plan).toMatchObject({ kind: 'boolean', operation,
      targetKey: beforeGraph.steps[0].key, toolKey: beforeGraph.steps[1].key });

    const before = await recompute(opened.document);
    expect(before.errors).toEqual([]);
    expect(before.bodies.map(body => body.featureId)).toEqual(['ex14-result']);
    const body = onlyBody(before.bodies, 'ex14-result');
    // A 4 * 6 cross-section with heights 7 and 3: union=168, subtraction=96 mm^3.
    expect(body.volume).toBeCloseTo(operation === 'union' ? 168 : 96, 6);
    const top = body.faces.find(face => face.surfaceKind === 'plane' && Math.abs(face.centroid[2] - 7) < 1e-7);
    if (top === undefined) throw new Error('Expected the independent z=7 top face');
    expect(body.origins?.state).toBe('tracked');
    const reference = createSubShapeReference(body, 'face', top.index);
    if (reference === null) throw new Error('Expected a stable reference to the retained target top face');
    expect(reference.origin).toEqual({ version: 1, shapeKind: 'face', identity: {
      kind: 'extrude-cap', featureId: 'ex14-target', end: 'end', profile: {
        sketchId: 'sketch-1', faceFeatureId: 'profile',
        lineFeatureIds: ['profile-bottom', 'profile-right', 'profile-top', 'profile-left'],
      },
    } });
    const savedDocument: PartDocument = { ...opened.document, selectionSets: [{
      id: 'ex14-top', name: 'saved target top', members: [{ kind: 'face', ref: reference }],
    }] };
    const bytes = writePcadFile(savedDocument, { savedAt: '2026-10-23T00:00:00.000Z' });
    const entries = unzipSync(bytes);
    expect(Object.keys(entries)).toEqual([PCAD_DOCUMENT_ENTRY]);
    const documentEntry = entries[PCAD_DOCUMENT_ENTRY];
    if (documentEntry === undefined) throw new Error('Missing actual PCAD document entry');
    // Derived native bodies are recomputed, never smuggled into the archive as saved results.
    expect(strFromU8(documentEntry)).not.toContain('"bodies"');
    expect(strFromU8(documentEntry)).not.toContain('"cache"');
    const current = readPcadFile(bytes);
    if (!current.ok) throw new Error(current.error.message);
    expect(current.document.solids).toEqual(savedDocument.solids);
    expect(current.document.sketches).toEqual(savedDocument.sketches);
    const member = current.document.selectionSets[0]?.members[0];
    if (member?.kind !== 'face') throw new Error('Missing saved extrusion top reference');
    expect(member.ref).toEqual(reference);
    expect(resolvePart(current.document).steps).toEqual(beforeGraph.steps);

    // A fresh bridge proves that saved keys/IDs are enough to rebuild the real graph after reopening.
    const cold = createDirectKernelBridge(createKernelApi(loadOcctForNode));
    try {
      const rebuilt = await recomputePart(current.document, cold);
      expect(rebuilt.errors).toEqual([]);
      const rebuiltBody = onlyBody(rebuilt.bodies, 'ex14-result');
      expect(rebuiltBody).not.toBe(body);
      expect(rebuiltBody.volume).toBeCloseTo(operation === 'union' ? 168 : 96, 6);
      expect(resolveCurrentOrigin(rebuiltBody, member.ref)).toMatchObject({ status: 'matched', basis: 'semantic' });

      // An authored revision uses the same feature/reference IDs but a genuinely different input.
      const revised: PartDocument = { ...current.document,
        solids: current.document.solids.map(feature => feature.id === 'ex14-target' && feature.kind === 'extrude'
          ? { ...feature, distance: { source: '4+5', value: 9, display: '9' } } : feature) };
      const revisedRead = readPcadFile(writePcadFile(revised, { savedAt: '2026-10-23T00:00:00.000Z' }));
      if (!revisedRead.ok) throw new Error(revisedRead.error.message);
      expect(revisedRead.document.solids[0]).toMatchObject({ id: 'ex14-target',
        distance: { source: '4+5', value: 9, display: '9' } });
      expect(revisedRead.document.selectionSets).toEqual(current.document.selectionSets);
      const revisedGraph = resolvePart(revisedRead.document);
      expect(revisedGraph.errors).toEqual([]);
      expect(revisedGraph.steps.map(step => step.featureId)).toEqual(['ex14-target', 'ex14-tool', 'ex14-result']);
      expect(revisedGraph.steps[0].key).not.toBe(beforeGraph.steps[0].key);
      expect(revisedGraph.steps[1].plan).toMatchObject({ kind: 'extrude', distance: 3 });
      expect(revisedGraph.steps[2].key).not.toBe(beforeGraph.steps[2].key);
      expect(revisedGraph.steps[2].plan).toMatchObject({ kind: 'boolean', operation,
        targetKey: revisedGraph.steps[0].key, toolKey: revisedGraph.steps[1].key });
      // Reuse the populated bridge: accepting the old input fingerprint would return the old volume.
      const changed = await recomputePart(revisedRead.document, cold);
      expect(changed.errors).toEqual([]);
      const changedBody = onlyBody(changed.bodies, 'ex14-result');
      expect(changedBody.volume).toBeCloseTo(operation === 'union' ? 216 : 144, 6);
      const resolution = resolveCurrentOrigin(changedBody, member.ref);
      expect(resolution).toMatchObject({ status: 'matched', basis: 'semantic' });
      if (resolution.status !== 'matched') throw new Error('Saved top reference was lost after the authored revision');
      const changedTop = changedBody.faces.find(face => face.index === resolution.address.index);
      if (changedTop === undefined) throw new Error('Missing resolved top face after revision');
      expect(changedTop.centroid[2]).toBeCloseTo(9, 6);
    } finally { cold.dispose(); }
  });
});
