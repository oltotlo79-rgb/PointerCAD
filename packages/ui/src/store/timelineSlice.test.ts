/** タイムライン。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  appendSolid,
  createEmptyPartDocument,
  removeSolid,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  attachPartRecompute,
} from './attachKernel.js';
import {
  createInitialDocumentState,
} from './initialDocumentState.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  createFakeRecompute,
  resultFor,
  tick,
  partWithPoint,
  partWithThreeSolids,
  extrudeFeature,
  holeFeature,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('タイムラインのつまみ(FR-507、FR-506、P4b タスク19)', () => {
  it('起動直後のつまみは末尾(null)で、知らせも出ていない(§0.a-0.19)', () => {
    expect(useAppStore.getState().timelineIndex).toBeNull();
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('つまみを動かしても文書は 1 バイトも変わらず、Undo の段も増えない', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const before = useAppStore.getState().document;
    const undoBefore = useAppStore.getState().undoStack.past.length;

    useAppStore.getState().setTimelineIndex(0);

    expect(useAppStore.getState().timelineIndex).toBe(0);
    // 形の正本は全体のまま。保存されるのはこれ(`savePart` は document を書く)。
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().document.solids).toHaveLength(3);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore);
  });

  it('文書をまるごと差し替えたら(開く)つまみは末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(1);
    expect(useAppStore.getState().timelineIndex).toBe(1);

    useAppStore.getState().applyDocument(partWithPoint(), { replacesDocument: true });

    expect(useAppStore.getState().timelineIndex).toBeNull();
    // 開いただけで「最後まで戻しました」とは言わない(言っても意味が無い)。
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('新規・復元(resetDocument)でもつまみは末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  it('元に戻す・やり直すでもつまみは末尾へ戻る(履歴の件数が変わりうるため)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().timelineIndex).toBeNull();

    useAppStore.getState().setTimelineIndex(0);
    useAppStore.getState().redo();
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  /*
   * タスク19 では、戻したまま作ったものは末尾へ積まれるので、つまみを末尾へ戻して
   * 「最後まで戻しました」と知らせていた。タスク20 で**つまみの位置へ差し込む**ように
   * 変えたので、期待値もそれに合わせて書き替えてある(緩めたのではなく、決めた振る舞いが
   * 変わった。計画書 タスク20「実装内容」)。
   */
  it('途中まで戻したまま履歴が伸びたら、つまみのところへ差し込んでつまみを 1 つ進める', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);

    const grown = appendSolid(useAppStore.getState().document, extrudeFeature('4'));
    useAppStore.getState().applyDocument(grown);

    // 押し出し4 は末尾ではなく、つまみ(押し出し1)の次へ入る。
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual([
      '1',
      '4',
      '2',
      '3',
    ]);
    // つまみは差し込んだ段へ進むので、作ったものがそのまま画面に出る。
    expect(useAppStore.getState().timelineIndex).toBe(1);
    expect(useAppStore.getState().timelineNoticeKey).toBe('timeline.inserted');
  });

  it('差し込みは Undo 1 回で元へ戻り、つまみも末尾へ戻る', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore
      .getState()
      .applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature('4')));

    useAppStore.getState().undo();

    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['1', '2', '3']);
    expect(useAppStore.getState().timelineIndex).toBeNull();
  });

  it('保存される文書には差し込んだ並びがそのまま入る(つまみで切った文書は保存しない)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);
    useAppStore
      .getState()
      .applyDocument(appendSolid(useAppStore.getState().document, extrudeFeature('4')));

    expect(useAppStore.getState().document.solids).toHaveLength(4);
    expect(useAppStore.getState().undoStack.present).toBe(useAppStore.getState().document);
  });

  it('つまみが末尾のまま履歴が伸びても、知らせは出ない(これまでどおり)', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const grown = appendSolid(useAppStore.getState().document, extrudeFeature('4'));
    useAppStore.getState().applyDocument(grown);

    expect(useAppStore.getState().timelineIndex).toBeNull();
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('戻したまま名前を変える・消すなど履歴が伸びない差し替えでは、つまみは動かない', () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    useAppStore.getState().setTimelineIndex(0);

    useAppStore.getState().applyDocument(removeSolid(useAppStore.getState().document, '3'));

    expect(useAppStore.getState().timelineIndex).toBe(0);
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('順序の入れ替えは Undo 1 段で、断られたら文書を 1 バイトも変えない(FR-507、FR-504)', () => {
    // 押し出し1 → 穴1(押し出し1 が対象)→ 押し出し2(独立)。
    const base = appendSolid(
      appendSolid(appendSolid(createEmptyPartDocument(), extrudeFeature('1')), holeFeature('h', '1')),
      extrudeFeature('2'),
    );
    useAppStore.getState().applyDocument(base);
    const undoBefore = useAppStore.getState().undoStack.past.length;

    // 独立した押し出し2 を先頭へ。1 回積むので取り消し 1 回で戻る(NFR-UX-3)。
    useAppStore.getState().moveTimelineItem('2', 0);
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['2', '1', 'h']);
    expect(useAppStore.getState().undoStack.past).toHaveLength(undoBefore + 1);
    expect(useAppStore.getState().timelineRefusal).toBeNull();
    // 動かしたのは並びだけで、フィーチャーそのものは同じ物のまま(NFR-PF-3。
    // 中身を作り直すと、変わっていない段まで形の計算をやり直すことになる)。
    expect(useAppStore.getState().document.solids[1]).toBe(base.solids[0]);
    expect(useAppStore.getState().document.solids[2]).toBe(base.solids[1]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.solids.map((solid) => solid.id)).toEqual(['1', 'h', '2']);

    // 押し出し1 を穴1 の後ろへは動かせない。断りは「壊れる側」の穴1 を指す。
    const before = useAppStore.getState().document;
    useAppStore.getState().moveTimelineItem('1', 1);
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().timelineRefusal?.blockingFeatureId).toBe('h');
    expect(useAppStore.getState().timelineRefusal?.message).toContain('穴h');

    // 次に形が変われば断りは用済み(FR-504)。
    useAppStore.getState().moveTimelineItem('2', 0);
    expect(useAppStore.getState().timelineRefusal).toBeNull();
  });

  it('つまみを動かすと、切った文書で計算し直す(保存する文書は全体のまま)', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);

    // つないだ直後は末尾なので、渡るのは文書そのもの(=== を保つ、NFR-PF-3)。
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].document).toBe(useAppStore.getState().document);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore.getState().setTimelineIndex(0);
    expect(fake.calls).toHaveLength(2);
    // 渡るのは 1 段目までに切った文書。
    expect(fake.calls[1].document.solids).toHaveLength(1);
    expect(fake.calls[1].document).not.toBe(useAppStore.getState().document);
    // 切っても中のフィーチャーは複製しないので、形の作り直しが起きない(§2.7)。
    expect(fake.calls[1].document.solids[0]).toBe(useAppStore.getState().document.solids[0]);
    // ストアの正本(保存されるもの)は全体のまま。
    expect(useAppStore.getState().document.solids).toHaveLength(3);
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await tick();

    // 末尾へ戻すと、また文書そのものが渡る。
    useAppStore.getState().setTimelineIndex(null);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].document).toBe(useAppStore.getState().document);
    fake.calls[2].settle(resultFor(fake.calls[2].document));
    await tick();
    detach();
  });

  it('同じ位置へ置き直しても計算し直さない', async () => {
    useAppStore.getState().applyDocument(partWithThreeSolids());
    const fake = createFakeRecompute();
    const detach = attachPartRecompute(fake.recompute);
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await tick();

    useAppStore.getState().setTimelineIndex(null);
    expect(fake.calls).toHaveLength(1);
    detach();
  });
});

