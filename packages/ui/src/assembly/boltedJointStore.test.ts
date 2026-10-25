import {
  addComponent, createAssemblyDocument, createComponentFor, joinRigidGroup, WORK_PLANES, type AssemblyDocument, type MateTarget,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { assemblyBuildReadiness, chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { assemblyTreeRows } from '../shell/assemblyTreeRows.js';
import { appendBoltedJointPick, boltedJointChoices, createBoltedJointDraft } from './boltedJointDraft.js';
import { beginComponentDrag } from './dragComponentActions.js';

beforeEach(resetTestStore);

function face(componentId: string, index: number): MateTarget {
  return { kind: 'subShape', componentId, ref: { bodyFeatureId: 'body-1', index,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } };
}

function twoPlates(): AssemblyDocument {
  let document = createAssemblyDocument('締結');
  for (const partRef of ['part-1', 'part-2']) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }, {}));
  }
  return document;
}

describe('ボルト締結の打ちかけ(文書と履歴を変えない)', () => {
  it('開始・面の選択・欄の変更・取消のどれも文書と Undo を変えない', () => {
    useAppStore.getState().openAssembly(twoPlates());
    const before = useAppStore.getState().assembly;
    expect(assemblyBuildReadiness(useAppStore.getState(), 'boltedJoint')).toEqual({ ready: true, reasonKey: null });
    chooseAssemblyBuild('boltedJoint');
    expect(useAppStore.getState().assemblyBoltedJointDraft?.picks).toEqual([]);
    // 新しい締結の画面の既定は本体規格・並目。規格部品の配置の既定(附属書JA)は変えない。
    expect(useAppStore.getState().assemblyBoltedJointDraft).toMatchObject({ dimensionSeries: 'main', threadSeries: 'coarse' });
    expect(useAppStore.getState().pickBoltedJointFace(face('component-1', 1))).toBe(true);
    expect(useAppStore.getState().pickBoltedJointFace(face('component-1', 2))).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ engagementSource: '12' });
    const state = useAppStore.getState();
    expect(state.assemblyBoltedJointDraft?.picks).toHaveLength(2);
    // 形を計算した表示が無い間は予告を作らない(古い形で提案しない)。
    expect(state.assemblyBoltedJointPreview).toEqual({ kind: 'issue', issue: { kind: 'stale' } });
    expect(state.commitBoltedJoint()).toBe(false);
    expect(state.assembly).toBe(before);
    expect(state.canUndo).toBe(false);
    useAppStore.getState().cancelBoltedJoint();
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('部品が 1 つしか無い時は開始できず、打ちかけ中は他の「組む」の道具を止める', () => {
    let document = createAssemblyDocument('一つ');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part-1' }, {}));
    useAppStore.getState().openAssembly(document);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'boltedJoint'))
      .toEqual({ ready: false, reasonKey: 'assembly.boltedJoint.needTwoComponents' });
    useAppStore.getState().openAssembly(twoPlates());
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'placeStandardPart').ready).toBe(false);
  });

  it('履歴が無い時の元に戻す・やり直すは、他の打ちかけと同じく締結の打ちかけをやめるだけ', () => {
    for (const step of ['undoAssembly', 'redoAssembly'] as const) {
      useAppStore.getState().openAssembly(twoPlates());
      const before = useAppStore.getState().assembly;
      expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
      useAppStore.getState()[step]();
      expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
      expect(useAppStore.getState().assemblyBoltedJointPreview).toBeNull();
      expect(useAppStore.getState().assembly).toBe(before);
    }
  });

  it('部品を押した時の動かせない知らせは、締結の打ちかけを開いた時だけ消え、開けない時は残る', () => {
    // 溶接の画面検査 q5 と同じ原因: 押下で部品を動かす試みが断られ、その知らせが打ちかけの案内より先に出続けた。
    useAppStore.getState().openAssembly(twoPlates());
    useAppStore.getState().setSelection(['component-1']);
    expect(beginComponentDrag('component-1', WORK_PLANES.xy, [0, 0, 0])).toBe(false);
    const refused = useAppStore.getState().assemblyDragNotice;
    expect(refused === null || refused === 'dragging' || refused === 'complete').toBe(false);
    // 開けない(計算中)時は打ちかけを作らず、知らせも消さない。
    useAppStore.setState({ isComputing: true });
    expect(useAppStore.getState().beginBoltedJoint()).toBe(false);
    expect(useAppStore.getState().assemblyDragNotice).toBe(refused);
    useAppStore.setState({ isComputing: false });
    chooseAssemblyBuild('boltedJoint');
    expect(useAppStore.getState().assemblyBoltedJointDraft?.picks).toEqual([]);
    expect(useAppStore.getState().assemblyDragNotice).toBeNull();
  });
});

