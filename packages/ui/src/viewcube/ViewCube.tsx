import { useEffect, useRef } from 'react';

import { t } from '../i18n/t.js';
import { orbit, type OrbitState } from '../viewport/cameraMath.js';
import { createViewCubeScene } from './createViewCubeScene.js';
import {
  interpolateOrbit,
  orbitStateForRegion,
  VIEW_TRANSITION_DURATION_MS,
  type ViewCubeRegion,
} from './viewCubeMath.js';

/** 表示の一辺(画素)。実寸は appShell.css の .pcad-viewcube が決め、読み取って合わせる。 */
const CUBE_SIZE_PIXELS = 120;

/** これ以上動いたらクリックではなくドラッグとみなす(画素)。 */
const DRAG_THRESHOLD_PIXELS = 4;

const PRIMARY_BUTTON = 0;

/** クリックで始まった視点の移り変わり。 */
interface ViewTransition {
  readonly from: OrbitState;
  readonly to: OrbitState;
  readonly startedAt: number;
}

/** 2 つの領域が同じ向きを指しているか。どちらも null なら同じとみなす。 */
function isSameRegion(a: ViewCubeRegion | null, b: ViewCubeRegion | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export interface ViewCubeProps {
  /** 現在の視点を返す。 */
  readonly getOrbit: () => OrbitState;
  /** 視点を変える。 */
  readonly setOrbit: (next: OrbitState) => void;
  /** ビューポートが描き直したときに知らせてもらう。戻り値を呼ぶと購読をやめる。 */
  readonly subscribeDraw: (listener: () => void) => () => void;
}

/**
 * ビューポート右上のビューキューブ(FR-103)。
 *
 * 視点の正本は attachCameraControls が持つ 1 箇所だけにする。ビューキューブは自分で視点を
 * 持たず、getOrbit / setOrbit で借りる。状態を 2 箇所に持つと必ず食い違うため。
 *
 * 描画も常時のループを持たず、本体ビューポートが描いた通知(subscribeDraw)に相乗りして
 * 同じ描画機会に 1 回だけ描く。自前でこまを進めるのはクリックの遷移中だけで、遷移が終われば
 * 予約を止める。待機中に requestAnimationFrame が回り続けないようにするため(NFR-PF-1)。
 */
export function ViewCube({ getOrbit, setOrbit, subscribeDraw }: ViewCubeProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const scene = createViewCubeScene(canvas, CUBE_SIZE_PIXELS);

    let frameId = 0;
    let transition: ViewTransition | null = null;
    let highlighted: ViewCubeRegion | null = null;
    let dragging = false;
    let movedDistance = 0;
    let lastX = 0;
    let lastY = 0;

    /** いまの視点とホバー状態で 1 回だけ描く。 */
    const drawOnce = (): void => {
      scene.render(getOrbit(), highlighted);
    };

    /** 遷移の 1 こまを進める。遷移が終わったら次のこまを予約せず、ループを止める。 */
    const stepTransition = (): void => {
      frameId = 0;
      if (transition === null) {
        return;
      }
      const elapsed = globalThis.performance.now() - transition.startedAt;
      const progress = elapsed / VIEW_TRANSITION_DURATION_MS;
      const stepped = interpolateOrbit(transition.from, transition.to, progress);
      // 遷移の途中で拡大縮小や平行移動をされても打ち消さないよう、向きだけを差し替える。
      const current = getOrbit();
      // setOrbit はビューポートの描画を予約し、その通知で drawOnce が走る。
      setOrbit({ ...current, azimuth: stepped.azimuth, elevation: stepped.elevation });
      if (progress >= 1) {
        transition = null;
        return;
      }
      frameId = globalThis.requestAnimationFrame(stepTransition);
    };

    /** 遷移を始める。すでにこまを予約済みならその予約に引き継がせる。 */
    const startTransition = (next: ViewTransition): void => {
      transition = next;
      if (frameId === 0) {
        frameId = globalThis.requestAnimationFrame(stepTransition);
      }
    };

    /** ホバー中の領域を差し替える。ビューポートは描き直らないので、変わったらここで描く。 */
    const setHighlighted = (next: ViewCubeRegion | null): void => {
      if (isSameRegion(highlighted, next)) {
        return;
      }
      highlighted = next;
      drawOnce();
    };

    // ビューポートが描いたら、同じ視点でビューキューブも描き直す。
    const unsubscribeDraw = subscribeDraw(drawOnce);

    /** canvas 上の位置から、指している領域を求める。 */
    const pickAt = (event: PointerEvent): ViewCubeRegion | null => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) {
        return null;
      }
      const normalizedX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      const normalizedY = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
      return scene.pick(normalizedX, normalizedY);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== PRIMARY_BUTTON) {
        return;
      }
      dragging = true;
      movedDistance = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) {
        setHighlighted(pickAt(event));
        return;
      }

      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      movedDistance += Math.abs(deltaX) + Math.abs(deltaY);

      if (movedDistance > DRAG_THRESHOLD_PIXELS) {
        // ドラッグが始まったら遷移を打ち切り、ビューポートと同じ感度で視点を回す。
        // 予約済みのこまは stepTransition が transition === null を見て自分で止める。
        transition = null;
        highlighted = null;
        // setOrbit がビューポートの描画を予約し、その通知でビューキューブも描き直る。
        setOrbit(orbit(getOrbit(), deltaX, deltaY));
      }
    };

    const releaseCapture = (event: PointerEvent): void => {
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!dragging) {
        return;
      }
      dragging = false;
      releaseCapture(event);

      const region = pickAt(event);
      setHighlighted(region);
      if (movedDistance > DRAG_THRESHOLD_PIXELS || region === null) {
        return;
      }

      // 遷移中に押し直されたら、前の遷移は今の視点から引き継いで打ち切る。
      const current = getOrbit();
      startTransition({
        from: current,
        to: orbitStateForRegion(region, current),
        startedAt: globalThis.performance.now(),
      });
    };

    const onPointerCancel = (event: PointerEvent): void => {
      dragging = false;
      releaseCapture(event);
      setHighlighted(null);
    };

    /** 捕捉が外部要因で外れたときも掴んだままにしない。 */
    const onLostPointerCapture = (): void => {
      dragging = false;
    };

    const onPointerLeave = (): void => {
      if (!dragging) {
        setHighlighted(null);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onLostPointerCapture);
    canvas.addEventListener('pointerleave', onPointerLeave);

    // 大きさを変えると描画バッファが空になるので、合わせ直したその場で描く。
    const observer = new ResizeObserver(() => {
      scene.resize(canvas.clientWidth);
      drawOnce();
    });
    observer.observe(canvas);
    scene.resize(canvas.clientWidth);
    drawOnce();

    return () => {
      if (frameId !== 0) {
        globalThis.cancelAnimationFrame(frameId);
      }
      unsubscribeDraw();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      observer.disconnect();
      scene.dispose();
    };
  }, [getOrbit, setOrbit, subscribeDraw]);

  return (
    <canvas
      ref={canvasRef}
      className="pcad-viewcube"
      width={CUBE_SIZE_PIXELS}
      height={CUBE_SIZE_PIXELS}
      aria-label={t('viewCube.label')}
      title={t('viewCube.tooltip')}
    />
  );
}
