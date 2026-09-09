/**
 * DXF のタグの列を実体(`DxfEntity`)の列へ畳む(要件 FR-813、計画書 docs/plans/P6-入出力.md
 * §2.7 タスク24)。
 *
 * 読み込みの 3 段のうちの 2 段目にあたる(計画書 §2.7)。
 *
 * ```
 * テキスト → parseDxfTags(text)   : DxfTag[]      … 字句(タスク22。dxfTags.ts)
 *          → readDxf(tags)        : DxfReadResult … 実体(この段)
 *          → dxfToSketch(…)       : SketchFeature[] … スケッチへの写し(タスク26。model 側)
 * ```
 *
 * ## 何をして、何をしないか
 *
 * - **扱う実体は 9 種**(計画書 §0.a-0.30): `POINT` / `LINE` / `CIRCLE` / `ARC` /
 *   `ELLIPSE` / `LWPOLYLINE` / `POLYLINE`(+ `VERTEX` / `SEQEND`)/ `SPLINE` / `INSERT`。
 *   **それ以外の実体(`TEXT` / `HATCH` / `DIMENSION` …)は黙って飛ばす**(断らない。
 *   他の CAD が書いた DXF には必ず知らない実体が入っているため)。飛ばした数だけを
 *   `skippedEntityCount` に残し、利用者へ知らせるかどうかは上の段(タスク26)が決める。
 * - **`INSERT` はここで展開する。** ブロックの中身を「倍率 → 回転 → 移動」の順で写した
 *   実体に置き換えるので、この段より上はブロックを知らなくてよい。**入れ子は 8 段まで**
 *   (計画書 §0.a-0.32)。9 段目と自己参照は `DXF_BLOCK_NESTING_MESSAGE` で断る。
 * - **多角形(`LWPOLYLINE` / `POLYLINE`)は線分と円弧の並びへ開く。** 写し先の
 *   `SketchFeature` に多角形の種類が無く(計画書 §0.32 が「`line` と `arc` の並び」と決めている)、
 *   ふくらみ(bulge)の換算をこの段で済ませておけば、上の段は 1 対 1 で写すだけで済むため。
 * - **単位の換算はここでしない。** `$INSUNITS`(1 = inch、4 = mm、無ければ mm。計画書 §0.a-0.6)を
 *   読んで `unit` に添えるだけで、**座標はファイルに書かれた数のまま**返す。理由は 3 つ。
 *   ①`unit` が `'other'`(フィートやメートル)のときにどうするかは、利用者へ訊く画面を持つ
 *   上の段の判断であること。②STL / OBJ は「取り込みの時に利用者へ訊く」(計画書 §0.a-0.6)ので、
 *   換算の場所を上の段へ揃えたほうが 1 か所で済むこと。③書き出し(タスク25)は
 *   `$INSUNITS = 4`(mm)固定なので、この段で換算すると往復で二重に掛かる恐れがあること。
 * - **Z 座標は捨てる**(2D の図として取り込む。計画書 §0.a-0.33)。捨てた実体の数を
 *   `offPlaneCount` に残す。**文言(「平面から外れた図形が N 個あります。」)はここでは出さない**
 *   ——案内を出すかどうかは上の段(タスク26)が決める。
 *
 * ## 断りと、黙って飛ばすものの線引き
 *
 * **形式として読めないもの**(`ENDSEC` が無い、`ENDBLK` が無い、既知の実体に必要な
 * グループコードが無い、半径が 0 以下)は `DXF_UNSUPPORTED_FORMAT_MESSAGE` で断る。
 * 壊れた対応のまま読み進めると、別の図形として「読めた」ことになってしまうため
 * (字句の段(タスク22)と同じ考え方)。
 * 一方、**知らない実体**は正常な DXF にも必ず入っているので飛ばす。
 *
 * ## 触れていないもの(上の段・別のタスクへの申し送り)
 *
 * - `INSERT` の並べ置き(グループ 70 / 71 の列数・行数、44 / 45 の間隔)は**1 個として読む**。
 *   複数の CAD で既定が 1 であり、繰り返しの配置は稀なため。
 * - 押し出しの向き(グループ 210 / 220 / 230)は**見ない**(計画書 §0.a、タスク23 の申し送り)。
 *   平らな DXF が対象なので、向きが反転した実体は鏡に映った位置で読まれる。
 * - 色(グループ 62)は**生の整数のまま**持つ(`0` = ブロックに従う、`256` = レイヤーに従う、
 *   負 = 表示を消してある、の意味づけは上の段の仕事)。
 */

import {
  bulgeToArc,
  ellipseFromDxf,
  parseDxfInteger,
  parseDxfNumber,
  splineFromDxf,
  type DxfArcGeometry,
  type DxfEllipseGeometry,
  type DxfPoint2d,
  type DxfSplineGeometry,
} from './dxfCurves.js';
import { DXF_UNSUPPORTED_FORMAT_MESSAGE, type DxfTag } from './dxfTags.js';
import { decodeDxfString } from './dxfDrawingTypes.js';

