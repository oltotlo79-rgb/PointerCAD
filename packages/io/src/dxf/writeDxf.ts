/**
 * 実体(`DxfEntity`)を DXF R12(AC1009)のテキストへ書き出す(要件 FR-813、
 * 計画書 docs/plans/P6-入出力.md §2.7 タスク25)。
 *
 * 書き出しの 2 段のうちの 1 段目にあたる(読み込みの `readDxf.ts` の逆向き)。
 *
 * ```
 * SketchFeature[] → sketchToDxf(sketch) : DxfEntity[] … スケッチの写し(タスク26。model 側)
 *                 → writeDxf(entities)  : string      … この段
 * ```
 *
 * ## 何を書き、何を書かないか
 *
 * - **版は R12(`$ACADVER` = `AC1009`)**(§0.a-0.30 の承認)。R12 は `ENTITIES` だけで
 *   図が成り立つ最も単純な版で、どの CAD も読める。新しい版は `OBJECTS` / `CLASSES` と
 *   拡張辞書が要り、書く量が 3 倍になる。
 * - **単位は mm 固定(`$INSUNITS` = 4)**(§0.a-0.7「書き出しは常に mm」)。
 *   表示の単位が inch でもファイルの中身は mm(NFR-RE-3)。
 * - **`TABLES` は `LTYPE`(`CONTINUOUS` 1 本)と `LAYER`(使ったレイヤーぶん)だけ**書く。
 *   §2.7 の骨組みは `HEADER` / `ENTITIES` / `EOF` しか描いていないが、**実体が名指しした
 *   レイヤーと線種が表に無い DXF を断る読み手がある**ので、「他 CAD で開ける最小」
 *   (タスク25 の検証表の判断基準)を満たすためにこの 2 つだけ足す。逆に
 *   `VPORT` / `STYLE` / `VIEW` は名指ししないので書かない。
 * - **文字・寸法・線種の使い分け・レイヤーの色分けは書かない**(FR-730 は P8。§0.a-0.30)。
 *
 * ## R12 に無い実体の落とし方(楕円・自由曲線)
 *
 * `ELLIPSE` と `SPLINE` と `LWPOLYLINE` は **R13 以降**の実体で、R12 には無い。
 * §0.a-0.30 は「書き出しは R12」と「書き出す実体に `ELLIPSE` / `SPLINE` / `LWPOLYLINE` を
 * 含める」を両方書いていて、そのままでは両立しない。**版のほうを守り、楕円と自由曲線は
 * `POLYLINE` + `VERTEX` + `SEQEND`(R12 で読める折れ線)へ落とす**ことにした。理由は、
 * §0.a-0.30 が R12 を選んだ根拠が「どの CAD も読める」ことであり、AC1009 と名乗る
 * ファイルに R13 の実体を混ぜると**その根拠がそのまま崩れる**ため。
 * 形が変わる読み替えなので、**落とした本数を `DxfWriteResult.flattenedCurveCount` に残す**
 * (案内を出すかどうかは画面を持つ上の段の判断。FR-504「止めずに警告する」)。
 *
 * 落とすときの分割の細かさは 1 か所に置く。楕円は `ELLIPSE_SEGMENTS_PER_TURN`(この
 * ファイルの定数)、自由曲線は `sampleSpline`(`@pointercad/model`)の既定
 * (`SPLINE_SEGMENTS_PER_SPAN`)で、**画面に描いている折れ線と同じ細かさ・同じ式**にする。
 *
 * ## `@pointercad/model` の評価関数を借りている理由
 *
 * 自由曲線の折れ線は `sampleSpline`、楕円の方位角 → 媒介変数は `azimuthToEllipseParameter`
 * を使う。`packages/io` は既に `@pointercad/model` に依存していて(`package.json` の
 * `dependencies`、`eslint.config.js` も io → model を許している)、**B スプラインの式を
 * 3 つ目に写すと、画面に見えている曲線と書き出した折れ線が食い違う**ため。
 * (同じ式は kernel と model に既に 2 つあり、model 側の注釈がその事情を書いている。)
 *
 * ## 決定性(§0.a-0.62)
 *
 * 同じ実体の列からは必ず同じ文字列ができる。日時・作成者・乱数を一切書かず、
 * 数の書き方を `formatDxfNumber` の 1 か所へ寄せ(9 桁で丸め・末尾の 0 を落とし・`-0` を
 * 書かない)、レイヤーの並びは**実体に出てきた順**に固定しているため。
 */

