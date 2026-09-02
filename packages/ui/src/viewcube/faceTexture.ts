import * as THREE from 'three';

import { t, type MessageKey } from '../i18n/t.js';

/** 面 1 枚ぶんの画像の一辺(画素)。表示寸法より大きく描いて文字のにじみを防ぐ。 */
const TEXTURE_SIZE = 128;

const FACE_TEXT_COLOR = '#1f2430';
const FACE_FONT = '700 54px "Yu Gothic UI", "Meiryo", sans-serif';

/**
 * 立方体の 1 面ぶんの文字入り画像を作る。
 *
 * 面の文字は ja.json から引く(NFR-MA-5)。地の色は面ごとに変え、光を上・前・右から
 * 当てたときの明るさの差を表す(立体に見えるようにするため)。稜線は 3 次元の線で
 * 別に描くので、ここでは枠を描かない。
 */
export function createFaceTexture(labelKey: MessageKey, fillColor: string): THREE.CanvasTexture {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('ビューキューブの面を描く準備ができませんでした。');
  }

  context.fillStyle = fillColor;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  context.fillStyle = FACE_TEXT_COLOR;
  context.font = FACE_FONT;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(t(labelKey), TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 立方体の 1 面の見た目。文字と地の色。 */
export interface ViewCubeFace {
  readonly labelKey: MessageKey;
  readonly fillColor: string;
}

/**
 * three.js の BoxGeometry の面の並び(+X, -X, +Y, -Y, +Z, -Z。いずれも立方体のローカル軸)に
 * 合わせた面の定義。
 *
 * 立方体は `createViewCubeScene` で X 軸まわりに +90 度倒し、three.js の既定(Y 上)を
 * 本アプリの Z 上(計画書 §0.a-0.9)へ合わせる。この回転でローカル軸はワールド軸へ
 * 次のように移る。
 *
 * - ローカル +X → ワールド +X(右)
 * - ローカル +Y → ワールド +Z(上)
 * - ローカル +Z → ワールド -Y(前)
 *
 * したがって並びは 右 / 左 / 上 / 下 / 前 / 後 になる。
 * BoxGeometry の UV は側面の「画像の上」がローカル +Y なので、この向きに倒したときだけ
 * 6 面すべての文字が上下反転も鏡像にもならずに読める(計画書タスク13 の並びと回転の向きは
 * 相互に矛盾していたため、検算のうえ修正した)。
 *
 * 地の色は「上・前・右の方向から光が当たっている」と見えるように、
 * 上 > 前 > 右 > 左 > 後 > 下 の順で暗くする。文字が読めるよう、どの面も十分明るく保つ。
 */
export const CUBE_FACES: readonly ViewCubeFace[] = [
  { labelKey: 'viewCube.right', fillColor: '#dfe3ea' },
  { labelKey: 'viewCube.left', fillColor: '#cbd0da' },
  { labelKey: 'viewCube.top', fillColor: '#eef1f6' },
  { labelKey: 'viewCube.bottom', fillColor: '#b6bcc9' },
  { labelKey: 'viewCube.front', fillColor: '#e3e7ee' },
  { labelKey: 'viewCube.back', fillColor: '#c6cbd6' },
];
