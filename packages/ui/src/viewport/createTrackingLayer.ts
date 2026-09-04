/**
 * 向きの吸着の案内線の表示層(計画書 docs/plans/P4b-スケッチの仕上げ.md タスク16、§0.14)。
 *
 * 対応要件: FR-110(吸着している間は案内線を表示する)、NFR-PF-1(60fps)、NFR-UX-7。
 *
 * 案内線は**細い破線**で、色は吸着の印と同じアクセント色、長さは**画面いっぱい**
 * (§0.14 の利用者の決定)。同時に出すのは**最大 2 本**なので、`LineSegments` を 1 つだけ
 * 作って中身の座標だけを書き換える(ポインタが動くたびに部品を作り直さない、NFR-PF-1。
 * `createSketchLayer.ts` の `setPositions` と同じ流儀)。
 *
 * 色は `themeColors.ts` のトークンから読む。ビューキューブの面に固定色を焼き込んで
 * テーマに追従しなかった失敗(docs/報告記録.md 2026-09-04 15:40)を繰り返さないため、
 * ここには 16 進の色を書かない(既定値の後退先は `themeColors.ts` の 1 か所)。
 */

import type { Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { TrackCandidate } from '../sketch/trackMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/** 同時に出す案内線の本数の上限(§0.14。3 本以上は画面が読めなくなる)。 */
export const MAX_TRACK_LINES = 2;

/** 1 本ぶんの数値の個数(両端 × x, y, z)。 */
const FLOATS_PER_LINE = 6;

/**
 * 線の太さ(画素)。下書きの線(1.5)より細くして、案内であって図形ではないことを見せる
 * (太い線が描けない端末では 1 画素になる。`createSketchLayer.ts` の注釈と同じ事情)。
 */
const TRACK_WIDTH_PIXELS = 1;

/**
 * 描く順。方眼・軸・面より前に出し、下書きの線(3)・点(4)より後ろに置く。
 * 案内線が下書きそのものを隠してしまわないようにするため。深度は見ない
 * (`depthTest: false`)ので、前後はこの数だけで決まる(`createSketchLayer.ts` と同じ)。
 */
const TRACK_RENDER_ORDER = 1;

/**
 * 破線の刻みと隙間を、案内線の長さ(片側)に対する比で決める。
 *
 * `LineDashedMaterial` の刻みは**ワールドの長さ**なので、固定値にすると拡大したときに
 * 実線に見え、縮小したときに点が潰れる。案内線の長さは方眼の広がり(= 視野のおよそ 2 倍、
 * `gridExtent`)に合わせてあるので、そこへ比を掛けると**どの拡大率でも画面上で同じ
 * 見え方**になる。0.004 は、視野の高さを画面の高さ(実測でおよそ 800 画素)へ写したとき
 * 刻みが 6 画素前後になる値。
 */
const DASH_SIZE_RATIO = 0.004;
const GAP_SIZE_RATIO = 0.003;

/** 長さがまだ知らされていないときの片側の長さ(mm)。方眼の初期値と同じ桁にする。 */
const DEFAULT_HALF_LENGTH_MM = 200;

/** 案内線 1 本を、通る点の両側へ `halfLength` だけ伸ばした線分の両端(§0.14「画面いっぱい」)。 */
export function trackLineEndpoints(
  line: TrackCandidate,
  halfLength: number,
): readonly [Vec3, Vec3] {
  const [originX, originY, originZ] = line.origin;
  const [directionX, directionY, directionZ] = line.direction;
  return [
    [
      originX - directionX * halfLength,
      originY - directionY * halfLength,
      originZ - directionZ * halfLength,
    ],
    [
      originX + directionX * halfLength,
      originY + directionY * halfLength,
      originZ + directionZ * halfLength,
    ],
  ];
}

/** 実際に描く本数。上限(2 本)を超える分は捨てる(§0.14)。 */
export function trackLineCount(lines: readonly TrackCandidate[]): number {
  return Math.min(lines.length, MAX_TRACK_LINES);
}

/**
 * 案内線の座標の並び。**長さは常に上限ぶん**(2 本 × 両端 × 3)にして、本数が変わっても
 * 入れ物を作り直さずに済むようにする(NFR-PF-1)。使わない分は 0 のまま残り、
 * 描く範囲(`setDrawRange`)で外す。
 */
export function trackLinePositions(
  lines: readonly TrackCandidate[],
  halfLength: number,
): Float32Array {
  const values = new Float32Array(MAX_TRACK_LINES * FLOATS_PER_LINE);
  const count = trackLineCount(lines);
  for (let index = 0; index < count; index += 1) {
    const [from, to] = trackLineEndpoints(lines[index], halfLength);
    values.set(from, index * FLOATS_PER_LINE);
    values.set(to, index * FLOATS_PER_LINE + 3);
  }
  return values;
}

export interface TrackingLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /** 出す案内線(最大 2 本)。`null` か空で消す。 */
  setLines(lines: readonly TrackCandidate[] | null): void;
  /** 表示テーマの色を反映する(FR-908)。材質を塗り替えるだけで部品は作り直さない。 */
  setThemeColors(colors: ThemeColors): void;
  /** 案内線を伸ばす長さ(片側、mm)。方眼の広がりに合わせて画面いっぱいにする。 */
  setHalfLength(halfLength: number): void;
  dispose(): void;
}

