/**
 * `attachSketchInteraction.ts` の当たり判定の順序を決める純関数の検査
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク23、§2.3.2)。
 *
 * 選択種類の純判定に加え、Node の EventTarget に最小の canvas/projection 契約を用意し、
 * pointermove / pointerdown が実ストアへ同じ候補を渡すことを検査する。
 * ブラウザーの投影・実カーネル形状のhitは E2E の connect-points で確かめる。
 */
import { absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, createPointFeature,
  replaceSketch, type Vec3 } from '@pointercad/model';
import { expectWithinBudget } from '@pointercad/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addsToSketchSelection,
  attachSketchInteraction,
  isDrawingTool,
  isLookTool,
  isSolidTool,
  picksBodies,
  picksSubShapes,
  skipsSketchElements,
  toSubShapeBodies,
} from './attachSketchInteraction.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import { snapToSphereGrid, type SphereGridSpec } from './buildSphereGrid.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { bodyFor, extrudeFeature, orbitFrom, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { accountingSnapshot, captureStagedSolidOwnership, currentStagedSolid, type PartStager,
  type StagedSolidState } from '../store/recomputeSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachCameraControls } from './attachCameraControls.js';
import type { ViewportScene } from './createViewportScene.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function interactionCanvas(): { canvas: HTMLCanvasElement; captured: Set<number>;
  send: (type: string, x?: number, y?: number, pointerId?: number) => void } {
  const captured = new Set<number>();
  const canvas = Object.assign(new EventTarget(), {
    clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
    setPointerCapture: (id: number): void => { captured.add(id); },
    hasPointerCapture: (id: number): boolean => captured.has(id),
    releasePointerCapture: (id: number): void => { captured.delete(id); },
    focus: (): void => {},
  }) as HTMLCanvasElement;
  return { canvas, captured, send: (type, x = 40, y = 50, pointerId = 1): void => {
    canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
      pointerId, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    }));
  } };
}

function attachPointInteraction(canvas: HTMLCanvasElement): ReturnType<typeof attachSketchInteraction> {
  const projection: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay'> = {
    worldToScreen: point => [point[0], point[1]], screenToPlanePoint: (x, y) => [x, y, 0],
    pointerRay: () => null,
  };
  return attachSketchInteraction(canvas, projection as ViewportScene, () => orbitFrom(0, 0), () => false);
}

function resetPointDocument(): void {
  resetTestStore();
  const empty = createEmptyPartDocument();
  const sketch = appendFeature(empty.sketches[0], createPointFeature(empty.sketches[0], absoluteCoordinate(40, 50, 0)));
  const document = replaceSketch(empty, sketch);
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1 });
  state.recordRecomputeCompletion(1, 'success');
  useAppStore.setState({ snapEnabled: false });
}