import { azimuthToEllipseParameter, sampleSpline, type Vec3 } from '@pointercad/model';

import type { DxfPoint2d } from './dxfCurves.js';
import { formatDxfTags, type DxfTag } from './dxfTags.js';
import type {
  DxfArcEntity,
  DxfEllipseEntity,
  DxfEntity,
  DxfEntityBase,
  DxfLineEntity,
  DxfPointEntity,
  DxfSplineEntity,
} from './readDxf.js';

/**
 * 書き出せない値の実体が混じっていたときに利用者へ見せる日本語(NFR-UX-5)。
 * 有限でない座標・0 以下の半径・点が 1 つしかない曲線・行を割る文字を含むレイヤー名を、
 * この 1 文で断る(利用者にとっては「この図形は DXF にできない」という同じ 1 つの事実のため)。
 */
export const DXF_WRITE_INVALID_VALUE_MESSAGE = 'DXF に書き出せない値の図形が含まれています。';

/** 書き出す版(§0.a-0.30)。 */
export const DXF_WRITE_ACAD_VERSION = 'AC1009';

/** 書き出す単位(§0.a-0.7。4 = mm)。 */
export const DXF_WRITE_INSUNITS = 4;

/** 実体がレイヤーを持たないときに使うレイヤー(§0.a-0.30「レイヤーは 1 枚(`0`)だけ」)。 */
const DEFAULT_LAYER = '0';

/** すべての実体が使う線種。R12 の `LTYPE` 表に 1 本だけ書く。 */
const CONTINUOUS_LINETYPE = 'CONTINUOUS';

/** 小数点以下の桁数(§2.7「小数点以下 9 桁」。`.pcad` の丸めと揃える)。 */
const DECIMALS = 9;

/** 全周の楕円を折れ線へ落とすときの分割数(5 度ごと)。**分割の細かさはここ 1 か所。** */
const ELLIPSE_SEGMENTS_PER_TURN = 72;

const FULL_TURN_DEGREES = 360;

/**
 * 全周とみなす角度の差(度)。ちょうど 360 度を期待するが、円弧を回した実体
 * (`readDxf.ts` の `transformArc`)は最後の桁が動くので、厳密な比較はできない。
 */
const FULL_TURN_EPSILON = 1e-9;

/** 色(グループ 62)として書ける範囲。R12 の色番号は 0〜256、負は「表示を消してある」。 */
const MIN_COLOR = -255;
const MAX_COLOR = 256;

/** `POLYLINE` の 70 の bit 1(閉じている)。 */
const POLYLINE_CLOSED_FLAG = 1;

/** レイヤーの表に書く色(7 = 白/黒。図の色は実体ごとの 62 で持つ)。 */
const LAYER_TABLE_COLOR = 7;

/** 書き出しの結果。**上の段(タスク26)が案内の文言を組み立てるための材料を持つ。** */
export interface DxfWriteResult {
  /** DXF のテキスト(改行は `\r\n`)。 */
  readonly text: string;
  /**
   * 折れ線へ落とした曲線(楕円・自由曲線)の数。R12 に `ELLIPSE` / `SPLINE` が無いため、
   * **形がわずかに変わる**ことを利用者へ知らせられるように数える。
   */
  readonly flattenedCurveCount: number;
}

