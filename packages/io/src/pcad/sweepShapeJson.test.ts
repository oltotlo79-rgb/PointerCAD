import { appendSolid, createEmptyPartDocument, type PartDocument, type SweepFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './documentJson.js';

const savedAt = '2026-09-03T01:23:45.678Z';
const expression = (source: string, value: number) => ({ source, value, display: source });

function sweep(shape: Partial<Pick<SweepFeature, 'twistDegrees' | 'endScale' | 'wallThickness'>>): SweepFeature {
  const base = createEmptyPartDocument();
  return { id: 'sweep', name: 'スイープ', kind: 'sweep', suppressed: false, frenet: true,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    path: { sketchId: base.activeSketchId, curveIds: ['path'] }, ...shape };
}
const SHAPED = sweep({ twistDegrees: expression('90', 90), endScale: expression('0.5', 0.5), wallThickness: expression('1', 1) });

/** スイープのねじれ・終わりの大きさ・肉厚(M-07)の保存。使った文書だけ版 24 で、版 24 未満を名乗る文書のこの欄は読むのも書くのも断る。 */
describe('スイープのねじれ・終わりの大きさ・肉厚の保存形式 24(M-07)', () => {
  it('3 つの欄を式のまま往復し、欄の並びは frenet の後、開いて保存し直しても 1 バイトも変わらない', () => {
    const document = appendSolid(createEmptyPartDocument(), SHAPED);
    expect(document.schemaVersion).toBe(24);
    const encoded = serializeDocument(document, { savedAt });
    expect(encoded).toContain('"schema": 24');
    const order = ['"frenet"', '"twistDegrees"', '"endScale"', '"wallThickness"'].map(key => encoded.indexOf(key));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.solids).toEqual([SHAPED]);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
  });

  it('欄の無いスイープは版 22 のまま書き、3 つの欄を書かない', () => {
    const plain = sweep({});
    const encoded = serializeDocument(appendSolid(createEmptyPartDocument(), plain), { savedAt });
    expect(encoded).toContain('"schema": 22');
    for (const key of ['twistDegrees', 'endScale', 'wallThickness']) expect(encoded).not.toContain(`"${key}"`);
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.solids[0]).toEqual(plain);
  });

  it('版 24 未満を名乗る文書にこの欄があれば、書くのも読むのも断る(欄を捨てて形を変えない)', () => {
    for (const schemaVersion of [22, 23]) {
      const document: PartDocument = { ...createEmptyPartDocument(), schemaVersion, solids: [SHAPED] };
      expect(() => serializeDocument(document, { savedAt })).toThrow('スイープのねじれ・終わりの大きさ・肉厚を保存するには保存形式の版24が必要です。');
    }
    const encoded = serializeDocument(appendSolid(createEmptyPartDocument(), SHAPED), { savedAt });
    const forged = encoded.replace('"schema": 24', '"schema": 23').replace('"schemaVersion": 24', '"schemaVersion": 23');
    const result = parseDocument(forged);
    expect(result).toMatchObject({ ok: false, error: { code: 'notPcad' } });
    if (result.ok) throw new Error('欄が黙って捨てられました');
    expect(result.error.message).toBe('スイープのねじれ・終わりの大きさ・肉厚を読むには保存形式の版24が必要です。');
  });

  it.each(['null', 'true', '"90"'])('不正なねじれの欄 %s は断る', (value) => {
    const encoded = serializeDocument(appendSolid(createEmptyPartDocument(), SHAPED), { savedAt });
    expect(encoded).toContain('"twistDegrees": {');
    expect(parseDocument(encoded.replace('"twistDegrees": {', `"twistDegrees": ${value}, "discarded": {`)).ok).toBe(false);
  });
});
