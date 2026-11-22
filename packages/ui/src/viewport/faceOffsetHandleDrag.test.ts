/**
 * 面の移動の矢印のつまみを引く(M-05 4-2a、`faceOffsetHandleDrag.ts`)と、ビューポートの入力への結び
 * (`sketchInteractionResources.ts`。押下の順・捕捉・離す・掴んでいる間の Esc・OS の取消・打ち直し)。
 *
 * 写し方は検査用の平行投影: 画面 x = 世界 x × 10、画面 y = 世界 z × 10、光線は +Y の向き。右の端面
 * (重心 (40, 15, 5)、外向きの法線 +X)の上で、画面の x の 10 画素が距離 1 mm になる。
 */
import {
  absoluteCoordinate, appendFeature, replaceSketch, resolveSketch, type SolidBody, type SolidFaceEntry, type Vec3,
} from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { bodyFor, orbitFrom, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import type { ViewportScene } from './createViewportScene.js';
import { createFaceOffsetHandleDrag } from './faceOffsetHandleDrag.js';

afterEach(() => { vi.unstubAllGlobals(); resetTestStore(); });

const END_FACE = subShapeElementId('extrude-1', 'face', 0);

const scene: Pick<ViewportScene, 'pointerRay'> = {
  pointerRay: (x, y) => ({ origin: [x / 10, -1000, y / 10], direction: [0, 1, 0] }),
};
function project(point: Vec3): readonly [number, number] { return [point[0] * 10, point[2] * 10]; }

function endFace(): SolidFaceEntry {
  return { index: 0, surfaceKind: 'plane', area: 300, centroid: [40, 15, 5], axis: [1, 0, 0], radius: null,
    triangleOffset: 0, triangleCount: 1 };
}

/** 板の右の端面を選び、面の移動の入力欄を距離 `source` で開く。 */
function openFaceOffset(source: string): void {
  resetTestStore();
  const body: SolidBody = { ...bodyFor('extrude-1'), faces: [endFace()] };
  useAppStore.setState({ bodies: [body], selection: [END_FACE], selectionKind: 'face' });
  const input = reduceNumericInput(createNumericInput('faceOffset', 'faceOffsetDistance'), { type: 'edit', index: 0, source });
  useAppStore.getState().openNumericInput(input, [0, 0]);
}

function distanceSource(): string | undefined {
  return useAppStore.getState().numericInput?.fields[0]?.source;
}

describe('つまみを引くと、入力欄の距離だけが動く(M-05 4-2a)', () => {
  it('根もと(距離 5 → 画面 (450, 50))の 18px の内だけ掴め、引いた所の距離を表示の文字で欄へ入れる。文書は変えない', () => {
    openFaceOffset('5');
    const before = useAppStore.getState();
    const drag = createFaceOffsetHandleDrag(scene, project);
    expect(drag.begin([480, 50])).toBe(false);
    expect(drag.active()).toBe(false);
    expect(drag.begin([450, 50])).toBe(true);
    drag.move([500, 50]);
    expect(distanceSource()).toBe('10');
    drag.move([377.77, 50]);
    expect(distanceSource()).toBe('-2.223');
    drag.end();
    expect(drag.active()).toBe(false);
    const after = useAppStore.getState();
    expect(after.numericInput?.step).toBe('faceOffsetDistance');
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.numericInput?.fields[0]?.typed).toBe(true);
  });

  it('掴んだ所と根もとの差を保つので、押した所でつまみが跳ねない', () => {
    openFaceOffset('5');
    const drag = createFaceOffsetHandleDrag(scene, project);
    expect(drag.begin([455, 50])).toBe(true);
    drag.move([455, 50]);
    expect(distanceSource()).toBe('5');
    drag.move([505, 50]);
    expect(distanceSource()).toBe('10');
  });

  it('同じ文字になる動きではストアを動かさない', () => {
    openFaceOffset('5');
    const drag = createFaceOffsetHandleDrag(scene, project);
    drag.begin([450, 50]);
    const revision = useAppStore.getState().numericInputRevision;
    drag.move([450.0001, 50]);
    expect(useAppStore.getState().numericInputRevision).toBe(revision);
  });

  it('表示が inch の時は inch の数を入れる(確定と同じく打った数として読まれる)', () => {
    openFaceOffset('5');
    useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, lengthUnit: 'inch' } });
    const drag = createFaceOffsetHandleDrag(scene, project);
    // inch の 5 は 127mm なので、根もとは x = 167(画面 1670)。
    expect(drag.begin([1670, 50])).toBe(true);
    drag.move([1670 + 254, 50]);
    expect(distanceSource()).toBe('6');
  });

  it('視線が法線と平行な時は動かさない', () => {
    openFaceOffset('5');
    const parallel: Pick<ViewportScene, 'pointerRay'> = { pointerRay: (x, y) => ({ origin: [0, x, y], direction: [1, 0, 0] }) };
    const drag = createFaceOffsetHandleDrag(parallel, project);
    expect(drag.begin([450, 50])).toBe(true);
    drag.move([600, 50]);
    expect(distanceSource()).toBe('5');
  });

  it('Esc(cancel)は掴む前の入力欄を丸ごと戻す。窓は閉じない', () => {
    openFaceOffset('5');
    const opened = useAppStore.getState().numericInput;
    const drag = createFaceOffsetHandleDrag(scene, project);
    drag.begin([450, 50]);
    drag.move([520, 50]);
    expect(distanceSource()).toBe('12');
    drag.cancel();
    expect(drag.active()).toBe(false);
    expect(useAppStore.getState().numericInput).toBe(opened);
  });

  it('打ち直された欄にはもう書かない(打った数が優先)。その後の Esc も打った数を残す', () => {
    openFaceOffset('5');
    const drag = createFaceOffsetHandleDrag(scene, project);
    drag.begin([450, 50]);
    drag.move([520, 50]);
    const typed = reduceNumericInput(useAppStore.getState().numericInput ?? createNumericInput('faceOffset', 'faceOffsetDistance'),
      { type: 'edit', index: 0, source: '7' });
    useAppStore.getState().updateNumericInput(typed);
    expect(drag.ownsInput(useAppStore.getState())).toBe(false);
    drag.move([600, 50]);
    expect(distanceSource()).toBe('7');
    drag.cancel();
    expect(distanceSource()).toBe('7');
  });

  it('入力欄が無い・面の移動でない段の時は掴まない', () => {
    openFaceOffset('5');
    useAppStore.getState().closeNumericInput();
    expect(createFaceOffsetHandleDrag(scene, project).begin([450, 50])).toBe(false);
    useAppStore.getState().openNumericInput(createNumericInput('faceRotate', 'faceRotateAngle'), [0, 0]);
    expect(createFaceOffsetHandleDrag(scene, project).begin([400, 50])).toBe(false);
  });
});

