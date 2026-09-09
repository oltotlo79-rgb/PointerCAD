/** カメラの位置を、注視点まわりの球面座標で表す。単位は mm とラジアン。 */
export interface OrbitState {
  /** 方位角。+X から +Y へ向かう向きが正。 */
  readonly azimuth: number;
  /** 仰角。XY 平面が 0、+Z が正。 */
  readonly elevation: number;
  /** 注視点からの距離(mm)。 */
  readonly distance: number;
  /** 注視点の座標(mm)。 */
  readonly target: readonly [number, number, number];
  /** 名前付き視点が持つ上向きとレンズのズーム。既存の視点はZ上・1倍。 */
  readonly up?: readonly [number, number, number];
  readonly zoom?: number;
}

/** 真上・真下でカメラの上方向が反転しないよう、仰角にわずかな余裕を残す。 */
export const MAX_ELEVATION = Math.PI / 2 - 1e-4;
export const MIN_DISTANCE = 0.1;
export const MAX_DISTANCE = 100_000;

/** 1 ピクセルのドラッグで回る角度(ラジアン)。 */
export const ORBIT_RADIANS_PER_PIXEL = 0.008;
/** ホイール 1 段(deltaY = 100)あたりの拡大率。 */
export const ZOOM_FACTOR_PER_NOTCH = 1.1;
/** 透視投影の垂直画角(ラジアン)。 */
export const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;

/**
 * ホーム視点は等角(斜め上)から見る(FR-108)。**前・上・右の 3 面が見える向き**にする。
 *
 * 利用者の指示 2026-09-06「最初の表示状態で上、右、後が見えた方向に待っているが
 * 初期状態は前と上と左右どちらかが見えた状態がいい」。左右は右を採る(多くの CAD の既定)。
 *
 * PointerCAD は Z が上で、面の向きはビューキューブの割り当て(`viewcube/viewCubeMath.ts` の
 * `FACE_REGIONS`)どおり **前 = −Y、右 = +X、上 = +Z**。方位角 +45°(2026-09-06 以前の既定)は
 * カメラを (+X, +Y, +Z) へ置くので、見えるのは右・**後ろ**・上の 3 面だった。方位角を −45° に
 * すると (+X, −Y, +Z) から見ることになり、前・右・上の 3 面が見える。
 * **仰角と距離は変えていない**——見える面の組み合わせだけを変えている。
 *
 * この 1 つの定数が、起動直後(`attachCameraControls` の初期値)・「視点を戻す」(Home キーと
 * `goHome`)・ビューポートの格子の初期の刻み(`createViewportScene`)の全部を決める。
 * P6 の名前付きビューと 4 分割表示(FR-113)もここを参照する。
 */
export const HOME_ORBIT: OrbitState = {
  azimuth: -Math.PI / 4,
  elevation: Math.atan(Math.SQRT1_2),
  distance: 200,
  target: [0, 0, 0],
};

/**
 * ホーム視点で見えている 3 面の法線(前・上・右)。既定の視点が「利用者へ向く面 = 前」を
 * 見せていることを検査から確かめるために置く(利用者の指示 2026-09-06)。
 *
 * `viewcube/viewCubeMath.ts` の `FACE_REGIONS` の front / top / right と同じ向き。
 * ある面が見えているかどうかは「面の法線と視線の内積が負」(法線がカメラを向いている)で決まる。
 */
export const HOME_VISIBLE_FACE_NORMALS = {
  front: [0, -1, 0],
  top: [0, 0, 1],
  right: [1, 0, 0],
} as const satisfies Record<string, readonly [number, number, number]>;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 中ボタンのドラッグで視点を回す(FR-101)。 */
export function orbit(state: OrbitState, deltaXPixels: number, deltaYPixels: number): OrbitState {
  return {
    ...state,
    azimuth: state.azimuth - deltaXPixels * ORBIT_RADIANS_PER_PIXEL,
    elevation: clamp(
      state.elevation + deltaYPixels * ORBIT_RADIANS_PER_PIXEL,
      -MAX_ELEVATION,
      MAX_ELEVATION,
    ),
  };
}

/** ホイールで拡大・縮小する(FR-101)。deltaY が正なら遠ざかる。 */
export function zoom(state: OrbitState, wheelDeltaY: number): OrbitState {
  const notches = wheelDeltaY / 100;
  return {
    ...state,
    distance: clamp(
      state.distance * Math.pow(ZOOM_FACTOR_PER_NOTCH, notches),
      MIN_DISTANCE,
      MAX_DISTANCE,
    ),
  };
}

