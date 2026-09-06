/**
 * 下絵の画像の表示層と、作図面に貼るための計算(計画書 docs/plans/P6-入出力.md
 * §0.a-0.45〜0.47、§2.14、タスク39)。
 *
 * 対応要件: FR-332(読み込んだ画像を作図面に置き、2 点で寸法を合わせ、その上をなぞって
 * スケッチできる)、NFR-UX-2(その場の数値入力)、NFR-PF-1(60fps)。
 *
 * **前半は純関数だけ**(three.js に触れない)。作図面の上での置き方から 4 頂点のワールド座標を
 * 作り、押した点を画像の画素へ写し戻し、2 点の実寸から幅・高さ(mm)を出す。§2.14 の式と
 * 検証表はここで固定する。**後半が three.js の層**で、画像 1 枚につき面 1 枚を貼る。
 *
 * **下絵は形にならない。** 押し出しの材料にも当たり判定にもならず、入切・移動・不透明度の
 * 変更で再計算は走らない(`part/documentChange.ts` の `affectsShape` が偽、§2.14)。
 * 下絵の線には吸着しない(§0.a-0.47。画像の中の線を見つけるには画像処理が要り、要件に無い。
 * P1 のグリッド吸着・端点吸着はそのまま効くので、なぞる操作は成立する)。
 *
 * **テクスチャ・材質・形は必ず `dispose()` する**(P5 §4)。消したとき・画像を差し替えた
 * ときの経路を両方作り、検査で回数を数える。
 */

