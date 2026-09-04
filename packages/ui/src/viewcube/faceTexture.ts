import * as THREE from 'three';

import { t, type MessageKey } from '../i18n/t.js';
import type { ThemeColors } from '../viewport/themeColors.js';

/** 面 1 枚ぶんの画像の一辺(画素)。表示寸法より大きく描いて文字のにじみを防ぐ。 */
const TEXTURE_SIZE = 128;

const FACE_FONT = '700 54px "Yu Gothic UI", "Meiryo", sans-serif';

/**
 * 立方体の 1 面ぶんの文字入り画像を作る。
 *
 * 面の文字は ja.json から引く(NFR-MA-5)。地の色・文字の色は呼び出し側(テーマの色、
 * P4 タスク2 仕上げ)が渡す。稜線は 3 次元の線で別に描くので、ここでは枠を描かない。
 */
export function createFaceTexture(
  labelKey: MessageKey,
  fillColor: string,
  textColor: string,
): THREE.CanvasTexture {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('ビューキューブの面を描く準備ができませんでした。');
  }

  context.fillStyle = fillColor;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  context.fillStyle = textColor;
  context.font = FACE_FONT;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(t(labelKey), TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 立方体の 1 面の見た目。文字の言葉と、テーマの色から地の色を引く欄。 */
export interface ViewCubeFace {
  readonly labelKey: MessageKey;
  /** `ThemeColors` のうち、この面の地の色を持つ欄。 */
  readonly fillField: keyof ThemeColors;
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
 * 上 > 前 > 右 > 左 > 後 > 下 の順で暗くする(ダークの値。テーマごとの実際の値は
 * `viewport/themeColors.ts` の `ThemeColors` / `appShell.css` の `--pcad-viewcube-face-*`)。
 * 文字が読めるよう、どの面も十分明るく保つ。
 */
export const CUBE_FACES: readonly ViewCubeFace[] = [
  { labelKey: 'viewCube.right', fillField: 'viewCubeFaceRight' },
  { labelKey: 'viewCube.left', fillField: 'viewCubeFaceLeft' },
  { labelKey: 'viewCube.top', fillField: 'viewCubeFaceTop' },
  { labelKey: 'viewCube.bottom', fillField: 'viewCubeFaceBottom' },
  { labelKey: 'viewCube.front', fillField: 'viewCubeFaceFront' },
  { labelKey: 'viewCube.back', fillField: 'viewCubeFaceBack' },
];
