/**
 * 基準ジオメトリ(基準軸・基準点・座標系)の 3D 表示
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク13、FR-329)。
 *
 * 任意の作業平面(FR-328)そのものは、作図面として選ばれているものだけを
 * `createSketchLayer` が薄い矩形で出す。ここで出すのは**参照のためだけの軸・点・座標系**で、
 * 形を作らない補助なので、線は細く、点は小さく、座標系は 3 色の短い矢印にする。
 *
 * 色は `themeColors.ts` のトークンから引く(FR-908)。ここで 16 進数を決め打ちしない。
 * 軸と点はスケッチの線・点と同じ色、座標系の 3 本はワールドの XYZ 軸と同じ色にそろえ、
 * 「どの向きが X か」を画面の中で 1 通りの意味に保つ。
 *
 * `visible: false` の基準ジオメトリは出さない(FR-329「表示/非表示を切り替えられる」)。
 * 参照はできるので、文書からは消さない。
 */

import type {
  ResolvedReferenceAxis,
  ResolvedReferenceCoordinateSystem,
  ResolvedReferencePoint,
  ResolvedReferences,
  Vec3,
} from '@pointercad/model';
import * as THREE from 'three';

import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/** 基準軸を画面に出す長さ(mm、原点から片側)。方眼の広がりに合わせて後から変える。 */
const DEFAULT_AXIS_HALF_LENGTH_MM = 100;

/** 座標系の矢印の長さ(mm)。軸より短くして「向きの印」だと分かるようにする。 */
const COORDINATE_SYSTEM_ARROW_MM = 20;

/** 矢じりの長さと開きの比(矢印の全長に対する割合)。 */
const ARROW_HEAD_RATIO = 0.25;
const ARROW_HEAD_SPREAD_RATIO = 0.1;

/** 基準点の印の大きさ(画素)。スケッチの点より小さくして見分ける。 */
const POINT_SIZE_PIXELS = 5;

/** 細い線(基準軸)の太さ(画素)。 */
const AXIS_WIDTH_PIXELS = 1;

/** 面より後に描くための描画順。スケッチの点(4)より手前へは出さない。 */
const REFERENCE_RENDER_ORDER = 2;

export interface ReferenceLayer {
  readonly group: THREE.Group;
  /** 解決済みの基準ジオメトリを反映する。同じものを渡し直したときは作り直さない。 */
  update(references: ResolvedReferences): void;
  /** 表示テーマの色を反映する(FR-908)。 */
  setThemeColors(colors: ThemeColors): void;
  /** 基準軸を出す長さ(原点から片側、mm)。方眼の広がりに合わせる。 */
  setAxisHalfLength(millimetres: number): void;
  dispose(): void;
}

type LinesObject = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type PointsObject = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

function createLines(color: number): LinesObject {
  const object = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color,
      linewidth: AXIS_WIDTH_PIXELS,
      // 面の奥にあっても隠れないようにする(スケッチの線と同じ扱い)。
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  object.renderOrder = REFERENCE_RENDER_ORDER;
  return object;
}

function createPoints(color: number): PointsObject {
  const object = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color,
      size: POINT_SIZE_PIXELS,
      sizeAttenuation: false,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  object.renderOrder = REFERENCE_RENDER_ORDER;
  return object;
}

/** 位置の並びを差し替える。個数が同じなら同じ入れ物へ書き写す(NFR-PF-1)。 */
function setPositions(object: THREE.Points | THREE.LineSegments, values: Float32Array): void {
  const existing = object.geometry.getAttribute('position');
  if (
    existing instanceof THREE.BufferAttribute &&
    existing.array instanceof Float32Array &&
    existing.array.length === values.length
  ) {
    existing.array.set(values);
    existing.needsUpdate = true;
    object.geometry.computeBoundingSphere();
    object.visible = values.length > 0;
    return;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(values, 3));
  geometry.computeBoundingSphere();
  object.geometry.dispose();
  object.geometry = geometry;
  object.visible = values.length > 0;
}

function pushPoint(into: number[], point: Vec3): void {
  into.push(point[0], point[1], point[2]);
}

/** 基準軸 1 本を、原点をはさんだ 1 本の線分にする。 */
function buildAxisPositions(
  axes: readonly ResolvedReferenceAxis[],
  halfLength: number,
): Float32Array {
  const values: number[] = [];
  for (const axis of axes) {
    if (!axis.visible) {
      continue;
    }
    const { origin, direction } = axis;
    pushPoint(values, [
      origin[0] - direction[0] * halfLength,
      origin[1] - direction[1] * halfLength,
      origin[2] - direction[2] * halfLength,
    ]);
    pushPoint(values, [
      origin[0] + direction[0] * halfLength,
      origin[1] + direction[1] * halfLength,
      origin[2] + direction[2] * halfLength,
    ]);
  }
  return new Float32Array(values);
}