/**
 * 折れ線へ落とした曲線があったときに見せる日本語(NFR-UX-5)。
 * 文言を組み立てる場所を 1 か所にして、画面(P6 の書き出しの窓)と検査で同じ文にする。
 */
export function dxfFlattenedCurveMessage(count: number): string {
  return `${String(count)} 個の曲線は折れ線に近づけて書き出しました。`;
}

/**
 * 数を DXF の値として書く形にする(§2.7)。
 *
 * - **小数点以下 9 桁で丸める**(`.pcad` の 9 桁の丸めと揃える)。
 * - **末尾の 0 を落とす**(`1.500000000` ではなく `1.5`)。
 * - **`-0` を書かない**(`0` にする。同じ形から違うバイト列ができないようにするため)。
 * - **指数表記にしない**(`1e-7` のような書き方を受け取れない読み手があるため)。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。有限でない数
 *   (`NaN` / `±Infinity`)と、10 の 21 乗以上で指数表記になってしまう数のとき。
 *   mm の座標としては現実に無い大きさなので、書かずに断る。
 */
export function formatDxfNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  // `toFixed` は 10 の 21 乗以上で指数表記になる。その形は下の点検で断る。
  const fixed = value.toFixed(DECIMALS);
  if (fixed.includes('e') || fixed.includes('E')) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  // `toFixed` は必ず小数点を書くので、末尾の 0 と小数点は同じ 1 つの式で落とせる。
  const trimmed = fixed.replace(/\.?0+$/, '');
  // `-0.0000000001` は `-0.000000000` へ丸まる。符号だけが残らないようにする。
  return trimmed === '-0' ? '0' : trimmed;
}

/** 度を `[0, 360)` へ畳む。`-0` は作らない(`readDxf.ts` の決めと揃える)。 */
function foldDegrees(degrees: number): number {
  const wrapped = degrees % FULL_TURN_DEGREES;
  const positive = wrapped < 0 ? wrapped + FULL_TURN_DEGREES : wrapped;
  return positive === 0 ? 0 : positive;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / (FULL_TURN_DEGREES / 2);
}

function tag(code: number, value: string): DxfTag {
  return { code, value };
}

function numberTag(code: number, value: number): DxfTag {
  return { code, value: formatDxfNumber(value) };
}

/**
 * レイヤー名を確かめる。空なら `0` へ寄せる(DXF は空の名前を持てない)。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。改行を含むとき。
 *   DXF は「1 行 = 1 つの値」なので、改行の入った名前を書くと**タグの対応がずれた
 *   読めないファイル**ができる(黙って詰めると別のレイヤーに化けるので、詰めずに断る)。
 */
function layerName(entity: DxfEntityBase): string {
  if (entity.layer.includes('\n') || entity.layer.includes('\r')) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  return entity.layer === '' ? DEFAULT_LAYER : entity.layer;
}

/**
 * すべての実体に共通の欄(レイヤー・色)。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。色が整数でないか、
 *   R12 の色番号の範囲の外のとき(読み直せない値を書かないため)。
 */
function baseTags(entity: DxfEntityBase): DxfTag[] {
  const tags: DxfTag[] = [tag(8, layerName(entity))];
  if (entity.color !== null) {
    if (!Number.isInteger(entity.color) || entity.color < MIN_COLOR || entity.color > MAX_COLOR) {
      throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
    }
    tags.push(tag(62, String(entity.color)));
  }
  return tags;
}

/** 1 点(グループ `code` / `code + 10` / `code + 20`)。**Z は必ず 0**(平らな図。§0.a-0.34)。 */
function pointTags(code: number, point: DxfPoint2d): DxfTag[] {
  return [numberTag(code, point.x), numberTag(code + 10, point.y), numberTag(code + 20, 0)];
}

function writePointEntity(entity: DxfPointEntity): DxfTag[] {
  return [tag(0, 'POINT'), ...baseTags(entity), ...pointTags(10, entity.position)];
}

