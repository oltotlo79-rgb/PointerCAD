import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createAssemblyDocument, createComponentFor, weldSegmentsOf,
  type AssemblyDocument, type MateSubShapeGeometry, type MateTarget, type Placement,
  type SubShapeRef, type Vec3, type WeldBodyLookup, type SolidBody,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { planeBody, TEE_PLANE_BODIES } from './filletWeldBodies.testSupport.js';
import {
  appendFilletWeldPick, commitFilletWeldDraft, createFilletWeldDraft, createFilletWeldEditDraft, filletWeldPickKind,
  filletWeldSegments, previewFilletWeldDraft, selectedWeldId,
  type AssemblyFilletWeldDraft, type FilletWeldDraftContext,
} from './filletWeldDraft.js';

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

/** 立板(部品座標 x 0〜100、y 0〜8、z 0〜50)を (0,26,10) に、底板(上面 z=10)を原点に置いた T 継手。 */
function tee(): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
}

function ref(index: number, kind: 'face' | 'edge'): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 1, position: [0, 0, 0], axis: [1, 0, 0], radius: null } };
}

function target(componentId: string, index: number, kind: 'face' | 'edge'): MateTarget {
  return { kind: 'subShape', componentId, ref: ref(index, kind) };
}

/** いまの形(部品座標): 立板の側面 1・下の辺 2、底板の上面 3。 */
const SHAPES = new Map<string, MateSubShapeGeometry>([
  ['component-1:1', { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }],
  ['component-1:2', { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }],
  ['component-2:3', { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null }],
]);

const BODIES = TEE_PLANE_BODIES;

function context(document: AssemblyDocument, bodiesOf: WeldBodyLookup = BODIES): FilletWeldDraftContext {
  return { document, partRevisions: REVISIONS, bodiesOf,
    resolve: (component, reference) => SHAPES.get(`${component.id}:${String(reference.index)}`) ?? null };
}

function picked(patch: Partial<AssemblyFilletWeldDraft> = {}): AssemblyFilletWeldDraft {
  let draft = createFilletWeldDraft('doc');
  for (const pick of [target('component-1', 1, 'face'), target('component-1', 2, 'edge'), target('component-2', 3, 'face')]) {
    draft = appendFilletWeldPick(draft, pick) ?? draft;
  }
  return { ...draft, legOnSecondSource: '6', legOnFirstSource: '8', materialId: 'steel', ...patch };
}

describe('溶接の選択の下書き', () => {
  it('面・同じ部品の辺・別の部品の面の順だけを受け、2 つ目は辺を選ぶ', () => {
    let draft = createFilletWeldDraft('doc');
    expect(filletWeldPickKind(draft)).toBe('face');
    expect(appendFilletWeldPick(draft, target('component-1', 2, 'edge'))).toBeNull();
    draft = appendFilletWeldPick(draft, target('component-1', 1, 'face')) ?? draft;
    expect(filletWeldPickKind(draft)).toBe('edge');
    expect(appendFilletWeldPick(draft, target('component-1', 1, 'face'))).toBeNull();
    expect(appendFilletWeldPick(draft, target('component-2', 2, 'edge'))).toBeNull();
    draft = appendFilletWeldPick(draft, target('component-1', 2, 'edge')) ?? draft;
    expect(appendFilletWeldPick(draft, target('component-1', 4, 'face'))).toBeNull();
    draft = appendFilletWeldPick(draft, target('component-2', 3, 'face')) ?? draft;
    expect(draft.picks).toHaveLength(3);
    expect(appendFilletWeldPick(draft, target('component-2', 5, 'face'))).toBeNull();
    expect(appendFilletWeldPick(createFilletWeldDraft('doc'), { kind: 'origin', componentId: 'component-1', element: 'origin' })).toBeNull();
  });

  it('脚長・材質に既定値を置かず、空のままなら理由を返す', () => {
    const draft = createFilletWeldDraft('doc');
    expect([draft.legOnSecondSource, draft.legOnFirstSource, draft.materialId]).toEqual(['', '', '']);
    expect(previewFilletWeldDraft(context(tee()), { ...picked(), legOnSecondSource: '' }))
      .toEqual({ kind: 'issue', issue: { kind: 'value', field: 'legOnSecond' } });
    const noMaterial = previewFilletWeldDraft(context(tee()), picked({ materialId: '' }));
    expect(noMaterial.kind === 'plan' && !noMaterial.result.ok ? noMaterial.result.rejections.map((item) => item.code) : null)
      .toEqual(['materialRequired']);
  });
});