describe('sketch interaction の入力所有権', () => {
  it('点の作図押下は数値入力だけを開き、文書を確定しない', () => {
    resetPointDocument();
    useAppStore.getState().setActiveTool('point');
    const { canvas, send } = interactionCanvas();
    const attached = attachPointInteraction(canvas);
    try {
      const before = useAppStore.getState();
      send('pointerdown', 100, 120);
      expect(useAppStore.getState().numericInput?.toolId).toBe('point');
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    } finally { attached.detach(); resetTestStore(); }
  });

  it.each(['pointerup', 'pointercancel', 'detach'] as const)(
    '断面つまみの%sは捕捉を解き、文書とUndoを変更しない', ending => {
      resetPointDocument();
      useAppStore.getState().toggleSectionView();
      const { canvas, captured, send } = interactionCanvas();
      const attached = attachPointInteraction(canvas);
      try {
        const before = useAppStore.getState();
        send('pointerdown', 0, 0);
        expect(captured.has(1)).toBe(true);
        if (ending === 'detach') attached.detach();
        else send(ending, 0, 0);
        expect(captured.size).toBe(0);
        send('pointerup', 0, 0);
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      } finally { attached.detach(); resetTestStore(); }
    },
  );

  it('100回の装着破棄で6 listenerとstore購読を残さない', () => {
    resetPointDocument();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++; frames.set(id, callback); return id;
    });
    const cancel = vi.fn((id: number) => { frames.delete(id); });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { canvas, captured, send } = interactionCanvas();
    const add = vi.spyOn(canvas, 'addEventListener');
    const remove = vi.spyOn(canvas, 'removeEventListener');
    const focus = vi.spyOn(canvas, 'focus');
    const subscribe = vi.spyOn(useAppStore, 'subscribe');
    for (let index = 0; index < 100; index++) {
      const attached = attachPointInteraction(canvas);
      send('pointerdown');
      send('pointermove', 55, 60);
      expect(frames.size).toBe(1);
      expect(captured.has(1)).toBe(true);
      attached.detach();
      attached.detach();
      expect(frames.size).toBe(0);
      expect(captured.size).toBe(0);
      expect(useAppStore.getState().sketchDrag).toBeNull();
    }
    expect(add).toHaveBeenCalledTimes(600);
    expect(remove).toHaveBeenCalledTimes(600);
    expect(add.mock.calls.map(([type]) => type)).toEqual(remove.mock.calls.map(([type]) => type));
    expect(subscribe).toHaveBeenCalledTimes(100);
    expect(cancel).toHaveBeenCalledTimes(100);
    useAppStore.getState().requestViewportFocus();
    expect(focus).not.toHaveBeenCalled();
    resetTestStore();
  });

  it('同値の吸着を新canvasが再公開した後、旧canvasのdetachは新しい印を消さない', () => {
    resetPointDocument();
    useAppStore.setState({ snapEnabled: true });
    const first = interactionCanvas();
    const second = interactionCanvas();
    const oldAttachment = attachPointInteraction(first.canvas);
    const newAttachment = attachPointInteraction(second.canvas);
    try {
      first.send('pointermove');
      const oldIndicator = useAppStore.getState().snapIndicator;
      expect(oldIndicator).not.toBeNull();
      second.send('pointermove');
      const newIndicator = useAppStore.getState().snapIndicator;
      expect(newIndicator).toEqual(oldIndicator);
      expect(newIndicator).not.toBe(oldIndicator);
      oldAttachment.detach();
      expect(useAppStore.getState().snapIndicator).toBe(newIndicator);
      newAttachment.detach();
      expect(useAppStore.getState().snapIndicator).toBeNull();
    } finally { oldAttachment.detach(); newAttachment.detach(); resetTestStore(); }
  });

  it('旧dragのownerが新canvasへ移った後のstopDragは新しい一時表示を消さない', () => {
    resetPointDocument();
    const first = interactionCanvas();
    const second = interactionCanvas();
    const oldAttachment = attachPointInteraction(first.canvas);
    const newAttachment = attachPointInteraction(second.canvas);
    try {
      first.send('pointerdown');
      const oldDrag = useAppStore.getState().sketchDrag;
      second.send('pointerdown');
      expect(useAppStore.getState().sketchDrag).not.toBe(oldDrag);
      const indicator = { screen: [40, 50], kind: 'endpoint', elementId: 'new-canvas' } as const;
      const editPreview = { kind: 'trim', points: [[0, 0, 0], [1, 0, 0]] } as const;
      useAppStore.getState().setSnapIndicator(indicator);
      useAppStore.getState().setEditPreview(editPreview);
      first.send('pointermove');
      expect(first.captured.size).toBe(0);
      expect(useAppStore.getState().snapIndicator).toBe(indicator);
      expect(useAppStore.getState().editPreview).toBe(editPreview);
    } finally { oldAttachment.detach(); newAttachment.detach(); resetTestStore(); }
  });

  it('文書差替えは次のpointer/RAFを待たず掴みと断面の捕捉を解く', () => {
    resetPointDocument();
    const { canvas, captured, send } = interactionCanvas();
    const attached = attachPointInteraction(canvas);
    try {
      send('pointerdown');
      expect(captured.has(1)).toBe(true);
      useAppStore.getState().resetDocument(createEmptyPartDocument());
      expect(captured.size).toBe(0);
      expect(useAppStore.getState().sketchDrag).toBeNull();
      useAppStore.getState().toggleSectionView();
      send('pointerdown', 0, 0);
      expect(captured.has(1)).toBe(true);
      useAppStore.getState().resetDocument(createEmptyPartDocument());
      expect(captured.size).toBe(0);
    } finally { attached.detach(); resetTestStore(); }
  });

  it.each(['pointercancel', 'Escape', 'detach', 'old-document'] as const)(
    '%sは解いた仮形と予約RAFを捨て、遅れたpointerupでも確定しない', ending => {
      resetPointDocument();
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 1;
      const cancel = vi.fn((id: number) => { frames.delete(id); });
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextFrame++; frames.set(id, callback); return id;
      });
      vi.stubGlobal('cancelAnimationFrame', cancel);
      const { canvas, captured, send } = interactionCanvas();
      const attached = attachPointInteraction(canvas);
      try {
        send('pointerdown');
        expect(useAppStore.getState().sketchDrag).not.toBeNull();
        expect(captured.has(1)).toBe(true);
        send('pointermove', 55, 60);
        expect(frames.size).toBe(1);
        const firstFrame = [...frames.entries()][0];
        expect(firstFrame).toBeDefined();
        if (firstFrame !== undefined) {
          frames.delete(firstFrame[0]);
          firstFrame[1](0);
        }
        expect(useAppStore.getState().dragResolved).not.toBeNull();
        send('pointermove', 60, 65);
        expect(frames.size).toBe(1);
        const oldFrame = [...frames.values()][0];
        expect(oldFrame).toBeDefined();
        const before = useAppStore.getState();
        if (ending === 'old-document') {
          useAppStore.getState().resetDocument(createEmptyPartDocument());
        } else if (ending === 'Escape') {
          canvas.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
        } else if (ending === 'detach') attached.detach();
        else send('pointercancel');
        const afterCancel = useAppStore.getState();
        expect(afterCancel.sketchDrag).toBeNull();
        expect(afterCancel.dragResolved).toBeNull();
        expect(frames.size).toBe(0);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(captured.size).toBe(0);
        oldFrame?.(0);
        expect(useAppStore.getState().dragResolved).toBeNull();
        send('pointerup');
        expect(useAppStore.getState().document).toBe(afterCancel.document);
        expect(useAppStore.getState().undoStack).toBe(afterCancel.undoStack);
        if (ending !== 'old-document') {
          expect(afterCancel.document).toBe(before.document);
          expect(afterCancel.undoStack).toBe(before.undoStack);
        }
      } finally { attached.detach(); resetTestStore(); }
    },
  );

  it('drag後のpointerupだけが点を確定し、Undoを1段増やす', () => {
    resetPointDocument();
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(1, callback); return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const { canvas, captured, send } = interactionCanvas();
    const attached = attachPointInteraction(canvas);
    try {
      const before = useAppStore.getState();
      send('pointerdown');
      send('pointermove', 90, 90, 2);
      send('pointerup', 90, 90, 2);
      expect(frames.size).toBe(0);
      expect(useAppStore.getState().sketchDrag).not.toBeNull();
      expect(captured.has(1)).toBe(true);
      send('pointermove', 55, 60);
      expect(frames.size).toBe(1);
      const frame = frames.get(1);
      expect(frame).toBeDefined();
      frames.delete(1);
      frame?.(0);
      expect(useAppStore.getState().dragResolved).not.toBeNull();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      send('pointerup', 55, 60);
      expect(useAppStore.getState().document).not.toBe(before.document);
      expect(useAppStore.getState().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(useAppStore.getState().sketchDrag).toBeNull();
      expect(captured.size).toBe(0);
    } finally { attached.detach(); resetTestStore(); }
  });
});

