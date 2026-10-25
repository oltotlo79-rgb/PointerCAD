import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyFilletWeld, createAssemblyDocument, createComponentFor, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  planFilletWeld, planFilletWeldEdit, weldSegmentsOf, WORK_PLANES,
  type AssemblyDocument, type FilletWeldRequest, type MateTarget, type Placement, type SubShapeRef, type Vec3, type WeldBodyLookup,
  type SolidBody,
} from '@pointercad/model';
import { writeAssemblyDocument } from '@pointercad/io';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { assemblyBuildReadiness, chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { beginComponentDrag } from './dragComponentActions.js';
import { planeBody, TEE_PLANE_BODIES } from './filletWeldBodies.testSupport.js';

beforeEach(resetTestStore);

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

function tee(): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
}

function face(componentId: string, partRef: string, centroid: Vec3, normal: Vec3): FilletWeldRequest['first'] {
  return { componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, centroid, normal,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: centroid, axis: normal, radius: null } } };
}

/** 断続ビード2本の溶接を足した文書(画面の確定と同じ `applyFilletWeld` の結果)。 */
function welded(document: AssemblyDocument, cylinder: boolean | 'interior' = false): AssemblyDocument {
  const bodies: WeldBodyLookup = component => {
    const original = TEE_PLANE_BODIES(component);
    if (!cylinder || component.id !== 'component-2' || original === null) return original;
    return original.map((body): SolidBody => ({ ...body, bodyKind: 'solid', faces: [{ index: 0, surfaceKind: 'cylinder',
      radius: 10, area: 2000 * Math.PI, axis: [1, 0, 0], axisOrigin: [0, 34, cylinder === 'interior' ? 20 : 0], centroid: [50, 34, cylinder === 'interior' ? 20 : 0],
      cylinderSpan: [0, 100], cylinderExterior: cylinder !== 'interior', triangleOffset: 0, triangleCount: 0 }] }));
  };
  const planned = planFilletWeld(document, {
    first: face('component-1', 'standing', [50, 8, 25], [0, 1, 0]),
    second: cylinder ? { componentId: 'component-2', sourceKey: 'part:base@rev-b', centroid: [50, 34, cylinder === 'interior' ? 20 : 0], normal: null,
      face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
        radius: 10, area: 2000 * Math.PI, axis: [1, 0, 0], position: [50, 34, cylinder === 'interior' ? 20 : 0] } } }
      : face('component-2', 'base', [50, 30, 10], [0, 0, 1]),
    edge: { midpoint: [50, 8, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 1, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 6, segments: [{ start: 0, length: 30 }, { start: 60, length: 40 }], materialId: 'steel',
  }, REVISIONS, bodies);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function faceTarget(componentId: string, index: number): MateTarget {
  return { kind: 'subShape', componentId, ref: { bodyFeatureId: 'extrude-1', index,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } };
}

describe('溶接の打ちかけ(文書と履歴を変えない)', () => {
  it('開始・選択・欄の変更・取消のどれも文書と Undo を変えず、形の表示が無い間は予告しない', () => {
    useAppStore.getState().openAssembly(tee());
    const before = useAppStore.getState().assembly;
    expect(assemblyBuildReadiness(useAppStore.getState(), 'filletWeld')).toEqual({ ready: true, reasonKey: null });
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: null, picks: [], materialId: '' });
    expect(useAppStore.getState().pickFilletWeldTarget(faceTarget('component-1', 1))).toBe(true);
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '6', legOnFirstSource: '6', materialId: 'steel' });
    const state = useAppStore.getState();
    expect(state.assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
    expect(state.commitFilletWeld()).toBe(false);
    expect([state.assembly, state.canUndo]).toEqual([before, false]);
    // 打ちかけの間は他の「組む」の道具を止める。
    expect(assemblyBuildReadiness(state, 'boltedJoint').ready).toBe(false);
    useAppStore.getState().cancelFilletWeld();
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    expect([useAppStore.getState().assembly, useAppStore.getState().canUndo]).toEqual([before, false]);
  });

  it('部品が1つだけの時は始められない', () => {
    let document = createAssemblyDocument('一つ');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, {}));
    useAppStore.getState().openAssembly(document);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'filletWeld'))
      .toEqual({ ready: false, reasonKey: 'assembly.filletWeld.needTwoComponents' });
  });

  it('履歴が無い時の元に戻す・やり直すは、溶接の打ちかけをやめるだけ', () => {
    for (const step of ['undoAssembly', 'redoAssembly'] as const) {
      useAppStore.getState().openAssembly(tee());
      const before = useAppStore.getState().assembly;
      expect(useAppStore.getState().beginFilletWeld()).toBe(true);
      useAppStore.getState()[step]();
      expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
      expect(useAppStore.getState().assemblyFilletWeldPreview).toBeNull();
      expect(useAppStore.getState().assembly).toBe(before);
    }
  });
});