/** すべての実体が持つ欄。 */
export interface DxfEntityBase {
  /** グループ 8。**前後の空白は落とさない**(レイヤー名の一部として意味があるため)。 */
  readonly layer: string;
  /** グループ 62。無ければ `null`。意味づけ(0 / 256 / 負)は上の段が決める。 */
  readonly color: number | null;
}

/** `POINT`。 */
export interface DxfPointEntity extends DxfEntityBase {
  readonly kind: 'point';
  readonly position: DxfPoint2d;
}

/** `LINE`、および多角形を開いた直線の区間。 */
export interface DxfLineEntity extends DxfEntityBase {
  readonly kind: 'line';
  readonly start: DxfPoint2d;
  readonly end: DxfPoint2d;
}

/**
 * `CIRCLE` / `ARC`、および多角形のふくらみ(bulge)を開いた円弧の区間。
 * **円は「開始 0 度・終了 360 度の円弧」として持つ**(計画書 §0.32。写し先の
 * `SketchArcFeature` が全周の指定で円になるため、種類を増やさない)。
 */
export interface DxfArcEntity extends DxfEntityBase, DxfArcGeometry {
  readonly kind: 'arc';
}

/** `ELLIPSE`(全周・弧の両方)。 */
export interface DxfEllipseEntity extends DxfEntityBase, DxfEllipseGeometry {
  readonly kind: 'ellipse';
}

/** `SPLINE`。 */
export interface DxfSplineEntity extends DxfEntityBase, DxfSplineGeometry {
  readonly kind: 'spline';
}

/** 読み取れた実体。**写し先の `SketchFeature` の 5 種と 1 対 1 に対応する。** */
export type DxfEntity =
  | DxfPointEntity
  | DxfLineEntity
  | DxfArcEntity
  | DxfEllipseEntity
  | DxfSplineEntity;

/**
 * `$INSUNITS` から見た長さの単位。`'other'` は「単位は書いてあるが mm でも inch でもない」
 * (0 = 無単位、2 = フィート、5 = cm、6 = m など)。**どう扱うかは上の段が決める。**
 */
export type DxfLengthUnit = 'mm' | 'inch' | 'other';

/** `readDxf` の結果。**上の段(タスク26)が案内の文言を組み立てるための材料をすべて持つ。** */
export interface DxfReadResult {
  /** 読み取れた実体(`INSERT` は展開済み、多角形は線分と円弧へ開き済み)。 */
  readonly entities: readonly DxfEntity[];
  /** `$INSUNITS` から見た単位。**座標はこの単位のままで、換算していない。** */
  readonly unit: DxfLengthUnit;
  /** `$INSUNITS` の生の値。ヘッダに無ければ `null`(`unit` は `'mm'` とみなす)。 */
  readonly insUnits: number | null;
  /** 扱わない実体を飛ばした数(展開後の数。`INSERT` の中で飛ばした分も数える)。 */
  readonly skippedEntityCount: number;
  /** Z が 0 でなかった実体の数(平らにして取り込んだ数。計画書 §0.a-0.33)。 */
  readonly offPlaneCount: number;
  /** `BLOCKS` にあったブロックの定義の数(展開した回数ではない)。 */
  readonly blockCount: number;
}

/** ブロックの入れ子が深すぎるときに利用者へ見せる日本語(計画書 §2.7 の表)。 */
export const DXF_BLOCK_NESTING_MESSAGE = 'ブロックの入れ子が深すぎます。';

/**
 * ブロックの配置の倍率が縦と横で違う(または軸が直交しない)ときに見せる日本語。
 *
 * **なぜ断るのか:** 縦横で倍率が違う配置に置かれた円・円弧は**円ではなく楕円**になり、
 * 楕円はさらに軸の向きが変わった別の楕円になる。近い形に落として黙って取り込むと、
 * 図面の寸法が静かに狂う。**点・線分・自由曲線は倍率が違っても厳密に写せる**(アフィン変換で
 * 制御点をそのまま動かせるため)ので、**円弧・楕円を含む配置に出会ったときだけ**断る。
 * 元の CAD で「分解」してから書き出せば取り込めるので、直し方も利用者に分かる。
 */
export const DXF_NON_UNIFORM_SCALE_MESSAGE = 'ブロックの縦横で倍率が違う配置には対応していません。';

/**
 * 展開した実体が多すぎるときに見せる日本語。
 *
 * **なぜ要るのか:** ブロックが入れ子で互いを何度も置くと、8 段の制限の中でも
 * 実体の数は掛け算で増える(1 段あたり 6 個置くだけで 8 段目には 6⁷ = 27 万個になる)。
 * 上限が無いと、読み込みが終わらないように見えてしまう(NFR-PF)。
 */
export const DXF_TOO_MANY_ENTITIES_MESSAGE = 'この DXF は図形が多すぎて取り込めません。';