describe('頂点モードの実canvasイベントはhoverと確定で同じpoint/vertex候補を使う', () => {
  it.each(['shiftKey', 'ctrlKey'] as const)('%sで実点を追加し重なる投影は拒否する', modifier => {
    resetTestStore();
    let document = appendSolid(createEmptyPartDocument(), extrudeFeature('solid-1'));
    const sketch = appendFeature(document.sketches[0], createPointFeature(document.sketches[0], absoluteCoordinate(40, 50, 60), 'free'));
    document = replaceSketch(document, sketch);
    const vertexOrigin = { version: 1, shapeKind: 'vertex', identity: {
      kind: 'box-vertex', featureId: 'solid-1', role: 'top-front-left' } } as const;
    const body = { ...bodyFor('solid-1'),
      mesh: { ...bodyFor('solid-1').mesh, positions: new Float32Array([0, 0, 0, 10, 20, 30]) },
      vertices: [{ index: 0, position: [10, 20, 30] as Vec3 }],
      origins: { version: 1, state: 'tracked', bindings: [
        { origin: vertexOrigin, state: 'unique', current: { kind: 'vertex', index: 0 } }] } as const };
    const state = () => useAppStore.getState();
    state().resetDocument(document);
    state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1, bodies: [body] });
    state().recordRecomputeCompletion(1, 'success');
    state().setSelectionKind('vertex');
    const captured = new Set<number>();
    const canvas = Object.assign(new EventTarget(), {
      clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600,
        width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
      setPointerCapture: (id: number): void => { captured.add(id); }, hasPointerCapture: (id: number): boolean => captured.has(id),
      releasePointerCapture: (id: number): void => { captured.delete(id); }, focus: () => {},
    }) as HTMLCanvasElement;
    const projection: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint'> = {
      worldToScreen: point => [point[0], point[1]], screenToPlanePoint: (x, y) => [x, y, 0],
    };
    const scene = projection as ViewportScene;
    const controls = attachCameraControls(canvas, () => {});
    const interaction = attachSketchInteraction(canvas, scene, () => controls.getOrbit(), () => controls.isDragging());
    const send = (type: string, x: number, y: number, additive = false): void => {
      canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0,
        clientX: x, clientY: y, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
        [modifier]: additive,
      }));
    };
    try {
      send('pointermove', 10, 20);
      expect(state().hoveredElementId).toBe('solid-1#vertex:0');
      send('pointerdown', 10, 20); send('pointerup', 10, 20);
      expect(state().selection).toEqual(['solid-1#vertex:0']);
      const original = state().connectionSelection?.endpoints.get('solid-1#vertex:0');
      expect(original).toMatchObject({ kind: 'vertex', originalReference: { origin: vertexOrigin },
        matchedReference: { origin: vertexOrigin } });
      send('pointermove', 40, 50);
      expect(state().hoveredElementId).toBe('point-1');
      send('pointerdown', 40, 50, true); send('pointerup', 40, 50, true);
      expect(state().selection).toEqual(['solid-1#vertex:0', 'point-1']);
      expect(state().connectionSelection?.endpoints.get('solid-1#vertex:0')).toBe(original);
      expect(state().connectionSelection?.endpoints.get('point-1')).toMatchObject({ kind: 'point', sketchId: sketch.id });
      expect(state().document).toBe(document);
      const selection = state().selection, undo = state().undoStack;
      useAppStore.setState({ bodies: [{ ...body, vertices: [...body.vertices, { index: 1, position: [40, 50, 90] }] }] });
      send('pointermove', 40, 50); expect(state().hoveredElementId).toBeNull();
      send('pointerdown', 40, 50, true); send('pointerup', 40, 50, true);
      expect(state().selection).toBe(selection); expect(state().undoStack).toBe(undo);
      expect(state().editErrorKey).toBe('sketch.connect.ambiguous');
    } finally { interaction.detach(); controls.detach(); resetTestStore(); }
  });
});