describe('溶接は Undo 1 段で戻り、Redo で同じ文書に戻る', () => {
  it.each([false, true, 'interior'] as const)('ビードの部品・材質・互いの固定を足した文書は 1 回の元に戻すで前の文書、やり直すで同じ文書 (cylinder=%s)', (cylinder) => {
    useAppStore.getState().openAssembly(tee());
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('no assembly');
    const after = welded(before, cylinder);
    if (cylinder) {
      const beads = after.components.filter(component => component.source.kind === 'standardPart');
      expect(beads).toHaveLength(2);
      for (const bead of beads) {
        if (bead.source.kind !== 'standardPart') throw new Error('Expected standard weld bead');
        expect(bead.source.generatorRevision).toBe(cylinder === 'interior' ? 'fillet-weld-4' : 'fillet-weld-3');
        expect(bead.source.options['weldCylinderRadius']).toBe('10');
      }
    }
    useAppStore.getState().applyAssembly(after);
    expect(useAppStore.getState().assembly?.components).toHaveLength(4);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(before);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(after);
  });

  it('ビードを1つ選んで始めると直す下書きになり、「溶接を消す」はビードだけを Undo 1 段で消す', () => {
    useAppStore.getState().openAssembly(welded(tee()));
    const withWeld = useAppStore.getState().assembly;
    if (withWeld === null) throw new Error('no assembly');
    const beads = weldSegmentsOf(withWeld).get('weld-1')?.map((component) => component.id) ?? [];
    expect(beads).toHaveLength(2);
    useAppStore.getState().setSelection([beads[1] ?? '']);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'filletWeld')).toEqual({ ready: true, reasonKey: null });
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({
      weldId: 'weld-1', mode: 'intermittent', startSource: '0', lengthsSource: '30, 40', gapsSource: '30', materialId: 'steel',
    });
    expect(useAppStore.getState().pickFilletWeldTarget(faceTarget('component-1', 1))).toBe(false);
    expect(useAppStore.getState().removeFilletWeldDraft()).toBe(true);
    const removed = useAppStore.getState().assembly;
    expect(removed?.components.map((component) => component.id)).toEqual(['component-1', 'component-2']);
    expect(removed?.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1']);
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(withWeld);
  });

  it('ビードを押して選んだ時の動かせない知らせは、直す打ちかけを始めると消え、溶接の案内を隠さない', () => {
    // 画面検査 q5 の実際の失敗: ビードの押下で部品を動かす試みが断られ(状態欄の断り)、その知らせが残ったまま
    // 溶接の打ちかけの案内より先に出続けた。
    useAppStore.getState().openAssembly(welded(tee()));
    const withWeld = useAppStore.getState().assembly;
    const bead = withWeld === null ? undefined : weldSegmentsOf(withWeld).get('weld-1')?.[0]?.id;
    if (bead === undefined) throw new Error('no bead');
    useAppStore.getState().setSelection([bead]);
    expect(beginComponentDrag(bead, WORK_PLANES.xy, [0, 0, 0])).toBe(false);
    const refused = useAppStore.getState().assemblyDragNotice;
    expect(refused === null || refused === 'dragging' || refused === 'complete').toBe(false);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', lengthsSource: '30, 40' });
    expect(useAppStore.getState().assemblyDragNotice).toBeNull();
  });
});

