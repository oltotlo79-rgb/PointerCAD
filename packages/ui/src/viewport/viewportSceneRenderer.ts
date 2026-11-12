import * as THREE from 'three';
import { viewportPixelRatio } from './viewportRenderScale.js';
import type { ViewportScene } from './createViewportScene.js';
import type { createSceneConstruction } from './viewportSceneResources.js';

/*
 * createViewportScene のレンダラ(描画バッファ)。作るのは Scene 1 つにつき 1 台で、構築中の台帳に
 * 載せて取得する。描画バッファの大きさと、視点操作中に画素を減らす切り替えもここが持つ。
 */

export type SceneRenderer = ReturnType<typeof createSceneRenderer>;
type RendererMethods = Pick<ViewportScene, 'resize' | 'setInteractiveRendering'>;

export function createSceneRenderer(canvas: HTMLCanvasElement,
  acquired: ReturnType<typeof createSceneConstruction>['acquired'], isDisposed: () => boolean) {
  // 背景は CSS(.pcad-viewport の縦グラデーション)に任せ、描画結果だけを重ねる。
  const renderer = acquired('renderer', new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }));
  let interactiveRendering = false;
  renderer.setPixelRatio(viewportPixelRatio(globalThis.devicePixelRatio, interactiveRendering));
  renderer.setClearColor(0x000000, 0);
  /*
    ビューの断面表示(FR-111)。**材質ごとの**クリッピング平面を
    使うので、レンダラ側でその機能を開けておく。開けるだけでは何も変わらない——
    three.js は `material.clippingPlanes` が空(または null)の材質を従来どおりに描く
    (`WebGLClipping.setState` の先頭で抜ける)ので、断面表示を使わない限り費用はゼロ
    (NFR-PF-1)。レンダラ全体の `renderer.clippingPlanes` は使わない(方眼・軸・
    スケッチ・つまみまで切れてしまうため)。
  */
  renderer.localClippingEnabled = true;

  let width = 1;
  let height = 1;
  let sizeInitialized = false;

  const methods: RendererMethods = {
    resize(widthPixels, heightPixels): void {
      if (isDisposed()) return;
      const nextWidth = Math.max(widthPixels, 1);
      const nextHeight = Math.max(heightPixels, 1);
      if (sizeInitialized && width === nextWidth && height === nextHeight) return;
      width = nextWidth;
      height = nextHeight;
      sizeInitialized = true;
      // CSS の大きさは指定済みなので描画バッファだけを合わせる。
      renderer.setSize(width, height, false);
    },

    /** 視点操作中は描画画素を減らし、離したら通常解像度へ戻す。 */
    setInteractiveRendering(active): void {
      if (isDisposed()) return;
      if (interactiveRendering === active) {
        return;
      }
      interactiveRendering = active;
      // setPixelRatio 自身が現在の論理サイズで setSize を呼ぶ。重ねて呼ぶと
      // canvas.width/height が再代入され、同じ寸法でも描画バッファを再確保してしまう。
      renderer.setPixelRatio(viewportPixelRatio(globalThis.devicePixelRatio, interactiveRendering));
    },
  };

  return { renderer, methods, width: () => width, height: () => height };
}
