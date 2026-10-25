import { addComponent, createAssemblyDocument, createComponentFor, type AssemblyDocument, type ComponentSource, type SubShapeRef } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(resetTestStore);

function ref(kind: 'face' | 'edge', index = 0): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 10, position: [5, 0, 0], axis: [1, 0, 0], radius: null } };
}

const nested = (path: readonly [string, ...string[]], kind: 'face' | 'edge', index = 0) => ({ path, ref: ref(kind, index) });

/** 子の組を `組,A` に置き、根の葉の板 `root-plate` を並べた根(平らと入れ子の混ざった溶接の相手)。 */
function mixedRoot(): AssemblyDocument {
  let document = createAssemblyDocument('根');
  const entries: readonly (readonly [string, ComponentSource])[] = [
    ['組,A', { kind: 'subAssembly', assemblyRef: 'child' }], ['root-plate', { kind: 'part', partRef: 'plate-part' }]];
  for (const [id, source] of entries) document = addComponent(document, { ...createComponentFor(document, source, {}), id });
  return document;
}

/** 開いた組立と、解いた時の入力を持たない表示(作り直しの途中・古い表示)。 */
function openWithoutSource(): AssemblyDocument {
  useAppStore.getState().openAssembly(mixedRoot());
  const document = useAppStore.getState().assembly;
  if (document === null) throw new Error('no assembly');
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: document,
    resolved: { parts: new Map(), placements: new Map(), partKeys: new Map(), errors: [] },
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  chooseAssemblyBuild('filletWeld');
  useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '6', legOnFirstSource: '6', materialId: 'steel' });
  return document;
}

describe('平らと入れ子の混ざった溶接を、今の溶接の窓の口で選ぶ・直す・確定する', () => {
  it('入れ子を先に選ぶと、後の平らの面は根の葉の1要素の経路として同じ下書きへ入る', () => {
    openWithoutSource();
    expect(useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'face'))).toBe(true);
    expect(useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'edge'))).toBe(true);
    expect(useAppStore.getState().pickFilletWeldTarget({ kind: 'subShape', componentId: 'root-plate', ref: ref('face', 3) })).toBe(true);
    expect(useAppStore.getState().assemblyNestedWeldDraft?.picks.map((item) => [item.path, item.ref.index]))
      .toEqual([[['組,A', 'plate'], 0], [['組,A', 'plate'], 0], [['root-plate'], 3]]);
    expect(useAppStore.getState().assemblyFilletWeldDraft?.picks).toEqual([]);
  });

  it('平らを先に選ぶと、入れ子を選んだ時に平らの面と辺が選んだ順のまま1要素の経路へ移る', () => {
    openWithoutSource();
    expect(useAppStore.getState().pickFilletWeldTarget({ kind: 'subShape', componentId: 'root-plate', ref: ref('face', 3) })).toBe(true);
    expect(useAppStore.getState().pickFilletWeldTarget({ kind: 'subShape', componentId: 'root-plate', ref: ref('edge', 2) })).toBe(true);
    expect(useAppStore.getState().assemblyNestedWeldDraft).toBeNull();
    expect(useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'face'))).toBe(true);
    expect(useAppStore.getState().assemblyNestedWeldDraft?.picks.map((item) => [item.path, item.ref.fingerprint.kind]))
      .toEqual([[['root-plate'], 'face'], [['root-plate'], 'edge'], [['組,A', 'plate'], 'face']]);
    expect(useAppStore.getState().assemblyFilletWeldDraft?.picks).toEqual([]);
    // 同じ配置の面をもう一度は受けない(3 つで選び終わり)。
    expect(useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'face', 1))).toBe(false);
  });

  it('窓・状態欄が読む予告は、選ぶ数から始まり、解いた時の入力の無い表示では「形が古い」になる。欄を直すと作り直す', () => {
    openWithoutSource();
    useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'face'));
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'needPicks', count: 1 } });
    useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'edge'));
    useAppStore.getState().pickFilletWeldTarget({ kind: 'subShape', componentId: 'root-plate', ref: ref('face', 3) });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
    // 脚長を数でない値にすると、平らな溶接と同じ欄の理由になり、直すと再び作り直す。
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: 'x' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'value', field: 'legOnSecond' } });
    useAppStore.getState().updateFilletWeldDraft({ legOnSecondSource: '5' });
    expect(useAppStore.getState().assemblyFilletWeldPreview).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
  });

  it('窓の確定(commitFilletWeld)は入れ子の確定へ渡り、古い表示では文書も Undo も変えない。取消で下書きも消える', () => {
    const before = openWithoutSource();
    useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'face'));
    useAppStore.getState().pickNestedFilletWeldTarget(nested(['組,A', 'plate'], 'edge'));
    useAppStore.getState().pickFilletWeldTarget({ kind: 'subShape', componentId: 'root-plate', ref: ref('face', 3) });
    expect(useAppStore.getState().commitFilletWeld()).toBe(false);
    expect([useAppStore.getState().assembly, useAppStore.getState().canUndo]).toEqual([before, false]);
    useAppStore.getState().cancelFilletWeld();
    expect([useAppStore.getState().assemblyNestedWeldDraft, useAppStore.getState().assemblyNestedWeldPreview,
      useAppStore.getState().assemblyFilletWeldPreview]).toEqual([null, null, null]);
  });
});