/** 立板・底板の id を、読点・`%`・`:` を含む利用者の名付けに替えた T 継手。 */
function namedTee(first: string, second: string): AssemblyDocument {
  const document = tee();
  return { ...document, components: document.components.map(component => ({ ...component, id: component.id === 'component-1' ? first : second })) };
}

/** 名付けた2部品の断続ビード2本の溶接(画面の確定と同じ `applyFilletWeld` の結果)。 */
function namedWelded(document: AssemblyDocument, first: string, second: string): AssemblyDocument {
  const planned = planFilletWeld(document, {
    first: face(first, 'standing', [50, 8, 25], [0, 1, 0]), second: face(second, 'base', [50, 30, 10], [0, 0, 1]),
    edge: { midpoint: [50, 8, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 1, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 6, segments: [{ start: 0, length: 30 }, { start: 60, length: 40 }], materialId: 'steel',
  }, REVISIONS, TEE_PLANE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function storedWeldParts(document: AssemblyDocument | null): readonly (string | undefined)[] {
  return (document === null ? [] : weldSegmentsOf(document).get('weld-1') ?? [])
    .map(bead => (bead.source.kind === 'standardPart' ? bead.source.options['weldParts'] : undefined));
}

/** ビードを1つ選んで「溶接」を始め、直す下書きになった時の溶接の id(下書きは取り消して文書を変えない)。 */
function editDraftOfFirstBead(): { readonly weldId: string | null; readonly lengthsSource: string } | null {
  const assembly = useAppStore.getState().assembly;
  const bead = assembly === null ? undefined : weldSegmentsOf(assembly).get('weld-1')?.[0]?.id;
  if (bead === undefined) return null;
  useAppStore.getState().setSelection([bead]);
  chooseAssemblyBuild('filletWeld');
  const draft = useAppStore.getState().assemblyFilletWeldDraft;
  useAppStore.getState().cancelFilletWeld();
  return draft === null ? null : { weldId: draft.weldId, lengthsSource: draft.lengthsSource };
}

describe('読点・%・: を含む部品の id の溶接(ストアの命令と Undo/Redo)', () => {
  // 期待する欄は手で書いた: 読点を含む時は `v2:<1つ目>:<2つ目>`、id の中の `%`・`,`・`:` は `%25`・`%2C`・`%3A`。
  it.each([
    ['立板,左', 'base:%2C,1', 'v2:立板%2C左:base%3A%252C%2C1'],
    ['a%,b', 'c:d', 'v2:a%25%2Cb:c%3Ad'],
  ])('溶接・直す・消すと元に戻す・やり直すの各段で、2部品 (%s / %s) を正しく指したまま (欄 %s)', (first, second, stored) => {
    useAppStore.getState().openAssembly(namedTee(first, second));
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('no assembly');
    const after = namedWelded(before, first, second);
    useAppStore.getState().applyAssembly(after);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored, stored]);
    expect(useAppStore.getState().assembly?.components.map(component => component.rigidGroupId))
      .toEqual(['fastening-1', 'fastening-1', 'fastening-1', 'fastening-1']);
    // 保存した2部品を読めなければ、ビードを選んでも直す下書きにならない。
    expect(editDraftOfFirstBead()).toEqual({ weldId: 'weld-1', lengthsSource: '30, 40' });

    const edit = planFilletWeldEdit(after, { weldId: 'weld-1', legOnSecond: 5, legOnFirst: 5, segments: [{ start: 0, length: 100 }],
      materialId: 'steel' }, REVISIONS, TEE_PLANE_BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    expect([edit.plan.firstComponentId, edit.plan.secondComponentId]).toEqual([first, second]);
    const applied = applyFilletWeld(after, edit.plan, REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const edited = applied.document;
    useAppStore.getState().applyAssembly(edited);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored]);
    expect(editDraftOfFirstBead()).toEqual({ weldId: 'weld-1', lengthsSource: '100' });

    // 元に戻す・やり直すは1段ずつ、溶接の前・溶接・直した後の文書へ移り、どの段でも同じ2部品を指す。
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(after);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored, stored]);
    expect(editDraftOfFirstBead()).toEqual({ weldId: 'weld-1', lengthsSource: '30, 40' });
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().assembly?.components.map(component => component.id)).toEqual([first, second]);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(after);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);
    expect(editDraftOfFirstBead()).toEqual({ weldId: 'weld-1', lengthsSource: '100' });

    // 「溶接を消す」もストアの命令で1段。2部品と組は残り、元に戻すで直した後の文書に戻る。
    const bead = weldSegmentsOf(edited).get('weld-1')?.[0]?.id;
    if (bead === undefined) throw new Error('no bead');
    useAppStore.getState().setSelection([bead]);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().removeFilletWeldDraft()).toBe(true);
    const removed = useAppStore.getState().assembly;
    expect(removed?.components.map(component => [component.id, component.rigidGroupId]))
      .toEqual([[first, 'fastening-1'], [second, 'fastening-1']]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(edited);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored]);
  });
});

