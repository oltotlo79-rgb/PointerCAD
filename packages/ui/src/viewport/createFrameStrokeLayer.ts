/**
 * 3D の画面で打った点と、点を結ぶ一時の線の層(一筆書きの配置 E-08 第 2 段。安全柵の床の線 E-12 も同じ点の列を使う)。
 *
 * 文書の形ではない一時の印なので、部品の後ろでも見えるように深度を見ない(向きの吸着の案内線の層と同じ)。閉じた時は、
 * 最後の点から最初の点へも結ぶ。断面で切らない(案内であって形ではないため)。点の列は押すたびにしか変わらないので、
 * 変わった時だけ形を作り直す(同じ点の列と閉じるの組なら何もしない)。
 *
 * 色は向きの吸着の案内線と同じアクセント色(`themeColors.ts` の track。5 テーマで地と 3:1 以上)。16 進の色はここに書かない。
 */
import type { Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { FrameStroke } from '../assembly/frameStroke.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/** 点の大きさ(画素。拡大・縮小しても変えない。組立の層の頂点の点と同じ 7)。 */
const POINT_SIZE_PIXELS = 7;

/** 描く順。深度を見ないので前後はこの数で決まる。接合チェックの印(2・3)より後に描いて、印に隠れないようにする。 */
const STROKE_RENDER_ORDER = 4;

/** 検査専用の口(`window.pcadViewportFrameStroke`)が読む、描いている点の数・線の本数・閉じているか。隠している時は 0・0・false。 */
export interface FrameStrokeView {
  readonly points: number;
  readonly segments: number;
  readonly closed: boolean;
}

export interface FrameStrokeLayer {
  readonly group: THREE.Group;
  /** 打った点の列を描く。null か点が無い時は隠す。 */
  update(stroke: FrameStroke | null): void;
  /** 今描いている物の数(検査専用の口が読む)。 */
  view(): FrameStrokeView;
  setThemeColors(colors: ThemeColors): void;
  dispose(): void;
}

const HIDDEN_VIEW: FrameStrokeView = { points: 0, segments: 0, closed: false };

/** 続く 2 点を結ぶ線分の両端の並び(LineSegments の形)。閉じた時は、3 点以上の時だけ最後の点から最初の点へも結ぶ。 */
function segmentPositions(points: readonly Vec3[], closed: boolean): Float32Array {
  const pairs: Vec3[] = [];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    if (start !== undefined && end !== undefined) pairs.push(start, end);
  }
  const first = points[0], last = points.at(-1);
  if (closed && points.length >= 3 && first !== undefined && last !== undefined) pairs.push(last, first);
  return new Float32Array(pairs.flat());
}

function positionGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export function createFrameStrokeLayer(): FrameStrokeLayer {
  const group = new THREE.Group();
  group.name = 'frame-stroke';
  group.visible = false;
  const lineMaterial = new THREE.LineBasicMaterial({ color: DEFAULT_THEME_COLORS.track, depthTest: false, depthWrite: false,
    transparent: true });
  const pointMaterial = new THREE.PointsMaterial({ color: DEFAULT_THEME_COLORS.track, size: POINT_SIZE_PIXELS, sizeAttenuation: false,
    depthTest: false, depthWrite: false, transparent: true });
  const lines = new THREE.LineSegments(positionGeometry(new Float32Array(0)), lineMaterial);
  lines.name = 'frame-stroke:lines';
  const dots = new THREE.Points(positionGeometry(new Float32Array(0)), pointMaterial);
  dots.name = 'frame-stroke:points';
  for (const object of [lines, dots]) {
    object.renderOrder = STROKE_RENDER_ORDER;
    // 点の列は毎回作り直すので、境界球の計算と視錐台の外し込みを省く(一時の印は常に描く)。
    object.frustumCulled = false;
  }
  group.add(lines, dots);
  let lastPoints: readonly Vec3[] | null = null;
  let lastClosed = false;

  return {
    group,
    update(stroke): void {
      const points = stroke === null || stroke.points.length === 0 ? null : stroke.points;
      const closed = stroke?.closed ?? false;
      if (points === lastPoints && closed === lastClosed) return;
      lastPoints = points;
      lastClosed = closed;
      lines.geometry.dispose();
      dots.geometry.dispose();
      lines.geometry = positionGeometry(points === null ? new Float32Array(0) : segmentPositions(points, closed));
      dots.geometry = positionGeometry(new Float32Array(points === null ? [] : points.flat()));
      group.visible = points !== null;
    },
    view(): FrameStrokeView {
      if (!group.visible) return HIDDEN_VIEW;
      return { points: dots.geometry.getAttribute('position').count, segments: lines.geometry.getAttribute('position').count / 2,
        closed: lastClosed };
    },
    setThemeColors(colors): void {
      lineMaterial.color.setHex(colors.track);
      pointMaterial.color.setHex(colors.track);
    },
    dispose(): void {
      group.remove(lines, dots);
      lines.geometry.dispose();
      dots.geometry.dispose();
      lineMaterial.dispose();
      pointMaterial.dispose();
    },
  };
}
