import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, type PartDocument, type SolidFeature } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';

const savedAt = '2026-09-03T01:23:45.678Z';
// 立体を板金へ変える行(M-08)。保存するのは元の履歴 id・基準の面の参照・内半径と K 係数の式だけ。
const convert = {
  id: 'convert-1', kind: 'sheetConvert', name: '板金へ変換', suppressed: false, sourceFeatureId: 'box-1',
  referenceFace: { bodyFeatureId: 'box-1', index: 5,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [5, 5, 10], axis: [0, 0, 1], radius: null } },
  rule: { innerRadius: { source: '1 + 1', value: 2, display: '1 + 1' }, kFactor: { source: '0.4', value: 0.4, display: '0.4' } },
} satisfies SolidFeature;

function boxDocument(): PartDocument {
  const empty = createEmptyPartDocument();
  return appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), id: 'box-1' });
}
function withDeclaredVersion(text: string, version: number): string {
  return text.replace('"schema": 24', `"schema": ${String(version)}`)
    .replace('"schemaVersion": 24', `"schemaVersion": ${String(version)}`);
}

describe('M-08 立体を板金へ変える行と保存形式の版24', () => {
  it('変換の行を足した部品だけ版24になり、元・基準の面・式を往復する。変換の無い部品は版22のまま', () => {
    const base = boxDocument();
    expect(base.schemaVersion).toBe(22);
    const plain = serializeDocument(base, { savedAt });
    expect(plain).toContain('"schema": 22');
    const document = appendSolid(base, convert);
    expect(document.schemaVersion).toBe(24);
    const encoded = serializeDocument(document, { savedAt });
    expect(encoded).toContain('"schema": 24');
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(24);
    expect(reopened.document.solids).toEqual(document.solids);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
    const old = parseDocument(plain);
    if (!old.ok) throw new Error(old.error.message);
    expect(old.document.schemaVersion).toBe(22);
  });

  it('版24未満と書かれた変換の行は読む時も書く時も断る', () => {
    const document = appendSolid(boxDocument(), convert);
    const encoded = serializeDocument(document, { savedAt });
    for (const schemaVersion of [21, 22, 23]) {
      expect(() => serializeDocument({ ...document, schemaVersion }, { savedAt }))
        .toThrow(new RangeError('板金への変換を保存するには保存形式の版24が必要です。'));
      expect(parseDocument(withDeclaredVersion(encoded, schemaVersion))).toMatchObject({
        ok: false, error: { code: 'notPcad', message: '板金への変換を読むには保存形式の版24が必要です。' },
      });
    }
  });

  it('欄の欠け・面でない基準・自分を元にする行・K 係数の範囲外を断る', () => {
    const encoded = serializeDocument(appendSolid(boxDocument(), convert), { savedAt });
    for (const key of ['sourceFeatureId', 'referenceFace', 'rule']) {
      const missing = parseDocument(encoded.replace('"' + key + '":', '"missingConvertField":'));
      expect(missing).toMatchObject({ ok: false, error: { code: 'missingField' } });
    }
    expect(parseDocument(encoded.replace('"kind": "face"', '"kind": "vertex"'))).toMatchObject({ ok: false });
    expect(parseDocument(encoded.replace('"sourceFeatureId": "box-1"', '"sourceFeatureId": "convert-1"')))
      .toMatchObject({ ok: false, error: { code: 'invalidField' } });
    expect(parseDocument(encoded.replace('"value": 0.4', '"value": 0.7'))).toMatchObject({ ok: false, error: { code: 'invalidField' } });
  });
});
