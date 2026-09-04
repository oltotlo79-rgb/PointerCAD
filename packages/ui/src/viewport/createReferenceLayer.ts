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

import { labelWorldHeight } from './cameraMath.js';
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
  /**
   * 名前の札(基準軸・座標系)が画面上でおよそ一定の大きさ(約 13px)に見えるよう、
   * カメラ距離・画面(canvas)の高さ・UI 拡大率から札のワールド高さを計算し直す
   * (P4 仕上げ (f))。視点操作(ズーム)のたびに毎描画で呼ぶ想定。
   */
  updateScreenScale(distance: number, viewportHeightPixels: number, uiScalePercent: number): void;
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

/* ---------------------------------------------------------------------------
 * 名前の札(P4 タスク33、タスク9・13 の申し送り「基準軸が方眼と同じ長さで見分けにくい」)
 * ------------------------------------------------------------------------- */

/** 札の文字の大きさ(画素、等倍の画面での基準)と、札の内側の余白(画素)。 */
const LABEL_FONT_PIXELS = 22;
const LABEL_PADDING_PIXELS = 8;

/**
 * 札の高さを画面上でおよそ一定に保つ、目標の画素数(P4 仕上げ (f)、
 * 統括の目視 2026-09-04「札が画面幅の 1/6 ほどに巨大化する」への対応)。
 * 12〜14px 相当という指示のうち中央の値を採る。
 */
const LABEL_SCREEN_HEIGHT_PIXELS = 13;

/**
 * canvas に文字を描く解像度の倍率の上限。高 DPI 画面(devicePixelRatio が高い、
 * または OS の拡大率が高い)でも文字がにじまないよう、画面の解像度に応じて
 * canvas を実寸より大きく描く(`createViewportScene.ts` の `MAX_PIXEL_RATIO` と同じ考え方。
 * 上限を設けるのはメモリと描画負荷を抑えるため)。
 *
 * 画面上の大きさ(ワールド単位の高さ)はカメラ距離から毎描画で計算し直す別の仕組みなので、
 * ズームでは canvas を作り直さない(NFR-PF-1)。ここは「1 画素あたり何回描くか」だけを決める。
 */
const MAX_LABEL_RESOLUTION_SCALE = 2;

/** 札を軸の端から少し内側へ寄せる割合(端に置くと方眼の外へはみ出して見えるため)。 */
const LABEL_AXIS_POSITION_RATIO = 0.92;

/** 札 1 枚。名前が同じなら作り直さない。 */
interface NameTag {
  readonly sprite: THREE.Sprite;
  readonly texture: THREE.CanvasTexture;
  readonly text: string;
  /** 画面上の幅と高さの比(横長の札がつぶれないようにする)。 */
  readonly aspect: number;
}

/**
 * 文字を描いた小さな絵を作り、札にする。DOM の要素を画面に重ねる方法もあるが、
 * 視点が動くたびに位置を計算し直す仕掛けが要る。札は 3D の中に置いてしまうほうが、
 * 描画のたびに three.js が位置を合わせてくれて配線が増えない。
 *
 * `resolutionScale` は canvas の画素数だけを底上げする(表示上の大きさ・縦横比は変えない)。
 * 高 DPI の画面でも輪郭がにじまないようにするため(P4 仕上げ (f))。
 */
