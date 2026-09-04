import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { orbit, type OrbitState } from '../viewport/cameraMath.js';
import { readThemeColors } from '../viewport/themeColors.js';
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

/**
 * 面を押して視点が移った直後に、ホバーの丸い下地を消しておくための打ち消し。
 *
 * CSS の `.pcad-viewcube:hover` は指が同じ場所に留まっている限り外れないので、
 * ポインタが動かなくても下地が残ってしまう(docs/報告記録.md 2026-09-03 00:06 の (c))。
 * 要素に直接書いた指定は CSS の規則より強いため、ここで背景を打ち消す。
 * 次にポインタが動いたら外し、ふつうのホバーへ戻す。
 */
const HOVER_SUPPRESSED_STYLE: React.CSSProperties = { background: 'transparent' };

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
 *
 * 面を押して視点が移り始めたら、指が止まったままでも強調(面の青と丸い下地)を消す。
 * 押した後も光ったままだと、まだ押せる場所を指しているのか区別が付かないため(NFR-UX-7)。
 *
 * 面・稜線・文字・ホバーの色はテーマに追従する(FR-908、P4 タスク2 仕上げ)。
 * `ViewportCanvas.tsx` と同じ作り(`themeDirty` を立てておき、次の描画機会に一度だけ
 * `readThemeColors()` を読み直す)にそろえる。テーマだけが変わっても本体ビューポートは
 * 必ず描き直す(`requestDraw`)ので、その通知(`subscribeDraw`)に乗って自分も気づける。
 */
export function ViewCube({ getOrbit, setOrbit, subscribeDraw }: ViewCubeProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ホバーの見た目だけの一時状態なのでストアへは載せない(rules/04-設計の規律.md)。
  const [hoverSuppressed, setHoverSuppressed] = useState(false);

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
    // 起動直後も 1 回読む(保存されていたテーマで始まるため)。ViewportCanvas.tsx と同じ理由。
    let themeDirty = true;

    /** いまの視点とホバー状態で 1 回だけ描く。テーマが変わっていれば先に読み直す。 */
    const drawOnce = (): void => {
      if (themeDirty) {
        themeDirty = false;
        scene.setThemeColors(readThemeColors());
      }
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

    /** いまホバーの下地を打ち消しているか。変わったときだけ描き直しを頼む。 */
    let hoverSuppressedNow = false;

    /** ホバーの丸い下地を消す・戻す。 */
    const suppressHover = (next: boolean): void => {
      if (hoverSuppressedNow === next) {
        return;
      }
      hoverSuppressedNow = next;
      setHoverSuppressed(next);
    };

    // ビューポートが描いたら、同じ視点でビューキューブも描き直す。
    const unsubscribeDraw = subscribeDraw(drawOnce);

    // テーマが変わったことを覚えておく。実際に読み直すのは次の描画機会(drawOnce)。
    // 属性(data-theme)を書くのは applyDisplaySettings.ts の見張りなので、読むのは
    // ここでの記録だけにして、実際の値は次の描画のときに読む(ViewportCanvas.tsx と同じ)。
    const unsubscribeTheme = useAppStore.subscribe((next, previous) => {
      if (next.displaySettings.theme !== previous.displaySettings.theme) {
        themeDirty = true;
      }
    });

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
        // 指が動いたらふつうのホバーへ戻す(直前のクリックで消していても)。
        suppressHover(false);
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
        // 回し始めれば指は動いている。ふつうのホバーへ戻してよい。
        suppressHover(false);
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
      if (movedDistance > DRAG_THRESHOLD_PIXELS || region === null) {
        // 回し終わり、または立方体の外。指のある場所のホバーを出し直すだけ。
        setHighlighted(region);
        return;
      }

      // ここから視点が移る。指が止まったままでも強調は残さない(面の青も丸い下地も消す)。
      // pointerleave を待つと、押した場所から動かさない限り強調が残り続けるため。
      setHighlighted(null);
      suppressHover(true);

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
      suppressHover(false);
      setHighlighted(null);
    };

    /** 捕捉が外部要因で外れたときも掴んだままにしない。 */
    const onLostPointerCapture = (): void => {
      dragging = false;
    };

    const onPointerLeave = (): void => {
      if (!dragging) {
        // 出ていけば CSS のホバーも外れるので、打ち消しはもう要らない。
        suppressHover(false);
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
      unsubscribeTheme();
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
      style={hoverSuppressed ? HOVER_SUPPRESSED_STYLE : undefined}
      width={CUBE_SIZE_PIXELS}
      height={CUBE_SIZE_PIXELS}
      aria-label={t('viewCube.label')}
      title={t('viewCube.tooltip')}
    />
  );
}