function writeLineEntity(entity: DxfLineEntity): DxfTag[] {
  return [
    tag(0, 'LINE'),
    ...baseTags(entity),
    ...pointTags(10, entity.start),
    ...pointTags(11, entity.end),
  ];
}

/**
 * 円弧。**全周なら `CIRCLE`、それ以外は `ARC`**(§2.7)。
 *
 * `ARC` の開始角(50)・終了角(51)は**度**で、**DXF の円弧は必ず反時計回りに
 * 50 から 51 へ回る**。実体のほうは `endAngle − startAngle` が符号つきの中心角なので、
 * **時計回り(差が負)のときは始めと終わりを入れ替える**(同じ形の円弧になる。
 * 向きそのものは DXF に書けないので、読み直すと反時計回りとして戻る)。
 *
 * 差が 0 の円弧は `CIRCLE` として書く。`readDxf.ts` が「50 と 51 が同じなら全周」と
 * 読む約束なので、読み書きで同じ図形になるほうへ揃える。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。半径が 0 以下のとき
 *   (`readDxf.ts` が 0 以下の半径を断るので、読み直せない DXF を作らないため)。
 */
function writeArcEntity(entity: DxfArcEntity): DxfTag[] {
  if (!(entity.radius > 0)) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  const head = [...baseTags(entity), ...pointTags(10, entity.center), numberTag(40, entity.radius)];
  const sweep = entity.endAngle - entity.startAngle;
  if (Math.abs(sweep) >= FULL_TURN_DEGREES - FULL_TURN_EPSILON || sweep === 0) {
    return [tag(0, 'CIRCLE'), ...head];
  }
  const counterClockwise = sweep > 0;
  const start = counterClockwise ? entity.startAngle : entity.endAngle;
  const end = counterClockwise ? entity.endAngle : entity.startAngle;
  return [
    tag(0, 'ARC'),
    ...head,
    numberTag(50, foldDegrees(start)),
    numberTag(51, foldDegrees(end)),
  ];
}

/**
 * 折れ線(`POLYLINE` + `VERTEX` + `SEQEND`)。**R12 に `LWPOLYLINE` は無い**ので、
 * 頂点を別々の実体として並べるこの形で書く。
 *
 * `66`(頂点が続く)は R12 の `POLYLINE` に必須で、`10` / `20` / `30` は使われないが
 * 書く決まりになっている(読み手はここを見ない。`readDxf.ts` も見ていない)。
 */
function writePolyline(
  entity: DxfEntityBase,
  points: readonly DxfPoint2d[],
  closed: boolean,
): DxfTag[] {
  const base = baseTags(entity);
  const tags: DxfTag[] = [
    tag(0, 'POLYLINE'),
    ...base,
    tag(66, '1'),
    tag(70, String(closed ? POLYLINE_CLOSED_FLAG : 0)),
    ...pointTags(10, { x: 0, y: 0 }),
  ];
  for (const point of points) {
    tags.push(tag(0, 'VERTEX'), ...base, ...pointTags(10, point));
  }
  tags.push(tag(0, 'SEQEND'), ...base);
  return tags;
}

/**
 * 楕円(弧)を折れ線へ落とす。**方位角を等分**し、`azimuthToEllipseParameter`
 * (`@pointercad/model`)で媒介変数へ直してから楕円の上の点を求める。
 *
 * 等分するのを媒介変数ではなく方位角にしたのは、`DxfEllipseGeometry` の開始角・終了角が
 * 方位角で、**端の点が必ず指定どおりの位置に来る**ようにするため
 * (媒介変数で等分しても端は合うが、開始角から測った角度の刻みが素直にならない)。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。半径が 0 以下のとき。
 */