/** `INSERT` の入れ子の深さの上限(計画書 §0.a-0.32)。 */
export const DXF_MAX_BLOCK_NESTING_DEPTH = 8;

/** 展開後の実体の数の上限。性能の上限(1 万エンティティ / 3 秒。§2.17 #6)の 10 倍を取る。 */
export const DXF_MAX_ENTITY_COUNT = 100_000;

/** `$INSUNITS` の値。DXF の仕様の番号(計画書 §0.a-0.6 が使うのはこの 2 つだけ)。 */
const INSUNITS_INCH = 1;
const INSUNITS_MILLIMETER = 4;

const FULL_TURN_DEGREES = 360;
const HALF_TURN_DEGREES = 180;

/**
 * 直交と等倍率を判定するときの相対の許容誤差。回転角 90 度の余弦が
 * ちょうど 0 にならない(`Math.cos(Math.PI / 2)` = 6.1e−17)ため、厳密な比較はできない。
 */
const SIMILARITY_TOLERANCE = 1e-9;

/**
 * 平面の相似変換(および一般のアフィン変換)。`(x, y)` を
 * `(a·x + c·y + tx, b·x + d·y + ty)` へ写す。`(a, b)` が第 1 軸の像、`(c, d)` が第 2 軸の像。
 */
interface DxfTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

const IDENTITY_TRANSFORM: DxfTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** タグの列を「先頭のグループ 0 の値(実体の名前)」ごとに切ったもの。 */
interface DxfRecord {
  readonly type: string;
  readonly tags: readonly DxfTag[];
}

/** `BLOCKS` にあったブロック 1 つ。 */
interface DxfBlock {
  /** グループ 10 / 20。中身の座標から引いてから配置する基点。 */
  readonly base: DxfPoint2d;
  readonly records: readonly DxfRecord[];
}

/** 展開の途中で持ち回る数え上げ。実体の列と同じ回数だけ増える。 */
interface ReadState {
  readonly blocks: ReadonlyMap<string, DxfBlock>;
  readonly entities: DxfEntity[];
  skippedEntityCount: number;
  offPlaneCount: number;
}

/** 多角形の頂点(読み取りの途中だけ可変)。 */
interface PolylineVertex {
  x: number;
  y: number;
  bulge: number;
}

function unsupported(): Error {
  return new Error(DXF_UNSUPPORTED_FORMAT_MESSAGE);
}

/** `-0` を `0` へ寄せる(`dxfTags.ts` / `dxfCurves.ts` の決めと揃える)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 度を `[0, 360)` へ畳む。 */
function foldDegrees(degrees: number): number {
  const wrapped = degrees % FULL_TURN_DEGREES;
  return normalizeZero(wrapped < 0 ? wrapped + FULL_TURN_DEGREES : wrapped);
}

function toDegrees(radians: number): number {
  return (radians * HALF_TURN_DEGREES) / Math.PI;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / HALF_TURN_DEGREES;
}

function makePoint(x: number, y: number): DxfPoint2d {
  return { x: normalizeZero(x), y: normalizeZero(y) };
}

/** 中心から半径 `radius`、方位角 `degrees` の点。円弧を写すときに始点の像を求めるのに使う。 */
function pointAtAngle(center: DxfPoint2d, radius: number, degrees: number): DxfPoint2d {
  const radians = toRadians(degrees);
  return makePoint(center.x + radius * Math.cos(radians), center.y + radius * Math.sin(radians));
}

// ---------------------------------------------------------------------------
// タグの取り出し
// ---------------------------------------------------------------------------

/** 同じコードが複数あるときは**最初の 1 つ**を返す(1 つしか意味を持たない欄のため)。 */
function firstTagValue(tags: readonly DxfTag[], code: number): string | undefined {
  for (const tag of tags) {
    if (tag.code === code) {
      return tag.value;
    }
  }
  return undefined;
}

/** 必須の数。無ければ「形式に対応していません」で断る(欠けた実体を推測で埋めない)。 */
function requiredNumber(tags: readonly DxfTag[], code: number): number {
  const value = firstTagValue(tags, code);
  if (value === undefined) {
    throw unsupported();
  }
  return parseDxfNumber(value);
}

function optionalNumber(tags: readonly DxfTag[], code: number, fallback: number): number {
  const value = firstTagValue(tags, code);
  return value === undefined ? fallback : parseDxfNumber(value);
}

function optionalInteger(tags: readonly DxfTag[], code: number, fallback: number): number {
  const value = firstTagValue(tags, code);
  return value === undefined ? fallback : parseDxfInteger(value);
}

/** レイヤー(グループ 8)と色(グループ 62)。実体に共通の欄。 */
function readEntityBase(tags: readonly DxfTag[]): DxfEntityBase {
  const layer = firstTagValue(tags, 8);
  const color = firstTagValue(tags, 62);
  return {
    layer: layer === undefined ? '0' : decodeDxfString(layer),
    color: color === undefined ? null : parseDxfInteger(color),
  };
}

