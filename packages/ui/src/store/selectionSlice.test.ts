/** 選択・選択セット。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  appendSolid,
  createEmptyPartDocument,
  removeSolid,
  type SolidBody,
} from '@pointercad/model';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  extrudeFeature,
  bodyFor,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('選択の種類(FR-106、NFR-UX-1、計画書 P3 タスク21、§0.a-0.6)', () => {
  it('起動時の選択の種類は立体(body)', () => {
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('setSelectionKind で手動切替でき、種類が変わると選択は空になる', () => {
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().setSelectionKind('face');
    expect(useAppStore.getState().selectionKind).toBe('face');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('setSelectionKind を同じ種類で 2 回呼んでも、2 回目は選択が残る(変わっていないので)', () => {
    useAppStore.getState().setSelectionKind('body'); // 1 回目: 起動時から変わらない
    useAppStore.getState().setSelection(['extrude-1']);
    useAppStore.getState().setSelectionKind('body'); // 2 回目もやはり変わらない
    expect(useAppStore.getState().selectionKind).toBe('body');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);
  });

  it('setActiveTool(select) は選択の種類を立体へ戻す', () => {
    useAppStore.getState().setSelectionKind('edge');
    useAppStore.getState().setActiveTool('select');
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('加工の道具を選ぶと必要な種類へ自動で切り替わる(§0.a-0.6: 穴・ねじ穴→面、面取り→辺、パターン→立体)', () => {
    useAppStore.getState().setActiveTool('hole');
    expect(useAppStore.getState().selectionKind).toBe('face');
    useAppStore.getState().setActiveTool('threadHole');
    expect(useAppStore.getState().selectionKind).toBe('face');
    useAppStore.getState().setActiveTool('fillet');
    expect(useAppStore.getState().selectionKind).toBe('edge');
    useAppStore.getState().setActiveTool('chamfer');
    expect(useAppStore.getState().selectionKind).toBe('edge');
    useAppStore.getState().setActiveTool('linearPattern');
    expect(useAppStore.getState().selectionKind).toBe('body');
    useAppStore.getState().setActiveTool('circularPattern');
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it('道具の変更で選択の種類が変わると選択が空になり、変わらなければ選択は残る', () => {
    useAppStore.getState().setActiveTool('select');
    useAppStore.getState().setSelection(['extrude-1']);

    // body → body(押し出しも立体を選ぶ道具なので種類は変わらない)。
    useAppStore.getState().setActiveTool('extrude');
    expect(useAppStore.getState().selection).toEqual(['extrude-1']);

    // body → edge(R 面取りは辺を選ぶ)。合わない選択は外れる。
    useAppStore.getState().setActiveTool('fillet');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('フィーチャーを消すと部分形状の選択(extrude-1#face:0)も外れる(§0.a-0.8)', () => {
    const withSolid = appendSolid(createEmptyPartDocument(), extrudeFeature('extrude-1'));
    useAppStore.getState().applyDocument(withSolid, { undoable: false });
    useAppStore.getState().setSelectionKind('face');
    useAppStore.getState().setSelection(['extrude-1#face:0']);
    expect(useAppStore.getState().selection).toEqual(['extrude-1#face:0']);

    useAppStore.getState().applyDocument(removeSolid(withSolid, 'extrude-1'));
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('立体の選択と部分形状の選択が混ざった状態で setSelectionKind すると選択が空になる', () => {
    useAppStore.getState().setSelectionKind('body');
    useAppStore.getState().setSelection(['extrude-1', 'extrude-2#face:0']);
    useAppStore.getState().setSelectionKind('face');
    expect(useAppStore.getState().selection).toEqual([]);
  });

  it('resetDocument で選択の種類も立体へ戻る(NFR-UX-3、前の部品の状態を持ち越さない)', () => {
    useAppStore.getState().setSelectionKind('edge');
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().selectionKind).toBe('body');
  });

  it(
    '加工の確定後、道具を選択へ戻してから作った立体を選ぶと選択が残る' +
      '(タスク30 不具合(a): AppShell.onSolidCommit が setActiveTool(\'select\') → setSelection の' +
      '順で呼ぶ。逆順だと setActiveTool が種類の変化(面/辺 → 立体)を見て選択を空にする)',
    () => {
      // 穴・ねじ穴・R/C面取りのように選ぶ種類が body 以外になる道具で確定した状況を再現する。
      useAppStore.getState().setActiveTool('hole');
      useAppStore.getState().setSelection(['extrude-1#face:0']);
      expect(useAppStore.getState().selectionKind).toBe('face');

      // 修正後の順(道具を選択へ戻してから、作った立体を選ぶ)。
      useAppStore.getState().setActiveTool('select');
      useAppStore.getState().setSelection(['hole-1']);

      const state = useAppStore.getState();
      expect(state.selectionKind).toBe('body');
      expect(state.selection).toEqual(['hole-1']);
    },
  );

  it('(参考)逆順だと setActiveTool が選択を空にする(タスク30 不具合(a) の再現)', () => {
    useAppStore.getState().setActiveTool('hole');
    useAppStore.getState().setSelection(['extrude-1#face:0']);

    // 修正前の順(作った立体を選んでから、道具を選択へ戻す)だと選択が空になる。
    useAppStore.getState().setSelection(['hole-1']);
    useAppStore.getState().setActiveTool('select');

    expect(useAppStore.getState().selection).toEqual([]);
  });
});

describe('選択セット(FR-112、P6 タスク43)', () => {
  /** 面 2 枚・辺 1 本・頂点 1 つを持つ立体(指紋を作れるだけの中身を入れる)。 */
  function bodyWithSubShapes(featureId: string): SolidBody {
    return {
      ...bodyFor(featureId),
      faces: [
        {
          index: 0,
          surfaceKind: 'plane',
          area: 100,
          centroid: [5, 5, 10],
          axis: [0, 0, 1],
          radius: null,
          triangleOffset: 0,
          triangleCount: 1,
        },
        {
          index: 1,
          surfaceKind: 'plane',
          area: 100,
          centroid: [5, 5, 0],
          axis: [0, 0, -1],
          radius: null,
          triangleOffset: 1,
          triangleCount: 1,
        },
      ],
      edges: [
        {
          index: 0,
          curveKind: 'line',
          length: 10,
          midpoint: [5, 0, 0],
          start: [0, 0, 0],
          end: [10, 0, 0],
          axis: [1, 0, 0],
          radius: null,
          segmentOffset: 0,
          segmentCount: 1,
        },
      ],
      vertices: [{ index: 0, position: [0, 0, 0] }],
    };
  }

  /** 立体 1 つを画面に置き、指定したものを選んだ状態にする。 */
  function selectOn(selection: readonly string[]): void {
    useAppStore.setState({ bodies: [bodyWithSubShapes('extrude-1')], selection });
  }

  it('いま選んでいる面に名前を付けて覚え、形の計算は走らない(§0.a-0.44)', () => {
    selectOn(['extrude-1#face:0', 'extrude-1#face:1']);
    expect(useAppStore.getState().createSelectionSetFromSelection('上面')).toBeNull();

    const sets = useAppStore.getState().document.selectionSets;
    expect(sets).toHaveLength(1);
    expect(sets[0]?.name).toBe('上面');
    expect(sets[0]?.members).toHaveLength(2);
    // 形に影響しない変更なので計算中の札は立たない(`affectsShape` が偽)。
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('辺・頂点・立体も覚える(利用者の決定、2026-09-06)', () => {
    selectOn(['extrude-1', 'extrude-1#edge:0', 'extrude-1#vertex:0']);
    useAppStore.getState().createSelectionSetFromSelection('まぜこぜ');
    const kinds = useAppStore
      .getState()
      .document.selectionSets[0]?.members.map((member) => member.kind);
    expect(kinds).toEqual(['body', 'edge', 'vertex']);
  });

  it('名前が空なら断り、文書を 1 バイトも変えない(NFR-UX-5)', () => {
    selectOn(['extrude-1#face:0']);
    const before = useAppStore.getState().document;
    expect(useAppStore.getState().createSelectionSetFromSelection('   ')).toBe('emptyName');
    // 同一参照のままであること(取り消しの段も積まれていない)。
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('同じ名前の組を 2 つ作れる(id で区別する。§2.13)', () => {
    selectOn(['extrude-1#face:0']);
    useAppStore.getState().createSelectionSetFromSelection('上面');
    useAppStore.getState().createSelectionSetFromSelection('上面');
    const sets = useAppStore.getState().document.selectionSets;
    expect(sets).toHaveLength(2);
    expect(sets[0]?.id).not.toBe(sets[1]?.id);
  });

  it('何も選んでいなくても空の組を作れる(あとから足せる。§2.13)', () => {
    selectOn([]);
    expect(useAppStore.getState().createSelectionSetFromSelection('あとで')).toBeNull();
    expect(useAppStore.getState().document.selectionSets[0]?.members).toEqual([]);
  });

  it('あとから足せる。同じものをもう一度足しても増えない', () => {
    selectOn([]);
    useAppStore.getState().createSelectionSetFromSelection('あとで');
    const id = useAppStore.getState().document.selectionSets[0]?.id ?? '';

    selectOn(['extrude-1#face:0']);
    useAppStore.getState().addSelectionToSet(id);
    expect(useAppStore.getState().document.selectionSets[0]?.members).toHaveLength(1);

    const afterFirst = useAppStore.getState().document;
    useAppStore.getState().addSelectionToSet(id);
    // 1 件も増えないときは文書を作り直さない(NFR-PF-1)。
    expect(useAppStore.getState().document).toBe(afterFirst);
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('名前を変えられる。空の名前は断り、元の名前が残る', () => {
    selectOn(['extrude-1#face:0']);
    useAppStore.getState().createSelectionSetFromSelection('上面');
    const id = useAppStore.getState().document.selectionSets[0]?.id ?? '';

    expect(useAppStore.getState().renameSelectionSet(id, '天板')).toBeNull();
    expect(useAppStore.getState().document.selectionSets[0]?.name).toBe('天板');

    expect(useAppStore.getState().renameSelectionSet(id, ' ')).toBe('emptyName');
    expect(useAppStore.getState().document.selectionSets[0]?.name).toBe('天板');
  });

  it('消せる。取り消し 1 回で戻る(FR-505)', () => {
    selectOn(['extrude-1#face:0']);
    useAppStore.getState().createSelectionSetFromSelection('上面');
    const id = useAppStore.getState().document.selectionSets[0]?.id ?? '';

    useAppStore.getState().removeSelectionSet(id);
    expect(useAppStore.getState().document.selectionSets).toEqual([]);

    useAppStore.getState().undo();
    expect(useAppStore.getState().document.selectionSets).toHaveLength(1);
  });

  it('組を選ぶと中身が選択に入り、選ぶ種類もそろう(FR-112「呼び出す」)', () => {
    selectOn(['extrude-1#face:0', 'extrude-1#face:1']);
    useAppStore.getState().createSelectionSetFromSelection('上面');
    const id = useAppStore.getState().document.selectionSets[0]?.id ?? '';

    useAppStore.setState({ selection: [], selectionKind: 'body' });
    expect(useAppStore.getState().selectSelectionSet(id)).toBe(0);
    expect(useAppStore.getState().selection).toEqual(['extrude-1#face:0', 'extrude-1#face:1']);
    expect(useAppStore.getState().selectionKind).toBe('face');
    expect(useAppStore.getState().isComputing).toBe(false);
  });

  it('面が消えていたらその 1 件だけ引けず、件数を返す。組は残る(FR-504、§2.13)', () => {
    selectOn(['extrude-1#face:0', 'extrude-1#face:1']);
    useAppStore.getState().createSelectionSetFromSelection('上面');
    const id = useAppStore.getState().document.selectionSets[0]?.id ?? '';

    // 面が 1 枚だけになった立体(番号 1 の面がもう無い)。
    const shrunk = bodyWithSubShapes('extrude-1');
    useAppStore.setState({ bodies: [{ ...shrunk, faces: shrunk.faces.slice(0, 1) }] });

    expect(useAppStore.getState().selectSelectionSet(id)).toBe(1);
    expect(useAppStore.getState().selection).toEqual(['extrude-1#face:0']);
    expect(useAppStore.getState().document.selectionSets[0]?.members).toHaveLength(2);
  });
});

/**
 * 3D プリントの点検の結果の置き場(FR-815、P6 §0.53。タスク42・43)。
 * **43b が置くのは欄と口だけ**で、中身を入れるのは 43a。
 */