export function createTrackingLayer(): TrackingLayer {
  const group = new THREE.Group();

  const positions = new Float32Array(MAX_TRACK_LINES * FLOATS_PER_LINE);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.LineDashedMaterial({
    color: DEFAULT_THEME_COLORS.track,
    linewidth: TRACK_WIDTH_PIXELS,
    dashSize: DEFAULT_HALF_LENGTH_MM * DASH_SIZE_RATIO,
    gapSize: DEFAULT_HALF_LENGTH_MM * GAP_SIZE_RATIO,
    // 面より後に描くための「半透明」扱い(透け具合は 1 のままなので色は変わらない)。
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const lineObject = new THREE.LineSegments(geometry, material);
  lineObject.renderOrder = TRACK_RENDER_ORDER;
  lineObject.visible = false;
  // 画面いっぱいに伸ばす線なので、包む球で視錐台の外と判定されると消えてしまう。
  lineObject.frustumCulled = false;
  group.add(lineObject);

  /** いま出している案内線。長さやテーマが変わったときに引き直すために覚えておく。 */
  let lines: readonly TrackCandidate[] = [];
  let halfLength = DEFAULT_HALF_LENGTH_MM;

  /** いまの案内線と長さを、同じ入れ物の中身として書き写す(部品は作り直さない)。 */
  function refresh(): void {
    const count = trackLineCount(lines);
    if (count === 0) {
      lineObject.visible = false;
      return;
    }
    positions.set(trackLinePositions(lines, halfLength));
    const attribute = geometry.getAttribute('position');
    attribute.needsUpdate = true;
    geometry.setDrawRange(0, count * 2);
    // 破線の刻みはワールドの長さで決まるので、長さを変えたら合わせ直して測り直す。
    material.dashSize = halfLength * DASH_SIZE_RATIO;
    material.gapSize = halfLength * GAP_SIZE_RATIO;
    lineObject.computeLineDistances();
    lineObject.visible = true;
  }

  return {
    group,

    setLines(next): void {
      lines = next ?? [];
      refresh();
    },

    setThemeColors(colors): void {
      material.color.setHex(colors.track);
    },

    setHalfLength(next): void {
      if (next <= 0 || !Number.isFinite(next) || next === halfLength) {
        return;
      }
      halfLength = next;
      refresh();
    },

    dispose(): void {
      lines = [];
      geometry.dispose();
      material.dispose();
    },
  };
}
