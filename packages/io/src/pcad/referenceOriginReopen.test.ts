import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createEmptyPartDocument, resolveSubShapeReference,
  type CurrentOriginIndex, type PartDocument, type SolidBody, type SubShapeRef } from '@pointercad/model';
import { migrateToCurrentSchema, parseDocument, serializeDocument } from './documentJson.js';
import { PCAD_DOCUMENT_ENTRY, readPcadFile, writePcadFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const origin = { version: 1 as const, shapeKind: 'face' as const,
  identity: { kind: 'box-face' as const, featureId: 'box-1', role: 'top' as const } };
const saved: SubShapeRef = { bodyFeatureId: 'box-1', index: 5,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 400,
    position: [0, 0, 20], axis: [0, 0, 1], radius: null }, origin };

// Fixed version-17 input, independent of the current document factory and writer.
// The old file carries geometric fingerprints, never a fabricated semantic origin.
const legacy17 = {
  schema: 17, app: 'PointerCAD', kind: 'part', savedAt: '2026-10-03T00:00:00.000Z',
  document: {
    id: 'legacy-part', name: '旧17の箱', schemaVersion: 17,
    sketches: [{ id: 'sketch-1', name: 'スケッチ1', features: [], constraints: [] }],
    activeSketchId: 'sketch-1', references: [], parameters: [],
    solids: [{ id: 'box-1', name: '箱1', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: { mode: 'absolute',
        x: { source: '0', value: 0, display: '0' }, y: { source: '0', value: 0, display: '0' },
        z: { source: '10', value: 10, display: '10' } } },
      axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box',
        sizeX: { source: '20', value: 20, display: '20' },
        sizeY: { source: '20', value: 20, display: '20' },
        sizeZ: { source: '20', value: 20, display: '20' } } }],
    sheetUnfolds: [], appearance: { entries: [] }, canvases: [], namedViews: [],
    configurations: [], activeConfigurationId: null,
    selectionSets: [{ id: 'selected', name: 'top', members: [{ kind: 'face', ref: {
      bodyFeatureId: 'box-1', index: 5, fingerprint: { kind: 'face', surfaceKind: 'plane',
        area: 400, position: [0, 0, 20], axis: [0, 0, 1], radius: null },
    } }] }],
  },
} as const;