// ---------------------------------------------------------------------------
// 変換
// ---------------------------------------------------------------------------

function isIdentityTransform(transform: DxfTransform): boolean {
  return (
    transform.a === 1 &&
    transform.b === 0 &&
    transform.c === 0 &&
    transform.d === 1 &&
    transform.tx === 0 &&
    transform.ty === 0
  );
}

function applyTransform(transform: DxfTransform, point: DxfPoint2d): DxfPoint2d {
  return makePoint(
    transform.a * point.x + transform.c * point.y + transform.tx,
    transform.b * point.x + transform.d * point.y + transform.ty,
  );
}

/** `outer` を後から掛ける合成(`outer ∘ inner`)。入れ子のブロックで内側から外側へ積む。 */
function composeTransforms(outer: DxfTransform, inner: DxfTransform): DxfTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/** 行列式。負なら鏡に映っている(回る向きが反転する)。 */
function determinant(transform: DxfTransform): number {
  return transform.a * transform.d - transform.b * transform.c;
}

/**
 * 相似変換(回転 + 等倍率、鏡像を含む)なら倍率を返し、そうでなければ `null` を返す。
 * 2 本の軸の像が**直交していて長さが等しい**ことが条件で、これが崩れると
 * 円が楕円へ、楕円が別の楕円へ化ける(`DXF_NON_UNIFORM_SCALE_MESSAGE` の理由)。
 */
function similarityScale(transform: DxfTransform): number | null {
  const firstLength = Math.hypot(transform.a, transform.b);
  const secondLength = Math.hypot(transform.c, transform.d);
  if (firstLength === 0 || secondLength === 0) {
    return null;
  }
  const dot = transform.a * transform.c + transform.b * transform.d;
  if (Math.abs(dot) > SIMILARITY_TOLERANCE * firstLength * secondLength) {
    return null;
  }
  if (Math.abs(firstLength - secondLength) > SIMILARITY_TOLERANCE * Math.max(firstLength, secondLength)) {
    return null;
  }
  return firstLength;
}

function transformArc(entity: DxfArcEntity, transform: DxfTransform): DxfArcEntity {
  const scale = similarityScale(transform);
  if (scale === null) {
    throw new Error(DXF_NON_UNIFORM_SCALE_MESSAGE);
  }
  const center = applyTransform(transform, entity.center);
  // 始点の像から開始角を測り直す。回転角を足し算で求めるより、鏡像も同じ 1 本の式で扱える。
  const start = applyTransform(transform, pointAtAngle(entity.center, entity.radius, entity.startAngle));
  const startAngle = foldDegrees(toDegrees(Math.atan2(start.y - center.y, start.x - center.x)));
  const sweep = entity.endAngle - entity.startAngle;
  const oriented = determinant(transform) < 0 ? -sweep : sweep;
  return {
    ...entity,
    center,
    radius: entity.radius * scale,
    startAngle,
    endAngle: normalizeZero(startAngle + oriented),
  };
}

function transformEllipse(entity: DxfEllipseEntity, transform: DxfTransform): DxfEllipseEntity {
  const scale = similarityScale(transform);
  if (scale === null) {
    throw new Error(DXF_NON_UNIFORM_SCALE_MESSAGE);
  }
  const center = applyTransform(transform, entity.center);
  const majorEnd = applyTransform(
    transform,
    pointAtAngle(entity.center, entity.majorRadius, entity.rotation),
  );
  const rotation = foldDegrees(toDegrees(Math.atan2(majorEnd.y - center.y, majorEnd.x - center.x)));
  // 開始角・終了角は「長軸から測った方位角」なので、鏡像では符号が反転する。
  const mirrored = determinant(transform) < 0;
  const startAngle = foldDegrees(mirrored ? -entity.startAngle : entity.startAngle);
  const sweep = entity.endAngle - entity.startAngle;
  const oriented = mirrored ? -sweep : sweep;
  return {
    ...entity,
    center,
    majorRadius: entity.majorRadius * scale,
    minorRadius: entity.minorRadius * scale,
    rotation,
    startAngle,
    endAngle: normalizeZero(startAngle + oriented),
  };
}

/**
 * 実体を配置の変換で写す。**単位変換(恒等変換)のときは何もしない**——
 * 円弧を角度から座標へ戻して測り直すと最後の桁が動くので、`ENTITIES` 直下の実体
 * (変換が要らないほとんどの実体)の数をそのまま保つため。
 */
function transformEntity(entity: DxfEntity, transform: DxfTransform): DxfEntity {
  if (isIdentityTransform(transform)) {
    return entity;
  }
  switch (entity.kind) {
    case 'point':
      return { ...entity, position: applyTransform(transform, entity.position) };
    case 'line':
      return {
        ...entity,
        start: applyTransform(transform, entity.start),
        end: applyTransform(transform, entity.end),
      };
    case 'arc':
      return transformArc(entity, transform);
    case 'ellipse':
      return transformEllipse(entity, transform);
    case 'spline':
      // 自由曲線は制御点・通過点をそのまま動かせる(アフィン変換で形が保たれる)ので、
      // 縦横で倍率が違っても厳密に写せる。
      return { ...entity, points: entity.points.map((point) => applyTransform(transform, point)) };
  }
}

