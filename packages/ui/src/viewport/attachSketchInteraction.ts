/**
 * ビューポートの上でのホバー・選択・吸着・形の作り始めを結ぶ
 * (計画書 docs/plans/P1-式とスケッチ.md タスク21 手順4)。
 *
 * 対応要件: FR-106(ホバーとクリック選択)、FR-107(吸着)、FR-307(続けてかく)、FR-309(面)。
 *
 * 判定の中身(当たり判定・吸着候補・履歴の作り方)はすべて純関数に置いてあり、
 * ここは「DOM の出来事をストアの操作へ詰め替える」だけにする。視点操作
 * (attachCameraControls)とぶつからないよう、左ボタン以外と Alt 併用は何もしない。
 */

import { WORK_PLANES, type Vec3 } from '@pointercad/model';

import { t } from '../i18n/t.js';
import {
  createNumericInput,
  isCoordinateStep,
  reduceNumericInput,
  type NumericInputStep,
  type SketchToolId,
} from '../sketch/numericInput.js';
import { pickSketchElement } from '../sketch/pickMath.js';
import { commitFace } from '../sketch/sketchCommands.js';
import {
  chooseSnap,
  collectSnapCandidates,
  SNAP_RADIUS_PIXELS,
  type ProjectToScreen,
  type SnapCandidate,
} from '../sketch/snapMath.js';
import { useAppStore, type SnapIndicator } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';

const LEFT_BUTTON = 0;

/** 数値入力で位置を決める道具。選択と面はクリックだけで進む。 */
type DrawingToolId = Exclude<SketchToolId, 'select' | 'face'>;

/** 道具ごとの、最初に開く段階。 */
const FIRST_STEP: Readonly<Record<DrawingToolId, NumericInputStep>> = {
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
};

export interface SketchInteraction {
  detach(): void;
}

/** 印を出し直す必要があるかどうか。同じ場所なら書き換えず、無駄な再描画を起こさない。 */
function sameIndicator(a: SnapIndicator | null, b: SnapIndicator | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.kind === b.kind &&
    a.elementId === b.elementId &&
    a.screen[0] === b.screen[0] &&
    a.screen[1] === b.screen[1]
  );
}