describe('Shift/Ctrlで追加・解除する選択とドラッグの共通判定', () => {
  it.each([
    { shiftKey: false, ctrlKey: false, additive: false },
    { shiftKey: true, ctrlKey: false, additive: true },
    { shiftKey: false, ctrlKey: true, additive: true },
    { shiftKey: true, ctrlKey: true, additive: true },
  ])('$shiftKey/$ctrlKeyでは追加=$additive', event => {
    expect(addsToSketchSelection(event)).toBe(event.additive);
  });
});

describe('isSolidTool', () => {
  it('P2 の3道具(押し出し・回転・縫合)を拾う', () => {
    expect(isSolidTool('extrude')).toBe(true);
    expect(isSolidTool('revolve')).toBe(true);
    expect(isSolidTool('sew')).toBe(true);
  });

  it('P3 の加工6種とばねも拾う(以前は "extrude"|"revolve"|"sew" の3つしか見ておらず、これらの道具で pointerdown が座標入力へ誤って流れる不具合があった)', () => {
    expect(isSolidTool('hole')).toBe(true);
    expect(isSolidTool('threadHole')).toBe(true);
    expect(isSolidTool('fillet')).toBe(true);
    expect(isSolidTool('chamfer')).toBe(true);
    expect(isSolidTool('linearPattern')).toBe(true);
    expect(isSolidTool('circularPattern')).toBe(true);
    expect(isSolidTool('spring')).toBe(true);
  });

  it('スケッチの道具は拾わない', () => {
    expect(isSolidTool('select')).toBe(false);
    expect(isSolidTool('point')).toBe(false);
    expect(isSolidTool('line')).toBe(false);
    expect(isSolidTool('arc')).toBe(false);
    expect(isSolidTool('pointArray')).toBe(false);
    expect(isSolidTool('face')).toBe(false);
  });
});