describe('つまみの初回の案内(FR-507、利用者の決定①、P4b タスク22b-(a))', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    // 既読を「まだ見せていない」に戻す(端末に覚える欄なので検査ごとに初期化する)。
    useAppStore.setState({
      displaySettings: { ...useAppStore.getState().displaySettings, timelineHintSeen: false },
    });
  });

  it('ソリッドが初めて 2 段になったとき 1 回だけ帯に案内を出し、既読を覚える', () => {
    const one = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    const two = appendSolid(one, extrudeFeature('extrude-2'));

    // 1 段目では出さない(戻す先が無い)。
    useAppStore.getState().applyDocument(one);
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
    expect(useAppStore.getState().displaySettings.timelineHintSeen).toBe(false);

    // 2 段目で出る。
    useAppStore.getState().applyDocument(two);
    expect(useAppStore.getState().timelineNoticeKey).toBe('timeline.hint');
    expect(useAppStore.getState().displaySettings.timelineHintSeen).toBe(true);

    // 3 段目では出さない(既読になっている)。
    useAppStore.getState().applyDocument(appendSolid(two, extrudeFeature('extrude-3')));
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });

  it('既読なら二度と出さない', () => {
    useAppStore.setState({
      displaySettings: { ...useAppStore.getState().displaySettings, timelineHintSeen: true },
    });
    const one = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(one);
    useAppStore.getState().applyDocument(appendSolid(one, extrudeFeature('extrude-2')));
    expect(useAppStore.getState().timelineNoticeKey).toBeNull();
  });
});

/*
 * 測定の欄(FR-1102、P5 タスク31)。**測る・消すの操作はタスク32** で、ここが決めるのは
 * 「結果を持つ欄」と「いつ消えるか」だけ。要件の「モデルを変更するまで残る」を、
 * `affectsShape` の真偽そのままで固定する(§0.a-0.29)。
 */