describe('選択の下書きの規則', () => {
  it('穴と当てる面は同じ部品から選び、5 つ目は足さない', () => {
    let draft = createBoltedJointDraft('doc');
    draft = appendBoltedJointPick(draft, face('component-1', 1)) ?? draft;
    expect(appendBoltedJointPick(draft, face('component-2', 2))).toBeNull();
    for (const target of [face('component-1', 2), face('component-2', 1), face('component-2', 2)]) {
      draft = appendBoltedJointPick(draft, target) ?? draft;
    }
    expect(draft.picks).toHaveLength(4);
    expect(appendBoltedJointPick(draft, face('component-2', 3))).toBeNull();
    expect(appendBoltedJointPick(createBoltedJointDraft('doc'), { kind: 'origin', componentId: 'component-1', element: 'origin' })).toBeNull();
  });

  it('長さの欄は 0 以上の数か式だけを受け、確認済みの長さを未確認の一覧より先に渡す', () => {
    expect(boltedJointChoices({ ...createBoltedJointDraft('doc'), engagementSource: '-1' }))
      .toEqual({ kind: 'value', field: 'engagement' });
    const choices = boltedJointChoices({ ...createBoltedJointDraft('doc'), engagementSource: '10', bottomClearanceSource: '0' });
    if ('kind' in choices) throw new Error('unexpected issue');
    expect([choices.engagement, choices.blindBottomClearance, choices.minimumProtrusion]).toEqual([10, 0, 0]);
    const firstUnverified = choices.lengthAvailability.findIndex((entry) => !entry.verified);
    const lastVerified = choices.lengthAvailability.map((entry) => entry.verified).lastIndexOf(true);
    expect(lastVerified).toBeGreaterThanOrEqual(0);
    expect(lastVerified).toBeLessThan(firstUnverified);
    // 確認済みの根拠は本体規格・並目の行だけ。附属書JA の行には付けない。
    expect(choices.lengthAvailability.filter((entry) => entry.verified)
      .every((entry) => entry.boltRowKey.endsWith(':main') && entry.threadSeries === 'coarse')).toBe(true);
  });
});

describe('締結の組の表示と解除', () => {
  it('木の行に締結の印を出し、「締結を外す」は 1 回の Undo で戻せる', () => {
    useAppStore.getState().openAssembly(joinRigidGroup(twoPlates(), ['component-1', 'component-2']));
    const rows = assemblyTreeRows(useAppStore.getState().assembly ?? twoPlates())
      .find((section) => section.key === 'component')?.rows ?? [];
    expect(rows.map((row) => row.badges.includes('fastened'))).toEqual([true, true]);
    useAppStore.getState().setSelection(['component-2']);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'releaseFastening')).toEqual({ ready: true, reasonKey: null });
    const fastened = useAppStore.getState().assembly;
    chooseAssemblyBuild('releaseFastening');
    expect(useAppStore.getState().assembly?.components.map((component) => component.rigidGroupId)).toEqual([undefined, undefined]);
    expect(useAppStore.getState().assembly?.components.map((component) => component.placement))
      .toEqual(fastened?.components.map((component) => component.placement));
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(fastened);
  });

  it('組に属さない部品を選んでいる時は「締結を外す」を出さない', () => {
    useAppStore.getState().openAssembly(twoPlates());
    useAppStore.getState().setSelection(['component-1']);
    expect(assemblyBuildReadiness(useAppStore.getState(), 'releaseFastening'))
      .toEqual({ ready: false, reasonKey: 'assembly.boltedJoint.selectFastened' });
  });
});
