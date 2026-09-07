/** 作図面・スケッチ。useAppStore.test.ts から責務単位で移した回帰テスト。 */

import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createEmptySketchDocument,
  FREE_WORK_PLANE_ID,
  WORK_PLANES,
  type PartDocument,
  type SketchDocument,
  type SketchPointFeature,
} from '@pointercad/model';
import {
  expressionValueFromNumber,
} from '@pointercad/expression';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  HOME_ORBIT,
} from '../viewport/cameraMath.js';
import {
  workPlaneForOrbit,
  workPlaneOfSketch,
} from './documentDerived.js';
import {
  createInitialDocumentState,
} from './initialDocumentState.js';
import {
  useAppStore,
} from './useAppStore.js';
import {
  resetTestStore,
  documentWithPoint,
  orbitFrom,
} from './testing/createTestStore.js';

beforeEach(resetTestStore);

describe('作図面(§0.a-0.3)', () => {
  it('作図面を明示的に切り替えられる', () => {
    useAppStore.getState().setWorkPlane('yz');
    expect(useAppStore.getState().workPlaneId).toBe('yz');
    useAppStore.getState().setWorkPlane('xy');
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('真上から見ていれば XY(法線 (0,0,1) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(0, 90))).toBe('xy');
    expect(workPlaneForOrbit(orbitFrom(123, -90))).toBe('xy');
  });

  it('+X 側から見ていれば YZ(法線 (1,0,0) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(0, 0))).toBe('yz');
    expect(workPlaneForOrbit(orbitFrom(180, 0))).toBe('yz');
  });

  it('+Y 側から見ていれば XZ(法線 (0,-1,0) が視線と平行)', () => {
    expect(workPlaneForOrbit(orbitFrom(90, 0))).toBe('xz');
    expect(workPlaneForOrbit(orbitFrom(-90, 0))).toBe('xz');
  });

  it('等角のホーム視点は 3 面に等しく傾くので既定の XY にする(FR-108)', () => {
    expect(workPlaneForOrbit(HOME_ORBIT)).toBe('xy');
  });

  it('「視点に合わせる」で今の視点に最も近い面へ移る', () => {
    useAppStore.getState().matchWorkPlaneToView(orbitFrom(90, 10));
    expect(useAppStore.getState().workPlaneId).toBe('xz');
    useAppStore.getState().matchWorkPlaneToView(orbitFrom(0, 80));
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('「視点に合わせる」の要求は数で伝える(視点の正本はビューポートにある)', () => {
    // ストアは視点を持たないので、押されたことだけを数えてビューポートに渡し返させる。
    expect(useAppStore.getState().matchWorkPlaneRequestCount).toBe(0);
    useAppStore.getState().requestMatchWorkPlaneToView();
    useAppStore.getState().requestMatchWorkPlaneToView();
    expect(useAppStore.getState().matchWorkPlaneRequestCount).toBe(2);
    // 数えるだけで作図面は変わらない。
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });
});

describe('3D スケッチで押した場所の面(FR-330、タスク14)', () => {
  /** 画面に正対する面の代わり。向きだけが要るので基準の XY をそのまま使う。 */
  const plane = { ...WORK_PLANES.xy, id: FREE_WORK_PLANE_ID };

  it('初期値は null(まだ一度も押していない)', () => {
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
  });

  it('道具を変えたら捨てる(取りかけを持ち越さない、NFR-UX-3)', () => {
    useAppStore.getState().setFreeSketchPlane(plane);
    expect(useAppStore.getState().freeSketchPlane).toEqual(plane);
    useAppStore.getState().setActiveTool('line');
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
  });

  it('作図面を変えたら捨てる(前の作図面の面を持ち越さない)', () => {
    useAppStore.getState().setFreeSketchPlane(plane);
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().freeSketchPlane).toBeNull();
    // 3D スケッチを選んだこと自体は残る。
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);
  });
});