import {
  canvasSizeFromScale,
  planeToWorld,
  scaleFromTwoPoints,
  type CanvasPixelPoint,
  type ScaleFromTwoPointsResult,
  type SketchCanvas,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';
import * as THREE from 'three';

import type { DecodedCanvasImage } from '../file/canvasFile.js';

// ---------------------------------------------------------------------------
// 作図面の上での置き方(純関数。three.js に触れない)
// ---------------------------------------------------------------------------

/**
 * 下絵 1 枚の作図面の上での置き方。**式はここへ来る前に評価済み**(数だけを持つ)。
 *
 * 文書の `SketchCanvas` は幅・高さ・向き・不透明度を式(`ExpressionValue`)のまま持つ
 * (FR-202)ので、描く直前に `canvasPlacementOf` が評価値だけを取り出してこの形にする。
 * 描画の計算に式を持ち込まないと、検査が数だけで書ける。
 */
export interface CanvasPlacement {
  /** 作図面の上での幅(mm)。画像の横(第 1 軸)方向の長さ。 */
  readonly widthMm: number;
  /** 同じく高さ(mm)。画像の縦(第 2 軸)方向の長さ。 */
  readonly heightMm: number;
  /** 画像の中心の位置(作図面の第 1 軸方向)。 */
  readonly centerU: number;
  /** 画像の中心の位置(作図面の第 2 軸方向)。 */
  readonly centerV: number;
  /** 作図面の中での回り(度)。0 なら画像の横が作図面の第 1 軸に沿う。 */
  readonly rotationDegrees: number;
}

/** 画像の画素の大きさ。復号した画像から取る(文書には保存しない、`rules/04`)。 */
export interface CanvasPixelSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 文書の下絵 1 枚から、描くための置き方を取り出す(式は評価値を使う。FR-202)。
 *
 * **中心の位置は作図面の座標**(第 1 軸・第 2 軸)として読む(`SketchCanvas.origin` の
 * 注釈のとおり)。座標の入れ方(`CoordinateInput`)は絶対・相対・極の 3 通りあるが、
 * 下絵を置く口(ストア)が作るのは**絶対のものだけ**なので、それ以外は基準の位置(0, 0)へ
 * 落とす。落としても画面から消えないので、利用者は掴んで置き直せる(FR-504「止めずに警告」)。
 */
export function canvasPlacementOf(canvas: SketchCanvas): CanvasPlacement {
  const origin = canvas.origin;
  const absolute = origin.mode === 'absolute';
  return {
    widthMm: canvas.width.value,
    heightMm: canvas.height.value,
    centerU: absolute ? origin.x.value : 0,
    centerV: absolute ? origin.y.value : 0,
    rotationDegrees: canvas.rotation.value,
  };
}

/**
 * 面の 4 頂点の並び順。**左上 → 右上 → 左下 → 右下**(画像を正面から見たときの順)。
 * `CANVAS_CORNER_UVS` と `CANVAS_TRIANGLE_INDICES` はこの順を前提にする。
 */
export const CANVAS_CORNER_COUNT = 4;

/**
 * 頂点ごとの uv(画像のどこを貼るか)。**v = 1 が画像の上端**。
 *
 * `decodeCanvasImage` が `imageOrientation: 'flipY'` で復号する(three.js の `Texture.flipY` は
 * `ImageBitmap` に効かないため)ので、ここは普通の画像と同じ向きで書ける。
 */
export const CANVAS_CORNER_UVS: readonly number[] = [0, 1, 1, 1, 0, 0, 1, 0];

/**
 * 三角形 2 枚の頂点の番号。左上(0)・右上(1)・左下(2)・右下(3)を
 * (0, 2, 1) と (2, 3, 1) に割る。作図面を法線の側から見て反時計回り(表)になる並び。
 */
export const CANVAS_TRIANGLE_INDICES: readonly number[] = [0, 2, 1, 2, 3, 1];

/** 4 頂点の作図面の上での位置(中心を原点としたときの、回す前の (u, v))。上の並び順。 */
const CANVAS_CORNER_SIGNS: readonly (readonly [number, number])[] = [
  [-0.5, 0.5],
  [0.5, 0.5],
  [-0.5, -0.5],
  [0.5, -0.5],
];

/** 度をラジアンへ(three.js にも model にも同じ変換があるが、ここは数式 1 行で足りる)。 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * 下絵の面の 4 頂点のワールド座標(FR-332、§2.14)。**three.js に触れない純関数**。
 *
 * 幅・高さから中心まわりの (u, v) を作り、`rotationDegrees` だけ第 1 軸から第 2 軸へ回し、
 * 中心へ寄せてから作図面のワールド座標へ写す(`planeToWorld`)。
 *
 * 例(§2.14 とタスク39 の検証表): XY 面に幅 400・高さ 300 を原点中心・傾き 0 で置くと、
 * 4 頂点は `(±200, ±150, 0)` になる。
 */
export function buildCanvasPlanePositions(
  placement: CanvasPlacement,
  plane: WorkPlane,
): readonly Vec3[] {
  const angle = toRadians(placement.rotationDegrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return CANVAS_CORNER_SIGNS.map(([signU, signV]) => {
    const localU = signU * placement.widthMm;
    const localV = signV * placement.heightMm;
    return planeToWorld(
      plane,
      placement.centerU + localU * cos - localV * sin,
      placement.centerV + localU * sin + localV * cos,
    );
  });
}

/** 4 頂点を three.js の位置の並び(12 個の数)へ。頂点の順は上の並びのまま。 */
export function canvasPositionValues(corners: readonly Vec3[]): Float32Array {
  const values = new Float32Array(CANVAS_CORNER_COUNT * 3);
  for (let index = 0; index < CANVAS_CORNER_COUNT; index += 1) {
    values.set(corners[index] ?? [0, 0, 0], index * 3);
  }
  return values;
}

/**
 * 作図面の上の点 (u, v) を、画像の画素の座標へ写し戻す(§2.14 の寸法合わせの下ごしらえ)。
 *
 * 画素は**左上が原点**で、`u` が右、`v` が下(`CanvasPixelPoint` の決め)。置き方の逆算なので、
 * 中心を引き、`rotationDegrees` だけ逆に回してから、幅・高さで割って画素へ直す。
 *
 * 幅・高さが 0 のときは割れないので、画像の中心の画素を返す(2 点が同じ位置になるので、
 * 続く `scaleFromTwoPoints` が「離れた 2 点を指してください」と断る)。
 */
export function canvasPixelPointOf(
  placement: CanvasPlacement,
  pixelSize: CanvasPixelSize,
  planePoint: readonly [number, number],
): CanvasPixelPoint {
  const angle = toRadians(placement.rotationDegrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offsetU = planePoint[0] - placement.centerU;
  const offsetV = planePoint[1] - placement.centerV;
  // 貼るときと逆向きに回す(回す前の、画像の横・縦に沿った長さへ戻す)。
  const localU = offsetU * cos + offsetV * sin;
  const localV = -offsetU * sin + offsetV * cos;
  const ratioU = placement.widthMm === 0 ? 0 : localU / placement.widthMm;
  // 画素の縦は下向きなので、作図面の第 2 軸(上向き)とは符号が逆になる。
  const ratioV = placement.heightMm === 0 ? 0 : -localV / placement.heightMm;
  return [(ratioU + 0.5) * pixelSize.width, (ratioV + 0.5) * pixelSize.height];
}

/** 2 点の寸法合わせの結果。断りの理由と日本語は model(タスク38)のものをそのまま通す。 */
export type CanvasResizeResult =
  | {
      readonly ok: true;
      /** 合わせた後の作図面の上での幅(mm)。 */
      readonly widthMm: number;
      /** 同じく高さ(mm)。 */
      readonly heightMm: number;
      /** 縮尺(mm / 画素)。**保存はしない**(幅 ÷ 画素の幅でいつでも出せる、`rules/04`)。 */
      readonly scale: number;
      /** 2 点の画素の距離(検算と案内のため)。 */
      readonly pixelDistance: number;
    }
  | Extract<ScaleFromTwoPointsResult, { readonly ok: false }>;

/**
 * 下絵の上で指した 2 点と、その実寸(mm)から、新しい幅・高さ(mm)を出す(§0.a-0.46、§2.14)。
 *
 * ```
 * 画素の距離 d = √((u₂−u₁)² + (v₂−v₁)²)
 * 縮尺 s = 実寸 / d          [mm / 画素]
 * 幅(mm) = s × 画素の幅     高さ(mm) = s × 画素の高さ
 * ```
 *
 * 例(§2.14): 800×600 画素の画像で (100,100)〜(500,100) の 400 画素を 200mm と指定すると
 * `s = 0.5` になり、幅 400mm・高さ 300mm になる。
 *
 * 2 点は**作図面の上の点**(押した場所を作図面へ落としたもの)で受け取り、ここで画素へ
 * 写し戻してから model の `scaleFromTwoPoints`(タスク38)へ渡す。式の正本は model 側 1 か所で、
 * 断りの文言(同じ位置・実寸が 0 以下)もそちらのものをそのまま返す。
 */
export function canvasSizeForTwoPoints(
  placement: CanvasPlacement,
  pixelSize: CanvasPixelSize,
  firstPlanePoint: readonly [number, number],
  secondPlanePoint: readonly [number, number],
  realLengthMm: number,
): CanvasResizeResult {
  const outcome = scaleFromTwoPoints(
    canvasPixelPointOf(placement, pixelSize, firstPlanePoint),
    canvasPixelPointOf(placement, pixelSize, secondPlanePoint),
    realLengthMm,
  );
  if (!outcome.ok) {
    return outcome;
  }
  const size = canvasSizeFromScale(outcome.scale, pixelSize.width, pixelSize.height);
  return {
    ok: true,
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    scale: outcome.scale,
    pixelDistance: outcome.pixelDistance,
  };
}

// ---------------------------------------------------------------------------
// three.js の表示層
// ---------------------------------------------------------------------------

/**
 * 描く順。**スケッチの線より必ず後ろ**(§0.a-0.46)。
 *
 * `createSketchLayer.ts` の数直線は 作図面の矩形 -1 → 面 0 → 縁 2 → 線 3 → 点 4 で、
 * 立体は 1(`createSolidLayer.ts`)。下絵はそのすべての後ろに置くので、いちばん小さい
 * -1(作図面の矩形)より下の -2 にする。なぞる対象は「紙」なので、方眼も作図面の矩形も
 * 下絵の上に見えるほうが位置を確かめやすい。
 */
export const CANVAS_RENDER_ORDER = -2;

/** 描く下絵 1 枚ぶん。文書と復号した画像から、画面側(`ViewportCanvas.tsx`)が組み立てる。 */
export interface CanvasDraw {
  /** 下絵の id(`SketchCanvas.id`)。同じ id なら部品を使い回す(NFR-PF-1)。 */
  readonly id: string;
  /** 復号した画像。**差し替えたかどうかは同一参照で見る。** */
  readonly image: DecodedCanvasImage;
  /** 貼り付ける作図面(解いたもの)。 */
  readonly plane: WorkPlane;
  /** 作図面の上での置き方(式は評価済み)。 */
  readonly placement: CanvasPlacement;
  /** 不透明度 0〜1(`SketchCanvas.opacity` の評価値そのまま。§2.14)。 */
  readonly opacity: number;
}

export interface CanvasLayer {
  /** シーンへ足す入れ物。 */
  readonly group: THREE.Group;
  /**
   * 出す下絵を差し替える(FR-332)。**入切(`visible`)で外したものと、平面を解けないものは
   * 呼び出し側が並びから外して渡す**(この層は渡された分だけを描く)。
   *
   * 同じ id のものは部品を使い回し、位置・不透明度だけを書き換える(NFR-PF-1)。
   * 並びから消えた id の部品は、テクスチャ・材質・形を捨ててから外す(P5 §4)。
   */
  update(draws: readonly CanvasDraw[]): void;
  dispose(): void;
}

/** 面 1 枚ぶんの控え。 */
interface CanvasEntry {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** 位置の並び(4 頂点 × 3)。中身だけを書き換えるので入れ物は作り直さない。 */
  readonly positions: Float32Array;
  /** いま貼っている画像。差し替えを見分けるために覚えておく。 */
  image: DecodedCanvasImage;
}

/**
 * 面 1 枚を作る。**深度は書かない**(`depthWrite: false`、§0.a-0.46)ので、下絵が
 * スケッチや立体を隠すことはない。**両面**にするのは、作図面の裏へ回っても下絵が消えないため
 * (`createSketchLayer.ts` の作図面の矩形と同じ)。
 *
 * **クリッピング平面(断面表示、FR-111、タスク35)は配らない。** 配ると、中を見るために
 * 断面表示を入れた瞬間に下絵まで切れて消えてしまい、「なぞるための紙」として用を成さない
 * (タスク39 の判断)。下絵は形ではないので、切っても体積にも三角形にも関係しない。
 */
function createCanvasEntry(image: DecodedCanvasImage, opacity: number): CanvasEntry {
  const positions = new Float32Array(CANVAS_CORNER_COUNT * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from(CANVAS_CORNER_UVS), 2));
  geometry.setIndex(Array.from(CANVAS_TRIANGLE_INDICES));

  const material = new THREE.MeshBasicMaterial({
    map: canvasTextureOf(image),
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = CANVAS_RENDER_ORDER;
  return { mesh, positions, image };
}

/**
 * 画像 1 枚からテクスチャを作る。**捨てるのは持ち主(この層)**で、`ImageBitmap` 自体は
 * 閉じない(復号した画像を覚えているのは画面側の控えなので、持ち主を 2 か所に作らない)。
 */
function canvasTextureOf(image: DecodedCanvasImage): THREE.Texture {
  const texture: THREE.Texture = new THREE.Texture(image);
  // 画像は sRGB(見たままの色)。下絵は照明の影響を受けない材質(MeshBasicMaterial)に貼る。
  texture.colorSpace = THREE.SRGBColorSpace;
  // 拡大したときに画素が四角く目立たないよう滑らかに伸ばす。縮小は 1 段だけ(mipmap を
  // 作ると 8MB の画像で記憶が 1.33 倍になるうえ、なぞる線がぼやける)。
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // 素材を差し込んだだけでは GPU へ上がらないので、次に描くときに上げるよう印を付ける。
  texture.needsUpdate = true;
  return texture;
}

/** 面 1 枚ぶんの資源を捨てる(テクスチャ・材質・形の 3 つ。P5 §4)。 */
function disposeCanvasEntry(entry: CanvasEntry): void {
  entry.mesh.material.map?.dispose();
  entry.mesh.material.dispose();
  entry.mesh.geometry.dispose();
}

export function createCanvasLayer(): CanvasLayer {
  const group = new THREE.Group();
  /** id ごとの面。並びの順は描く順に影響しない(`renderOrder` が決める)。 */
  const entries = new Map<string, CanvasEntry>();

  return {
    group,

    update(draws): void {
      const alive = new Set<string>();
      for (const draw of draws) {
        alive.add(draw.id);
        let entry = entries.get(draw.id);
        if (entry === undefined) {
          entry = createCanvasEntry(draw.image, draw.opacity);
          entries.set(draw.id, entry);
          group.add(entry.mesh);
        } else if (entry.image !== draw.image) {
          // 画像を差し替えた。古いテクスチャだけを捨てる(材質と形はそのまま使い回す)。
          entry.mesh.material.map?.dispose();
          entry.mesh.material.map = canvasTextureOf(draw.image);
          entry.mesh.material.needsUpdate = true;
          entry.image = draw.image;
        }
        entry.positions.set(
          canvasPositionValues(buildCanvasPlanePositions(draw.placement, draw.plane)),
        );
        entry.mesh.geometry.getAttribute('position').needsUpdate = true;
        // 面が動くと包む球も変わる。作り直さないと視錐台の外と誤判定されて消える。
        entry.mesh.geometry.computeBoundingSphere();
        entry.mesh.material.opacity = draw.opacity;
      }
      for (const [id, entry] of entries) {
        if (alive.has(id)) {
          continue;
        }
        group.remove(entry.mesh);
        disposeCanvasEntry(entry);
        entries.delete(id);
      }
    },

    dispose(): void {
      for (const entry of entries.values()) {
        group.remove(entry.mesh);
        disposeCanvasEntry(entry);
      }
      entries.clear();
    },
  };
}