describe('区間の欄', () => {
  it('連続で長さが空なら始点から辺の終わりまで、断続は長さと間隔を区間ごとに変えられる', () => {
    expect(filletWeldSegments({ ...createFilletWeldDraft('d'), startSource: '15' }, 100)).toEqual([{ start: 15, length: 85 }]);
    expect(filletWeldSegments({ ...createFilletWeldDraft('d'), mode: 'intermittent', startSource: '5',
      lengthsSource: '12, 30、7.5', gapsSource: '8, 20.5' }, 100))
      .toEqual([{ start: 5, length: 12 }, { start: 25, length: 30 }, { start: 75.5, length: 7.5 }]);
  });

  it('間隔の数が合わない・数でない欄は区間を作らずに理由を返す(負の値は計画が断る)', () => {
    const intermittent = { ...createFilletWeldDraft('d'), mode: 'intermittent' as const, lengthsSource: '10, 10', gapsSource: '' };
    expect(filletWeldSegments(intermittent, 100)).toEqual({ kind: 'gapCount' });
    expect(filletWeldSegments({ ...intermittent, gapsSource: 'abc' }, 100)).toEqual({ kind: 'value', field: 'gaps' });
    expect(filletWeldSegments({ ...intermittent, lengthsSource: '' }, 100)).toEqual({ kind: 'value', field: 'lengths' });
    expect(filletWeldSegments({ ...createFilletWeldDraft('d'), startSource: '1/0' }, 100)).toEqual({ kind: 'value', field: 'start' });
    expect(filletWeldSegments({ ...intermittent, gapsSource: '-5' }, 100)).toEqual([{ start: 0, length: 10 }, { start: 5, length: 10 }]);
    const overlap = previewFilletWeldDraft(context(tee()), picked({ mode: 'intermittent', lengthsSource: '10, 10', gapsSource: '-5' }));
    expect(overlap.kind === 'plan' && !overlap.result.ok ? overlap.result.rejections.map((item) => item.code) : null)
      .toEqual(['segmentsOverlap']);
  });
});