describe('isDrawingTool', () => {
  it('位置を数値で決める4道具だけを拾う', () => {
    expect(isDrawingTool('point')).toBe(true);
    expect(isDrawingTool('line')).toBe(true);
    expect(isDrawingTool('arc')).toBe(true);
    expect(isDrawingTool('pointArray')).toBe(true);
  });

  it('選択・面・立体の道具・加工の道具は拾わない', () => {
    expect(isDrawingTool('select')).toBe(false);
    expect(isDrawingTool('face')).toBe(false);
    expect(isDrawingTool('extrude')).toBe(false);
    expect(isDrawingTool('hole')).toBe(false);
  });
});

describe('isLookTool', () => {
  it('外観と測るだけを拾う', () => {
    expect(isLookTool('appearance')).toBe(true);
    expect(isLookTool('measure')).toBe(true);
  });

  it('立体の道具・選択・かき込む道具は拾わない', () => {
    expect(isLookTool('select')).toBe(false);
    expect(isLookTool('extrude')).toBe(false);
    expect(isLookTool('point')).toBe(false);
  });
});

describe('picksBodies(P5 仕上げ (j): 外観・測るのあいだ立体を押しても選べなかった)', () => {
  it('選択・立体の道具・断面は今までどおり立体を拾う', () => {
    expect(picksBodies('select')).toBe(true);
    expect(picksBodies('extrude')).toBe(true);
    expect(picksBodies('linearPattern')).toBe(true);
    expect(picksBodies('planeSection')).toBe(true);
  });

  it('外観と測るも立体を拾う(外観は `4` キーで立体ごとに色を付ける道、測るは体積・質量特性・立体 2 つの隙間)', () => {
    expect(picksBodies('appearance')).toBe(true);
    expect(picksBodies('measure')).toBe(true);
  });

  it('かき込む道具と面の道具は拾わない(押した場所が座標そのもの / 面の境界の順が壊れる)', () => {
    expect(picksBodies('point')).toBe(false);
    expect(picksBodies('line')).toBe(false);
    expect(picksBodies('rectangle')).toBe(false);
    expect(picksBodies('face')).toBe(false);
  });
});

describe('picksSubShapes', () => {
  it('選択の種類が body なら道具に関わらず拾わない(立体の経路を使う)', () => {
    expect(picksSubShapes('body', 'hole')).toBe(false);
    expect(picksSubShapes('body', 'select')).toBe(false);
  });

  it('選択の種類が face / edge / vertex で、かき込む道具でなければ拾う', () => {
    expect(picksSubShapes('face', 'hole')).toBe(true);
    expect(picksSubShapes('edge', 'fillet')).toBe(true);
    expect(picksSubShapes('vertex', 'fillet')).toBe(true);
    // 選択・面の道具でも、選択の種類を手動で部分形状へ切り替えていれば拾う
    // (onPointerDown 側は select / face を選択の種類より先に判定するので、
    // クリックの振る舞いそのものは変わらない。ここは判定関数だけの検査)。
    expect(picksSubShapes('edge', 'select')).toBe(true);
  });

  it('かき込む道具(点・線・円弧・点列)は、選択の種類が部分形状でも拾わない', () => {
    expect(picksSubShapes('face', 'point')).toBe(false);
    expect(picksSubShapes('edge', 'line')).toBe(false);
    expect(picksSubShapes('vertex', 'arc')).toBe(false);
    expect(picksSubShapes('edge', 'pointArray')).toBe(false);
  });
});

