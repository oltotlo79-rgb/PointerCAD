/**
 * 測定の結果の表示層(計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク31、
 * §0.a-0.29/0.30、§2.10)。
 *
 * 対応要件: FR-1102(測った値をその場に出し、モデルを変えるまで残す)、NFR-PF-1(60fps)、
 * NFR-UX-7。
 *
 * 出すものは 3 つだけ。
 * - **距離**: 測った 2 点を結ぶ線 1 本と、両端の小さな丸。
 * - **角度**: 頂から伸びる 2 本の線と、その間の弧(`MeasureAngleSpec`)。
 * - **値の札**: 定数サイズのスプライト 1 枚(`createReferenceLayer.ts` の名前の札と同じ作り)。
 *   面積・体積のように線を引けない測定は、札だけを `anchor` の位置へ出す。
 *
 * **毎コマ作り直さない。** 入れ物(線・弧・点・札)は最初に 1 組だけ作り、
 * `update` は同じ入れ物の中身(座標と描く範囲)を書き換えるだけにする。同じ測定を
 * 渡し直したときは何も触らない(`last === next` で早く返る。NFR-PF-1)。
 *
 * **色は `themeColors.ts` のトークンから読む。** ビューキューブの面に固定色を焼き込んで
 * テーマに追従しなかった失敗(docs/報告記録.md 2026-09-04 15:40)を繰り返さないため、
 * ここには 16 進の色を書かない(既定値の後退先は `themeColors.ts` の 1 か所)。
 *
 * **常時の描画ループは作らない**(docs/報告記録.md 2026-09-02 15:42)。札の大きさを
 * 画面上で一定に保つ `updateScreenScale` は、既に回っている描画(`createViewportScene` の
 * `drawScene`)の中から呼ばれるだけで、この場は自分で `requestAnimationFrame` を持たない。
 */

import type { Vec3 } from '@pointercad/model';
import * as THREE from 'three';