/**
 * 立板・底板を実際に抱き込んだ一式(部品の版は抱き込んだ内容から決まる)、名付けた2部品の T 継手、
 * 画面の表示が持つ「配置 id → 部品の鍵」と「部品の鍵 → 形」(TEE_PLANE_BODIES と同じ面と辺)。
 */
async function embeddedNamedTee(first: string, second: string) {
  const standing = await embedPart(EMPTY_PART_LIBRARY, { ...createEmptyPartDocument(), name: '立板' }, '立板.pcad', '');
  const base = await embedPart(standing.library, { ...createEmptyPartDocument(), name: '底板' }, '底板.pcad', '');
  expect(base.reused).toBe(false);
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, { ...createComponentFor(document, { kind: 'part', partRef: standing.partRef },
    { placement: placement([0, 26, 10]) }), id: first });
  document = addComponent(document, { ...createComponentFor(document, { kind: 'part', partRef: base.partRef },
    { placement: placement([0, 0, 0]) }), id: second });
  const bodies = new Map<string, readonly SolidBody[]>([
    [standing.partRef, [planeBody([[0, 8, 0], [100, 8, 0], [100, 8, 50], [0, 8, 50]], [0, 1, 0])]],
    [base.partRef, [planeBody([[0, 0, 10], [100, 0, 10], [100, 60, 10], [0, 60, 10]], [0, 0, 1])]],
  ]);
  return { document, library: base.library, bodies, partKeys: new Map([[first, standing.partRef], [second, base.partRef]]) };
}

type EmbeddedNamedTee = Awaited<ReturnType<typeof embeddedNamedTee>>;

/** 作り直しが終わって、いまの文書の形を表示が持った状態(attachAssemblyInteraction.test の準備と同じ形)。 */
function publishView(fixture: EmbeddedNamedTee, document: AssemblyDocument | null): void {
  if (document === null) throw new Error('no assembly');
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document,
    resolved: { parts: new Map(), placements: new Map(), partKeys: fixture.partKeys, errors: [] },
    bodies: fixture.bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
}

/** 表示の形と同じ指紋の部分形状(立板の側面と下の辺、底板の上面。どれも部品座標)。 */
function shapePick(componentId: string, index: number, fingerprint: SubShapeRef['fingerprint']): MateTarget {
  return { kind: 'subShape', componentId, ref: { bodyFeatureId: 'extrude-1', index, fingerprint } };
}

