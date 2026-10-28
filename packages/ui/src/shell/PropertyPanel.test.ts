/**
 * `PropertyPanel.tsx` の (g)「拘束で決まった、いまの位置」の表示だけを
 * 有効数字 9 桁へ丸める `roundSolvedCoordinateText`(P4b タスク23b-1)を検査する。
 * 保存値・入力欄には触れない機能なので、ここでは丸めの文字列だけを見る
 * (vitest の include は `src/**\/*.test.ts` のみで `.tsx` を含まないので、
 * このファイルはコンポーネントを描画せず純関数だけを呼ぶ)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, findSolid, FREE_WORK_PLANE_ID, replaceSolid,
  type HoleFeature, type SketchFeature, type ThreadHoleFeature } from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { historyFormula, nativeHistoryHarness, shapeSha } from '../solid/holeThreadHistory.testSupport.js';
import { summarizeSolid } from '../solid/solidSummary.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { reconcileDraftVersion } from './fieldDraft.js';
import type { FieldUnits } from './propertyFieldUnits.js';

import {
  appearanceSectionKey,
  cutSectionKey,
  createSolidPropertyFieldEdit,
  massSectionKey,
  measureSectionKey,
  primitiveSectionKey,
  roundSolvedCoordinateText,
  reconcileCylindricalPropertySelection,
  ruledSectionKey,
  setSphereGridAngle,
  sphereGridAnglesOf,
  sphereGridSectionKey,
} from './PropertyPanel.js';

const locationUnits: FieldUnits = { variables: new Map([['高さ', 17]]), exactVariables: new Map([['高さ', '17']]),
  nonLengthVariables: new Set(), lengthUnit: 'mm', pendingVariables: new Set() };
const indexedHole: HoleFeature = { id: 'indexed-hole', name: '穴', kind: 'hole', suppressed: false, targetFeatureId: 'stock',
  face: { bodyFeatureId: 'stock', index: 0, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
    area: 1000, position: [0, 0, 20], axis: [0, 0, 1], radius: 20 } },
  centers: [], diameter: historyFormula('2 * 3', 6), depth: { kind: 'blind', depth: historyFormula('2 * 4', 8) },
  tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
  cylindrical: { kind: 'cylinder-face', locations: [
    { height: historyFormula('10 + 10', 20), angle: historyFormula('15 + 15', 30) },
    { height: historyFormula('7 * 4', 28), angle: historyFormula('-45 * 2', -90) },
  ] } };
const indexedThread: ThreadHoleFeature = { ...indexedHole, id: 'indexed-thread', kind: 'threadHole',
  designation: 'M6', series: 'coarse', pitch: expressionValueFromNumber(1),
  drillDiameter: expressionValueFromNumber(6 - 1.0825317547305482),
  threadLength: historyFormula('2 + 2', 4), representation: 'simplified' };

describe('円筒穴のプロパティ編集位置', () => {
  beforeEach(resetTestStore);
  it.each([indexedHole, indexedThread])('$kind: 2位置の表示と書戻しが同じ位置を使い、他の全欄を保持する', feature => {
    const document = appendSolid(createEmptyPartDocument(), feature);
    for (const index of [0, 1]) {
      const selection = { ...reconcileCylindricalPropertySelection(feature, null), index };
      const summary = summarizeSolid(document, feature, [], selection.index);
      expect(summary.fields.find(field => field.key === 'holeCylinderHeight')?.value).toBe(feature.cylindrical?.locations[index]?.height);
      expect(summary.fields.find(field => field.key === 'holeCylinderAngle')?.value).toBe(feature.cylindrical?.locations[index]?.angle);
      for (const key of ['holeCylinderHeight', 'holeCylinderAngle']) {
        if (key !== 'holeCylinderHeight' && key !== 'holeCylinderAngle') throw new Error('Unexpected property');
        const edit = createSolidPropertyFieldEdit(feature, key, selection, locationUnits);
        const member = key === 'holeCylinderHeight' ? 'height' : 'angle';
        const value = historyFormula(member === 'height' ? '高さ + 2' : '-360 + 17', member === 'height' ? 19 : -343);
        const changed = findSolid(edit.replaceValue(document, value), feature.id);
        expect(changed).toEqual({ ...feature, cylindrical: { kind: 'cylinder-face', locations:
          feature.cylindrical?.locations.map((location, slot) => slot === index ? { ...location, [member]: value } : location) } });
      }
    }
  });

  it('feature切替・位置数変更・不正indexは有効な最初の位置へ戻し、古い書戻しは拒否する', () => {
    const selection = { ...reconcileCylindricalPropertySelection(indexedHole, null), index: 1 };
    expect(reconcileCylindricalPropertySelection(indexedHole, selection)).toBe(selection);
    expect(reconcileCylindricalPropertySelection(indexedThread, selection).index).toBe(0);
    const single: HoleFeature = { ...indexedHole, cylindrical: { kind: 'cylinder-face', locations: [
      { height: expressionValueFromNumber(20), angle: expressionValueFromNumber(30) },
    ] } };
    expect(reconcileCylindricalPropertySelection(single, selection).index).toBe(0);
    const changedCount = appendSolid(createEmptyPartDocument(), single);
    const oldEdit = createSolidPropertyFieldEdit(indexedHole, 'holeCylinderHeight', selection, locationUnits);
    expect(oldEdit.replaceValue(changedCount, expressionValueFromNumber(18))).toBe(changedCount);
    for (const index of [-1, 2, 0.5, NaN, Infinity]) {
      const invalid = { ...selection, index };
      expect(reconcileCylindricalPropertySelection(indexedHole, invalid).index).toBe(0);
      const document = appendSolid(createEmptyPartDocument(), indexedHole);
      expect(createSolidPropertyFieldEdit(indexedHole, 'holeCylinderAngle', invalid, locationUnits)
        .replaceValue(document, expressionValueFromNumber(0))).toBe(document);
    }
    const other = appendSolid(createEmptyPartDocument(), indexedThread);
    expect(oldEdit.replaceValue(other, expressionValueFromNumber(18))).toBe(other);
  });

  it('位置とfeatureで下書き/React/履歴のkeyを分け、Undoと再読込の文書版で下書きを捨てる', () => {
    const first = reconcileCylindricalPropertySelection(indexedHole, null), second = { ...first, index: 1 };
    const key = createSolidPropertyFieldEdit(indexedHole, 'holeCylinderHeight', first, locationUnits).key;
    const secondKey = createSolidPropertyFieldEdit(indexedHole, 'holeCylinderHeight', second, locationUnits).key;
    expect(secondKey).not.toBe(key);
    expect(createSolidPropertyFieldEdit(indexedThread, 'holeCylinderHeight',
      reconcileCylindricalPropertySelection(indexedThread, null), locationUnits).key).not.toBe(key);
    useAppStore.getState().applyDocument(appendSolid(createEmptyPartDocument(), indexedHole), { opensDocument: true });
    const before = useAppStore.getState();
    const draft = { draft: { key: secondKey, source: '高さ *' }, seenVersion: before.documentVersion };
    const edit = createSolidPropertyFieldEdit(indexedHole, 'holeCylinderHeight', second, locationUnits);
    useAppStore.getState().applyDocument(edit.replaceValue(before.document, expressionValueFromNumber(18)), { coalesceKey: edit.key });
    useAppStore.getState().undo();
    expect(reconcileDraftVersion(draft, useAppStore.getState().documentVersion).draft).toBeNull();
    useAppStore.getState().applyDocument(before.document, { opensDocument: true });
    expect(reconcileDraftVersion(draft, useAppStore.getState().documentVersion).draft).toBeNull();
    expect(reconcileCylindricalPropertySelection(indexedHole, second)).toBe(second);
  });

  it.each([indexedHole, indexedThread])('$kind: 1位置と非円筒は既存の欄/履歴keyと変数・単位を保つ', feature => {
    const location = feature.cylindrical?.locations[0];
    if (location === undefined) throw new Error('Missing fixture location');
    const single: HoleFeature | ThreadHoleFeature = { ...feature, cylindrical: { kind: 'cylinder-face', locations: [location] } };
    const document = appendSolid(createEmptyPartDocument(), single);
    const selection = reconcileCylindricalPropertySelection(single, null);
    const edit = createSolidPropertyFieldEdit(single, 'holeCylinderHeight', selection, { ...locationUnits, lengthUnit: 'inch' });
    expect(edit.key).toBe(`field:${single.id}:holeCylinderHeight`);
    const value = historyFormula('高さ + 2', 19);
    const changed = findSolid(edit.replaceValue(document, value), single.id);
    if (changed?.kind !== 'hole' && changed?.kind !== 'threadHole') throw new Error('Expected machining feature');
    expect(changed.cylindrical?.locations[0]?.height).toBe(value);
    const planar = { ...feature, cylindrical: undefined };
    const planarDocument = appendSolid(createEmptyPartDocument(), planar);
    const planarEdit = createSolidPropertyFieldEdit(planar, 'depth', reconcileCylindricalPropertySelection(planar, null), locationUnits);
    expect(planarEdit.key).toBe(`field:${feature.id}:depth`);
    expect(findSolid(planarEdit.replaceValue(planarDocument, value), planar.id)?.id).toBe(feature.id);
  });
});

describe('円筒複数位置のPropertyPanelと実native履歴', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);
  beforeEach(resetTestStore);
  it.each(['blind', 'thread'])('%s: 選択だけは差0、位置2編集を1Undo/RedoでID/参照/実形状ごと戻す', async operation => {
    if (operation !== 'blind' && operation !== 'thread') throw new Error('Unexpected operation');
    const harness = await nativeHistoryHarness('cylinder');
    try {
      harness.confirm(harness.begin(operation)); await harness.committed();
      const initial = useAppStore.getState(), feature = initial.document.solids.at(-1);
      if ((feature?.kind !== 'hole' && feature?.kind !== 'threadHole') || feature.cylindrical === undefined) throw new Error('Missing radial machining');
      const multiple = { ...feature, cylindrical: { ...feature.cylindrical, locations: [
        ...feature.cylindrical.locations, { height: historyFormula('7 * 4', 28), angle: historyFormula('-45 * 2', -90) },
      ] } };
      useAppStore.getState().applyDocument(replaceSolid(initial.document, feature.id, multiple)); await harness.settled();
      const before = useAppStore.getState(), beforeShape = shapeSha();
      const first = reconcileCylindricalPropertySelection(multiple, null), second = { ...first, index: 1 };
      expect(reconcileCylindricalPropertySelection(multiple, second)).toBe(second);
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().bodies).toBe(before.bodies); expect(shapeSha()).toBe(beforeShape);
      const edit = createSolidPropertyFieldEdit(multiple, 'holeCylinderHeight', second, locationUnits);
      const candidate = edit.replaceValue(before.document, historyFormula('17 + 2', 19));
      const changed = findSolid(candidate, multiple.id);
      if (changed?.kind !== 'hole' && changed?.kind !== 'threadHole') throw new Error('Missing edited machining');
      expect(changed.cylindrical?.locations[0]).toBe(multiple.cylindrical.locations[0]);
      expect(changed.face).toBe(multiple.face); expect(changed.id).toBe(multiple.id);
      useAppStore.getState().applyDocument(candidate, { coalesceKey: edit.key }); await harness.settled();
      const afterShape = shapeSha(); expect(afterShape).not.toBe(beforeShape);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      useAppStore.getState().undo(); await harness.settled();
      expect(useAppStore.getState().document).toEqual(before.document); expect(shapeSha()).toBe(beforeShape);
      useAppStore.getState().redo(); await harness.settled();
      expect(useAppStore.getState().document).toEqual(candidate); expect(shapeSha()).toBe(afterShape);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    } finally { harness.dispose(); }
  }, 180_000);
});

describe('roundSolvedCoordinateText', () => {
  it('残差でずれた値を有効数字 9 桁へ丸める(末尾の 0 は落ちる)', () => {
    expect(roundSolvedCoordinateText('= (0, 0.999999999989, 0)(拘束で決まった値)')).toBe(
      '= (0, 1, 0)(拘束で決まった値)',
    );
  });

  it('12 桁の表示から 9 桁へ丸め、他の 2 つの数と接頭辞・接尾辞は変えない', () => {
    expect(
      roundSolvedCoordinateText('= (10.1234567890123, -3, 0.000123456789012)(拘束で決まった値)'),
    ).toBe('= (10.1234568, -3, 0.000123456789)(拘束で決まった値)');
  });

  it('想定と違う形の文字列はそのまま返す(壊れた文字列を作らない)', () => {
    expect(roundSolvedCoordinateText('未知の形')).toBe('未知の形');
  });
});

/**
 * 外観の節の `key`(P5 仕上げ (d))。
 *
 * 同じ親(`.pcad-panel__body`)には「立体/スケッチ要素/基準ジオメトリの節」が
 * `key={feature.id}`(= 選んでいる要素の id)で並ぶ。外観の節が同じ文字列を `key` にすると
 * **兄弟の鍵が重なり**、React が選び直しのときに古い節を消し損ねて、前に選んでいた立体の
 * 節が画面に積み上がる(2026-09-05 実測: 立体を選び直すたびに「立体/かたち/断面/結果」の
 * 4 節が増え、E2E の `体積` の照合が 2 要素になって落ちた)。重ならないことをここで固定する。
 */