// ---------------------------------------------------------------------------
// タグの列 → 記録(0 で切る)
// ---------------------------------------------------------------------------

/**
 * タグの列を、グループ 0(実体の名前)で切った記録の列にする。
 * 最初の 0 より前のタグは、どの実体にも属さないので捨てる。
 */
function splitRecords(tags: readonly DxfTag[]): readonly DxfRecord[] {
  const records: DxfRecord[] = [];
  let type: string | null = null;
  let body: DxfTag[] = [];
  for (const tag of tags) {
    if (tag.code === 0) {
      if (type !== null) {
        records.push({ type, tags: body });
      }
      type = tag.value.trim();
      body = [];
    } else if (type !== null) {
      body.push(tag);
    }
  }
  if (type !== null) {
    records.push({ type, tags: body });
  }
  return records;
}

// ---------------------------------------------------------------------------
// HEADER / BLOCKS
// ---------------------------------------------------------------------------

/**
 * `HEADER` から `$INSUNITS` だけを拾う(計画書 タスク24 手順 2)。
 * ヘッダの変数は「`9`/変数名」に続けて値のタグが来るので、**次の `9` が現れる前の
 * `70`** を値とみなす。
 */
function readInsUnits(tags: readonly DxfTag[]): number | null {
  let inVariable = false;
  for (const tag of tags) {
    if (tag.code === 9) {
      inVariable = tag.value.trim() === '$INSUNITS';
      continue;
    }
    if (inVariable && tag.code === 70) {
      return parseDxfInteger(tag.value);
    }
  }
  return null;
}

/** `$INSUNITS` の値を、上の段が扱う 3 通りへ寄せる(計画書 §0.a-0.6)。 */
function toLengthUnit(insUnits: number | null): DxfLengthUnit {
  if (insUnits === null) {
    // 単位が書かれていない DXF は mm とみなす(計画書 §0.6)。
    return 'mm';
  }
  if (insUnits === INSUNITS_INCH) {
    return 'inch';
  }
  if (insUnits === INSUNITS_MILLIMETER) {
    return 'mm';
  }
  return 'other';
}

/**
 * `BLOCKS` セクションを読む。`0/BLOCK` から `0/ENDBLK` までが 1 つのブロックで、
 * ブロック名(グループ 2)は**大文字小文字を区別せずに**引けるようにする
 * (DXF を書く CAD が同じ名前を違う綴りで書くことがあるため)。
 */
function readBlocks(tags: readonly DxfTag[]): ReadonlyMap<string, DxfBlock> {
  const blocks = new Map<string, DxfBlock>();
  const records = splitRecords(tags);
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record.type !== 'BLOCK') {
      index += 1;
      continue;
    }
    const name = (firstTagValue(record.tags, 2) ?? '').trim();
    const base = makePoint(optionalNumber(record.tags, 10, 0), optionalNumber(record.tags, 20, 0));
    index += 1;
    const content: DxfRecord[] = [];
    while (index < records.length && records[index].type !== 'ENDBLK') {
      content.push(records[index]);
      index += 1;
    }
    if (index >= records.length) {
      // `ENDBLK` が無い = ブロックの終わりが決まらない。読み進めると次のブロックと混ざる。
      throw unsupported();
    }
    index += 1;
    blocks.set(name.toUpperCase(), { base, records: content });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// 実体の読み取り
// ---------------------------------------------------------------------------

function readPointEntity(record: DxfRecord): DxfPointEntity {
  return {
    ...readEntityBase(record.tags),
    kind: 'point',
    position: makePoint(requiredNumber(record.tags, 10), requiredNumber(record.tags, 20)),
  };
}

function readLineEntity(record: DxfRecord): DxfLineEntity {
  return {
    ...readEntityBase(record.tags),
    kind: 'line',
    start: makePoint(requiredNumber(record.tags, 10), requiredNumber(record.tags, 20)),
    end: makePoint(requiredNumber(record.tags, 11), requiredNumber(record.tags, 21)),
  };
}

/** `CIRCLE` は「開始 0 度・終了 360 度の円弧」として読む(計画書 §0.32)。 */
function readCircleEntity(record: DxfRecord): DxfArcEntity {
  const radius = requiredNumber(record.tags, 40);
  if (radius <= 0) {
    throw unsupported();
  }
  return {
    ...readEntityBase(record.tags),
    kind: 'arc',
    center: makePoint(requiredNumber(record.tags, 10), requiredNumber(record.tags, 20)),
    radius,
    startAngle: 0,
    endAngle: FULL_TURN_DEGREES,
  };
}