describe('読点・%・: を含む部品の id の溶接を、ストアの確定(commitFilletWeld)で足して直す', () => {
  // 期待する欄は手で書いた: 読点を含む時は `v2:<1つ目>:<2つ目>`、id の中の `%`・`,`・`:` は `%25`・`%2C`・`%3A`。
  it.each([
    ['立板,左', 'base:%2C,1', 'v2:立板%2C左:base%3A%252C%2C1'],
    ['a%,b', 'c:d', 'v2:a%25%2Cb:c%3Ad'],
  ])('面・辺・面を選んで確定し、ビードから直して確定し、元に戻す・やり直すの各段で2部品 (%s / %s) を指す (欄 %s)', async (first, second, stored) => {
    const fixture = await embeddedNamedTee(first, second);
    useAppStore.getState().openAssembly(fixture.document, fixture.library);
    const before = useAppStore.getState().assembly;
    publishView(fixture, before);

    // 新しい溶接: 1つ目の部品の面 → その部品の辺 → 2つ目の部品の面。予告が溶接できる時だけ確定が文書を変える。
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: null, picks: [] });
    for (const target of [
      shapePick(first, 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 8, 25], axis: [0, 1, 0], radius: null }),
      shapePick(first, 0, { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }),
      shapePick(second, 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 30, 10], axis: [0, 0, 1], radius: null }),
    ]) expect(useAppStore.getState().pickFilletWeldTarget(target)).toBe(true);
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '6', legOnFirstSource: '6', mode: 'intermittent',
      startSource: '0', lengthsSource: '30, 40', gapsSource: '30', materialId: 'steel' });
    const planned = useAppStore.getState().assemblyFilletWeldPreview;
    expect(planned?.kind === 'plan' && planned.result.ok
      ? [planned.result.plan.firstComponentId, planned.result.plan.secondComponentId] : planned).toEqual([first, second]);
    expect(useAppStore.getState().commitFilletWeld()).toBe(true);
    const welded = useAppStore.getState().assembly;
    if (welded === null || welded === before) throw new Error('weld was not committed');
    expect(storedWeldParts(welded)).toEqual([stored, stored]);
    expect(welded.components.slice(0, 2).map(component => [component.id, component.rigidGroupId]))
      .toEqual([[first, 'fastening-1'], [second, 'fastening-1']]);
    useAppStore.getState().cancelFilletWeld();

    // 直す: 作り直しの後の表示で、ビードを選んで始めると保存した2部品の溶接の下書きになり、確定で置き換わる。
    publishView(fixture, welded);
    const bead = weldSegmentsOf(welded).get('weld-1')?.[0]?.id;
    if (bead === undefined) throw new Error('no bead');
    useAppStore.getState().setSelection([bead]);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', lengthsSource: '30, 40', materialId: 'steel' });
    useAppStore.getState().updateFilletWeldDraft({ mode: 'continuous', legOnSecondSource: '5', legOnFirstSource: '5',
      startSource: '0', lengthsSource: '100', gapsSource: '' });
    const replanned = useAppStore.getState().assemblyFilletWeldPreview;
    expect(replanned?.kind === 'plan' && replanned.result.ok
      ? [replanned.result.plan.firstComponentId, replanned.result.plan.secondComponentId] : replanned).toEqual([first, second]);
    expect(useAppStore.getState().commitFilletWeld()).toBe(true);
    const edited = useAppStore.getState().assembly;
    if (edited === null || edited === welded) throw new Error('edit was not committed');
    expect(storedWeldParts(edited)).toEqual([stored]);
    expect((weldSegmentsOf(edited).get('weld-1') ?? []).map(segment => (segment.source.kind === 'standardPart' ? segment.source.size : null)))
      .toEqual(['5x5']);
    useAppStore.getState().cancelFilletWeld();

    // 元に戻す・やり直すは確定1回ずつ。どの段でも同じ2部品を指す。
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(welded);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored, stored]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().assembly?.components.map(component => component.id)).toEqual([first, second]);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(welded);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);
    expect(storedWeldParts(useAppStore.getState().assembly)).toEqual([stored]);
  });
});