export function attachSketchInteraction(
  canvas: HTMLCanvasElement,
  scene: ViewportScene,
  getCameraDistance: () => number,
): SketchInteraction {
  // メソッドをそのまま値として渡さない(@typescript-eslint/unbound-method)。
  const project: ProjectToScreen = (point) => scene.worldToScreen(point);

  function pointerPosition(event: PointerEvent): readonly [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  /** いま吸い付いている候補。吸着が切なら null(FR-107)。 */
  function findSnap(pointer: readonly [number, number]): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled) {
      return null;
    }
    const plane = WORK_PLANES[state.workPlaneId];
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    const candidates = collectSnapCandidates(
      state.resolvedSketch,
      plane,
      gridSpacing(getCameraDistance()),
      onPlane,
    );
    return chooseSnap(candidates, project, pointer, SNAP_RADIUS_PIXELS, new Set(state.snapKinds));
  }

  /** 押した先のワールド座標。吸い付いていればその点、無ければ作図面の上の点。 */
  function pointAt(pointer: readonly [number, number], snap: SnapCandidate | null): Vec3 | null {
    if (snap !== null) {
      return snap.position;
    }
    const plane = WORK_PLANES[useAppStore.getState().workPlaneId];
    return scene.screenToPlanePoint(pointer[0], pointer[1], plane);
  }

  function onPointerMove(event: PointerEvent): void {
    const state = useAppStore.getState();
    const pointer = pointerPosition(event);
    const snap = findSnap(pointer);

    // 当たり判定(6 画素)から外れていても、吸着(12 画素)が拾った要素は強調して
    // 「どこへ吸い付くのか」を見せる(FR-106、FR-107)。
    const picked = pickSketchElement(state.resolvedSketch, project, pointer);
    const nextHovered = picked !== null ? picked.elementId : (snap?.elementId ?? null);
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }

    const nextIndicator: SnapIndicator | null =
      snap === null
        ? null
        : {
            // 画面の外へ出るほど傾いた面でも印を見失わないよう、写せなければ指の位置に置く。
            screen: project(snap.position) ?? pointer,
            kind: snap.kind,
            elementId: snap.elementId,
          };
    if (!sameIndicator(state.snapIndicator, nextIndicator)) {
      state.setSnapIndicator(nextIndicator);
    }
  }

  function onPointerLeave(): void {
    const state = useAppStore.getState();
    if (state.hoveredElementId !== null) {
      state.setHovered(null);
    }
    if (state.snapIndicator !== null) {
      state.setSnapIndicator(null);
    }
  }

  /** 選択の道具と面の道具。押した順が面の境界の順になる(FR-106、FR-309)。 */
  function pickInto(pointer: readonly [number, number], accumulate: boolean): void {
    const state = useAppStore.getState();
    const picked = pickSketchElement(state.resolvedSketch, project, pointer);
    if (picked === null) {
      if (!accumulate) {
        state.setSelection([]);
      }
      return;
    }
    if (accumulate) {
      state.toggleSelection(picked.elementId);
    } else {
      state.setSelection([picked.elementId]);
    }
  }

  /** 位置を数値で決める道具。押した場所を欄の既定値にして入力を開く(NFR-UX-1)。 */
  function openInputAt(tool: DrawingToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    // 開いていないときは、前の取りかけ(Esc で捨てた始点など)を持ち越さず最初から始める。
    if (opened === null || opened.toolId !== tool) {
      if (state.pendingStart !== null) {
        state.setPendingStart(null);
      }
    }
    const current =
      opened !== null && opened.toolId === tool ? opened : createNumericInput(tool, FIRST_STEP[tool]);

    // 押した場所から決められるのは絶対座標の欄だけ。相対・極は基準からの量、
    // 円弧の半径や点列の個数は座標ではないので、位置だけを動かす。
    const world = isCoordinateStep(current.step) && current.mode === 'absolute'
      ? pointAt(pointer, findSnap(pointer))
      : null;
    const filled =
      world === null ? current : reduceNumericInput(current, { type: 'setValues', values: world });
    state.openNumericInput(filled, pointer);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== LEFT_BUTTON || event.altKey) {
      return;
    }
    const state = useAppStore.getState();
    const pointer = pointerPosition(event);

    if (state.activeTool === 'select' || state.activeTool === 'face') {
      // 面の道具では 1 つずつ足していく。選択の道具は Shift を押したときだけ足す。
      pickInto(pointer, state.activeTool === 'face' || event.shiftKey);
      return;
    }

    // 既定の動作(canvas へ焦点を移す)を止めて、開いている欄から焦点を奪わない。
    // 押した場所の座標が欄へ入った直後に、そのまま Enter で決められるようにする(NFR-UX-2)。
    event.preventDefault();
    openInputAt(state.activeTool, pointer);
  }

  /** 面を張る(FR-309)。断られたら理由を帯に出し、履歴は変えない(FR-504、NFR-UX-5)。 */
  function commitSelectedFace(): void {
    const state = useAppStore.getState();
    const outcome = commitFace(
      state.sketch,
      state.resolvedSketch,
      state.workPlaneId,
      state.selection,
    );
    if (!outcome.ok) {
      state.setError(t(outcome.reasonKey));
      return;
    }
    // setError は計算中の印も下ろすので、履歴を差し替える前に消しておく。
    state.setError(null);
    state.setSketch(outcome.document);
    state.setSelection([]);
  }

  /**
   * canvas に焦点があるときだけ来る(ViewportCanvas の tabIndex={0})。
   * ポップアップの欄に焦点があるときは来ないので、そちらの Enter / Esc とぶつからない
   * (docs/報告記録.md 2026-09-02 15:42 の「Home キーは canvas に焦点があるときだけ」と同じ考え)。
   */
  function onKeyDown(event: KeyboardEvent): void {
    const state = useAppStore.getState();
    if (event.key === 'Escape') {
      event.preventDefault();
      state.setSelection([]);
      state.setPendingStart(null);
      state.closeNumericInput();
      return;
    }
    if (event.key === 'Enter' && state.activeTool === 'face') {
      event.preventDefault();
      commitSelectedFace();
    }
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('keydown', onKeyDown);

  return {
    detach(): void {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