/**
 * `ARC`(グループ 50 = 開始角、51 = 終了角、いずれも度)。
 * **DXF の円弧は必ず反時計回りに開始角から終了角へ回る**ので、終了角が開始角より小さければ
 * 360 度を足す。開始角と終了角が同じ値のときは全周(360 度)とみなす
 * (中心角 0 の円弧は図形として持てないため)。
 */
function readArcEntity(record: DxfRecord): DxfArcEntity {
  const radius = requiredNumber(record.tags, 40);
  if (radius <= 0) {
    throw unsupported();
  }
  const startAngle = foldDegrees(requiredNumber(record.tags, 50));
  const endRaw = requiredNumber(record.tags, 51);
  const sweep = foldDegrees(endRaw - startAngle);
  return {
    ...readEntityBase(record.tags),
    kind: 'arc',
    center: makePoint(requiredNumber(record.tags, 10), requiredNumber(record.tags, 20)),
    radius,
    startAngle,
    endAngle: startAngle + (sweep === 0 ? FULL_TURN_DEGREES : sweep),
  };
}

const FULL_TURN_RADIANS = 2 * Math.PI;

function readEllipseEntity(record: DxfRecord): DxfEllipseEntity {
  const geometry = ellipseFromDxf(
    makePoint(requiredNumber(record.tags, 10), requiredNumber(record.tags, 20)),
    makePoint(requiredNumber(record.tags, 11), requiredNumber(record.tags, 21)),
    requiredNumber(record.tags, 40),
    optionalNumber(record.tags, 41, 0),
    optionalNumber(record.tags, 42, FULL_TURN_RADIANS),
  );
  return { ...readEntityBase(record.tags), kind: 'ellipse', ...geometry };
}

/** `SPLINE` の既定の次数。グループ 71 を書かない実装があるので 3 次を補う。 */
const DEFAULT_SPLINE_DEGREE = 3;

/**
 * `SPLINE`。制御点(10/20)とフィット点(11/21)と重み(41)は同じコードが何度も現れるので、
 * **並び順のまま**畳む(`firstTagValue` では読めない)。ノット(40)は写し先が持たないので見ない。
 */
function readSplineEntity(record: DxfRecord): DxfSplineEntity {
  const controlPoints: DxfPoint2d[] = [];
  const fitPoints: DxfPoint2d[] = [];
  const weights: number[] = [];
  let controlX: number | null = null;
  let fitX: number | null = null;
  for (const tag of record.tags) {
    switch (tag.code) {
      case 10:
        controlX = parseDxfNumber(tag.value);
        break;
      case 20:
        if (controlX === null) {
          throw unsupported();
        }
        controlPoints.push(makePoint(controlX, parseDxfNumber(tag.value)));
        controlX = null;
        break;
      case 11:
        fitX = parseDxfNumber(tag.value);
        break;
      case 21:
        if (fitX === null) {
          throw unsupported();
        }
        fitPoints.push(makePoint(fitX, parseDxfNumber(tag.value)));
        fitX = null;
        break;
      case 41:
        weights.push(parseDxfNumber(tag.value));
        break;
      default:
        break;
    }
  }
  const geometry = splineFromDxf({
    degree: optionalInteger(record.tags, 71, DEFAULT_SPLINE_DEGREE),
    controlPoints,
    fitPoints,
    weights,
    closed: (optionalInteger(record.tags, 70, 0) & 1) !== 0,
  });
  return { ...readEntityBase(record.tags), kind: 'spline', ...geometry };
}

/**
 * 頂点の並びを、線分と円弧の区間へ開く。ふくらみ(bulge)が 0 でない区間は円弧、
 * 0 の区間は線分になる(`bulgeToArc` が `null` を返したら直線として扱う。タスク23 の決め)。
 * **長さ 0 の区間は捨てる**(同じ点が続けて書かれた多角形が、線分 0 本ぶんの図形を作らないため)。
 */
function polylineToEntities(
  vertices: readonly PolylineVertex[],
  closed: boolean,
  base: DxfEntityBase,
): readonly DxfEntity[] {
  const entities: DxfEntity[] = [];
  const lastIndex = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < lastIndex; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % vertices.length];
    const start = makePoint(from.x, from.y);
    const end = makePoint(to.x, to.y);
    if (from.bulge !== 0) {
      const arc = bulgeToArc(start, end, from.bulge);
      if (arc !== null) {
        entities.push({ ...base, kind: 'arc', ...arc });
        continue;
      }
    }
    if (start.x === end.x && start.y === end.y) {
      continue;
    }
    entities.push({ ...base, kind: 'line', start, end });
  }
  return entities;
}