describe('appearanceSectionKey', () => {
  it('立体を 1 つだけ選んでいても、その立体の id と同じ文字列にならない', () => {
    expect(appearanceSectionKey(['extrude-1'])).not.toBe('extrude-1');
  });

  it('面(部分形状)を 1 つだけ選んでいても、その id と同じ文字列にならない', () => {
    expect(appearanceSectionKey(['extrude-1#face:3'])).not.toBe('extrude-1#face:3');
  });

  it('選び直すと別の文字列になる(打ちかけの下書きを捨てるため)', () => {
    expect(appearanceSectionKey(['extrude-1'])).not.toBe(appearanceSectionKey(['extrude-2']));
    expect(appearanceSectionKey([])).not.toBe(appearanceSectionKey(['extrude-1']));
  });

  it('同じ選択なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(appearanceSectionKey(['extrude-1', 'extrude-2'])).toBe(
      appearanceSectionKey(['extrude-1', 'extrude-2']),
    );
  });
});

/**
 * 基本形状の節の `key`(P5 タスク18、rules/06 10.9)。
 *
 * 基本形状の節は `SolidProperties`(`key={solid.id}`)・外観の節
 * (`appearanceSectionKey(selection)`)と**同じ親**(`.pcad-panel__body`)に並ぶ。
 * 3 つの鍵が絶対に重ならないことをここで固定する(重なると React が古い節を消し損ね、
 * 選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('primitiveSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe('sphere-1');
    expect(primitiveSectionKey('box-12')).not.toBe('box-12');
  });

  it('立体を 1 つだけ選んでいるときの外観の節の鍵とも重ならない', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe(appearanceSectionKey(['sphere-1']));
  });

  it('別の立体なら別の文字列になる(選び直したら打ちかけの下書きを捨てる)', () => {
    expect(primitiveSectionKey('sphere-1')).not.toBe(primitiveSectionKey('sphere-2'));
  });

  it('同じ立体なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(primitiveSectionKey('torus-3')).toBe(primitiveSectionKey('torus-3'));
  });
});

/**
 * 面をつなぐ・ロフトの注記の節の `key`(P5 タスク27、rules/06 10.9)。
 *
 * この節も `SolidProperties`(`key={solid.id}`)・基本形状の節・外観の節と**同じ親**
 * (`.pcad-panel__body`)に並ぶ。4 つの鍵が絶対に重ならないことをここで固定する
 * (重なると React が古い節を消し損ね、選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('ruledSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe('ruled-1');
    expect(ruledSectionKey('loft-12')).not.toBe('loft-12');
  });

  it('外観の節・基本形状の節の鍵とも重ならない', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe(appearanceSectionKey(['ruled-1']));
    expect(ruledSectionKey('ruled-1')).not.toBe(primitiveSectionKey('ruled-1'));
  });

  it('別の立体なら別の文字列になる(選び直したら打ちかけの下書きを捨てる)', () => {
    expect(ruledSectionKey('ruled-1')).not.toBe(ruledSectionKey('ruled-2'));
    expect(ruledSectionKey('ruled-1')).not.toBe(ruledSectionKey('loft-1'));
  });

  it('同じ立体なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(ruledSectionKey('loft-3')).toBe(ruledSectionKey('loft-3'));
  });
});

/**
 * 測定・質量特性の節の `key`(P5 タスク32、rules/06 10.9)。
 *
 * この 2 つも `SolidProperties`(`key={solid.id}`)・基本形状の節・つなぎ方の節・外観の節と
 * **同じ親**(`.pcad-panel__body`)に並ぶ。6 つの鍵が絶対に重ならないことをここで固定する
 * (重なると React が古い節を消し損ね、選び直すたびに節が積み上がる。10.9 の再発防止)。
 */
