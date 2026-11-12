import * as THREE from 'three';
import { axisLength, gridExtent, gridFadeOpacity, isMajorGridLine } from './gridMath.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';
import type { createSceneConstruction, ViewportSceneLayers } from './viewportSceneResources.js';

/*
 * createViewportScene の方眼と XYZ 軸(FR-104)。線の色はテーマから頂点へ焼き込むので、間隔か
 * テーマが変わったときだけ形を作り直す。形の取得と返却は構築中の台帳(createSceneConstruction)を
 * 通し、作図面の矩形・基準軸・案内線の広がりも方眼の間隔に合わせてここでそろえる。
 */

/*
 * 方眼の色(副線は地から浮きすぎない濃さ、主線はその一段上)と軸の色(X 赤・Y 緑・Z 青)は
 * テーマが決める(FR-104、FR-908)。明るいテーマでは、地が明るいぶん線を濃くする。
 * ビューポートの地そのものは canvas の下の CSS(.pcad-viewport の縦グラデーション)なので、
 * ここでは扱わない。
 */

/** 原点を通る 3 本の軸の向き。色はテーマから取る。 */
const AXIS_DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** 軸 1 本ぶんの色を、向きの並びと同じ順で取り出す。 */
function axisColorsOf(colors: ThemeColors): readonly number[] {
  return [colors.axisX, colors.axisY, colors.axisZ];
}

/** 軸 1 本を何本の線分に割るか。頂点ごとの薄まりを線の途中でも効かせるために分ける。 */
const AXIS_SEGMENTS_PER_SIDE = 40;

/**
 * 基準軸(FR-329)を出す長さの、方眼の広がりに対する割合。
 * 方眼と同じ長さだと方眼の線に紛れるので、はっきり内側で終わるようにする。
 */
const REFERENCE_AXIS_EXTENT_RATIO = 0.55;

/** 位置(3 個)と色+不透明度(4 個)を並べて貯める、線分列の下書き。 */
interface LineBuffer {
  readonly positions: number[];
  readonly colors: number[];
}

function createLineBuffer(): LineBuffer {
  return { positions: [], colors: [] };
}

/**
 * 線分を 1 本足す。両端の不透明度は原点からの距離で決め、遠いほど薄くする。
 * 端点どうしの間は GPU が補間するので、長い線は呼び出し側で細かく割って渡す。
 */
function pushFadedSegment(
  buffer: LineBuffer,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  color: THREE.Color,
  extent: number,
): void {
  for (const point of [from, to]) {
    buffer.positions.push(point[0], point[1], point[2]);
    buffer.colors.push(
      color.r,
      color.g,
      color.b,
      gridFadeOpacity(Math.hypot(point[0], point[1], point[2]), extent),
    );
  }
}

function toLineGeometry(buffer: LineBuffer, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  acquire?.(geometry);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3));
  // 4 個組にすると three.js が頂点ごとの不透明度として扱う(USE_COLOR_ALPHA)。
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(buffer.colors, 4));
  return geometry;
}

/**
 * 方眼(主線と副線)の線分列を作る(FR-104)。
 *
 * 原点を通る 2 本は軸として別に描くのでここでは引かない。同じ位置に 2 本重ねると
 * 深度が競って縞模様になるため、重ねない作りにして縞模様そのものを起こさせない。
 */
function buildGridGeometry(spacing: number, colors: ThemeColors, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const extent = gridExtent(spacing);
  const halfCount = Math.round(extent / spacing);
  const minorColor = new THREE.Color(colors.gridMinor);
  const majorColor = new THREE.Color(colors.gridMajor);
  const buffer = createLineBuffer();

  for (let line = -halfCount; line <= halfCount; line += 1) {
    if (line === 0) {
      continue;
    }
    const color = isMajorGridLine(line) ? majorColor : minorColor;
    const offset = line * spacing;
    for (let cell = -halfCount; cell < halfCount; cell += 1) {
      const from = cell * spacing;
      const to = (cell + 1) * spacing;
      pushFadedSegment(buffer, [from, offset, 0], [to, offset, 0], color, extent);
      pushFadedSegment(buffer, [offset, from, 0], [offset, to, 0], color, extent);
    }
  }

  return toLineGeometry(buffer, acquire);
}