/** `LWPOLYLINE`(頂点が 1 つの記録の中に並ぶ版)。 */
function readLwPolylineEntities(record: DxfRecord): readonly DxfEntity[] {
  const vertices: PolylineVertex[] = [];
  for (const tag of record.tags) {
    switch (tag.code) {
      case 10:
        vertices.push({ x: parseDxfNumber(tag.value), y: 0, bulge: 0 });
        break;
      case 20:
      case 42: {
        const last = vertices[vertices.length - 1];
        if (last === undefined) {
          // 頂点の X より先に Y やふくらみが来る列は、対応がずれている。
          throw unsupported();
        }
        if (tag.code === 20) {
          last.y = parseDxfNumber(tag.value);
        } else {
          last.bulge = parseDxfNumber(tag.value);
        }
        break;
      }
      default:
        break;
    }
  }
  const closed = (optionalInteger(record.tags, 70, 0) & 1) !== 0;
  return polylineToEntities(vertices, closed, readEntityBase(record.tags));
}

/** `POLYLINE` の 70 のうち、写し先を持たない種類(多角形メッシュ・多面体メッシュ)。 */
const POLYLINE_MESH_FLAGS = 16 | 64;

/**
 * `POLYLINE` + `VERTEX`(+ `SEQEND`)。頂点が別々の記録として続くので、
 * 呼び出し側が集めた `VERTEX` の記録を受け取る。
 * **メッシュの多角形は写し先が無いので飛ばす**(`null` を返す)。
 */
function readPolylineEntities(
  record: DxfRecord,
  vertexRecords: readonly DxfRecord[],
): readonly DxfEntity[] | null {
  const flags = optionalInteger(record.tags, 70, 0);
  if ((flags & POLYLINE_MESH_FLAGS) !== 0) {
    return null;
  }
  const vertices: PolylineVertex[] = vertexRecords.map((vertex) => ({
    x: requiredNumber(vertex.tags, 10),
    y: requiredNumber(vertex.tags, 20),
    bulge: optionalNumber(vertex.tags, 42, 0),
  }));
  return polylineToEntities(vertices, (flags & 1) !== 0, readEntityBase(record.tags));
}

// ---------------------------------------------------------------------------
// Z 座標(平面から外れているか)
// ---------------------------------------------------------------------------

/** 実体そのものが持つ Z のグループコード(30 = 1 点目、31 = 2 点目、38 = 高さ)。 */
const Z_CODES: readonly number[] = [30, 31, 38];

/**
 * 記録が平面から外れているか(Z が 0 でないか)。**座標としては使わず、数えるだけ**
 * (計画書 §0.a-0.33「Z 座標は無視する。外れた図形があれば 1 行案内する」)。
 */
function isOffPlane(record: DxfRecord, vertexRecords: readonly DxfRecord[] = []): boolean {
  for (const tag of record.tags) {
    if (Z_CODES.includes(tag.code) && parseDxfNumber(tag.value) !== 0) {
      return true;
    }
  }
  return vertexRecords.some((vertex) => isOffPlane(vertex));
}

// ---------------------------------------------------------------------------
// 展開
// ---------------------------------------------------------------------------

/** `INSERT` の配置(倍率 → 回転 → 移動)を 1 つの変換にまとめる。 */
function insertTransform(record: DxfRecord, base: DxfPoint2d): DxfTransform {
  const scaleX = optionalNumber(record.tags, 41, 1);
  const scaleY = optionalNumber(record.tags, 42, 1);
  const rotation = toRadians(optionalNumber(record.tags, 50, 0));
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // 第 1 軸の像 = 回転(倍率 × x 軸)、第 2 軸の像 = 回転(倍率 × y 軸)。
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  const insertX = optionalNumber(record.tags, 10, 0);
  const insertY = optionalNumber(record.tags, 20, 0);
  // ブロックの基点が挿入点へ重なるように移動を決める。
  return {
    a,
    b,
    c,
    d,
    tx: insertX - (a * base.x + c * base.y),
    ty: insertY - (b * base.x + d * base.y),
  };
}

function pushEntities(
  state: ReadState,
  entities: readonly DxfEntity[],
  transform: DxfTransform,
): void {
  for (const entity of entities) {
    state.entities.push(transformEntity(entity, transform));
    if (state.entities.length > DXF_MAX_ENTITY_COUNT) {
      throw new Error(DXF_TOO_MANY_ENTITIES_MESSAGE);
    }
  }
}

/**
 * 記録の列を実体へ畳み、`INSERT` を展開する。
 *
 * @param records 対象の記録(`ENTITIES` セクション、またはブロックの中身)。
 * @param transform ここまでに積んだ配置の変換。
 * @param depth ここまでに展開した `INSERT` の段数(`ENTITIES` 直下は 0)。
 * @param state 数え上げと結果の入れ物(呼び出しをまたいで足していく)。
 */