describe('measureSectionKey / massSectionKey', () => {
  it('立体の id・部分形状の id と同じ文字列にならない', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe('extrude-1');
    expect(measureSectionKey(['extrude-1#face:3'])).not.toBe('extrude-1#face:3');
    expect(massSectionKey('extrude-1')).not.toBe('extrude-1');
  });

  it('他の 4 つの節の鍵とも重ならない', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe(appearanceSectionKey(['extrude-1']));
    expect(measureSectionKey(['extrude-1'])).not.toBe(primitiveSectionKey('extrude-1'));
    expect(measureSectionKey(['extrude-1'])).not.toBe(ruledSectionKey('extrude-1'));
    expect(massSectionKey('extrude-1')).not.toBe(measureSectionKey(['extrude-1']));
    expect(massSectionKey('extrude-1')).not.toBe(appearanceSectionKey(['extrude-1']));
  });

  it('選び直すと別の文字列になる(材料と密度をその立体の外観から選び直すため)', () => {
    expect(measureSectionKey(['extrude-1'])).not.toBe(measureSectionKey(['extrude-2']));
    expect(massSectionKey('extrude-1')).not.toBe(massSectionKey('extrude-2'));
  });

  it('同じ選択なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(measureSectionKey(['extrude-1', 'extrude-2'])).toBe(
      measureSectionKey(['extrude-1', 'extrude-2']),
    );
    expect(massSectionKey('box-3')).toBe(massSectionKey('box-3'));
  });
});