import type { LocalMeasureResult } from '../solid/measure.js';
import { labelWorldHeight } from './cameraMath.js';
import { cssColor, DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/* ---------------------------------------------------------------------------
 * 画面に出す測定 1 件
 * ------------------------------------------------------------------------- */

/**
 * 角度の描き方(頂・2 本の向き・弧の半径)。
 *
 * `LocalMeasureResult` は角度のとき `segment` を持たない(値は 2 つの向きから求まるので、
 * どこに線を引くかは測り方ではなく**見せ方**の話)。どの点を頂にしてどちらへ線を伸ばすかは
 * 選んだ面・辺から決まるので、組み立ては測定を作る側(タスク32)が行い、ここは
 * 受け取ったとおりに描く。
 */
export interface MeasureAngleSpec {
  /** 角の頂(2 本の線が出る点)。 */
  readonly apex: Vec3;
  /** 1 本目の向き(長さは問わない。長さ 0 なら描かない)。 */
  readonly from: Vec3;
  /** 2 本目の向き(同上)。 */
  readonly to: Vec3;
  /** 弧の半径(mm)。線の長さはこれに比例する。 */
  readonly radius: number;
}

/**
 * 画面に出している測定 1 件(ストアの `measurement`)。
 *
 * `result` はタスク30 の `measureLocally`(またはカーネルの返事を同じ形へ詰め替えたもの)、
 * `text` は `formatMeasure` の文字列。**この場は値を計算しない**(測る規則は
 * `solid/measure.ts` の 1 か所だけに置く)。
 */
export interface MeasurementState {
  /** 測った結果(種類・値・単位・線を引く 2 点)。 */
  readonly result: LocalMeasureResult;
  /** 値の札に出す文字(`formatMeasure(result)`)。 */
  readonly text: string;
  /** 角度の 2 本の線と弧。角度以外は null。 */
  readonly angle: MeasureAngleSpec | null;
  /** 線も角度も無い測定(面積・体積)で札を置く位置。無ければ札を出さない。 */
  readonly anchor: Vec3 | null;
}

/* ---------------------------------------------------------------------------
 * 見た目の数値
 * ------------------------------------------------------------------------- */

/**
 * 線の太さ(画素)。下書きの線(1.5)・案内線(1)より太くして、測った線が図形の線に
 * 紛れないようにする。太い線を描けない端末では 1 画素になる(`createSketchLayer.ts` と
 * 同じ事情で、WebGL の実装によっては `linewidth` が効かない)。
 */
const MEASURE_LINE_WIDTH_PIXELS = 2;

/** 端の丸の大きさ(画素)。スケッチの点(5)より少し大きく、拘束の印(16)よりは小さい。 */
const END_MARK_SIZE_PIXELS = 9;

/**
 * 弧の分割数。90 度で 32 分割なら 1 区間 2.8 度で、半径がどれだけ大きくても
 * 折れ線には見えない。分割を増やしても入れ物は同じ大きさのまま使い回す。
 */
export const MEASURE_ARC_SEGMENTS = 32;

/** 角度の 2 本の線の長さ(弧の半径に対する比)。弧より少し外へ出す。 */
const ANGLE_LEG_RATIO = 1.5;

/** 角度の札を置く位置(頂からの距離。弧の半径に対する比)。弧の少し外側。 */
const ANGLE_LABEL_RATIO = 1.15;

/**
 * 描く順。拘束の印(5)より手前に出す。測定は「いま知りたい値」なので、
 * 他の重ね描きに隠れると読めないため。深度は見ない(`depthTest: false`)ので
 * 前後はこの数だけで決まる(`createConstraintLayer.ts` と同じ流儀)。
 */
const MEASURE_RENDER_ORDER = 6;

/** 札の文字の大きさ(画素、等倍の画面での基準)と、札の内側の余白(画素)。 */
const LABEL_FONT_PIXELS = 22;
const LABEL_PADDING_PIXELS = 8;

/**
 * 札の高さを画面上でおよそ一定に保つ、目標の画素数。名前の札
 * (`createReferenceLayer.ts` の `LABEL_SCREEN_HEIGHT_PIXELS`)と同じ 13 画素にそろえ、
 * 画面の中で「3D に置いた文字」の大きさが 1 通りになるようにする。
 */
const LABEL_SCREEN_HEIGHT_PIXELS = 13;

/**
 * 札の絵を描く解像度の倍率の上限(`createReferenceLayer.ts` と同じ考え方)。
 * 高 DPI の画面でも文字がにじまないよう実寸より大きく描き、上限を設けて負荷を抑える。
 */
const MAX_LABEL_RESOLUTION_SCALE = 2;

/** 端の丸の絵の細かさ(表示の大きさに対する倍率)。`createConstraintLayer.ts` と同じ 2 倍。 */
const END_MARK_TEXTURE_SCALE = 2;

/** 線の入れ物の大きさ。距離は 1 本、角度は 2 本なので上限は 2 本。 */
const MAX_LINE_SEGMENTS = 2;
const FLOATS_PER_SEGMENT = 6;

/* ---------------------------------------------------------------------------
 * 座標の組み立て(純関数。three.js の入れ物には触らない)
 * ------------------------------------------------------------------------- */

function scaleFrom(origin: Vec3, direction: Vec3, length: number): Vec3 {
  return [
    origin[0] + direction[0] * length,
    origin[1] + direction[1] * length,
    origin[2] + direction[2] * length,
  ];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** 長さ 1 に揃える。長さが 0 のときは null(向きが決まらない)。 */
function unit(a: Vec3): Vec3 | null {
  const length = norm(a);
  return length === 0 ? null : [a[0] / length, a[1] / length, a[2] / length];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 弧を描くための平面の基底と開き。
 *
 * `u` は 1 本目の向き、`v` は 2 本目のうち `u` に直交する成分(グラム・シュミット)。
 * 2 本が平行・逆向きのときは平面が決まらないので null を返し、弧を描かない
 * (線 2 本と札だけになる)。角度は `atan2` で求める。`acos` は 0 度・180 度の近くで
 * 入力のわずかな誤差が角度へ大きく効くため(`solid/measure.ts` と同じ理由)。
 */
export function measureArcFrame(
  angle: MeasureAngleSpec,
): { readonly u: Vec3; readonly v: Vec3; readonly radians: number } | null {
  const u = unit(angle.from);
  const rawTo = unit(angle.to);
  if (u === null || rawTo === null || !Number.isFinite(angle.radius) || angle.radius <= 0) {
    return null;
  }
  // 2 本目のうち 1 本目に沿う成分(cos)と、直交する成分(sin の向き)へ分ける。
  const along = dot(rawTo, u);
  const perpendicular: Vec3 = [
    rawTo[0] - u[0] * along,
    rawTo[1] - u[1] * along,
    rawTo[2] - u[2] * along,
  ];
  const v = unit(perpendicular);
  if (v === null) {
    // 2 本が平行または逆向き。弧を描く平面が決まらない。
    return null;
  }
  return { u, v, radians: Math.atan2(norm(perpendicular), along) };
}

/** 測定 1 件を描くための座標一式。入れ物の大きさは測定に依らず一定(作り直さないため)。 */
export interface MeasureShapes {
  /** 線の座標(常に `MAX_LINE_SEGMENTS` 本ぶんの長さ)。 */
  readonly linePositions: Float32Array;
  /** 実際に描く線の本数(0〜2)。 */
  readonly lineCount: number;
  /** 弧の折れ線の座標(常に `MEASURE_ARC_SEGMENTS + 1` 点ぶんの長さ)。 */
  readonly arcPositions: Float32Array;
  /** 実際に描く弧の点の数(0 か `MEASURE_ARC_SEGMENTS + 1`)。 */
  readonly arcCount: number;
  /** 端の丸の座標(常に 2 点ぶんの長さ)。 */
  readonly endPositions: Float32Array;
  /** 実際に描く丸の数(0〜2)。 */
  readonly endCount: number;
  /** 値の札を置く位置。出さないときは null。 */
  readonly labelPosition: Vec3 | null;
}

const EMPTY_SHAPES: MeasureShapes = {
  linePositions: new Float32Array(MAX_LINE_SEGMENTS * FLOATS_PER_SEGMENT),
  lineCount: 0,
  arcPositions: new Float32Array((MEASURE_ARC_SEGMENTS + 1) * 3),
  arcCount: 0,
  endPositions: new Float32Array(6),
  endCount: 0,
  labelPosition: null,
};

/**
 * 測定 1 件から、線・弧・端の丸・札の座標を組み立てる(純関数)。
 *
 * 測定が null なら空(何も描かない)。距離は線 1 本と両端の丸、角度は線 2 本と弧と
 * 頂の丸、線も角度も無いもの(面積・体積)は `anchor` に札だけを出す。
 */
export function buildMeasureShapes(measurement: MeasurementState | null): MeasureShapes {
  if (measurement === null) {
    return EMPTY_SHAPES;
  }
  const linePositions = new Float32Array(MAX_LINE_SEGMENTS * FLOATS_PER_SEGMENT);
  const arcPositions = new Float32Array((MEASURE_ARC_SEGMENTS + 1) * 3);
  const endPositions = new Float32Array(6);

  const { segment } = measurement.result;
  if (segment !== null) {
    linePositions.set(segment[0], 0);
    linePositions.set(segment[1], 3);
    endPositions.set(segment[0], 0);
    endPositions.set(segment[1], 3);
    return {
      linePositions,
      lineCount: 1,
      arcPositions,
      arcCount: 0,
      endPositions,
      endCount: 2,
      // 札は 2 点の中点(線の真ん中)へ。
      labelPosition: [
        (segment[0][0] + segment[1][0]) / 2,
        (segment[0][1] + segment[1][1]) / 2,
        (segment[0][2] + segment[1][2]) / 2,
      ],
    };
  }

  const { angle } = measurement;
  if (angle !== null) {
    const frame = measureArcFrame(angle);
    const legLength = angle.radius * ANGLE_LEG_RATIO;
    const fromUnit = unit(angle.from);
    const toUnit = unit(angle.to);
    let lineCount = 0;
    if (fromUnit !== null) {
      linePositions.set(angle.apex, 0);
      linePositions.set(scaleFrom(angle.apex, fromUnit, legLength), 3);
      lineCount += 1;
    }
    if (toUnit !== null) {
      const offset = lineCount * FLOATS_PER_SEGMENT;
      linePositions.set(angle.apex, offset);
      linePositions.set(scaleFrom(angle.apex, toUnit, legLength), offset + 3);
      lineCount += 1;
    }
    // 頂に丸を 1 つ置く(どこの角を測ったかを示す)。
    endPositions.set(angle.apex, 0);

    if (frame === null) {
      return {
        linePositions,
        lineCount,
        arcPositions,
        arcCount: 0,
        endPositions,
        endCount: 1,
        labelPosition: angle.apex,
      };
    }
    for (let step = 0; step <= MEASURE_ARC_SEGMENTS; step += 1) {
      const theta = (frame.radians * step) / MEASURE_ARC_SEGMENTS;
      const cos = Math.cos(theta) * angle.radius;
      const sin = Math.sin(theta) * angle.radius;
      arcPositions[step * 3] = angle.apex[0] + frame.u[0] * cos + frame.v[0] * sin;
      arcPositions[step * 3 + 1] = angle.apex[1] + frame.u[1] * cos + frame.v[1] * sin;
      arcPositions[step * 3 + 2] = angle.apex[2] + frame.u[2] * cos + frame.v[2] * sin;
    }
    // 札は弧の真ん中の少し外側(2 本の線の間)。
    const half = frame.radians / 2;
    const cos = Math.cos(half) * angle.radius * ANGLE_LABEL_RATIO;
    const sin = Math.sin(half) * angle.radius * ANGLE_LABEL_RATIO;
    return {
      linePositions,
      lineCount,
      arcPositions,
      arcCount: MEASURE_ARC_SEGMENTS + 1,
      endPositions,
      endCount: 1,
      labelPosition: [
        angle.apex[0] + frame.u[0] * cos + frame.v[0] * sin,
        angle.apex[1] + frame.u[1] * cos + frame.v[1] * sin,
        angle.apex[2] + frame.u[2] * cos + frame.v[2] * sin,
      ],
    };
  }

  // 面積・体積など、線を引けない測定。札だけを置く(置く場所が無ければ何も出さない)。
  return {
    linePositions,
    lineCount: 0,
    arcPositions,
    arcCount: 0,
    endPositions,
    endCount: 0,
    labelPosition: measurement.anchor,
  };
}

/* ---------------------------------------------------------------------------
 * 絵(canvas)
 * ------------------------------------------------------------------------- */

/** 絵を描ける環境か(Node の検査環境・Worker には `document` が無い)。 */
function canDraw(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}

/** 札 1 枚。文字が同じなら作り直さない。 */
interface ValueTag {
  readonly texture: THREE.CanvasTexture;
  readonly text: string;
  readonly color: number;
  /** 画面上の幅と高さの比(横長の札がつぶれないようにする)。 */
  readonly aspect: number;
}

/**
 * 値の文字を描いた小さな絵を作る(`createReferenceLayer.ts` の名前の札と同じ作り)。
 * 絵を描けない環境では null を返し、札を出さずに済ませる(線と丸は出る)。
 */
function createValueTag(text: string, color: number, resolutionScale: number): ValueTag | null {
  if (!canDraw()) {
    return null;
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }
  const fontPixels = LABEL_FONT_PIXELS * resolutionScale;
  const paddingPixels = LABEL_PADDING_PIXELS * resolutionScale;
  const font = `${String(fontPixels)}px sans-serif`;
  context.font = font;
  const width = Math.ceil(context.measureText(text).width) + paddingPixels * 2;
  const height = fontPixels + paddingPixels * 2;
  canvas.width = width;
  canvas.height = height;
  // 大きさを変えたので設定はやり直す(canvas の決まり)。
  context.font = font;
  context.textBaseline = 'middle';
  const fill = cssColor(color);
  context.fillStyle = fill;
  context.strokeStyle = fill;
  // 細い書体でも縮めたときに消えないよう、同じ色で縁取って少し太らせる
  // (`createConstraintLayer.ts` の記号と同じ手当て)。
  context.lineWidth = resolutionScale;
  context.lineJoin = 'round';
  context.strokeText(text, paddingPixels, height / 2);
  context.fillText(text, paddingPixels, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  // 文字の色をそのまま出す。sRGB だと言わないと three が「線形の値」として扱い、
  // 画面へ出すときに明るく持ち上げてしまう(テーマごとに決めた明度差が崩れる)。
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, text, color, aspect: width / height };
}

/**
 * 端の丸の絵(塗りつぶした円)。`PointsMaterial` の既定は四角なので、丸くするには
 * 絵を貼るしかない。絵を描けない環境では null を返し、四角のまま出す。
 *
 * **色は焼き込まない**(白い円にする)。`PointsMaterial` は材質の色と絵を掛け合わせるので、
 * 白のままにしておけば材質の色がそのまま出て、テーマが変わっても絵を作り直さずに済む。
 */
function createDotTexture(): THREE.CanvasTexture | null {
  if (!canDraw()) {
    return null;
  }
  const size = Math.round(END_MARK_SIZE_PIXELS * END_MARK_TEXTURE_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }
  context.fillStyle = '#ffffff';
  context.beginPath();
  // 縁が絵の端で切れないよう、半径を半画素ぶん内側にする。
  context.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/* ---------------------------------------------------------------------------
 * 層
 * ------------------------------------------------------------------------- */

export interface MeasureLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /** 出す測定を差し替える。`null` で消す。同じものを渡し直したときは何も触らない。 */
  update(measurement: MeasurementState | null): void;
  /** 表示テーマの色を反映する(FR-908)。色を焼き込んだ絵(札・丸)は作り直す。 */
  setThemeColors(colors: ThemeColors): void;
  /**
   * 値の札が画面上でおよそ一定の大きさ(約 13px)に見えるよう、カメラ距離・画面の高さ・
   * UI 拡大率から札のワールド高さを計算し直す(`createReferenceLayer.ts` と同じ)。
   * 描画のたびに呼ばれる想定で、変わらなければ何もしない。
   */
  updateScreenScale(distance: number, viewportHeightPixels: number, uiScalePercent: number): void;
  dispose(): void;
}

export function createMeasureLayer(): MeasureLayer {
  const group = new THREE.Group();

  /* 線(距離 1 本 / 角度 2 本)。中身だけを書き換えるので、入れ物は一度だけ作る。 */
  const linePositions = new Float32Array(MAX_LINE_SEGMENTS * FLOATS_PER_SEGMENT);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color: DEFAULT_THEME_COLORS.measure,
    linewidth: MEASURE_LINE_WIDTH_PIXELS,
    // 面より後に描くための「半透明」扱い(透け具合は 1 のままなので色は変わらない)。
    transparent: true,
    // 立体の奥にある測定線も見えるようにする(計画書タスク31 の手順1)。
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.renderOrder = MEASURE_RENDER_ORDER;
  lines.visible = false;
  // 画面の外まで伸びうる線なので、包む球で視錐台の外と判定されて消えないようにする。
  lines.frustumCulled = false;
  group.add(lines);

  /* 弧(角度)。折れ線 1 本なので `Line`(`LineSegments` ではない)で描く。 */
  const arcPositions = new Float32Array((MEASURE_ARC_SEGMENTS + 1) * 3);
  const arcGeometry = new THREE.BufferGeometry();
  arcGeometry.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
  const arc = new THREE.Line(arcGeometry, lineMaterial);
  arc.renderOrder = MEASURE_RENDER_ORDER;
  arc.visible = false;
  arc.frustumCulled = false;
  group.add(arc);

  /* 端の小さな丸。大きさは画素で決める(寄っても引いても同じ大きさ)。 */
  const endPositions = new Float32Array(6);
  const endGeometry = new THREE.BufferGeometry();
  endGeometry.setAttribute('position', new THREE.BufferAttribute(endPositions, 3));
  const endMaterial = new THREE.PointsMaterial({
    color: DEFAULT_THEME_COLORS.measure,
    size: END_MARK_SIZE_PIXELS,
    sizeAttenuation: false,
    transparent: true,
    // 丸の外側(透明な地)を描かない。四角く欠けて見えるのを防ぐ。
    alphaTest: 0.1,
    depthTest: false,
    depthWrite: false,
  });
  const endMarks = new THREE.Points(endGeometry, endMaterial);
  endMarks.renderOrder = MEASURE_RENDER_ORDER;
  endMarks.visible = false;
  endMarks.frustumCulled = false;
  group.add(endMarks);

  /* 値の札(定数サイズのスプライト)。 */
  const labelMaterial = new THREE.SpriteMaterial({ transparent: true, depthTest: false });
  const label = new THREE.Sprite(labelMaterial);
  label.renderOrder = MEASURE_RENDER_ORDER;
  label.visible = false;
  // 札の下端を測った場所に合わせ、線や角の上へ重ならないようにする。
  label.center.set(0.5, 0);
  group.add(label);

  let colors: ThemeColors = DEFAULT_THEME_COLORS;
  let last: MeasurementState | null = null;
  let tag: ValueTag | null = null;
  // 丸の絵は色を持たない(材質の色が掛かる)ので、作るのは 1 回だけ。
  const dotTexture: THREE.CanvasTexture | null = createDotTexture();
  if (dotTexture !== null) {
    endMaterial.map = dotTexture;
  }
  // 高 DPI 画面でも文字がにじまないよう、canvas の解像度をここで 1 回だけ決める
  // (`createReferenceLayer.ts` と同じ考え方)。
  const resolutionScale = Math.min(
    typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1,
    MAX_LABEL_RESOLUTION_SCALE,
  );
  /** 札の高さ(mm)。最初の描画で `updateScreenScale` が決め直す。 */
  let tagWorldHeight = 2;

  function applyTagScale(): void {
    if (tag === null) {
      return;
    }
    label.scale.set(tagWorldHeight * tag.aspect, tagWorldHeight, 1);
  }

  function disposeTag(): void {
    if (tag === null) {
      return;
    }
    labelMaterial.map = null;
    tag.texture.dispose();
    tag = null;
  }

  /** 札の絵を、いまの文字と色で用意する(同じなら作り直さない)。 */
  function refreshTag(text: string | null): void {
    if (text === null) {
      disposeTag();
      label.visible = false;
      return;
    }
    if (tag !== null && tag.text === text && tag.color === colors.measure) {
      return;
    }
    disposeTag();
    const created = createValueTag(text, colors.measure, resolutionScale);
    if (created === null) {
      // 絵を描けない環境。札は出さないが、線と丸はそのまま出る。
      label.visible = false;
      return;
    }
    tag = created;
    labelMaterial.map = created.texture;
    labelMaterial.needsUpdate = true;
    applyTagScale();
  }

  /** いまの測定を、同じ入れ物の中身として書き写す(部品は作り直さない)。 */
  function apply(measurement: MeasurementState | null): void {
    const shapes = buildMeasureShapes(measurement);

    linePositions.set(shapes.linePositions);
    lineGeometry.getAttribute('position').needsUpdate = true;
    lineGeometry.setDrawRange(0, shapes.lineCount * 2);
    lines.visible = shapes.lineCount > 0;

    arcPositions.set(shapes.arcPositions);
    arcGeometry.getAttribute('position').needsUpdate = true;
    arcGeometry.setDrawRange(0, shapes.arcCount);
    arc.visible = shapes.arcCount > 0;

    endPositions.set(shapes.endPositions);
    endGeometry.getAttribute('position').needsUpdate = true;
    endGeometry.setDrawRange(0, shapes.endCount);
    endMarks.visible = shapes.endCount > 0;

    refreshTag(measurement === null || shapes.labelPosition === null ? null : measurement.text);
    if (shapes.labelPosition !== null && tag !== null) {
      label.position.set(
        shapes.labelPosition[0],
        shapes.labelPosition[1],
        shapes.labelPosition[2],
      );
      label.visible = true;
    } else {
      label.visible = false;
    }
  }

  return {
    group,

    update(measurement): void {
      if (measurement === last) {
        // 同じ測定を渡し直しただけ。並びも札も触らない(NFR-PF-1)。
        return;
      }
      last = measurement;
      apply(measurement);
    },

    setThemeColors(next): void {
      if (next.measure === colors.measure) {
        colors = next;
        return;
      }
      colors = next;
      lineMaterial.color.setHex(colors.measure);
      endMaterial.color.setHex(colors.measure);
      // 札だけは色を絵へ焼き込んでいるので作り直す(丸は材質の色が掛かるのでそのまま)。
      if (last !== null) {
        refreshTag(buildMeasureShapes(last).labelPosition === null ? null : last.text);
      }
    },

    updateScreenScale(distance, viewportHeightPixels, uiScalePercent): void {
      const nextHeight = labelWorldHeight(
        LABEL_SCREEN_HEIGHT_PIXELS,
        distance,
        viewportHeightPixels,
        uiScalePercent,
      );
      if (nextHeight === tagWorldHeight) {
        return;
      }
      tagWorldHeight = nextHeight;
      applyTagScale();
    },

    dispose(): void {
      last = null;
      disposeTag();
      dotTexture?.dispose();
      lineGeometry.dispose();
      arcGeometry.dispose();
      endGeometry.dispose();
      lineMaterial.dispose();
      endMaterial.dispose();
      labelMaterial.dispose();
    },
  };
}
