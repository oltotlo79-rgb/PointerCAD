import { appendSolid, createEmptyPartDocument, PART_SCHEMA_VERSION, type LoftFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './documentJson.js';

function serialized(smooth: boolean, directCurves = true, schemaVersion = PART_SCHEMA_VERSION): string {
  const document = createEmptyPartDocument();
  const loft: LoftFeature = { id: 'loft-1', name: 'ロフト1', kind: 'loft', suppressed: false, smooth,
    twist: { source: '1', value: 1, display: '1' }, sections: [0, 1].map((index) => directCurves
      ? { kind: 'sketchCurves', ref: { sketchId: document.activeSketchId, curveIds: [`spline-${index}`] } }
      : { kind: 'sketchFace', ref: { sketchId: document.activeSketchId, faceFeatureId: `face-${index}` } }) };
  return serializeDocument({ ...appendSolid(document, loft), schemaVersion });
}

describe('P11b ロフトの保存形式13', () => {
  it.each([false, true])('平滑化%sと断面の参照・順序が往復する', (smooth) => {
    const result = parseDocument(serialized(smooth)); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.document.solids[0]).toMatchObject({ smooth, twist: { source: '1' }, sections: [
      { kind: 'sketchCurves', ref: { curveIds: ['spline-0'] } }, { kind: 'sketchCurves', ref: { curveIds: ['spline-1'] } },
    ] });
  });
  it('版12のロフトにだけ既存どおりのfalseを補う', () => {
    // The legacy fixture owns its version; a future writer version must not change this migration input.
    const source = serialized(false, false, 12);
    expect(source).toContain('"schema": 12'); expect(source).toContain('"schemaVersion": 12');
    expect(source).toContain('"smooth": false,');
    const old = source.replace('"smooth": false,', '');
    const result = parseDocument(old); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.document.solids[0]).toMatchObject({ smooth: false });
    expect(result.document.schemaVersion).toBe(PART_SCHEMA_VERSION);
  });
  it('平滑化を必須にした版13でも欠落を旧版の既定値で埋めない', () => {
    const source = serialized(false, false, 13);
    expect(source).toContain('"schema": 13'); expect(source).toContain('"schemaVersion": 13');
    expect(source).toContain('"smooth": false,');
    expect(parseDocument(source.replace('"smooth": false,', '')).ok).toBe(false);
  });
  it.each(['"smooth": null,', '"smooth": "true",', '"smooth": 1,', ''])('現行版の不正/欠落平滑化を拒否する %s', (replacement) => {
    const source = serialized(false);
    expect(source).toContain('"smooth": false,');
    expect(parseDocument(source.replace('"smooth": false,', replacement)).ok).toBe(false);
  });
});