/**
 * 切断の「切る面」の節の `key`(P5 タスク27f、rules/06 10.9)。
 *
 * この節も `SolidProperties`(`key={solid.id}`)・基本形状の節・つなぎ方の節・外観の節・
 * 測定と質量特性の節と**同じ親**(`.pcad-panel__body`)に並ぶ。7 つの鍵が絶対に
 * 重ならないことをここで固定する(重なると React が古い節を消し損ね、選び直すたびに
 * 節が積み上がる。10.9 の再発防止)。
 */
describe('cutSectionKey', () => {
  it('立体の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(cutSectionKey('cut-1')).not.toBe('cut-1');
    expect(cutSectionKey('cut-12')).not.toBe('cut-12');
  });

  it('他の 5 つの節の鍵とも重ならない', () => {
    expect(cutSectionKey('cut-1')).not.toBe(appearanceSectionKey(['cut-1']));
    expect(cutSectionKey('cut-1')).not.toBe(primitiveSectionKey('cut-1'));
    expect(cutSectionKey('cut-1')).not.toBe(ruledSectionKey('cut-1'));
    expect(cutSectionKey('cut-1')).not.toBe(measureSectionKey(['cut-1']));
    expect(cutSectionKey('cut-1')).not.toBe(massSectionKey('cut-1'));
  });

  it('別の切断なら別の文字列になる(選び直したら作り直す)', () => {
    expect(cutSectionKey('cut-1')).not.toBe(cutSectionKey('cut-2'));
  });

  it('同じ切断なら同じ文字列になる(選び直していないのに作り直さない)', () => {
    expect(cutSectionKey('cut-3')).toBe(cutSectionKey('cut-3'));
  });
});

