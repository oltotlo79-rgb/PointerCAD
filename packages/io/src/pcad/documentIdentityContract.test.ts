import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { findSketch, findSolid, resolveSketch } from '@pointercad/model';
import { parseDocument } from './documentJson.js';
import { readPcadFile } from './pcadFile.js';

const expression = (value: number) => ({ source: String(value), value, display: String(value) });
const absolute = (x: number, y = 0) => ({ mode: 'absolute', x: expression(x), y: expression(y), z: expression(0) });
const point = (id: string, x: number, y = 0) => ({ id, kind: 'point', name: id, planeId: 'xy', at: absolute(x, y) });
const solid = (id: string) => ({ id, kind: 'extrude', name: id, suppressed: false,
  profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' }, distance: expression(10), reversed: false, symmetric: false });

function sketch(id: string, base = 1) {
  return { id, name: id, features: [
    point('point-1', base),
    { id: 'point-2', kind: 'point', name: 'dependent point', planeId: 'xy', at: { mode: 'relative',
      base: { kind: 'point', pointId: 'point-1' }, dx: expression(10), dy: expression(0), dz: expression(0) } },
    point('point-3', base, 10),
    { id: 'face-1', kind: 'face', name: 'triangle', planeId: 'xy',
      boundary: [{ featureId: 'point-1' }, { featureId: 'point-2' }, { featureId: 'point-3' }], color: '#7aa2f7' },
  ] };
}

/** Hand-authored historical/current field layouts, not a current serialized file with its version lowered. */
function rawFile(version: 3 | 22, changes: Record<string, unknown> = {}) {
  return { schema: version, kind: 'part', app: 'PointerCAD', savedAt: '2026-09-03T01:23:45.678Z', document: {
    schemaVersion: version, id: 'part-1', name: 'identity fixture', activeSketchId: 'sketch-1',
    sketches: [sketch('sketch-1')], solids: [solid('extrude-1')],
    ...(version === 22 ? { references: [], parameters: [], appearance: { entries: [] }, selectionSets: [], canvases: [],
      namedViews: [], configurations: [{ id: 'config-1', name: 'default', values: {} }],
      activeConfigurationId: 'config-1', sheetUnfolds: [] } : {}),
    ...changes,
  } };
}

function read(raw: ReturnType<typeof rawFile>, boundary: 'JSON' | 'PCAD') {
  const text = JSON.stringify(raw);
  return boundary === 'JSON' ? parseDocument(text) : readPcadFile(zipSync({ 'document.json': strToU8(text) }));
}

describe.each([3, 22] as const)('external identity scopes in schema%s', version => {
  it.each(['JSON', 'PCAD'] as const)('keeps equal feature IDs in distinct sketches unambiguous through %s', boundary => {
    const raw = rawFile(version, { sketches: [sketch('sketch-1', 1), sketch('sketch-2', 2)] });
    const before = structuredClone(raw);
    const result = read(raw, boundary);
    if (!result.ok) throw new Error(result.error.message);
    for (const [id, expectedX] of [['sketch-1', 11], ['sketch-2', 12]] as const) {
      const document = findSketch(result.document, id);
      if (document === undefined) throw new Error(`lost ${id}`);
      expect(resolveSketch(document).points.find(value => value.featureId === 'point-2')?.position).toEqual([expectedX, 0, 0]);
    }
    expect(raw).toEqual(before);
  });

  it.each(['JSON', 'PCAD'] as const)('keeps the sketch feature and solid lookup namespaces separate through %s', boundary => {
    const result = read(rawFile(version, { solids: [solid('point-1')] }), boundary);
    if (!result.ok) throw new Error(result.error.message);
    expect(findSolid(result.document, 'point-1')?.kind).toBe('extrude');
    expect(resolveSketch(result.document.sketches[0]).points.find(value => value.featureId === 'point-1')?.position).toEqual([1, 0, 0]);
  });

  it.each(['JSON', 'PCAD'] as const)('rejects one repeated point ID inside one sketch through %s', boundary => {
    const original = sketch('sketch-1');
    const duplicate = { ...original, features: [...original.features, point('point-1', 99)] };
    expect(read(rawFile(version, { sketches: [duplicate] }), boundary)).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it.each(['JSON', 'PCAD'] as const)('rejects one point/line ID collision inside one sketch through %s', boundary => {
    const original = sketch('sketch-1');
    // replaceFeature/removeFeature identify by ID alone; a type tag does not disambiguate an edit.
    const duplicate = { ...original, features: [...original.features,
      { id: 'point-1', kind: 'line', name: 'colliding line', planeId: 'xy', from: absolute(20), to: absolute(30),
        ...(version === 22 ? { construction: false } : {}) }] };
    expect(read(rawFile(version, { sketches: [duplicate] }), boundary)).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it.each(['JSON', 'PCAD'] as const)('rejects one repeated sketch ID in the part through %s', boundary => {
    expect(read(rawFile(version, { sketches: [sketch('sketch-1', 1), sketch('sketch-1', 2)] }), boundary))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it.each(['JSON', 'PCAD'] as const)('rejects one repeated solid/body ID in the part through %s', boundary => {
    expect(read(rawFile(version, { solids: [solid('extrude-1'), { ...solid('extrude-1'), name: 'second body' }] }), boundary))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });
});