function writeEllipseEntity(entity: DxfEllipseEntity): DxfTag[] {
  if (!(entity.majorRadius > 0) || !(entity.minorRadius > 0)) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  const sweep = entity.endAngle - entity.startAngle;
  const closed = Math.abs(sweep) >= FULL_TURN_DEGREES - FULL_TURN_EPSILON || sweep === 0;
  const turn = closed ? (sweep < 0 ? -FULL_TURN_DEGREES : FULL_TURN_DEGREES) : sweep;
  // 全周は分割数ぶんの頂点(最後の点は先頭と重なるので置かない)。弧は両端を含める。
  const segments = Math.max(
    2,
    Math.round((ELLIPSE_SEGMENTS_PER_TURN * Math.abs(turn)) / FULL_TURN_DEGREES),
  );
  const rotation = toRadians(entity.rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points: DxfPoint2d[] = [];
  const lastIndex = closed ? segments - 1 : segments;
  for (let index = 0; index <= lastIndex; index += 1) {
    const azimuth = toRadians(entity.startAngle + (turn * index) / segments);
    const parameter = azimuthToEllipseParameter(azimuth, entity.majorRadius, entity.minorRadius);
    // 長軸を第 1 軸に取った座標で点を出し、傾きのぶんだけ回してから中心へ寄せる。
    const localX = entity.majorRadius * Math.cos(parameter);
    const localY = entity.minorRadius * Math.sin(parameter);
    points.push({
      x: entity.center.x + localX * cos - localY * sin,
      y: entity.center.y + localX * sin + localY * cos,
    });
  }
  return writePolyline(entity, points, closed);
}

/**
 * 自由曲線を折れ線へ落とす。**`sampleSpline`(`@pointercad/model`)で画面と同じ折れ線**を
 * 作る(このファイル冒頭の「評価関数を借りている理由」)。
 *
 * 閉じた曲線は最後の点が先頭と重なるので 1 つ落とし、`POLYLINE` の 70 の bit 1 で閉じる
 * (`readDxf.ts` の `splineFromDxf` が「閉じるための重複点は持たない」と決めているのと同じ約束)。
 *
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。折れ線が 2 点未満のとき
 *   (点が 1 つの曲線は形が決まらず、書いても読み直すと消えるため)。
 */
function writeSplineEntity(entity: DxfSplineEntity): DxfTag[] {
  const sampled = sampleSpline({
    kind: 'spline',
    // `featureId` は `sampleSpline` が見ない欄(曲線の形は点・方式・閉じかだけで決まる)。
    featureId: '',
    mode: entity.mode,
    points: entity.points.map((point): Vec3 => [point.x, point.y, 0]),
    closed: entity.closed,
  });
  // 閉じた曲線の折れ線は先頭へ戻る点で終わるので、その 1 点を落としてから閉じる旗を立てる。
  const trimmed = entity.closed ? sampled.slice(0, -1) : sampled;
  if (trimmed.length < 2) {
    throw new Error(DXF_WRITE_INVALID_VALUE_MESSAGE);
  }
  const points = trimmed.map((point): DxfPoint2d => ({ x: point[0], y: point[1] }));
  return writePolyline(entity, points, entity.closed);
}

/** 1 つの実体のタグ。折れ線へ落としたかどうかも返す(案内の件数を数えるため)。 */
function writeEntity(entity: DxfEntity): { readonly tags: DxfTag[]; readonly flattened: boolean } {
  switch (entity.kind) {
    case 'point':
      return { tags: writePointEntity(entity), flattened: false };
    case 'line':
      return { tags: writeLineEntity(entity), flattened: false };
    case 'arc':
      return { tags: writeArcEntity(entity), flattened: false };
    case 'ellipse':
      return { tags: writeEllipseEntity(entity), flattened: true };
    case 'spline':
      return { tags: writeSplineEntity(entity), flattened: true };
  }
}

/** `HEADER` セクション。**版と単位だけ**を書く(§2.7 の骨組み)。 */
function headerTags(): DxfTag[] {
  return [
    tag(0, 'SECTION'),
    tag(2, 'HEADER'),
    tag(9, '$ACADVER'),
    tag(1, DXF_WRITE_ACAD_VERSION),
    tag(9, '$INSUNITS'),
    tag(70, String(DXF_WRITE_INSUNITS)),
    tag(0, 'ENDSEC'),
  ];
}

/**
 * `TABLES` セクション。**線種 1 本とレイヤーの表だけ**を書く。
 * レイヤーは**実体に出てきた順**に並べ、`0` は実体が使っていなくても必ず先頭に置く
 * (どの CAD も `0` があることを前提にしているため)。
 */
function tablesTags(layers: readonly string[]): DxfTag[] {
  const tags: DxfTag[] = [
    tag(0, 'SECTION'),
    tag(2, 'TABLES'),
    tag(0, 'TABLE'),
    tag(2, 'LTYPE'),
    tag(70, '1'),
    tag(0, 'LTYPE'),
    tag(2, CONTINUOUS_LINETYPE),
    tag(70, '0'),
    tag(3, 'Solid line'),
    // 72 = 65 は 'A'(整列の種類)。73 = 0 本の破線、40 = 模様の長さ 0 で「実線」を表す。
    tag(72, '65'),
    tag(73, '0'),
    tag(40, '0'),
    tag(0, 'ENDTAB'),
    tag(0, 'TABLE'),
    tag(2, 'LAYER'),
    tag(70, String(layers.length)),
  ];
  for (const layer of layers) {
    tags.push(
      tag(0, 'LAYER'),
      tag(2, layer),
      tag(70, '0'),
      tag(62, String(LAYER_TABLE_COLOR)),
      tag(6, CONTINUOUS_LINETYPE),
    );
  }
  tags.push(tag(0, 'ENDTAB'), tag(0, 'ENDSEC'));
  return tags;
}

/** 実体が使っているレイヤーを、出てきた順に並べる(`0` は必ず先頭)。 */
function collectLayers(entities: readonly DxfEntity[]): readonly string[] {
  const layers: string[] = [DEFAULT_LAYER];
  for (const entity of entities) {
    const name = layerName(entity);
    if (!layers.includes(name)) {
      layers.push(name);
    }
  }
  return layers;
}

/**
 * 実体の列を DXF R12 のテキストへ書き出し、**折れ線へ落とした曲線の数も返す**。
 *
 * @param entities 書き出す実体。空でもよい(骨だけの、他 CAD で開ける DXF ができる)。
 * @returns テキストと、折れ線へ落とした曲線の数。
 * @throws {Error} `DXF_WRITE_INVALID_VALUE_MESSAGE` を持つ例外。有限でない座標・
 *   0 以下の半径・点が 1 つしかない曲線・改行を含むレイヤー名・範囲外の色のとき。
 *   **途中まで書いた分を返さない**のは、欠けた図形のファイルを「書けた」ことに
 *   しないため(読み込みの段と同じ考え方)。
 */
export function writeDxfDocument(entities: readonly DxfEntity[]): DxfWriteResult {
  const tags: DxfTag[] = [
    ...headerTags(),
    ...tablesTags(collectLayers(entities)),
    tag(0, 'SECTION'),
    tag(2, 'ENTITIES'),
  ];
  let flattenedCurveCount = 0;
  for (const entity of entities) {
    const written = writeEntity(entity);
    tags.push(...written.tags);
    if (written.flattened) {
      flattenedCurveCount += 1;
    }
  }
  tags.push(tag(0, 'ENDSEC'), tag(0, 'EOF'));
  return { text: formatDxfTags(tags), flattenedCurveCount };
}

/**
 * 実体の列を DXF R12 のテキストへ書き出す(計画書 タスク25 手順 2 の入口)。
 * 折れ線へ落とした曲線の数が要るときは `writeDxfDocument` を使う。
 *
 * @throws {Error} `writeDxfDocument` と同じ。
 */
export function writeDxf(entities: readonly DxfEntity[]): string {
  return writeDxfDocument(entities).text;
}
