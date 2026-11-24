import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createEmptyPartDocument, createOffsetCache, createProjectionCache, createSheetFlangeFeature,
  createSubShapeCache, DEFAULT_PRIMITIVE_AXIS, resolvePart, sheetBoundaryEdges, type PartDocument, type PrimitiveFeature,
  type SheetConvertFeature, type SheetConvertLookup, type SheetConvertReason, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { failureMessage } from '../i18n/failureMessage.js';
import { MESSAGE_KEYS, t } from '../i18n/t.js';
import { resolveCachedSteps } from '../solid/resolveCachedSteps.js';
import { buildSheetCreation } from './sheetCommands.js';

/** 断る理由の符号の全部(型が数え漏れを見張る)。文は画面の側の一覧(ja/sheetMetal.json)が持つ。 */
const REASONS: Readonly<Record<SheetConvertReason, true>> = {
  invalidSource: true, ambiguousPair: true, variableThickness: true, unsupportedBend: true, cutAcrossBend: true, unsupportedBoundary: true,
  unsupportedConnection: true, sourceChanged: true, invalidRule: true, consumed: true, missingSource: true, pending: true, missingBody: true,
  workerBroken: true, rpcFailed: true,
};

// 50×30×2 の箱と、その下の面 z=0 を基準に板金へ変える行。認識の答えは計算部の代わりに手で組む(平板 1 枚)。
const box: PrimitiveFeature = { id: 'box-1', name: 'box', kind: 'primitive', suppressed: false,
  origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: DEFAULT_PRIMITIVE_AXIS,
  shape: { kind: 'box', sizeX: expressionValueFromNumber(50), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(2) } };
const convert: SheetConvertFeature = { kind: 'sheetConvert', id: 'convert-1', name: '板金へ変換1', suppressed: false, sourceFeatureId: 'box-1',
  referenceFace: { bodyFeatureId: 'box-1', index: 4,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1500, position: [25, 15, 0], axis: [0, 0, -1], radius: null } },
  rule: { innerRadius: expressionValueFromNumber(3), kFactor: expressionValueFromNumber(0.4) } };
const corners: readonly Vec3[] = [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]];
const lookup: SheetConvertLookup = request => request.id !== convert.id ? undefined : {
  reply: { id: request.id, kind: 'recognized', recognition: { ok: true, thickness: 2, bends: [], panels: [{ faceIndex: 4, oppositeFaceIndex: 5,
    inward: [0, 0, 1], holes: [], outer: corners.map((from, i) => ({ edgeIndex: i, curve: { kind: 'segment', from, to: corners[(i + 1) % 4] } })) }] } },
  origins: { face: () => null, edge: () => null },
};
const document: PartDocument = appendSolid(appendSolid(createEmptyPartDocument(), box), convert);

describe('M-08 変換した板金を、画面の確かめ・測定・書き出しの純な解決でも元にできる', () => {
  it('断る理由の符号は 15 種で、どれも文言の表に文がある(内部の誤りの文へ落ちない)', () => {
    const keys = Object.keys(REASONS).map(reason => `partError.sheetConvert.${reason}`);
    expect(keys).toHaveLength(15);
    for (const key of keys) {
      expect(MESSAGE_KEYS, key).toContain(key);
      expect(failureMessage({ key, parameters: {} })).not.toBe(t('assembly.error.internal'));
    }
  });

  it('認識の答えを渡すと、変換した板金の長い縁へのフランジを確定前の確かめで受け付ける(渡さないと元の板金が無いと断る)', () => {
    const sheet = resolvePart(document, { sheetRecognition: lookup }).sheetMetalBodies?.get(convert.id);
    const panel = sheet?.panels[0];
    if (panel === undefined) throw new Error('変換した板金の板がありません');
    const edges = sheetBoundaryEdges(panel);
    const long = edges.ok ? edges.value.find(edge => Math.hypot(...edge.to.map((value, i) => value - edge.from[i])) > 40) : undefined;
    if (long === undefined) throw new Error('長さ 50 の縁がありません');
    const flange = createSheetFlangeFeature(document, convert.id, [{ panelId: panel.id, boundaryId: long.id }]);
    expect(buildSheetCreation(document, flange, {}, 'mm', {}).ok).toBe(false);
    const built = buildSheetCreation(document, flange, {}, 'mm', { sheetRecognition: lookup });
    if (!built.ok) throw new Error(built.message);
    expect(built.document.solids.map(feature => feature.kind)).toEqual(['primitive', 'sheetConvert', 'sheetFlange']);
  });

  it('測定・書き出しの解き直しも、覚え書きの答えで変換の段を作り、元の箱を消費する(答えが無いと変換の段が無い)', () => {
    const deps = { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache() };
    const withAnswers = resolveCachedSteps(document, { ...deps, sheetRecognitions: { lookup } });
    expect(withAnswers.map(step => [step.featureId, step.plan.kind, step.visible])).toEqual([['box-1', 'primitive', false],
      ['convert-1', 'sheetBody', true]]);
    expect(resolveCachedSteps(document, deps).map(step => step.featureId)).toEqual(['box-1']);
  });
});