/**
 * カメラから注視点へ向かう単位ベクトル(視線の向き)。Z 軸が上の球面座標から作る。
 *
 * 「視点に最も近い作図面」(`useAppStore.ts` の `workPlaneForOrbit`)と、3D スケッチで
 * 押した場所に置く面(`sketch/freeSketch.ts` の `freeClickPlane`、FR-330)が共有する。
 * 同じ式を 2 か所に書かないよう、カメラの幾何を持つここ 1 か所に置く。
 */
export function viewDirection(state: OrbitState): [number, number, number] {
  const horizontal = Math.cos(state.elevation);
  return [
    -horizontal * Math.cos(state.azimuth),
    -horizontal * Math.sin(state.azimuth),
    -Math.sin(state.elevation),
  ];
}

/** カメラの位置(ワールド座標)。Z 軸が上。 */
export function cameraPosition(state: OrbitState): [number, number, number] {
  const horizontal = state.distance * Math.cos(state.elevation);
  return [
    state.target[0] + horizontal * Math.cos(state.azimuth),
    state.target[1] + horizontal * Math.sin(state.azimuth),
    state.target[2] + state.distance * Math.sin(state.elevation),
  ];
}

/** 画面 1 ピクセルが注視点の面上で何 mm に相当するか。 */
export function worldUnitsPerPixel(distance: number, viewportHeightPixels: number): number {
  return (2 * distance * Math.tan(VERTICAL_FIELD_OF_VIEW / 2)) / viewportHeightPixels;
}

/** Shift+中ボタンのドラッグで平行移動する(FR-101)。掴んだ点が指に追従する量だけ動かす。 */
export function pan(
  state: OrbitState,
  deltaXPixels: number,
  deltaYPixels: number,
  viewportHeightPixels: number,
): OrbitState {
  const scale = worldUnitsPerPixel(state.distance, viewportHeightPixels) / (state.zoom ?? 1);

  // 画面右方向のワールドベクトル(Z 軸が上なので水平面内で方位角に直交する)。
  let right: [number, number, number] = [-Math.sin(state.azimuth), Math.cos(state.azimuth), 0];
  // 画面上方向のワールドベクトル。
  let up: [number, number, number] = [
    -Math.sin(state.elevation) * Math.cos(state.azimuth),
    -Math.sin(state.elevation) * Math.sin(state.azimuth),
    Math.cos(state.elevation),
  ];

  if (state.up !== undefined) {
    const direction = viewDirection(state), requested = state.up;
    const cross = [direction[1] * requested[2] - direction[2] * requested[1],
      direction[2] * requested[0] - direction[0] * requested[2],
      direction[0] * requested[1] - direction[1] * requested[0]];
    const length = Math.hypot(...cross);
    if (length > 1e-10) {
      right = [cross[0] / length, cross[1] / length, cross[2] / length];
      up = [right[1] * direction[2] - right[2] * direction[1],
        right[2] * direction[0] - right[0] * direction[2], right[0] * direction[1] - right[1] * direction[0]];
    }
  }

  return {
    ...state,
    target: [
      state.target[0] - (right[0] * deltaXPixels - up[0] * deltaYPixels) * scale,
      state.target[1] - (right[1] * deltaXPixels - up[1] * deltaYPixels) * scale,
      state.target[2] - (right[2] * deltaXPixels - up[2] * deltaYPixels) * scale,
    ],
  };
}

/** 平行投影のときの表示範囲の高さ(mm)。透視投影と見た目の大きさを合わせる(FR-102)。 */
export function orthographicFrustumHeight(distance: number): number {
  return 2 * distance * Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
}

/**
 * 名前の札(基準軸・座標系、`createReferenceLayer.ts`)を画面上でおよそ一定の大きさに保つための、
 * その時点のワールド単位での高さ(mm、P4 仕上げ (f))。
 *
 * 札は world 単位の大きさの板(スプライト)なので、なにもしなければカメラに近づくほど
 * 画面上で大きく見える(統括の目視 2026-09-04「札が画面幅の 1/6 ほどに巨大化する」)。
 * `worldUnitsPerPixel` は `orthographicFrustumHeight` と同じ式を使っているため、
 * 透視投影・平行投影のどちらでも同じ計算で画面上の大きさをそろえられる。
 *
 * `uiScalePercent`(`DisplaySettings.uiScale`、90〜150)ぶんも大きさへ反映し、
 * UI 全体を拡大しているときは 3D の札も見やすいまま大きくする。
 */
export function labelWorldHeight(
  screenPixels: number,
  distance: number,
  viewportHeightPixels: number,
  uiScalePercent: number,
): number {
  return screenPixels * (uiScalePercent / 100) * worldUnitsPerPixel(distance, viewportHeightPixels);
}