/** attachSketchInteraction に同じ写し方の場面を渡し、canvas と window へ出来事を送る(`attachSketchInteraction.boundary.test.ts` と同じ作り)。 */
function harness() {
  const windowTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  const captured = new Set<number>();
  const target = new EventTarget();
  const canvas = Object.assign(target, {
    clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
    setPointerCapture: (id: number): void => { captured.add(id); },
    hasPointerCapture: (id: number): boolean => captured.has(id),
    releasePointerCapture: (id: number): void => { captured.delete(id); },
    focus: (): void => {},
  }) as HTMLCanvasElement;
  // 面を選ぶ種類のホバー(離した後の動き)は面の当たり(pickFaceAt)を引く。この検査では何にも当たらない。
  const projection: Pick<ViewportScene, 'worldToScreen' | 'screenToPlanePoint' | 'pointerRay' | 'pickBody' | 'pickFaceAt'> = {
    worldToScreen: project, screenToPlanePoint: (x, y) => [x, y, 0], pointerRay: (x, y) => scene.pointerRay(x, y),
    pickBody: () => null, pickFaceAt: () => null,
  };
  const attached = attachSketchInteraction(canvas, projection as ViewportScene, () => orbitFrom(0, 0), () => false);
  const pointer = (type: string, x: number, y: number): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerdown' ? 1 : 0,
      clientX: x, clientY: y, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    });
    canvas.dispatchEvent(event);
    return event;
  };
  const escape = (): Event => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    windowTarget.dispatchEvent(event);
    return event;
  };
  return { captured, pointer, escape, detach: () => { attached.detach(); } };
}

