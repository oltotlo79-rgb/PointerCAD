import * as THREE from 'three';

import { t, type MessageKey } from '../i18n/t.js';
import type { ThemeColors } from '../viewport/themeColors.js';
import { ATLAS_COLUMNS, ATLAS_ROWS } from './viewCubeGeometry.js';

/** 面 1 枚ぶんの画像の一辺(画素)。表示寸法より大きく描いて文字のにじみを防ぐ。 */
export const FACE_TEXTURE_SIZE = 256;

/**
 * 画面全体と同じ字体の並び(appShell.css の --pcad-font と同じ。単体の検査で照合する)。
 * 図面用の同梱字体(約4.5MB)を起動の時に別に取得しない。取得すると起動が重くなり、
 * 図面の字体の取得回数の上限(3回)の検査とも数が合わなくなる。
 */
export const VIEW_CUBE_FONT_FAMILY = '"Segoe UI", "Yu Gothic UI", "Meiryo", "Noto Sans JP", system-ui, sans-serif';

export const FACE_FONT = `600 96px ${VIEW_CUBE_FONT_FAMILY}`;

/**
 * 6 面と面取りをまとめた文字入り画像を作る。
 *
 * 面の文字は ja.json から引く(NFR-MA-5)。配色は既存のテーマを使い、陰影と細い縁を
 * 画像へ描いておく。毎こまの光源計算・影の描画や6材質への分割を必要としない。
 */
export function createCubeTexture(colors: ThemeColors): THREE.CanvasTexture {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = FACE_TEXTURE_SIZE * ATLAS_COLUMNS;
  canvas.height = FACE_TEXTURE_SIZE * ATLAS_ROWS;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('ビューキューブの面を描く準備ができませんでした。');
  }

  for (const [index, face] of CUBE_FACES.entries()) {
    const x = (index % ATLAS_COLUMNS) * FACE_TEXTURE_SIZE;
    const y = Math.floor(index / ATLAS_COLUMNS) * FACE_TEXTURE_SIZE;
    const base = new THREE.Color(colors[face.fillField]);
    const gradient = context.createLinearGradient(x, y, x + FACE_TEXTURE_SIZE * 0.3, y + FACE_TEXTURE_SIZE);
    gradient.addColorStop(0, base.clone().lerp(new THREE.Color(0xffffff), 0.035).getStyle());
    gradient.addColorStop(0.48, base.getStyle());
    gradient.addColorStop(1, base.clone().lerp(new THREE.Color(0x000000), 0.06).getStyle());
    context.fillStyle = gradient;
    context.fillRect(x, y, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE);
    // A fine inset rim keeps the face distinct from the actual bevel.
    context.strokeStyle = new THREE.Color(colors.viewCubeEdge).getStyle();
    context.globalAlpha = 0.55;
    context.lineWidth = 2;
    context.strokeRect(x + 3, y + 3, FACE_TEXTURE_SIZE - 6, FACE_TEXTURE_SIZE - 6);
    context.globalAlpha = 1;
    context.fillStyle = new THREE.Color(colors.viewCubeText).getStyle();
    context.font = FACE_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(t(face.labelKey), x + FACE_TEXTURE_SIZE / 2, y + FACE_TEXTURE_SIZE / 2);
  }
  // The seventh tile is used by all twelve bevels and eight chamfered corners.
  const bevelX = 2 * FACE_TEXTURE_SIZE, bevelY = FACE_TEXTURE_SIZE;
  const bevel = context.createLinearGradient(bevelX, bevelY, bevelX, bevelY + FACE_TEXTURE_SIZE);
  const edge = new THREE.Color(colors.viewCubeEdge);
  bevel.addColorStop(0, edge.clone().lerp(new THREE.Color(colors.viewCubeFaceTop), 0.3).getStyle());
  bevel.addColorStop(1, edge.clone().lerp(new THREE.Color(colors.viewCubeFaceBottom), 0.5).getStyle());
  context.fillStyle = bevel;
  context.fillRect(bevelX, bevelY, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Each tile is already supersampled. Avoid atlas bleed in distant mip levels.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

/** Small camera-facing axis labels, using the same font stack as the faces. */
export function createAxisTexture(label: 'X' | 'Y' | 'Z', color: number): THREE.CanvasTexture {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Unable to draw a view cube axis label.');
  context.font = `600 42px ${VIEW_CUBE_FONT_FAMILY}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = new THREE.Color(color).getStyle();
  context.fillText(label, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
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
 * 側面の「画像の上」はローカル +Y。上面はローカル -Z（ワールド +Y、後）へ向ける。
 * 下面の「画像の上」はローカル +Z（ワールド -Y、前）へ向ける。
 * UV の向きは viewCubeGeometry.ts でそろえ、文字を鏡像にしない。
 *
 * 地の色は上 > 前 > 右 > 左 > 後 > 下 の順で暗くする。
 * 5テーマの値は viewCube.css のキューブ専用トークンに置き、明るい文字と組み合わせる。
 */
export const CUBE_FACES: readonly ViewCubeFace[] = [
  { labelKey: 'viewCube.right', fillField: 'viewCubeFaceRight' },
  { labelKey: 'viewCube.left', fillField: 'viewCubeFaceLeft' },
  { labelKey: 'viewCube.top', fillField: 'viewCubeFaceTop' },
  { labelKey: 'viewCube.bottom', fillField: 'viewCubeFaceBottom' },
  { labelKey: 'viewCube.front', fillField: 'viewCubeFaceFront' },
  { labelKey: 'viewCube.back', fillField: 'viewCubeFaceBack' },
];