describe('skipsSketchElements(タスク30 不具合(c): 押し出したもとのスケッチ面が立体の面より先に当たる)', () => {
  it('選択の種類が body のときはスケッチ要素の当たり判定を飛ばさない(従来どおり)', () => {
    expect(skipsSketchElements('body')).toBe(false);
  });

  it('選択の種類が face / edge / vertex のときはスケッチ要素の当たり判定を飛ばす', () => {
    expect(skipsSketchElements('face')).toBe(true);
    expect(skipsSketchElements('edge')).toBe(true);
    expect(skipsSketchElements('vertex')).toBe(true);
  });
});

describe('toSubShapeBodies', () => {
  const withSubShapes: SolidBodyWithSubShapes = {
    featureId: 'hole-1',
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      triangleCount: 0,
    },
    volume: 1,
    isValid: true,
    faces: [
      {
        index: 0,
        surfaceKind: 'plane',
        area: 10,
        centroid: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
        triangleOffset: 0,
        triangleCount: 2,
      },
    ],
    edges: [],
    vertices: [],
    threadMarks: [],
  };

  /** 面・辺の一覧が無い(押し出し等、部分形状が空の)ボディ。空の一覧として詰め替わる。 */
  const withoutSubShapes: SolidBodyWithSubShapes = {
    featureId: 'extrude-1',
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgePositions: new Float32Array([1, 1, 1, 2, 2, 2]),
      triangleCount: 0,
    },
    volume: 1,
    isValid: true,
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };

  it('faces / edges / vertices をそのまま持ち越す', () => {
    const [result] = toSubShapeBodies([withSubShapes]);
    expect(result.featureId).toBe('hole-1');
    expect(result.mesh.edgePositions).toBe(withSubShapes.mesh.edgePositions);
    expect(result.faces).toBe(withSubShapes.faces);
    expect(result.edges).toEqual([]);
    expect(result.vertices).toEqual([]);
  });

  it('currentの起点表と有効性を参照捕捉へ持ち越す', () => {
    const origin = { version: 1, shapeKind: 'face', identity: {
      kind: 'box-face', featureId: 'hole-1', role: 'top' } } as const;
    const body = { ...withSubShapes, origins: { version: 1, state: 'tracked', bindings: [
      { origin, state: 'unique', current: { kind: 'face', index: 0 } }] } as const };
    const [result] = toSubShapeBodies([body]);
    expect(result).toMatchObject({ isValid: true, origins: body.origins });
    expect(result.faces).toBe(body.faces);
  });

  it('部分形状の一覧が空のボディは空の一覧として詰め替える', () => {
    const [result] = toSubShapeBodies([withoutSubShapes]);
    expect(result.featureId).toBe('extrude-1');
    expect(result.faces).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.vertices).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 球面上の点の吸着の費用(FR-431、NFR-PF-1、P5 タスク21 手順6)
 * ------------------------------------------------------------------ */

/** 実測に使う球面の案内線(既定の 5°、半径 10 の球)。 */
const SPHERE_GRID_SPEC: SphereGridSpec = { center: [0, 0, 0], radius: 10, stepDegrees: 5 };

/** 5° の交点の数(緯線 35 × 経線 72 + 極 2、計画書 §2.8.3)。 */
const SPHERE_GRID_POINT_COUNT = 35 * 72 + 2;

/**
 * `pointermove` 1 回ぶんの予算(ミリ秒)。1 コマ 16ms(60fps、NFR-PF-1)のうち、
 * 吸着に使ってよいのはごく一部なので **1ms** を上限にする(P4b の向きの吸着と同じ考え方)。
 */
const POINTER_MOVE_BUDGET_MS = 1;

/** 実測の平均を取る回数。1 回だけだと計測の揺れがそのまま出る。 */
const SNAP_ROUNDS = 2000;

/**
 * ワールド → 画面のいちばん素朴な写し。**判定半径(12 画素)の中に必ず入る倍率**にして、
 * 吸い付いた側(いちばん重い経路)の所要を測る。実測で効くのは変換の回数だけで、
 * 倍率そのものは費用に関係しない。
 */
const projectForTest: ProjectToScreen = (point) => [point[0] * 0.1 + 400, point[1] * 0.1 + 300];

describe('球面の案内線の交点への吸着の費用(FR-431、NFR-PF-1、§1.5-13)', () => {
  it(`交点 ${String(SPHERE_GRID_POINT_COUNT)} 個でも pointermove 1 回が 1ms に収まる`, () => {
    // 球の中心へ向かう光線(必ず当たる = いちばん重い経路)を少しずつ振りながら測る。
    const started = performance.now();
    let hits = 0;
    for (let round = 0; round < SNAP_ROUNDS; round += 1) {
      const angle = (round / SNAP_ROUNDS) * Math.PI * 2;
      const origin: Vec3 = [Math.cos(angle) * 100, Math.sin(angle) * 100, 30];
      const direction: Vec3 = [-Math.cos(angle), -Math.sin(angle), -0.3];
      const point = snapToSphereGrid(SPHERE_GRID_SPEC, { origin, direction }, projectForTest, [
        400,
        300,
      ]);
      if (point !== null) {
        hits += 1;
      }
    }
    const elapsed = (performance.now() - started) / SNAP_ROUNDS;
    // どの回も交点に吸い付いている(いちばん重い経路を測っている)。
    expect(hits).toBe(SNAP_ROUNDS);
    console.log(
      `[実測] 球面の案内線の吸着(交点 ${String(SPHERE_GRID_POINT_COUNT)} 個): ${elapsed.toFixed(5)} ms / pointermove(吸い付いた回数 ${String(hits)})`,
    );
    expectWithinBudget(elapsed, POINTER_MOVE_BUDGET_MS, '球面の案内線の交点への吸着');
  });
});

describe('押し出しの仮の形を表示している間の押下(EX-14)', () => {
  /** 押し出しの道具・輪郭の選択・開いた入力欄。`withPreview` なら成功した仮の形も表示中にする。 */
  function extrusionInProgress(withPreview: boolean): StagedSolidState | null {
    resetPointDocument();
    const document = appendSolid(useAppStore.getState().document, extrudeFeature('first'));
    useAppStore.getState().applyDocument(document);
    useAppStore.setState({ bodies: [bodyFor('first')] });
    useAppStore.getState().setActiveTool('extrude');
    useAppStore.getState().setSelection(['first']);
    useAppStore.getState().openNumericInput(createNumericInput('extrude', 'extrudeDistance'), [10, 10]);
    if (!withPreview) return null;
    let owned: StagedSolidState | null = null;
    const stager: PartStager = { stage: () => null, confirm: () => 'refused', cancel: () => undefined,
      owns: (staged) => staged === owned };
    useAppStore.getState().setPartStager(stager);
    const state = useAppStore.getState();
    const ownership = captureStagedSolidOwnership(state, stager, 1);
    if (ownership === null) throw new Error('An open part input must own staged work');
    const displayed = appendSolid(state.document, extrudeFeature('extrude-new'));
    const result = { ...resultFor(displayed), generation: 9, bodies: [bodyFor('first'), bodyFor('extrude-new')],
      meshJsAccounting: { documentId: displayed.id, partId: 'part-fixture', generation: 9,
        reading: { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
          cacheProtectedBytes: 0, retainedReplyBytes: 0, requestPeakReservedBytes: 0 },
        final: { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 0, cacheRetiredBytes: 0,
          cacheProtectedBytes: 0, displayBackingBytes: 0, replyBackingBytes: 0, retainedBackingBytes: 0,
          replyCloneReservedBytes: 0 } } };
    const staged: StagedSolidState = Object.freeze({ ownership, fingerprint: 'k', finalFeatureId: 'extrude-new',
      placement: { document: displayed, timelineIndex: null, inserted: false }, displayed, status: 'ready',
      result, accounting: accountingSnapshot(displayed, null, state.activeDocumentId, result, result.meshJsAccounting),
      wholeGeneration: null, errors: [], errorMessage: null, failure: null, confirmRequested: false });
    owned = staged;
    useAppStore.getState().publishStagedSolid(staged);
    return staged;
  }

  function attachWithEmptyScene(canvas: HTMLCanvasElement): ReturnType<typeof attachSketchInteraction> {
    // The real scene returns no body/face while a preview is displayed; here nothing is hit at all.
    const scene: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay' | 'pickBody' | 'pickFaceAt'> = {
      worldToScreen: point => [point[0], point[1]], screenToPlanePoint: (x, y) => [x, y, 0],
      pointerRay: () => null, pickBody: () => null, pickFaceAt: () => null,
    };
    return attachSketchInteraction(canvas, scene as ViewportScene, () => orbitFrom(0, 0), () => false);
  }

  it('a click on the preview or empty space keeps the selection the extrusion needs and the preview', () => {
    const staged = extrusionInProgress(true);
    const { canvas, send } = interactionCanvas();
    const attached = attachWithEmptyScene(canvas);
    try {
      const before = useAppStore.getState();
      expect(currentStagedSolid(before)).toBe(staged);
      send('pointerdown', 700, 500); send('pointerup', 700, 500);
      const after = useAppStore.getState();
      expect(after.selection).toBe(before.selection);
      expect(after.selection).toEqual(['first']);
      expect(after.numericInput).toBe(before.numericInput);
      expect(currentStagedSolid(after)).toBe(staged);
      expect(after.document).toBe(before.document);
      expect(after.undoStack).toBe(before.undoStack);
    } finally { attached.detach(); resetTestStore(); }
  });

  it('without a preview the same empty click still clears the selection (unchanged behaviour)', () => {
    extrusionInProgress(false);
    const { canvas, send } = interactionCanvas();
    const attached = attachWithEmptyScene(canvas);
    try {
      send('pointerdown', 700, 500); send('pointerup', 700, 500);
      expect(useAppStore.getState().selection).toEqual([]);
    } finally { attached.detach(); resetTestStore(); }
  });
});