describe('複数のスケッチ(P4 仕上げ (g)、FR-501、FR-328)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  /** 指定した作図面に置いた点を 1 つだけ持つスケッチ。 */
  function sketchOnPlane(id: string, name: string, planeId: 'xy' | 'xz' | 'yz'): SketchDocument {
    const point: SketchPointFeature = {
      id: 'point-1',
      name: '点1',
      planeId,
      kind: 'point',
      at: absoluteCoordinate(1, 2, 3),
    };
    return appendFeature({ id, name, features: [] }, point);
  }

  it('スケッチの作図面は最後に置いた要素の作図面(要素が無ければ決まらない)', () => {
    expect(workPlaneOfSketch(undefined)).toBeNull();
    expect(workPlaneOfSketch(createEmptySketchDocument())).toBeNull();
    expect(workPlaneOfSketch(sketchOnPlane('sketch-2', 'スケッチ2', 'xz'))).toBe('xz');
  });

  it('スケッチを切り替えると作図面が追従する', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'xy'), sketchOnPlane('sketch-2', 'スケッチ2', 'xz')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    expect(useAppStore.getState().workPlaneId).toBe('xy');

    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().document.activeSketchId).toBe('sketch-2');
    expect(useAppStore.getState().workPlaneId).toBe('xz');
    // 控えの sketch も切り替わり、作図面を解いた面(workPlane)も追いつく。
    expect(useAppStore.getState().sketch.id).toBe('sketch-2');
    expect(useAppStore.getState().workPlane).toEqual(WORK_PLANES.xz);

    useAppStore.getState().setActiveSketch('sketch-1');
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('要素が 1 つも無いスケッチへ切り替えても作図面は今のまま', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'yz'), createEmptySketchDocument2('sketch-2')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setWorkPlane('yz');
    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().document.activeSketchId).toBe('sketch-2');
    expect(useAppStore.getState().workPlaneId).toBe('yz');
  });

  it('切り替えでは Undo の段を作らない(形は変わらないため)', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = {
      ...base,
      sketches: [sketchOnPlane('sketch-1', 'スケッチ1', 'xy'), sketchOnPlane('sketch-2', 'スケッチ2', 'xz')],
      activeSketchId: 'sketch-1',
    };
    useAppStore.getState().applyDocument(document);
    const before = useAppStore.getState().undoStack.past.length;
    useAppStore.getState().setActiveSketch('sketch-2');
    expect(useAppStore.getState().undoStack.past).toHaveLength(before);
  });
});

/** 名前だけ差し替えた空のスケッチ(検査の読みやすさのための小さな補助)。 */
function createEmptySketchDocument2(id: string): SketchDocument {
  return { ...createEmptySketchDocument(), id, name: id };
}

describe('作図面が消えた文書に留まらない(P4b タスク22a-(5))', () => {
  /** 基準の3面のオフセット 0(= XY そのもの)を作業平面にした、いちばん単純な参照面。 */
  function documentWithReferencePlane(): PartDocument {
    return {
      ...createEmptyPartDocument(),
      references: [
        {
          id: 'referencePlane-1',
          name: '作業平面1',
          visible: true,
          kind: 'referencePlane',
          plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) },
        },
      ],
    };
  }

  it('作業平面へ切り替え → 新規 → workPlaneId が xy へ戻る(修正前は referencePlane-1 のまま残った)', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');
    expect(useAppStore.getState().workPlaneId).toBe('referencePlane-1');

    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('作業平面を持つ文書を開く → その id を保つ', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');

    // 開き直した先の文書にも同じ id の作業平面があれば、そのまま使う。
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    expect(useAppStore.getState().workPlaneId).toBe('referencePlane-1');
  });

  it('作業平面を持たない文書を開く → xy へ戻る', () => {
    useAppStore.getState().applyDocument(documentWithReferencePlane(), { replacesDocument: true });
    useAppStore.getState().setWorkPlane('referencePlane-1');

    useAppStore.getState().applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });
});

/*
 * 外観だけの変更で再計算を起こさない経路(P5 タスク10、要件§4.12、FR-1106〜1110)。
 * 「色を変えるとカーネルが 100 フィーチャーぶん走り直す」ことを防ぐ、P5 で最も効く配線。
 */

describe('3D スケッチのまま文書を差し替えたときの作図面(P4b タスク22b-(i))', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
  });

  it('3D スケッチのまま「新規」すると作図面は XY へ戻る', () => {
    /*
      Electron 台本の項目 10〜13 が落ちた不具合(統括の指示 2026-09-05)。3D スケッチのまま
      新規にすると作図面が「3D」のまま残り、次に描く矩形が
      「3D スケッチではこの形をかけません。」で必ず失敗していた。
    */
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);

    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().workPlaneId).toBe('xy');
  });

  it('3D スケッチのまま取り消しても作図面は 3D のまま(同じ部品の中の移動なので降ろさない)', () => {
    useAppStore.getState().setSketch(documentWithPoint());
    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);

    useAppStore.getState().undo();
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);
  });
});