/**
 * 球面の案内線・球の上の位置の節の `key`(P5 タスク21・22、rules/06 10.9)。
 *
 * この 2 つも `SolidProperties`(`key={solid.id}`)・`FeatureProperties`(`key={feature.id}`)・
 * 基本形状の節・つなぎ方の節・切断の節・外観の節・測定と質量特性の節と**同じ親**
 * (`.pcad-panel__body`)に並ぶ。鍵が絶対に重ならないことをここで固定する。
 */
describe('sphereGridSectionKey', () => {
  it('立体・要素の id と同じ文字列にならない(兄弟の鍵が重ならない)', () => {
    expect(sphereGridSectionKey('sphere-1')).not.toBe('sphere-1');
    expect(sphereGridSectionKey('point-3')).not.toBe('point-3');
  });

  it('他の節の鍵とも重ならない', () => {
    expect(sphereGridSectionKey('sphere-1')).not.toBe(appearanceSectionKey(['sphere-1']));
    expect(sphereGridSectionKey('sphere-1')).not.toBe(primitiveSectionKey('sphere-1'));
    expect(sphereGridSectionKey('sphere-1')).not.toBe(ruledSectionKey('sphere-1'));
    expect(sphereGridSectionKey('sphere-1')).not.toBe(cutSectionKey('sphere-1'));
    expect(sphereGridSectionKey('sphere-1')).not.toBe(measureSectionKey(['sphere-1']));
    expect(sphereGridSectionKey('sphere-1')).not.toBe(massSectionKey('sphere-1'));
  });

  it('別の球なら別の文字列、同じ球なら同じ文字列になる', () => {
    expect(sphereGridSectionKey('sphere-1')).not.toBe(sphereGridSectionKey('sphere-2'));
    expect(sphereGridSectionKey('sphere-1')).toBe(sphereGridSectionKey('sphere-1'));
  });
});