describe('drag release uses the actual canvas pointerup coordinates', () => {
  it.each(['pending', 'completed'] as const)('%s move A followed by release B commits B exactly once', phase => {
    resetPointDocument();
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1; frames.set(frameId, callback); return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const drain = (): void => {
      for (let count = 0; frames.size > 0; count += 1) {
        if (count >= 100) throw new Error('point drag frames did not settle');
        const entry = frames.entries().next();
        if (entry.done === true) break;
        frames.delete(entry.value[0]); entry.value[1](0);
      }
    };
    const { canvas, captured, send } = interactionCanvas();
    const attached = attachPointInteraction(canvas);
    try {
      const before = useAppStore.getState();
      send('pointerdown', 40, 50);
      send('pointermove', 55, 60);
      if (phase === 'completed') drain();
      send('pointerup', 80, 95);
      expect(captured.size).toBe(0);
      expect(useAppStore.getState().document).toBe(before.document);
      drain();
      const after = useAppStore.getState();
      expect(after.sketch.features[0]).toEqual({ ...before.sketch.features[0], at: absoluteCoordinate(80, 95, 0) });
      expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      expect(after.sketchDrag).toBeNull();
      send('pointerup', 100, 110);
      drain();
      expect(useAppStore.getState().document).toBe(after.document);
      expect(useAppStore.getState().undoStack).toBe(after.undoStack);
    } finally { attached.detach(); resetTestStore(); }
  });

  it('pointerdown and pointerup at the same position remain a click without solving or Undo', () => {
    resetPointDocument();
    const requestFrame = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { canvas, captured, send } = interactionCanvas();
    const attached = attachPointInteraction(canvas);
    try {
      const before = useAppStore.getState();
      send('pointerdown', 40, 50);
      send('pointerup', 40, 50);
      expect(requestFrame).not.toHaveBeenCalled();
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      expect(useAppStore.getState().sketchDrag).toBeNull();
      expect(captured.size).toBe(0);
    } finally { attached.detach(); resetTestStore(); }
  });
});
