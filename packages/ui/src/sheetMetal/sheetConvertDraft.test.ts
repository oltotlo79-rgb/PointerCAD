import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, defaultSheetMetalRule } from '@pointercad/model';
import { planeBody } from '../assembly/filletWeldBodies.testSupport.js';
import { selectedConvertFace, sheetConvertCandidate } from './sheetConvertDraft.js';

const body = planeBody([[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]], [0, 0, 1]);

describe('M-08 立体を板金へ変える行の下書き', () => {
  it('選択の最初の平らな面を基準にし、面が無い・平らでない時はそれぞれの文の鍵を返す', () => {
    const picked = selectedConvertFace([body.featureId, `${body.featureId}#face:0`], [body]);
    if (!picked.ok) throw new Error(picked.messageKey);
    expect(picked.sourceFeatureId).toBe(body.featureId);
    expect(picked.face).toMatchObject({ bodyFeatureId: body.featureId, index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane' } });
    expect(selectedConvertFace([body.featureId, `${body.featureId}#edge:0`], [body])).toEqual({ ok: false, messageKey: 'sheetMetal.convertNeedFace' });
    const curved = { ...body, faces: body.faces.map(face => ({ ...face, surfaceKind: 'cylinder' as const })) };
    expect(selectedConvertFace([`${body.featureId}#face:0`], [curved])).toEqual({ ok: false, messageKey: 'sheetMetal.convertNotPlanar' });
  });

  it('編集中の変換の行の板の面は拾わず、ほかの立体の面だけを元にする', () => {
    const converted = { ...body, featureId: 'sheetConvert-1' };
    expect(selectedConvertFace(['sheetConvert-1#face:0'], [converted, body], 'sheetConvert-1'))
      .toEqual({ ok: false, messageKey: 'sheetMetal.convertNeedFace' });
    const picked = selectedConvertFace(['sheetConvert-1#face:0', `${body.featureId}#face:0`], [converted, body], 'sheetConvert-1');
    expect(picked.ok && picked.sourceFeatureId).toBe(body.featureId);
  });

  it('新しく作る時は末尾へ足し、編集の時は同じ id の行を差し替える', () => {
    const empty = createEmptyPartDocument();
    const document = appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), id: body.featureId });
    const picked = selectedConvertFace([`${body.featureId}#face:0`], [body]);
    if (!picked.ok) throw new Error(picked.messageKey);
    const rule = { innerRadius: defaultSheetMetalRule().innerRadius, kFactor: defaultSheetMetalRule().kFactor };
    const created = sheetConvertCandidate(document, picked, rule);
    expect(created.document.solids.map(feature => feature.kind)).toEqual(['primitive', 'sheetConvert']);
    expect(created.feature).toMatchObject({ kind: 'sheetConvert', sourceFeatureId: body.featureId, referenceFace: picked.face, rule });
    expect(created.document.schemaVersion).toBe(24);
    const changed = { ...rule, kFactor: { ...rule.kFactor, source: '0.3', value: 0.3 } };
    const edited = sheetConvertCandidate(created.document, picked, changed, created.feature);
    expect(edited.document.solids).toHaveLength(2);
    expect(edited.feature.id).toBe(created.feature.id);
    expect(edited.feature.rule.kFactor.value).toBe(0.3);
  });
});