/**
 * 球面上の点の緯度・経度をプロパティから直す(FR-431、FR-202、FR-502、P5 タスク22)。
 * 座標そのものは書き換えないので、直した点は球面の上に留まったまま動く。
 */
describe('sphereGridAnglesOf / setSphereGridAngle', () => {
  const sphereGridPoint: SketchFeature = {
    id: 'point-1',
    name: '点1',
    planeId: FREE_WORK_PLANE_ID,
    kind: 'point',
    at: {
      mode: 'relative',
      base: {
        kind: 'sphereGrid',
        sphereFeatureId: 'sphere-1',
        latitude: expressionValueFromNumber(30),
        longitude: expressionValueFromNumber(45),
      },
      dx: expressionValueFromNumber(0),
      dy: expressionValueFromNumber(0),
      dz: expressionValueFromNumber(0),
    },
  };

  const plainPoint: SketchFeature = {
    id: 'point-2',
    name: '点2',
    planeId: FREE_WORK_PLANE_ID,
    kind: 'point',
    at: {
      mode: 'absolute',
      x: expressionValueFromNumber(1),
      y: expressionValueFromNumber(2),
      z: expressionValueFromNumber(3),
    },
  };

  it('球面上の点なら緯度・経度を取り出せる', () => {
    expect(sphereGridAnglesOf(sphereGridPoint)?.latitude.value).toBe(30);
    expect(sphereGridAnglesOf(sphereGridPoint)?.longitude.value).toBe(45);
  });

  it('球面上の点でなければ null(節そのものを出さない)', () => {
    expect(sphereGridAnglesOf(plainPoint)).toBeNull();
  });

  it('緯度だけを式のまま差し替える(経度と座標は触らない)', () => {
    const next = setSphereGridAngle(sphereGridPoint, 'latitude', {
      source: '30*2',
      value: 60,
      display: '60',
    });
    const angles = sphereGridAnglesOf(next);
    expect(angles?.latitude.source).toBe('30*2');
    expect(angles?.latitude.value).toBe(60);
    expect(angles?.longitude.value).toBe(45);
  });

  it('経度だけを差し替える', () => {
    const next = setSphereGridAngle(sphereGridPoint, 'longitude', expressionValueFromNumber(120));
    expect(sphereGridAnglesOf(next)?.longitude.value).toBe(120);
    expect(sphereGridAnglesOf(next)?.latitude.value).toBe(30);
  });

  it('球面上の点でない要素はそのまま返す(呼び出し側が種類を数え直さずに済む)', () => {
    expect(setSphereGridAngle(plainPoint, 'latitude', expressionValueFromNumber(10))).toBe(
      plainPoint,
    );
  });
});

