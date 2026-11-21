import { collectSubShapes, extractEdges, makeSurface, tessellate } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, replaceSketch, type PartDocument,
  type SketchFeature, type SolidFeature, type SubShapeRef } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';

const savedAt = '2026-09-03T01:23:45.678Z';
const offsetBody = {
  id: 'offset-1', kind: 'surface', name: '面全体のオフセット', suppressed: false,
  operation: { kind: 'offsetBody', targetFeatureId: 'surface-1', distance: { source: '-4 / 2', value: -2, display: '-4 / 2' } },
} satisfies SolidFeature;
const thicken = {
  id: 'thicken-1', kind: 'thicken', name: '厚み付け', suppressed: false, targetFeatureId: 'surface-1', side: 'both',
  thickness: { source: '2 + 3', value: 5, display: '2 + 3' },
} satisfies SolidFeature;

function surfaceDocument(): PartDocument {
  const document = createEmptyPartDocument();
  const sketch = document.sketches[0];
  const line: SketchFeature = {
    id: 'line-1', kind: 'line', name: '線分', planeId: 'xy', construction: false,
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(100, 0, 0),
  };
  return appendSolid(replaceSketch(document, appendFeature(sketch, line)), {
    id: 'surface-1', kind: 'surface', name: '曲面', suppressed: false,
    operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [line.id] },
      distance: { source: '100', value: 100, display: '100' }, reversed: false },
  });
}

function withDeclaredVersion(text: string, version: number): string {
  return text.replace('"schema": 24', `"schema": ${String(version)}`)
    .replace('"schemaVersion": 24', `"schemaVersion": ${String(version)}`);
}

async function measuredBlend(): Promise<Extract<SolidFeature, { kind: 'surface' }>> {
  const oc = await loadOcctForNode();
  const sheet = makeSurface(oc, { kind: 'extrude', profile: [{ kind: 'segment', from: [0, 0, 0], to: [100, 0, 0] }],
    direction: [0, 0, 1], distance: 100 });
  try {
    const { edges } = collectSubShapes(oc, sheet.shape, tessellate(oc, sheet.shape).faceRanges, extractEdges(oc, sheet.shape).edgeRanges);
    const ref = (z: number): SubShapeRef => {
      const matches = edges.filter(edge => edge.axis !== null && Math.abs(edge.axis[0]) > 0.99 && Math.abs(edge.midpoint[2] - z) < 1e-6);
      expect(matches).toHaveLength(1);
      const [edge] = matches;
      return { bodyFeatureId: 'surface-1', index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind,
        position: edge.midpoint, length: edge.length, axis: edge.axis, radius: edge.radius } };
    };
    return { id: 'blend', kind: 'surface', name: '滑らかなつなぎ', suppressed: false,
      operation: { kind: 'blend', a: ref(0), b: ref(100), weightA: thicken.thickness, weightB: { source: '3 * 2', display: '6', value: 6 }, flipB: true } };
  } finally { sheet.delete(); }
}

describe('面ボディの加工と保存形式の版24', () => {
  const cases = [
    { name: '面全体のオフセット', feature: offsetBody },
    { name: '厚み付け', feature: thicken },
  ];

  it.each(cases)('$name を足した部品は版24で式と対象を往復する', ({ feature }) => {
    const base = surfaceDocument();
    expect(base.schemaVersion).toBe(22);
    const document = appendSolid(base, feature);
    expect(document.schemaVersion).toBe(24);
    const encoded = serializeDocument(document, { savedAt });
    expect(encoded).toContain('"schema": 24');
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(24);
    expect(reopened.document.solids).toEqual(document.solids);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
  });

  it.each(cases)('版24未満と書かれた $name は読む時も書く時も断る', ({ name, feature }) => {
    const document = appendSolid(surfaceDocument(), feature);
    const encoded = serializeDocument(document, { savedAt });
    for (const schemaVersion of [21, 22, 23]) {
      expect(() => serializeDocument({ ...document, schemaVersion }, { savedAt }))
        .toThrow(new RangeError(`${name}を保存するには保存形式の版24が必要です。`));
      expect(parseDocument(withDeclaredVersion(encoded, schemaVersion))).toMatchObject({
        ok: false, error: { code: 'notPcad', message: `${name}を読むには保存形式の版24が必要です。` },
      });
    }
  });

  it('つなぎの辺と式と反転を版24で往復し、下位の版や不正な欄を断る', async () => {
    const feature = await measuredBlend();
    const document = appendSolid(surfaceDocument(), feature);
    const encoded = serializeDocument(document, { savedAt });
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(24);
    expect(reopened.document.solids.at(-1)).toEqual(feature);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
    for (const schemaVersion of [21, 22, 23]) {
      expect(() => serializeDocument({ ...document, schemaVersion }, { savedAt }))
        .toThrow('滑らかなつなぎを保存するには保存形式の版24が必要です。');
      expect(parseDocument(withDeclaredVersion(encoded, schemaVersion)))
        .toMatchObject({ ok: false, error: { code: 'notPcad', message: '滑らかなつなぎを読むには保存形式の版24が必要です。' } });
    }
    for (const key of ['a', 'b', 'weightA', 'weightB', 'flipB']) {
      const invalid = encoded.replace('"' + key + '":', '"missingBlendField":');
      const missing = parseDocument(invalid);
      if (missing.ok) throw new Error('必須の欄がないつなぎを読み込みました。');
      expect(missing.error.code).toBe('missingField');
      expect(missing.error.message).toContain('.operation.' + key);
    }
    expect(parseDocument(encoded.replace('"flipB": true', '"flipB": 1')))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  }, 180_000);

  it('知らない曲面の作り方は版24でも断る', () => {
    const encoded = serializeDocument(appendSolid(surfaceDocument(), offsetBody), { savedAt });
    expect(parseDocument(encoded.replace('"kind": "offsetBody"', '"kind": "unknownOperation"')))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });

  it('知らない厚み付けの向きは版24でも断る', () => {
    const encoded = serializeDocument(appendSolid(surfaceDocument(), thicken), { savedAt });
    expect(parseDocument(encoded.replace('"side": "both"', '"side": "unknownSide"')))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });
});