/** 原点を通る XYZ 軸の線分列を作る(FR-104)。方眼と同じ薄まり方をさせる。 */
function buildAxisGeometry(length: number, colors: ThemeColors, acquire?: (geometry: THREE.BufferGeometry) => void): THREE.BufferGeometry {
  const buffer = createLineBuffer();
  const axisColors = axisColorsOf(colors);

  for (let axis = 0; axis < AXIS_DIRECTIONS.length; axis += 1) {
    const direction = AXIS_DIRECTIONS[axis];
    const color = new THREE.Color(axisColors[axis]);
    for (let step = -AXIS_SEGMENTS_PER_SIDE; step < AXIS_SEGMENTS_PER_SIDE; step += 1) {
      const from = (step / AXIS_SEGMENTS_PER_SIDE) * length;
      const to = ((step + 1) / AXIS_SEGMENTS_PER_SIDE) * length;
      pushFadedSegment(
        buffer,
        [direction[0] * from, direction[1] * from, direction[2] * from],
        [direction[0] * to, direction[1] * to, direction[2] * to],
        color,
        length,
      );
    }
  }

  return toLineGeometry(buffer, acquire);
}

type SceneConstruction = Pick<ReturnType<typeof createSceneConstruction>, 'acquired' | 'returnAcquired'>;
type GridLayers = Pick<ViewportSceneLayers, 'grid' | 'axisLines' | 'sketchLayer' | 'referenceLayer' | 'trackingLayer'>;

/**
 * 方眼と軸の持ち主を作り、最初の間隔で 1 回組み立てる。返すのは間隔の読み出し・作り直し・テーマの
 * 差し替え。テーマの色を他の層へ配るのは呼び出し側(applySceneThemeColors)。
 */
export function createSceneGrid(layers: GridLayers, construction: SceneConstruction, initialSpacing: number) {
  const { grid, axisLines, sketchLayer, referenceLayer, trackingLayer } = layers;
  const { acquired, returnAcquired } = construction;
  function acquireLineGeometry(geometry: THREE.BufferGeometry): void { acquired('line geometry', geometry); }
  /** いま効いているテーマの色。`setColors` が来るまでは既定(ダーク)。 */
  let colors: ThemeColors = DEFAULT_THEME_COLORS;
  let currentSpacing = 0;

  /**
   * 方眼と XYZ 軸を作り直す(FR-104)。間隔が変わったときと、テーマが変わったときだけ呼ぶ
   * (色は頂点ごとの並びへ焼き込むので、テーマの切替では作り直すしかない。
   * 描画のたびには呼ばれないので NFR-PF-1 に触らない)。
   */
  function rebuild(spacing: number): void {
    returnAcquired(grid.geometry);
    grid.geometry = buildGridGeometry(spacing, colors, acquireLineGeometry);
    returnAcquired(axisLines.geometry);
    axisLines.geometry = buildAxisGeometry(axisLength(spacing), colors, acquireLineGeometry);
    // 作図面の矩形は方眼と同じ広がりにする。
    sketchLayer.setWorkPlaneExtent(gridExtent(spacing));
    // 基準軸は方眼より**短く**する。
    // 方眼と同じ長さだと方眼の線と見分けが付かず、どこまでが軸なのか分からなかった。
    referenceLayer.setAxisHalfLength(gridExtent(spacing) * REFERENCE_AXIS_EXTENT_RATIO);
    // 案内線は方眼と同じ広がりまで伸ばす(視野のおよそ 2 倍なので「画面いっぱい」になる)。
    trackingLayer.setHalfLength(gridExtent(spacing));
    currentSpacing = spacing;
  }
  rebuild(initialSpacing);

  return {
    rebuild,
    spacing: (): number => currentSpacing,
    /** 方眼と軸は頂点ごとの色を持つので、いまの間隔のまま組み立て直す。 */
    setColors(next: ThemeColors): void {
      colors = next;
      rebuild(currentSpacing);
    },
  };
}
