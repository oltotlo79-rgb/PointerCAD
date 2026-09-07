/** 拘束・引っぱり。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createEmptySketchDocument,
  replaceSketch,
  sketchConstraints,
  resolveSketch,
  type PartDocument,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  commitConstraintFromSelection,
} from '../sketch/constraintCommands.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  resultFor,
  sketchResultFor,
  documentWithPoint,
  partWithPoint,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('拘束の控えと後始末(FR-313、P4b タスク13)', () => {
  /** 線分 2 本を持つスケッチと、その 2 本に付けた直角の拘束。 */
  function partWithPerpendicular(): PartDocument {
    let sketch = appendFeature(createEmptySketchDocument(), {
      id: 'line-1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
      construction: false,
    });
    sketch = appendFeature(sketch, {
      id: 'line-2',
      name: '線分2',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(3, 9, 0),
      construction: false,
    });
    const outcome = commitConstraintFromSelection(sketch, 'perpendicular', ['line-1', 'line-2']);
    if (!outcome.ok) {
      throw new Error(`拘束を足せなかった: ${outcome.reason}`);
    }
    return replaceSketch(createEmptyPartDocument(), outcome.document);
  }

  it('拘束が無ければ一覧も診断も空のまま(要らない計算をしない)', () => {
    const store = useAppStore.getState();
    store.applySketch(documentWithPoint(), sketchResultFor(documentWithPoint()));
    expect(useAppStore.getState().constraintSummaries).toEqual([]);
    expect(useAppStore.getState().constraintDiagnosis).toBeNull();
  });

  it('再計算の結果から拘束の一覧と診断を控える', () => {
    const part = partWithPerpendicular();
    useAppStore.getState().applyDocument(part);
    const sketch = part.sketches[0];
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));
    const summaries = useAppStore.getState().constraintSummaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].label).toBe('直角1');
    // 印は 2 本の線の中点に 1 つずつ(`constraintSummary.ts` の `anchors`)。
    expect(summaries[0].anchors).toHaveLength(2);
  });

  it('要素を消すと、それを指していた拘束も一緒に消える(取り消し 1 回で戻る)', () => {
    const part = partWithPerpendicular();
    useAppStore.getState().applyDocument(part);
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(1);

    useAppStore.getState().removeSketchFeature('line-2');
    expect(useAppStore.getState().sketch.features.map((feature) => feature.id)).toEqual(['line-1']);
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(0);

    useAppStore.getState().undo();
    expect(sketchConstraints(useAppStore.getState().sketch)).toHaveLength(1);
    expect(useAppStore.getState().sketch.features).toHaveLength(2);
  });

  it('拘束の道具を選ぶと、下地の道具は選択に戻り、選択と押した相手は空になる', () => {
    useAppStore.getState().setActiveTool('line');
    useAppStore.getState().setSelection(['line-1']);
    useAppStore.getState().setConstraintTool('perpendicular');
    const state = useAppStore.getState();
    expect(state.activeConstraintKind).toBe('perpendicular');
    expect(state.activeTool).toBe('select');
    expect(state.selection).toEqual([]);
    expect(state.constraintTargets).toEqual([]);
  });

  it('別の道具を選ぶと拘束の道具はやめる(取りかけを持ち越さない)', () => {
    useAppStore.getState().setConstraintTool('parallel');
    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().activeConstraintKind).toBeNull();
  });

  it('文書が変われば拘束の断りは用済み(FR-504)', () => {
    useAppStore.getState().setConstraintError('線を 2 本選んでください。');
    expect(useAppStore.getState().constraintErrorMessage).not.toBeNull();
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().constraintErrorMessage).toBeNull();
  });
});

describe('引っぱりの一時状態(FR-313、P4b タスク14)', () => {
  /** 引っぱっている点の見立て。中身は `dragSketch.ts` の検査が押さえている。 */
  const drag = {
    pointKey: 'line-1:end',
    featureId: 'line-1',
    field: 'to',
    index: null,
    startUv: [10, 0],
    grabUv: [10, 0],
  } as const;

  it('掴んだだけでは形を変えない(押しただけで動かない)', () => {
    useAppStore.getState().beginSketchDrag(drag);
    expect(useAppStore.getState().sketchDrag).toEqual(drag);
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('掴んだら前の断りは消える(押し直したら理由も出し直す)', () => {
    useAppStore.getState().setDragRefusal('drag.error.fixed');
    useAppStore.getState().beginSketchDrag(drag);
    expect(useAppStore.getState().dragRefusalKey).toBeNull();
  });

  it('Esc(取り消し)は仮の形ごと捨てる', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().beginSketchDrag(drag);
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().endSketchDrag(false);
    expect(useAppStore.getState().sketchDrag).toBeNull();
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('離したときの形は次の計算まで残す(元の形へ戻ってちらつかない)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().beginSketchDrag(drag);
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().endSketchDrag(true);
    expect(useAppStore.getState().sketchDrag).toBeNull();
    expect(useAppStore.getState().dragResolved).not.toBeNull();
  });

  it('計算した形が届いたら仮の形は用済み(applySketch)', () => {
    const sketch = documentWithPoint();
    useAppStore.getState().setDragResolved(resolveSketch(sketch));
    useAppStore.getState().applySketch(sketch, sketchResultFor(sketch));
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('部品まるごとの計算が届いても仮の形は用済み(applyRecompute)', () => {
    const part = partWithPoint();
    useAppStore.getState().setDragResolved(resolveSketch(documentWithPoint()));
    useAppStore.getState().applyRecompute(part, resultFor(part));
    expect(useAppStore.getState().dragResolved).toBeNull();
  });

  it('文書が変われば引っぱれなかった理由は用済み(FR-504)', () => {
    useAppStore.getState().setDragRefusal('drag.error.derived');
    expect(useAppStore.getState().dragRefusalKey).not.toBeNull();
    useAppStore.getState().applyDocument(partWithPoint());
    expect(useAppStore.getState().dragRefusalKey).toBeNull();
  });
});

/**
 * 作図面が消えた文書に留まらない(統括の指示、2026-09-05。P4b タスク22a-(5))。
 *
 * 再現した不具合: 3 点の作業平面を作って作図面をその参照面に切り替えた後「新規」を
 * 押すと、空の新文書は `references` が空なのに `workPlaneId` が古い参照面の id の
 * まま残り、以後の矩形・線分が存在しない作図面を指して作られる(面が張れず
 * 「作図面が見つかりません」)。`documentPatch`(`resetDocument` / `applyDocument` の
 * 開く・復元の枝 / `undo` / `redo` が共通で通る)で、`workPlaneId` がその文書の
 * `references` に無ければ既定の XY へ戻すことで直した。
 */