/*
 * EX-08.UNDO through the store's own commands (commitFilletWeld, the edit draft, removeFilletWeldDraft) with the embedded
 * tee above. The compared bytes are the file the user would save (writeAssemblyDocument with a fixed savedAt), so
 * "unchanged" covers the whole saved document. Hand-derived refusals on the 100 mm contact: a second bead from 60 with
 * length 80 ends at 140 (segmentOutsideContact); a gap of -10 starts the second bead at 20 inside the first 0..30
 * (segmentsOverlap); in the edit, 60 + 50 = 110 also runs past the contact.
 */

const UNDO_SAVED_AT = '2026-10-24T00:00:00.000Z';

function savedBytes(document: AssemblyDocument | null): string {
  if (document === null) throw new Error('no assembly');
  return writeAssemblyDocument(document, { savedAt: UNDO_SAVED_AT });
}

function ids(document: AssemblyDocument | null): readonly string[] {
  return (document?.components ?? []).map((component) => component.id);
}

/** A refused commit applies nothing: the saved bytes are the same and the Undo stack is the same object. */
function expectRefusedWeldCommit(bytes: string): void {
  const undo = useAppStore.getState().assemblyUndoStack;
  expect(useAppStore.getState().commitFilletWeld()).toBe(false);
  expect(savedBytes(useAppStore.getState().assembly)).toBe(bytes);
  expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
}

function previewCodes(): readonly string[] | null {
  const preview = useAppStore.getState().assemblyFilletWeldPreview;
  return preview?.kind === 'plan' && !preview.result.ok ? preview.result.rejections.map((rejection) => rejection.code) : null;
}