describe('EX05 planar property position and history', () => {
  beforeEach(resetTestStore);
  const planarHole: HoleFeature = { ...indexedHole, cylindrical: undefined,
    face: { bodyFeatureId: 'stock', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1000, position: [11, -7, 5], axis: [-0.48, 0.36, 0.8], radius: null } },
    planar: { kind: 'plane-face', locations: [
      { x: historyFormula('2 * 3', 6), y: historyFormula('-2 * 2', -4) },
      { x: historyFormula('-6 / 2', -3), y: historyFormula('10 / 2', 5) },
    ] } };
  const planarThread: ThreadHoleFeature = { ...indexedThread, cylindrical: undefined,
    face: planarHole.face, planar: planarHole.planar };
  it.each([planarHole, planarThread])('$kind: select has no history; XY edit has one Undo/Redo, other position unchanged', feature => {
    const document = appendSolid(createEmptyPartDocument(), feature);
    useAppStore.getState().applyDocument(document, { opensDocument: true });
    const before = useAppStore.getState();
    const first = reconcileCylindricalPropertySelection(feature, null), second = { ...first, index: 1 };
    expect(reconcileCylindricalPropertySelection(feature, second)).toBe(second);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    const summary = summarizeSolid(document, feature, [], 1);
    expect(summary.fields.find(field => field.key === 'holePlanarX')?.value.source).toBe('-6 / 2');
    expect(summary.fields.find(field => field.key === 'holePlanarY')?.value.source).toBe('10 / 2');
    const edit = createSolidPropertyFieldEdit(feature, 'holePlanarX', second, locationUnits);
    const value = historyFormula('-12 / 2', -6);
    const changed = edit.replaceValue(before.document, value);
    const updated = findSolid(changed, feature.id);
    if (updated?.kind !== 'hole' && updated?.kind !== 'threadHole') throw new Error('Expected hole');
    expect(updated.planar?.locations[0]).toBe(feature.planar?.locations[0]);
    expect(updated.planar?.locations[1]?.x).toBe(value);
    expect(updated.planar?.locations[1]?.y).toBe(feature.planar?.locations[1]?.y);
    expect(updated.face).toBe(feature.face);
    expect(updated.id).toBe(feature.id);
    useAppStore.getState().applyDocument(changed, { coalesceKey: edit.key });
    expect(useAppStore.getState().undoStack.past.length).toBe(before.undoStack.past.length + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before.document);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(changed);
    expect(createSolidPropertyFieldEdit(feature, 'holePlanarX', first, locationUnits).key).not.toBe(edit.key);
    const invalid = { ...second, index: 2 };
    expect(createSolidPropertyFieldEdit(feature, 'holePlanarX', invalid, locationUnits).replaceValue(document, value)).toBe(document);
    expect(reconcileCylindricalPropertySelection(indexedHole, second).index).toBe(0);
    const oldEdit = createSolidPropertyFieldEdit(feature, 'holePlanarX', second, locationUnits);
    const oldPlacement = feature.kind === 'hole' ? indexedHole : indexedThread;
    const replaced = replaceSolid(document, feature.id, oldPlacement);
    expect(oldEdit.replaceValue(replaced, value)).toBe(replaced);
    const draft = { draft: { key: edit.key, source: '2 *' }, seenVersion: before.documentVersion };
    expect(reconcileDraftVersion(draft, useAppStore.getState().documentVersion).draft).toBeNull();
  });
});