describe('ビューポートの入力への結び(M-05 4-2a)', () => {
  it('根もとの押下は既定の動作を止めて(入力欄の焦点を残して)捕まえ、動かすと欄が動き、離すと捕捉を返して数を残す', () => {
    openFaceOffset('5');
    const before = useAppStore.getState();
    const h = harness();
    try {
      expect(h.pointer('pointerdown', 450, 50).defaultPrevented).toBe(true);
      expect(h.captured.has(1)).toBe(true);
      h.pointer('pointermove', 480, 50);
      expect(distanceSource()).toBe('8');
      h.pointer('pointerup', 480, 50);
      expect(h.captured.size).toBe(0);
      expect(distanceSource()).toBe('8');
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().selection).toEqual([END_FACE]);
      // 離した後の動きは引かない(ホバーになる)。
      h.pointer('pointermove', 600, 50);
      expect(distanceSource()).toBe('8');
    } finally { h.detach(); }
  });

  it('掴んでいる間の Esc は、掴む前の数へ戻して捕捉を返し、入力欄は閉じない。掴んでいない時の Esc には手を出さない', () => {
    openFaceOffset('5');
    const opened = useAppStore.getState().numericInput;
    const h = harness();
    try {
      h.pointer('pointerdown', 450, 50);
      h.pointer('pointermove', 520, 50);
      expect(distanceSource()).toBe('12');
      expect(h.escape().defaultPrevented).toBe(true);
      expect(useAppStore.getState().numericInput).toBe(opened);
      expect(h.captured.size).toBe(0);
      // 遅れて届いた pointerup は何もしない。
      h.pointer('pointerup', 520, 50);
      expect(useAppStore.getState().numericInput).toBe(opened);
      expect(h.escape().defaultPrevented).toBe(false);
      expect(useAppStore.getState().numericInput).toBe(opened);
    } finally { h.detach(); }
  });

  it('OS の取消(pointercancel)も掴む前の数へ戻す', () => {
    openFaceOffset('5');
    const opened = useAppStore.getState().numericInput;
    const h = harness();
    try {
      h.pointer('pointerdown', 450, 50);
      h.pointer('pointermove', 520, 50);
      h.pointer('pointercancel', 520, 50);
      expect(useAppStore.getState().numericInput).toBe(opened);
      expect(h.captured.size).toBe(0);
    } finally { h.detach(); }
  });

  it('掴んでいる間に欄が打ち直されたら、捕捉を返して離し、もう書かない', () => {
    openFaceOffset('5');
    const h = harness();
    try {
      h.pointer('pointerdown', 450, 50);
      h.pointer('pointermove', 520, 50);
      const typed = reduceNumericInput(useAppStore.getState().numericInput ?? createNumericInput('faceOffset', 'faceOffsetDistance'),
        { type: 'edit', index: 0, source: '7' });
      useAppStore.getState().updateNumericInput(typed);
      expect(h.captured.size).toBe(0);
      h.pointer('pointermove', 600, 50);
      expect(distanceSource()).toBe('7');
    } finally { h.detach(); }
  });

  it('破棄すると掴みも Esc の受け手も外れる', () => {
    openFaceOffset('5');
    const h = harness();
    h.pointer('pointerdown', 450, 50);
    h.detach();
    expect(h.captured.size).toBe(0);
    const opened = useAppStore.getState().numericInput;
    expect(h.escape().defaultPrevented).toBe(false);
    expect(useAppStore.getState().numericInput).toBe(opened);
  });
});

describe('押し出しのつまみを引く(M-05 4-2b)', () => {
  it('距離の鍵を持つ欄に両側の全長を書き、0 以下の動きでは欄を書き換えない', () => {
    resetTestStore();
    const state = useAppStore.getState();
    const corners: readonly Vec3[] = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]];
    const boundary = corners.map((_, index) => ({ featureId: `point-${String(index + 1)}` }));
    const withPoints = corners.reduce((current, point, index) => appendFeature(current, {
      id: boundary[index].featureId, name: boundary[index].featureId, planeId: 'xy', kind: 'point',
      at: absoluteCoordinate(...point),
    }), state.sketch);
    const sketch = appendFeature(withPoints, { id: 'face-1', name: '面1', planeId: 'xy', kind: 'face', boundary, color: '#808080' });
    useAppStore.setState({ document: replaceSketch(state.document, sketch), sketch, resolvedSketch: resolveSketch(sketch), selection: ['face-1'] });

    const symmetric = reduceNumericInput(createNumericInput('extrude', 'extrudeDistance'), { type: 'toggle', key: 'symmetric' });
    const tapered = reduceNumericInput(symmetric, { type: 'toggle', key: 'tapered' });
    // 距離が先頭に固定されていても検査が通ってしまわないよう、傾きの欄を先にする。
    state.openNumericInput({ ...tapered, fields: [...tapered.fields].reverse() }, [0, 0]);
    const drag = createFaceOffsetHandleDrag(scene, project);

    // 両側へ 10 の根もと (20, 15, 5) を掴み、z = 8 の所まで引くと欄は 16。
    expect(drag.begin([200, 50])).toBe(true);
    drag.move([200, 80]);
    const edited = useAppStore.getState().numericInput;
    expect(edited?.fields[0]).toBe(tapered.fields[1]);
    expect(edited?.fields[1]).toMatchObject({ key: 'distance', source: '16', typed: true });
    drag.move([200, 0.001]);
    drag.move([200, 0]);
    drag.move([200, -20]);
    expect(useAppStore.getState().numericInput).toBe(edited);
    drag.end();
  });
});
