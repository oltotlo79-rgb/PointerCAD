import * as THREE from 'three';

import { t, type MessageKey } from '../i18n/t.js';

/** 面 1 枚ぶんの画像の一辺(画素)。表示寸法より大きく描いて文字のにじみを防ぐ。 */
const TEXTURE_SIZE = 128;

const FACE_FILL_COLOR = '#d8dce4';
const FACE_BORDER_COLOR = '#7a8394';
const FACE_TEXT_COLOR = '#1e1e1e';
const FACE_BORDER_WIDTH = 6;
const FACE_FONT = '600 56px "Yu Gothic UI", "Meiryo", sans-serif';

/**
 * 立方体の 1 面ぶんの文字入り画像を作る。
 * 面の文字は ja.json から引く(NFR-MA-5)。
 */
export function createFaceTexture(labelKey: MessageKey): THREE.CanvasTexture {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('ビューキューブの面を描く準備ができませんでした。');
  }

  context.fillStyle = FACE_FILL_COLOR;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  context.strokeStyle = FACE_BORDER_COLOR;
  context.lineWidth = FACE_BORDER_WIDTH;
  context.strokeRect(
    FACE_BORDER_WIDTH / 2,
    FACE_BORDER_WIDTH / 2,
    TEXTURE_SIZE - FACE_BORDER_WIDTH,
    TEXTURE_SIZE - FACE_BORDER_WIDTH,
  );

  context.fillStyle = FACE_TEXT_COLOR;
  context.font = FACE_FONT;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(t(labelKey), TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * three.js の BoxGeometry の面の並び(+X, -X, +Y, -Y, +Z, -Z。いずれも立方体のローカル軸)に
 * 合わせた文字キー。
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
 */
export const FACE_LABEL_KEYS: readonly MessageKey[] = [
  'viewCube.right',
  'viewCube.left',
  'viewCube.top',
  'viewCube.bottom',
  'viewCube.front',
  'viewCube.back',
];