describe('予告と確定', () => {
  it.each([false, true])('previews the current full cylinder side and refuses a changed band before commit (inner=%s)', (inner) => {
    const document = tee(), draft = picked({ legOnSecondSource: '2', legOnFirstSource: '3' });
    const cylinder: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', area: 2000 * Math.PI,
      radius: 10, axis: [1, 0, 0], axisOrigin: [0, 34, inner ? 20 : 0], position: [50, 34, inner ? 20 : 0], cylinderSpan: [0, 100], cylinderExterior: !inner };
    const bodiesOf: WeldBodyLookup = component => {
      const original = BODIES(component);
      if (component.id !== 'component-2' || original === null) return original;
      return original.map((body): SolidBody => ({ ...body, bodyKind: 'solid', faces: [{ index: 3, surfaceKind: 'cylinder', area: 2000 * Math.PI,
        radius: 10, axis: [1, 0, 0], axisOrigin: [0, 34, inner ? 20 : 0], centroid: [50, 34, inner ? 20 : 0], cylinderSpan: [0, 100],
        cylinderExterior: !inner, triangleOffset: 0, triangleCount: 0 }] }));
    };
    const current: FilletWeldDraftContext = { ...context(document, bodiesOf),
      resolve: (component, reference) => component.id === 'component-2' ? cylinder
        : SHAPES.get(`${component.id}:${String(reference.index)}`) ?? null };
    const preview = previewFilletWeldDraft(current, draft);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const expectedArea = (30 * Math.sin(0.2) + (inner ? 1 : -1) * 100 * (0.2 - Math.sin(0.2))) / 2;
    expect(preview.result.plan.nominalVolume).toBeCloseTo(expectedArea * 100, 9);
    const changed = commitFilletWeldDraft({ ...current, bodiesOf: BODIES }, draft, preview.result.plan);
    expect(changed).toEqual({ ok: false, issue: { kind: 'stale' } });
    const committed = commitFilletWeldDraft(current, draft, preview.result.plan);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    const source = committed.document.components.find(component => component.id === committed.componentIds[0])?.source;
    expect(source?.kind === 'standardPart' ? source.options.weldCylinderSide : null).toBe(inner ? 'interior' : undefined);
    const edit = createFilletWeldEditDraft('doc', committed.document, 'weld-1');
    if (edit === null) throw new Error('Missing edit draft');
    expect(edit).toMatchObject({ legOnSecondSource: '2', legOnFirstSource: '3' });
    const again = previewFilletWeldDraft({ ...current, document: committed.document }, edit);
    expect(again.kind === 'plan' && again.result.ok ? again.result.plan.cylindricalRadius : again).toBe(10);
    expect(committed.document.components.find(component => component.id === committed.componentIds[0])?.source)
      .toMatchObject({ generatorRevision: inner ? 'fillet-weld-4' : 'fillet-weld-3', options: { weldCylinderRadius: '10' } });
  });

  it('いまの形から溶接線を作って予告し、予告と同じ計画の時だけ 1 つの新しい文書にする', () => {
    const document = tee();
    const preview = previewFilletWeldDraft(context(document), picked());
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    expect([preview.result.plan.contactLength, preview.result.plan.totalLength, preview.result.plan.nominalVolume]).toEqual([100, 100, 2400]);
    const committed = commitFilletWeldDraft(context(document), picked(), preview.result.plan);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    expect(committed.document).not.toBe(document);
    expect(weldSegmentsOf(committed.document).get('weld-1')?.map((component) => component.materialId)).toEqual(['steel']);
    // 予告の後に脚長を変えた下書きでは確定しない(予告と違う計画)。
    const changed = commitFilletWeldDraft(context(document), picked({ legOnFirstSource: '9' }), preview.result.plan);
    expect(changed).toEqual({ ok: false, issue: { kind: 'stale' } });
  });

  it('edits the middle irregular bead through public draft fields without moving or resizing its neighbours', () => {
    const document = tee();
    const initial = picked({ mode: 'intermittent', startSource: '10', lengthsSource: '20, 15, 25', gapsSource: '10, 15' });
    const preview = previewFilletWeldDraft(context(document), initial);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error('initial preview failed');
    const created = commitFilletWeldDraft(context(document), initial, preview.result.plan);
    if (!created.ok) throw new Error('initial commit failed');
    const snapshot = JSON.stringify(created.document);
    const draft = createFilletWeldEditDraft('doc', created.document, 'weld-1');
    if (draft === null) throw new Error('edit draft missing');
    // Moving only bead two from 40 to 45 and shortening it from 15 to 10 keeps bead three at 70.
    const changed = { ...draft, lengthsSource: '20, 10, 25', gapsSource: '15, 15' };
    const next = previewFilletWeldDraft(context(created.document), changed);
    if (next.kind !== 'plan' || !next.result.ok) throw new Error('edit preview failed');
    expect(next.result.plan.segments).toEqual([{ start: 10, length: 20 }, { start: 45, length: 10 }, { start: 70, length: 25 }]);
    expect(next.result.plan.nominalVolume).toBe(1320);
    const edited = commitFilletWeldDraft(context(created.document), changed, next.result.plan);
    if (!edited.ok) throw new Error('edit commit failed');
    expect(createFilletWeldEditDraft('doc', edited.document, 'weld-1')).toMatchObject({
      legOnSecondSource: '6', legOnFirstSource: '8', startSource: '10', lengthsSource: '20, 10, 25', gapsSource: '15, 15',
    });
    expect(JSON.stringify(created.document)).toBe(snapshot);
    for (const id of ['component-1', 'component-2']) {
      expect(edited.document.components.find(item => item.id === id)).toEqual(created.document.components.find(item => item.id === id));
    }
  });

  it('保存した溶接を直す下書きは、区間・脚長・材質を保存した値で埋め、選び直さずに予告できる', () => {
    const document = tee();
    const draft = picked({ mode: 'intermittent', startSource: '5', lengthsSource: '12, 30, 7.5', gapsSource: '8, 20.5', materialId: 'aluminum' });
    const preview = previewFilletWeldDraft(context(document), draft);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const committed = commitFilletWeldDraft(context(document), draft, preview.result.plan);
    if (!committed.ok) throw new Error('commit failed');
    const welded = committed.document;
    const bead = committed.componentIds[1] ?? '';
    expect(selectedWeldId(welded, [bead])).toBe('weld-1');
    expect(selectedWeldId(welded, ['component-1'])).toBeNull();
    expect(selectedWeldId(welded, [bead, 'component-1'])).toBeNull();
    const edit = createFilletWeldEditDraft('doc', welded, 'weld-1');
    expect(edit).toMatchObject({ weldId: 'weld-1', legOnSecondSource: '6', legOnFirstSource: '8', mode: 'intermittent',
      startSource: '5', lengthsSource: '12, 30, 7.5', gapsSource: '8, 20.5', materialId: 'aluminum', picks: [] });
    if (edit === null) throw new Error('edit draft missing');
    expect(appendFilletWeldPick(edit, target('component-1', 1, 'face'))).toBeNull();
    const editPreview = previewFilletWeldDraft(context(welded), { ...edit, mode: 'continuous', startSource: '0', lengthsSource: '' });
    expect(editPreview.kind === 'plan' && editPreview.result.ok
      ? [editPreview.result.plan.replacedComponentIds.length, editPreview.result.plan.totalLength] : null).toEqual([3, 100]);
    expect(createFilletWeldEditDraft('doc', welded, 'weld-9')).toBeNull();
  });

  it('予告は表示の形のボディで足元の当たりを確かめ、形が無ければ当たりとみなさない', () => {
    const missing = previewFilletWeldDraft(context(tee(), () => null), picked());
    expect(missing.kind === 'plan' && !missing.result.ok ? missing.result.rejections.map((item) => [item.code, item.detail.side]) : null)
      .toEqual([['contactFaceUnavailable', 'first'], ['contactFaceUnavailable', 'second']]);
    const narrow: WeldBodyLookup = (component) => component.source.kind === 'part' && component.source.partRef === 'base'
      ? [planeBody([[0, 0, 10], [100, 0, 10], [100, 37, 10], [0, 37, 10]], [0, 0, 1])] : BODIES(component);
    const crossed = previewFilletWeldDraft(context(tee(), narrow), picked());
    expect(crossed.kind === 'plan' && !crossed.result.ok ? crossed.result.rejections.map((item) => item.code) : null)
      .toEqual(['contactBoundaryCrossed']);
  });

  it('とても小さい正の始点・間隔も、保存して直す欄へ指数表記なしで戻り、同じ値のまま計画し直せる', () => {
    // 2^-23・2^-22 は String() では 1.19…e-7・2.38…e-7(式の文法に無い指数表記)になる。20 との和も倍精度で丸めずに表せる。
    const station = 2 ** -23, gap = 2 ** -22;
    const draft = picked({ mode: 'intermittent', startSource: '0.00000011920928955078125', lengthsSource: '20, 15',
      gapsSource: '0.0000002384185791015625' });
    const preview = previewFilletWeldDraft(context(tee()), draft);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const saved = [{ start: station, length: 20 }, { start: station + 20 + gap, length: 15 }];
    expect(preview.result.plan.segments).toEqual(saved);
    const committed = commitFilletWeldDraft(context(tee()), draft, preview.result.plan);
    if (!committed.ok) throw new Error('commit failed');
    const edit = createFilletWeldEditDraft('doc', committed.document, 'weld-1');
    if (edit === null) throw new Error('edit draft missing');
    expect([edit.startSource, edit.lengthsSource, edit.gapsSource])
      .toEqual(['0.00000011920928955078125', '20, 15', '0.0000002384185791015625']);
    // 直さずに予告し直すと、保存した区間とまったく同じ数になる(丸めない)。
    const again = previewFilletWeldDraft(context(committed.document), edit);
    expect(again.kind === 'plan' && again.result.ok ? again.result.plan.segments : again).toEqual(saved);
  });

  it('選び直せない面は理由付きの計画として返し、表示が文書と食い違う間は予告しない', () => {
    const missing = previewFilletWeldDraft({ ...context(tee()), resolve: () => null }, picked());
    expect(missing.kind === 'plan' && !missing.result.ok ? missing.result.rejections.map((item) => item.code) : null)
      .toEqual(['selectionNotFound', 'selectionNotFound', 'selectionNotFound']);
    expect(previewFilletWeldDraft(context(tee()), { ...picked(), picks: picked().picks.slice(0, 2) }))
      .toEqual({ kind: 'issue', issue: { kind: 'needPicks', count: 2 } });
  });
});