function buildPointPositions(points: readonly ResolvedReferencePoint[]): Float32Array {
  const values: number[] = [];
  for (const point of points) {
    if (point.visible) {
      pushPoint(values, point.position);
    }
  }
  return new Float32Array(values);
}

/**
 * 矢印 1 本ぶんの線分を足す(軸の線 1 本 + 矢じりの 2 本)。
 * 矢じりは「進む向きに垂直な適当な向き」へ開くのではなく、**残り 2 本の軸の向き**へ開く。
 * 3 本の矢じりが同じ平面に寝ないので、どの向きから見ても矢印だと分かる。
 */
function pushArrow(into: number[], origin: Vec3, direction: Vec3, spread: Vec3, length: number): void {
  const tip: Vec3 = [
    origin[0] + direction[0] * length,
    origin[1] + direction[1] * length,
    origin[2] + direction[2] * length,
  ];
  pushPoint(into, origin);
  pushPoint(into, tip);
  const back = length * ARROW_HEAD_RATIO;
  const side = length * ARROW_HEAD_SPREAD_RATIO;
  for (const sign of [1, -1]) {
    pushPoint(into, tip);
    pushPoint(into, [
      tip[0] - direction[0] * back + spread[0] * side * sign,
      tip[1] - direction[1] * back + spread[1] * side * sign,
      tip[2] - direction[2] * back + spread[2] * side * sign,
    ]);
  }
}

/** 座標系 1 つを、X・Y・Z の 3 本の矢印にする(軸ごとに別の入れ物へ積む)。 */
function buildCoordinateSystemPositions(
  systems: readonly ResolvedReferenceCoordinateSystem[],
  axis: 'x' | 'y' | 'z',
): Float32Array {
  const values: number[] = [];
  for (const system of systems) {
    if (!system.visible) {
      continue;
    }
    const direction =
      axis === 'x' ? system.xAxis : axis === 'y' ? system.yAxis : system.zAxis;
    // 矢じりを開く向きは、次の軸(X なら Y、Y なら Z、Z なら X)。
    const spread = axis === 'x' ? system.yAxis : axis === 'y' ? system.zAxis : system.xAxis;
    pushArrow(values, system.origin, direction, spread, COORDINATE_SYSTEM_ARROW_MM);
  }
  return new Float32Array(values);
}

/**
 * 基準ジオメトリの層を作る。中身の組み立ては純関数(上の build*)に寄せてあるので、
 * ここは three.js の入れ物と色の管理だけを受け持つ。
 */
export function createReferenceLayer(): ReferenceLayer {
  const group = new THREE.Group();

  const axisLines = createLines(DEFAULT_THEME_COLORS.sketchCurve);
  const pointMarks = createPoints(DEFAULT_THEME_COLORS.sketchPoint);
  const systemX = createLines(DEFAULT_THEME_COLORS.axisX);
  const systemY = createLines(DEFAULT_THEME_COLORS.axisY);
  const systemZ = createLines(DEFAULT_THEME_COLORS.axisZ);
  group.add(axisLines);
  group.add(pointMarks);
  group.add(systemX);
  group.add(systemY);
  group.add(systemZ);

  let halfLength = DEFAULT_AXIS_HALF_LENGTH_MM;
  let last: ResolvedReferences | null = null;

  function apply(references: ResolvedReferences): void {
    setPositions(axisLines, buildAxisPositions(references.axes, halfLength));
    setPositions(pointMarks, buildPointPositions(references.points));
    setPositions(systemX, buildCoordinateSystemPositions(references.coordinateSystems, 'x'));
    setPositions(systemY, buildCoordinateSystemPositions(references.coordinateSystems, 'y'));
    setPositions(systemZ, buildCoordinateSystemPositions(references.coordinateSystems, 'z'));
  }

  apply({ planes: [], axes: [], points: [], coordinateSystems: [], errors: [] });

  return {
    group,

    update(references): void {
      if (references === last) {
        return;
      }
      last = references;
      apply(references);
    },

    setThemeColors(colors): void {
      axisLines.material.color.setHex(colors.sketchCurve);
      pointMarks.material.color.setHex(colors.sketchPoint);
      systemX.material.color.setHex(colors.axisX);
      systemY.material.color.setHex(colors.axisY);
      systemZ.material.color.setHex(colors.axisZ);
    },

    setAxisHalfLength(millimetres): void {
      if (millimetres === halfLength) {
        return;
      }
      halfLength = millimetres;
      if (last !== null) {
        // 長さだけが変わったので、軸の線だけを引き直す。
        setPositions(axisLines, buildAxisPositions(last.axes, halfLength));
      }
    },

    dispose(): void {
      for (const object of [axisLines, systemX, systemY, systemZ]) {
        object.geometry.dispose();
        object.material.dispose();
      }
      pointMarks.geometry.dispose();
      pointMarks.material.dispose();
      last = null;
    },
  };
}