describe('EX-08.UNDO the saved bytes and ids through the store', () => {
  it('refusals and a cancel keep the exact bytes; a weld, an edit and a removal are one Undo step each and Redo restores bytes and ids', async () => {
    const fixture = await embeddedNamedTee('component-1', 'component-2');
    useAppStore.getState().openAssembly(fixture.document, fixture.library);
    const opened = useAppStore.getState().assembly;
    const openedBytes = savedBytes(opened);
    publishView(fixture, opened);
    chooseAssemblyBuild('filletWeld');
    for (const target of [
      shapePick('component-1', 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 8, 25], axis: [0, 1, 0], radius: null }),
      shapePick('component-1', 0, { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }),
      shapePick('component-2', 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 30, 10], axis: [0, 0, 1], radius: null }),
    ]) expect(useAppStore.getState().pickFilletWeldTarget(target)).toBe(true);
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '6', legOnFirstSource: '6', mode: 'intermittent',
      startSource: '0', lengthsSource: '30, 80', gapsSource: '30', materialId: 'steel' });
    expect(previewCodes()).toContain('segmentOutsideContact');
    expectRefusedWeldCommit(openedBytes);
    useAppStore.getState().updateFilletWeldDraft({ lengthsSource: '30, 40', gapsSource: '-10' });
    expect(previewCodes()).toContain('segmentsOverlap');
    expectRefusedWeldCommit(openedBytes);
    // A valid preview, then the base plate's file is imported again with other contents (a new revision) before the
    // commit: the previewed plan no longer matches, so nothing is added.
    useAppStore.getState().updateFilletWeldDraft({ gapsSource: '30' });
    const previewed = useAppStore.getState().assemblyFilletWeldPreview;
    if (previewed?.kind !== 'plan' || !previewed.result.ok) throw new Error(JSON.stringify(previewed));
    const baseRef = fixture.partKeys.get('component-2');
    useAppStore.setState({ assemblyLibrary: { ...fixture.library, partFiles: fixture.library.partFiles.map((file) =>
      (file.ref === baseRef ? { ...file, contentHash: `${file.contentHash}-changed` } : file)) } });
    expectRefusedWeldCommit(openedBytes);
    useAppStore.setState({ assemblyLibrary: fixture.library });
    // A cancel keeps the exact bytes and the history.
    const undo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().cancelFilletWeld();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(openedBytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(undo);
    expect(useAppStore.getState().canUndo).toBe(false);

    // The weld: one Undo step back to the exact bytes, Redo to the exact bytes and the same bead ids.
    chooseAssemblyBuild('filletWeld');
    for (const target of [
      shapePick('component-1', 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 8, 25], axis: [0, 1, 0], radius: null }),
      shapePick('component-1', 0, { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }),
      shapePick('component-2', 0, { kind: 'face', surfaceKind: 'plane', area: 1, position: [50, 30, 10], axis: [0, 0, 1], radius: null }),
    ]) expect(useAppStore.getState().pickFilletWeldTarget(target)).toBe(true);
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '6', legOnFirstSource: '6', mode: 'intermittent',
      startSource: '0', lengthsSource: '30, 40', gapsSource: '30', materialId: 'steel' });
    expect(useAppStore.getState().commitFilletWeld()).toBe(true);
    useAppStore.getState().cancelFilletWeld();
    const welded = useAppStore.getState().assembly;
    const weldedBytes = savedBytes(welded);
    expect(ids(welded)).toEqual(['component-1', 'component-2', 'component-3', 'component-4']);
    useAppStore.getState().undo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(openedBytes);
    useAppStore.getState().redo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(weldedBytes);
    expect(ids(useAppStore.getState().assembly)).toEqual(['component-1', 'component-2', 'component-3', 'component-4']);

    // The edit: a cancelled edit and a refused edit keep the exact bytes; the committed edit replaces the beads with new
    // ids (never the old ones) in one Undo step.
    publishView(fixture, welded);
    useAppStore.getState().setSelection(['component-4']);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', lengthsSource: '30, 40', gapsSource: '30' });
    useAppStore.getState().updateFilletWeldDraft({ lengthsSource: '30, 50' });
    expect(previewCodes()).toContain('segmentOutsideContact');
    expectRefusedWeldCommit(weldedBytes);
    const editUndo = useAppStore.getState().assemblyUndoStack;
    useAppStore.getState().cancelFilletWeld();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(weldedBytes);
    expect(useAppStore.getState().assemblyUndoStack).toBe(editUndo);
    // Starting a tool clears the selection (chooseAssemblyBuild -> cancelMate), so the bead is selected again.
    useAppStore.getState().setSelection(['component-4']);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().assemblyFilletWeldDraft).toMatchObject({ weldId: 'weld-1', lengthsSource: '30, 40' });
    useAppStore.getState().updateFilletWeldDraft({ lengthsSource: '30, 20' });
    expect(useAppStore.getState().commitFilletWeld()).toBe(true);
    useAppStore.getState().cancelFilletWeld();
    const edited = useAppStore.getState().assembly;
    const editedBytes = savedBytes(edited);
    expect(ids(edited)).toEqual(['component-1', 'component-2', 'component-5', 'component-6']);
    useAppStore.getState().undo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(weldedBytes);
    useAppStore.getState().redo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(editedBytes);
    expect(ids(useAppStore.getState().assembly)).toEqual(['component-1', 'component-2', 'component-5', 'component-6']);

    // The removal ("溶接を消す"): only the beads go, the two parts keep their group; one Undo step back to the exact bytes.
    useAppStore.getState().setSelection(['component-5']);
    chooseAssemblyBuild('filletWeld');
    expect(useAppStore.getState().removeFilletWeldDraft()).toBe(true);
    const removed = useAppStore.getState().assembly;
    expect(removed?.components.map((component) => [component.id, component.rigidGroupId]))
      .toEqual([['component-1', 'fastening-1'], ['component-2', 'fastening-1']]);
    useAppStore.getState().undo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(editedBytes);
    useAppStore.getState().redo();
    expect(savedBytes(useAppStore.getState().assembly)).toBe(savedBytes(removed));
  });
});
