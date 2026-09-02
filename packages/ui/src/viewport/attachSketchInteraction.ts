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

import {
  curveEnd,
  curveStart,
  dotVec3,
  lengthVec3,
  radiansToDegrees,
  resolveCoordinate,
  resolvePointReference,
  subVec3,
  vertexKey,
  WORK_PLANES,
  type ResolveContext,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';

import {
  createNumericInput,
  DEFAULT_COORDINATE_BASE,
  isCoordinateStep,
  reduceNumericInput,
  type NumericInputState,
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

/** 基準点を引くだけの問い合わせに使う名前。失敗の理由は捨てるので画面には出ない。 */
const BASE_PROBE_ID = 'numericInput';

export interface SketchInteraction {
  detach(): void;
}

/**
 * 解決済みの形から端点・中心の一覧を作る。次に作る要素の基準点を引くのに使う。
 * 点列は同じ featureId の先頭が start、末尾が end(resolveSketch と同じ約束)。
 */
function collectVertices(resolved: ResolvedSketch): Map<string, Vec3> {
  const vertices = new Map<string, Vec3>();
  for (const point of resolved.points) {
    const start = vertexKey(point.featureId, 'start');
    if (!vertices.has(start)) {
      vertices.set(start, point.position);
    }
    vertices.set(vertexKey(point.featureId, 'end'), point.position);
  }
  for (const segment of resolved.segments) {
    vertices.set(vertexKey(segment.featureId, 'start'), segment.from);
    vertices.set(vertexKey(segment.featureId, 'end'), segment.to);
  }
  for (const arc of resolved.arcs) {
    vertices.set(vertexKey(arc.featureId, 'center'), arc.center);
    vertices.set(vertexKey(arc.featureId, 'start'), curveStart(arc));
    vertices.set(vertexKey(arc.featureId, 'end'), curveEnd(arc));
  }
  return vertices;
}

/**
 * 「直前の点」(FR-302)。履歴の末尾へ次の要素を足すときの基準になる。
 * 履歴を後ろからたどり、点を作った要素・線分・円弧のうち解決できている最初のものの
 * 終わりを採る。面は点を作らないので飛ばす(resolveSketch の previous と同じ決め方)。
 */
function lastCreatedPoint(document: SketchDocument, resolved: ResolvedSketch): Vec3 | null {
  for (let index = document.features.length - 1; index >= 0; index -= 1) {
    const feature = document.features[index];
    if (feature.kind === 'face') {
      continue;
    }
    if (feature.kind === 'line') {
      const segment = resolved.segments.find((candidate) => candidate.featureId === feature.id);
      if (segment !== undefined) {
        return segment.to;
      }
      continue;
    }
    if (feature.kind === 'arc') {
      const arc = resolved.arcs.find((candidate) => candidate.featureId === feature.id);
      if (arc !== undefined) {
        return curveEnd(arc);
      }
      continue;
    }
    const group = resolved.points.filter((candidate) => candidate.featureId === feature.id);
    const last = group[group.length - 1];
    if (last !== undefined) {
      return last.position;
    }
  }
  return null;
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

  /**
   * 押した場所の基準になる点(FR-302、FR-303)。
   *
   * 線分の終点だけは自分の始点が基準で、それ以外は「直前の点」。
   * 決められなければ null を返し、呼び出し側が絶対座標へ切り替える。
   */
  function baseWorldPoint(step: NumericInputStep): Vec3 | null {
    const state = useAppStore.getState();
    const context: ResolveContext = {
      plane: WORK_PLANES[state.workPlaneId],
      points: state.resolvedSketch.points,
      previous: lastCreatedPoint(state.sketch, state.resolvedSketch),
      vertices: collectVertices(state.resolvedSketch),
    };
    if (step === 'lineEnd') {
      if (state.pendingStart === null) {
        return null;
      }
      const start = resolveCoordinate(state.pendingStart, context, BASE_PROBE_ID);
      return start.ok ? start.value : null;
    }
    const base = resolvePointReference(DEFAULT_COORDINATE_BASE, context, BASE_PROBE_ID);
    return base.ok ? base.value : null;
  }

  /**
   * 押した場所を、いま選ばれている指定方法の欄へ入れる(FR-107、NFR-UX-1)。
   *
   * 絶対ならその座標、相対なら基準からのずれ、極なら距離と作図面内の角度・仰角に直す。
   * 基準の点が決まらないときは絶対へ切り替えてから入れる。押した場所が欄に入らないまま
   * ポップアップが開くと、何を押したのか分からなくなるため。
   */
  function fillClickedPoint(input: NumericInputState, world: Vec3): NumericInputState {
    if (input.mode === 'absolute') {
      return reduceNumericInput(input, { type: 'setValues', values: world });
    }
    const base = baseWorldPoint(input.step);
    if (base === null) {
      const absolute = reduceNumericInput(input, { type: 'setMode', mode: 'absolute' });
      return reduceNumericInput(absolute, { type: 'setValues', values: world });
    }
    const offset = subVec3(world, base);
    if (input.mode === 'relative') {
      return reduceNumericInput(input, { type: 'setValues', values: offset });
    }
    // 極座標は polarOffset(planeMath.ts)の逆算。角度は第1軸から第2軸へ向かう向きが正。
    const plane = WORK_PLANES[useAppStore.getState().workPlaneId];
    const alongU = dotVec3(offset, plane.axisU);
    const alongV = dotVec3(offset, plane.axisV);
    const alongNormal = dotVec3(offset, plane.normal);
    return reduceNumericInput(input, {
      type: 'setValues',
      values: [
        lengthVec3(offset),
        radiansToDegrees(Math.atan2(alongV, alongU)),
        radiansToDegrees(Math.atan2(alongNormal, Math.hypot(alongU, alongV))),
      ],
    });
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

    // 円弧の半径や点列の個数は座標ではないので、位置だけを動かす。
    const world = isCoordinateStep(current.step) ? pointAt(pointer, findSnap(pointer)) : null;
    const filled = world === null ? current : fillClickedPoint(current, world);
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
      // 計算そのものの失敗とは分けて持つ。帯は「面を作れませんでした:」で出す(FR-504)。
      state.setFaceError(outcome.reasonKey);
      return;
    }
    state.setFaceError(null);
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

  /*
   * ビューポートへ焦点を戻す要求(ツールバーで面や選択を選んだ直後)。canvas を持っているのは
   * ここだけなので、要求の数が増えたら焦点を移す。これで Enter がそのまま効く(NFR-UX-4)。
   */
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.focusViewportRequestCount !== previous.focusViewportRequestCount) {
      canvas.focus();
    }
  });

  return {
    detach(): void {
      unsubscribe();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