function current(featureId: string, tracked: boolean): SolidBody {
  return { featureId, isValid: true, volume: 12_000,
    mesh: { positions: new Float32Array([0, 0, 0, 40, 30, 30]),
      normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    faces: [{ index: 17, surfaceKind: 'plane', area: 1200,
      centroid: [20, 15, 30], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 2 }], edges: [], vertices: [], threadMarks: [],
    origins: tracked ? { version: 1, state: 'tracked', bindings: [{
      origin, state: 'unique', current: { kind: 'face', index: 17 } }] }
      : { version: 1, state: 'untracked', reason: 'unsupported-operation' },
  };
}

describe('saved origin after cold document reopen', () => {
  it('migrates a fixed version-17 fixture by changing only the two version fields', () => {
    const before = JSON.stringify(legacy17);
    // 移行先は今の版(固定の版17の入力はそのまま)。版の数を決め打ちすると、版が上がるたびに落ちる。
    expect(migrateToCurrentSchema(legacy17, 17)).toEqual({ ...legacy17, schema: PCAD_SCHEMA_VERSION,
      document: { ...legacy17.document, schemaVersion: PCAD_SCHEMA_VERSION } });
    expect(JSON.stringify(legacy17)).toBe(before);
  });

  it('opens an old version-17 ZIP, resolves its unchanged reference and saves the current version', () => {
    const fixture = zipSync({ [PCAD_DOCUMENT_ENTRY]: strToU8(JSON.stringify(legacy17)) });
    const originalBytes = fixture.slice();
    const opened = readPcadFile(fixture);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const document = opened.document;
    const selected = document.selectionSets[0]?.members[0];
    if (selected?.kind !== 'face') throw new Error('旧17の面参照がありません');
    expect(document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(selected.ref).toEqual(legacy17.document.selectionSets[0].members[0].ref);
    expect(Object.hasOwn(selected.ref, 'origin')).toBe(false);
    const snapshot = JSON.stringify(document);
    const body = current('box-1', true);
    // Recomputed geometry still fits the old fingerprint, but the address has changed.
    const legacyBody: SolidBody = { ...body, faces: [{ ...body.faces[0], area: 400,
      centroid: [0, 0, 20] }] };
    const resolution = resolveSubShapeReference(legacyBody, selected.ref);
    expect(resolution.status).toBe('matched');
    if (resolution.status !== 'matched') throw new Error('旧17の面参照を解決できません');
    expect(resolution.match.reference.index).toBe(17);
    expect(resolution.match.basis).not.toBe('semantic');
    expect(resolution.originalReference).toBe(selected.ref);
    expect(Object.hasOwn(resolution.match.reference, 'origin')).toBe(false);
    const bytes = writePcadFile(document, { savedAt: legacy17.savedAt });
    const envelope: unknown = JSON.parse(strFromU8(unzipSync(bytes)[PCAD_DOCUMENT_ENTRY]));
    expect(envelope).toMatchObject({ schema: PCAD_SCHEMA_VERSION, document: { schemaVersion: PCAD_SCHEMA_VERSION,
      selectionSets: legacy17.document.selectionSets } });
    const reopened = readPcadFile(bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).toEqual(document);
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(fixture).toEqual(originalBytes);
  });

  it.each([false, true])('keeps legacy imported references ambiguous regardless of order %s', reverse => {
    const opened = parseDocument(JSON.stringify(legacy17));
    if (!opened.ok) throw new Error(opened.error.message);
    const selected = opened.document.selectionSets[0]?.members[0];
    if (selected?.kind !== 'face') throw new Error('旧17の面参照がありません');
    const before = serializeDocument(opened.document, { savedAt: legacy17.savedAt });
    const body = current('box-1', false);
    const faces = [17, 23].map(index => ({ ...body.faces[0], index, area: 400,
      centroid: [0, 0, 20] as const }));
    const imported: SolidBody = { ...body, faces: reverse ? [...faces].reverse() : faces,
      origins: { version: 1, state: 'untracked', reason: 'imported' } };
    expect(resolveSubShapeReference(imported, selected.ref).status).toBe('ambiguous');
    expect(resolveSubShapeReference({ ...imported, faces: [faces[0]] }, selected.ref).status).toBe('matched');
    expect(serializeDocument(opened.document, { savedAt: legacy17.savedAt })).toBe(before);
    expect(Object.hasOwn(selected.ref, 'origin')).toBe(false);
  });

  it('keeps saved identity and resolves a changed current address only through unique origin', () => {
    const document: PartDocument = { ...createEmptyPartDocument(),
      selectionSets: [{ id: 'selected', name: 'top', members: [{ kind: 'face', ref: saved }] }] };
    const text = serializeDocument(document, { savedAt: '2026-10-04T00:00:00.000Z' });
    const opened = parseDocument(text);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const selected = opened.document.selectionSets[0]?.members[0];
    expect(selected).toEqual({ kind: 'face', ref: saved });
    if (selected === undefined || selected.kind !== 'face') return;
    const resolved = resolveSubShapeReference(current('box-1', true), selected.ref);
    expect(resolved.status).toBe('matched');
    if (resolved.status === 'matched') {
      expect(resolved.match.reference.index).toBe(17);
      expect(resolved.match.basis).toBe('semantic');
      expect(resolved.originalReference).toBe(selected.ref);
    }
    expect(resolveSubShapeReference(current('box-1', false), selected.ref).status).toBe('missing');
    expect(resolveSubShapeReference(current('box-2', true), selected.ref).status).toBe('missing');
    expect(serializeDocument(opened.document, { savedAt: '2026-10-04T00:00:00.000Z' })).toBe(text);
  });

  it.each([false, true])('retains semantic identity across ZIP reopen and reordered geometry %s', reverse => {
    const document: PartDocument = { ...createEmptyPartDocument(),
      selectionSets: [{ id: 'selected', name: 'top', members: [{ kind: 'face', ref: saved }] }] };
    const bytes = writePcadFile(document, { savedAt: legacy17.savedAt });
    const opened = readPcadFile(bytes);
    if (!opened.ok) throw new Error(opened.error.message);
    const selected = opened.document.selectionSets[0]?.members[0];
    if (selected?.kind !== 'face') throw new Error('意味参照がありません');
    expect(selected.ref).toEqual(saved);
    const body = current('box-1', true);
    // The old address and fingerprint are a decoy; only the semantic table proves identity.
    const faces = [body.faces[0], { ...body.faces[0], index: saved.index, area: 400,
      centroid: [0, 0, 20] as const }];
    const geometry: SolidBody = { ...body, faces: reverse ? [...faces].reverse() : faces };
    expect(resolveSubShapeReference(geometry, selected.ref)).toMatchObject({ status: 'matched',
      match: { basis: 'semantic', reference: { index: 17 }, geometry: { position: [20, 15, 30] } } });
    const unresolved: readonly [CurrentOriginIndex, 'ambiguous' | 'missing'][] = [
      [{ version: 1, state: 'tracked', bindings: [{ origin, state: 'split',
        candidates: [{ kind: 'face', index: 17 }, { kind: 'face', index: 5 }] }] }, 'ambiguous'],
      [{ version: 1, state: 'tracked', bindings: [{ origin, state: 'merged',
        current: { kind: 'face', index: 17 }, coOrigins: [origin,
          { ...origin, identity: { ...origin.identity, role: 'bottom' } }] }] }, 'ambiguous'],
      [{ version: 1, state: 'tracked', bindings: [{ origin, state: 'missing', reason: 'deleted' }] }, 'missing'],
      [{ version: 1, state: 'tracked', bindings: [] }, 'missing'],
      [{ version: 1, state: 'untracked', reason: 'imported' }, 'missing'],
    ];
    for (const [origins, status] of unresolved) {
      const result = resolveSubShapeReference({ ...geometry, origins }, selected.ref);
      expect(result.status).toBe(status);
      expect(result.originalReference).toBe(selected.ref);
    }
    expect(writePcadFile(opened.document, { savedAt: legacy17.savedAt })).toEqual(bytes);
    expect(selected.ref).toEqual(saved);
  });
});