function createNameTag(text: string, color: number, resolutionScale: number): NameTag | null {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) {
    // 絵を描けない環境(検査用の見えない画面など)では札を出さない。線と点は出る。
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
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  context.fillText(text, paddingPixels, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.renderOrder = REFERENCE_RENDER_ORDER;
  return { sprite, texture, text, aspect: width / height };
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

  /** 名前の札の入れ物。名前が変わったときだけ作り直す(NFR-PF-1)。 */
  const tagGroup = new THREE.Group();
  group.add(tagGroup);
  const tags = new Map<string, NameTag>();

  let halfLength = DEFAULT_AXIS_HALF_LENGTH_MM;
  let last: ResolvedReferences | null = null;
  // 高 DPI 画面でも文字がにじまないよう、canvas の解像度をここで 1 回だけ決める
  // (devicePixelRatio が変わることは実運用ではまれで、`MAX_PIXEL_RATIO` と同じ考え方)。
  const resolutionScale = Math.min(
    typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1,
    MAX_LABEL_RESOLUTION_SCALE,
  );
  /**
   * 札の高さ(mm)。カメラ距離・画面の高さ・UI 拡大率から毎描画で計算し直す
   * (`updateScreenScale`、P4 仕上げ (f))。ここでの初期値は最初の描画までの仮の値。
   */
  let tagWorldHeight = DEFAULT_AXIS_HALF_LENGTH_MM * 0.02;

  /** いま出ている札すべてに、いまの `tagWorldHeight` を反映する。 */
  function applyTagScale(): void {
    for (const tag of tags.values()) {
      tag.sprite.scale.set(tagWorldHeight * tag.aspect, tagWorldHeight, 1);
    }
  }

  /** 札を 1 枚出す(すでに同じ文字の札があれば置き直すだけ)。 */
  function placeTag(featureId: string, text: string, position: Vec3, used: Set<string>): void {
    used.add(featureId);
    let tag = tags.get(featureId);
    if (tag === undefined || tag.text !== text) {
      if (tag !== undefined) {
        tagGroup.remove(tag.sprite);
        tag.texture.dispose();
        tag.sprite.material.dispose();
        tags.delete(featureId);
      }
      const created = createNameTag(text, DEFAULT_THEME_COLORS.sketchCurve, resolutionScale);
      if (created === null) {
        return;
      }
      tagGroup.add(created.sprite);
      tags.set(featureId, created);
      tag = created;
    }
    tag.sprite.position.set(position[0], position[1], position[2]);
    tag.sprite.scale.set(tagWorldHeight * tag.aspect, tagWorldHeight, 1);
  }

  /** いま出していない札を片付ける。 */
  function pruneTags(used: ReadonlySet<string>): void {
    for (const [featureId, tag] of [...tags]) {
      if (used.has(featureId)) {
        continue;
      }
      tagGroup.remove(tag.sprite);
      tag.texture.dispose();
      tag.sprite.material.dispose();
      tags.delete(featureId);
    }
  }

  /**
   * 名前の札を出し直す(FR-329、P4 タスク33)。
   *
   * 札を出すのは**軸と座標系だけ**にする。基準点は「どれがどれか」を木で選べば分かるうえ、
   * 平面や軸を決めるために同じ場所へ重なって置かれることが多く、札を出すと文字どうしが
   * 重なって却って読めなくなる(実測、2026-09-04)。軸は端の少し内側、座標系は
   * 矢印の先の高さへ置く。**画面に出していないもの(`visible: false`)には札を出さない。**
   */
  function applyTags(references: ResolvedReferences): void {
    const used = new Set<string>();
    for (const axis of references.axes) {
      if (!axis.visible) {
        continue;
      }
      const reach = halfLength * LABEL_AXIS_POSITION_RATIO;
      placeTag(axis.featureId, axis.name, [
        axis.origin[0] + axis.direction[0] * reach,
        axis.origin[1] + axis.direction[1] * reach,
        axis.origin[2] + axis.direction[2] * reach,
      ], used);
    }
    for (const system of references.coordinateSystems) {
      if (!system.visible) {
        continue;
      }
      // 原点の真上ではなく Z 軸の矢印の先へ置き、3 本の矢印と重ならないようにする。
      placeTag(system.featureId, system.name, [
        system.origin[0] + system.zAxis[0] * COORDINATE_SYSTEM_ARROW_MM,
        system.origin[1] + system.zAxis[1] * COORDINATE_SYSTEM_ARROW_MM,
        system.origin[2] + system.zAxis[2] * COORDINATE_SYSTEM_ARROW_MM,
      ], used);
    }
    pruneTags(used);
  }

  function apply(references: ResolvedReferences): void {
    setPositions(axisLines, buildAxisPositions(references.axes, halfLength));
    setPositions(pointMarks, buildPointPositions(references.points));
    setPositions(systemX, buildCoordinateSystemPositions(references.coordinateSystems, 'x'));
    setPositions(systemY, buildCoordinateSystemPositions(references.coordinateSystems, 'y'));
    setPositions(systemZ, buildCoordinateSystemPositions(references.coordinateSystems, 'z'));
    applyTags(references);
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
        // 長さだけが変わったので、軸の線と札の位置だけを引き直す
        // (札の大きさは軸の長さと切り離してある。`updateScreenScale` が別に決める)。
        setPositions(axisLines, buildAxisPositions(last.axes, halfLength));
        applyTags(last);
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
      for (const object of [axisLines, systemX, systemY, systemZ]) {
        object.geometry.dispose();
        object.material.dispose();
      }
      pointMarks.geometry.dispose();
      pointMarks.material.dispose();
      for (const tag of tags.values()) {
        tagGroup.remove(tag.sprite);
        tag.texture.dispose();
        tag.sprite.material.dispose();
      }
      tags.clear();
      last = null;
    },
  };
}