function expandRecords(
  records: readonly DxfRecord[],
  transform: DxfTransform,
  depth: number,
  state: ReadState,
): void {
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    index += 1;
    switch (record.type) {
      case 'POINT':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readPointEntity(record)], transform);
        break;
      case 'LINE':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readLineEntity(record)], transform);
        break;
      case 'CIRCLE':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readCircleEntity(record)], transform);
        break;
      case 'ARC':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readArcEntity(record)], transform);
        break;
      case 'ELLIPSE':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readEllipseEntity(record)], transform);
        break;
      case 'SPLINE':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, [readSplineEntity(record)], transform);
        break;
      case 'LWPOLYLINE':
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        pushEntities(state, readLwPolylineEntities(record), transform);
        break;
      case 'POLYLINE': {
        // 頂点は後ろに続く `VERTEX` の記録で、`SEQEND` で終わる。
        const vertexRecords: DxfRecord[] = [];
        while (index < records.length && records[index].type === 'VERTEX') {
          vertexRecords.push(records[index]);
          index += 1;
        }
        if (index < records.length && records[index].type === 'SEQEND') {
          index += 1;
        }
        state.offPlaneCount += isOffPlane(record, vertexRecords) ? 1 : 0;
        const entities = readPolylineEntities(record, vertexRecords);
        if (entities === null) {
          state.skippedEntityCount += 1;
        } else {
          pushEntities(state, entities, transform);
        }
        break;
      }
      case 'INSERT': {
        if (depth + 1 > DXF_MAX_BLOCK_NESTING_DEPTH) {
          // 自分自身を置くブロックもここで止まる(段数だけを見るので無限に回らない)。
          throw new Error(DXF_BLOCK_NESTING_MESSAGE);
        }
        const name = (firstTagValue(record.tags, 2) ?? '').trim().toUpperCase();
        const block = state.blocks.get(name);
        if (block === undefined) {
          // 定義の無いブロックは置きようがないので、知らない実体と同じ扱いで飛ばす。
          state.skippedEntityCount += 1;
          break;
        }
        state.offPlaneCount += isOffPlane(record) ? 1 : 0;
        expandRecords(
          block.records,
          composeTransforms(transform, insertTransform(record, block.base)),
          depth + 1,
          state,
        );
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
        // `POLYLINE` の外側に落ちている頂点。図形にならないので、数えずに捨てる。
        break;
      default:
        // 扱わない実体(`TEXT` / `HATCH` / `DIMENSION` …)。断らずに数だけ残す。
        state.skippedEntityCount += 1;
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * DXF のタグの列(`parseDxfTags` の結果)を実体の列へ畳む。
 *
 * `HEADER` の `$INSUNITS`、`BLOCKS` のブロック定義、`ENTITIES` の実体だけを見て、
 * 他のセクション(`TABLES` / `CLASSES` / `OBJECTS` …)は丸ごと読み飛ばす。
 * `0/EOF` より後ろのタグも読まない。
 *
 * @param tags `parseDxfTags` が読んだタグの列。
 * @returns 実体・単位・数え上げ(`DxfReadResult`)。**座標は換算していない。**
 * @throws {Error} `DXF_UNSUPPORTED_FORMAT_MESSAGE`(`ENDSEC` / `ENDBLK` が無い、
 *   既知の実体に必要な値が無い、半径が 0 以下)、`DXF_BLOCK_NESTING_MESSAGE`(入れ子が 9 段)、
 *   `DXF_NON_UNIFORM_SCALE_MESSAGE`(縦横で倍率の違う配置の中に円弧・楕円がある)、
 *   `DXF_TOO_MANY_ENTITIES_MESSAGE`(展開後の実体が上限を超えた)のいずれかを持つ例外。
 */
export function readDxf(tags: readonly DxfTag[]): DxfReadResult {
  let insUnits: number | null = null;
  let blocks: ReadonlyMap<string, DxfBlock> = new Map<string, DxfBlock>();
  let entityRecords: readonly DxfRecord[] = [];

  let index = 0;
  while (index < tags.length) {
    const tag = tags[index];
    if (tag.code === 0 && tag.value.trim() === 'EOF') {
      break;
    }
    if (tag.code !== 0 || tag.value.trim() !== 'SECTION') {
      index += 1;
      continue;
    }
    const nameTag = tags[index + 1];
    if (nameTag === undefined || nameTag.code !== 2) {
      // セクションの名前が無いと、中身が何かを決められない。
      throw unsupported();
    }
    let end = index + 2;
    while (end < tags.length && !(tags[end].code === 0 && tags[end].value.trim() === 'ENDSEC')) {
      end += 1;
    }
    if (end >= tags.length) {
      throw unsupported();
    }
    const body = tags.slice(index + 2, end);
    switch (nameTag.value.trim()) {
      case 'HEADER':
        insUnits = readInsUnits(body);
        break;
      case 'BLOCKS':
        blocks = readBlocks(body);
        break;
      case 'ENTITIES':
        entityRecords = splitRecords(body);
        break;
      default:
        break;
    }
    index = end + 1;
  }

  const state: ReadState = {
    blocks,
    entities: [],
    skippedEntityCount: 0,
    offPlaneCount: 0,
  };
  expandRecords(entityRecords, IDENTITY_TRANSFORM, 0, state);

  return {
    entities: state.entities,
    unit: toLengthUnit(insUnits),
    insUnits,
    skippedEntityCount: state.skippedEntityCount,
    offPlaneCount: state.offPlaneCount,
    blockCount: blocks.size,
  };
}
