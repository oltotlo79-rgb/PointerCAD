/**
 * すみ肉溶接のビード1区間の保存の形と、そこから組む部品。脚 `legOnSecond`(局所 X)と `legOnFirst`(局所 Y)の
 * 直角三角形の断面を、局所 +Z へ `length` だけ押し出す。台本に持つのは脚長・長さ・溶接の記録だけで、形は既存の
 * フィーチャーで組み直す。円筒外面では第2脚を円弧長とし、半径を版3へ保存して円弧と2直線の断面を押し出す。
 */

import { evaluateExpression, exactExpressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, nextSolidId, nextSolidName, replaceSketch } from '../../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName } from '../../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../../sketch/planeMath.js';
import type { SketchArcFeature, SketchFaceFeature, SketchLineFeature } from '../../sketch/types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { cylindricalWeldSection } from './cylindricalWeld.js';
import { MAX_WELD_SEGMENTS, segmentWithinContact } from './stationing.js';
import {
  FILLET_WELD_CATALOG_REVISION, FILLET_WELD_INNER_CYLINDRICAL_GENERATOR_REVISION, FILLET_WELD_CYLINDRICAL_GENERATOR_REVISION, FILLET_WELD_GENERATOR_REVISION, FILLET_WELD_OBLIQUE_GENERATOR_REVISION, weldCrossSectionIssue,
  weldInteriorAngle, type WeldInteriorAngle,
} from './types.js';

/** 1区間の保存した指定が表すもの。 */
export interface FilletWeldSegmentOptions {
  readonly weldId: string;
  readonly segment: number;
  readonly station: number;
  readonly length: number;
  readonly contactLength: number;
  /** 溶接した2部品(1つ目の面の部品、2つ目の面の部品)の id。 */
  readonly parts: readonly [string, string];
  /** 直角でない当たりの内角(度、欄 `weldAngle`)。直角のビードは持たない。 */
  readonly interiorAngleDegrees?: number;
  /** Exact contact radius; exterior revision 3 or explicit interior revision 4. */
  readonly cylindricalRadius?: number;
  readonly cylindricalSide?: 'interior';
}

/** Version is derived from validated persisted geometry, not from the current face. */
export function filletWeldSegmentRevision(segment: FilletWeldSegmentOptions): string {
  return segment.cylindricalSide === 'interior' ? FILLET_WELD_INNER_CYLINDRICAL_GENERATOR_REVISION
    : segment.cylindricalRadius !== undefined ? FILLET_WELD_CYLINDRICAL_GENERATOR_REVISION
      : segment.interiorAngleDegrees === undefined ? FILLET_WELD_GENERATOR_REVISION : FILLET_WELD_OBLIQUE_GENERATOR_REVISION;
}

function numberText(value: number): string {
  // 往復で同じ値に戻る最短の10進。利用者の値を丸めない。`length` は式として評価するので、式の文法に無い
  // 指数表記(String(1e-7) = '1e-7')を使わず、既存の `exactExpressionValueFromNumber` の普通の 10 進で書く。
  return exactExpressionValueFromNumber(value).source;
}

/**
 * ビードの区間の出どころを作る唯一の口(版を書き忘れない)。直角(`interiorAngleDegrees` が無い)は従来と同じ欄と
 * 版のまま。直角でない時だけ欄 `weldAngle` と版 `fillet-weld-2` を持つ。
 */
export function createFilletWeldSource(
  legOnSecond: number, legOnFirst: number, segment: FilletWeldSegmentOptions,
): StandardPartSource {
  const angle = segment.interiorAngleDegrees;
  const radius = segment.cylindricalRadius;
  return {
    kind: 'standardPart', catalog: 'filletWeld', size: `${numberText(legOnSecond)}x${numberText(legOnFirst)}`,
    options: {
      length: numberText(segment.length),
      weldId: segment.weldId,
      weldSegment: String(segment.segment),
      weldStation: numberText(segment.station),
      contactLength: numberText(segment.contactLength),
      weldParts: writeWeldParts(segment.parts),
      ...(angle === undefined ? {} : { weldAngle: numberText(angle) }),
      ...(radius === undefined ? {} : { weldCylinderRadius: numberText(radius) }),
      ...(segment.cylindricalSide === undefined ? {} : { weldCylinderSide: segment.cylindricalSide }),
    },
    catalogRevision: FILLET_WELD_CATALOG_REVISION,
    generatorRevision: filletWeldSegmentRevision(segment),
  };
}

/**
 * 保存した欄 `weldAngle` の内角。欄が無ければ直角(`null`)、扱える範囲の外・直角・崩れた値は `undefined`
 * (別の形で代えない)。
 */
export function filletWeldOptionAngle(options: Readonly<Record<string, string>>): WeldInteriorAngle | null | undefined {
  if (options.weldAngle === undefined) return null;
  const degrees = positiveNumber(options.weldAngle);
  return degrees === null ? undefined : weldInteriorAngle(degrees) ?? undefined;
}

function positiveNumber(text: string | undefined): number | null {
  if (text === undefined || !/^[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?$/i.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  if (text.trim() === '0') return 0;
  return positiveNumber(text);
}

/** `size`(`<legOnSecond>x<legOnFirst>`)の脚長。形が崩れていれば `null`。 */
export function filletWeldLegs(size: string): { readonly legOnSecond: number; readonly legOnFirst: number } | null {
  const parts = size.split('x');
  if (parts.length !== 2) return null;
  const legOnSecond = positiveNumber(parts[0]);
  const legOnFirst = positiveNumber(parts[1]);
  return legOnSecond === null || legOnFirst === null ? null : { legOnSecond, legOnFirst };
}

function segmentIndex(text: string | undefined): number | null {
  if (text === undefined || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value < MAX_WELD_SEGMENTS ? value : null;
}

/** 溶接した2部品の id を、読点を含んでも失わずに書く印付きの版の頭(この版の値は読点を1つも含まない)。 */
const WELD_PARTS_MARKED_PREFIX = 'v2:';

/**
 * 欄 `weldParts` を書く唯一の口。どちらの id も読点を含まなければ従来どおり `<1つ目>,<2つ目>`(古い保存と同じバイト)。
 * 読点を含む時だけ印付きの版 `v2:<1つ目>:<2つ目>` で書き、各 id の `%`・`,`・`:` を `%25`・`%2C`・`%3A` に置き換える。
 * 印付きの版は読点を含まないので、読点がちょうど1つの従来の値と取り違えない。
 */
function writeWeldParts(parts: readonly [string, string]): string {
  if (!parts[0].includes(',') && !parts[1].includes(',')) return `${parts[0]},${parts[1]}`;
  const escape = (id: string): string => id.replace(/[%,:]/g, (character) => (character === '%' ? '%25' : character === ',' ? '%2C' : '%3A'));
  return `${WELD_PARTS_MARKED_PREFIX}${escape(parts[0])}:${escape(parts[1])}`;
}

/**
 * 欄 `weldParts` を読む唯一の口。読点がちょうど1つなら従来の読み方、読点が無く印で始まれば印付きの版、他は `null`
 * (読点が2つ以上の値はどこで分けるか決まらないので推し量らない)。空の id・同じ id・欄の数の違い・知らない `%` の並び・
 * 読点を含まない2つの id を印付きの版で書いた値(書く口が作らない、同じ2部品の2通り目の書き方)も `null`。
 */
function readWeldParts(text: string | undefined): readonly [string, string] | null {
  if (text === undefined) return null;
  const pieces = text.split(',');
  if (pieces.length === 2) return distinctParts(pieces[0], pieces[1]);
  if (pieces.length !== 1 || !text.startsWith(WELD_PARTS_MARKED_PREFIX)) return null;
  const fields = text.slice(WELD_PARTS_MARKED_PREFIX.length).split(':');
  if (fields.length !== 2 || !fields.every((field) => /^(?:[^%]|%25|%2C|%3A)*$/.test(field))) return null;
  const ids = fields.map((field) => field.replace(/%(?:25|2C|3A)/g,
    (escaped) => (escaped === '%25' ? '%' : escaped === '%2C' ? ',' : ':')));
  return ids.some((id) => id.includes(',')) ? distinctParts(ids[0], ids[1]) : null;
}

function distinctParts(first: string | undefined, second: string | undefined): readonly [string, string] | null {
  return first === undefined || second === undefined || first === '' || second === '' || first === second ? null : [first, second];
}

/**
 * 保存した区間の溶接の記録。欄が1つでも欠ける・崩れていれば `null`。区間の番号は 0 以上の安全な整数で上限未満、
 * 溶接した2部品は別々の id、始点と長さは計画と同じ `segmentWithinContact` の規則で当たりの辺の内側。
 */
export function filletWeldSegmentOptions(options: Readonly<Record<string, string>>): FilletWeldSegmentOptions | null {
  const length = positiveNumber(options.length);
  const station = nonNegativeNumber(options.weldStation);
  const contactLength = positiveNumber(options.contactLength);
  const segment = segmentIndex(options.weldSegment);
  const weldId = options.weldId;
  const parts = readWeldParts(options.weldParts);
  const angle = filletWeldOptionAngle(options);
  const radius = options.weldCylinderRadius === undefined ? undefined : positiveNumber(options.weldCylinderRadius);
  const side = options.weldCylinderSide;
  if (side !== undefined && (side !== 'interior' || radius === undefined)) return null;
  if (length === null || station === null || contactLength === null || segment === null
    || weldId === undefined || weldId === '' || parts === null
    || !segmentWithinContact(station, length, contactLength) || angle === undefined
    || radius === null || (radius !== undefined && angle !== null)) return null;
  return { weldId, segment, station, length, contactLength, parts,
    ...(angle === null ? {} : { interiorAngleDegrees: angle.degrees }),
    ...(radius === undefined ? {} : { cylindricalRadius: radius }),
    ...(side === undefined ? {} : { cylindricalSide: side }) };
}

/** ビードの部品を組む。知らない版・崩れた値は `null`(別の形で代えない)。 */
export function buildFilletWeldPart(source: StandardPartSource): PartDocument | null {
  if (source.catalog !== 'filletWeld' || source.catalogRevision !== FILLET_WELD_CATALOG_REVISION) return null;
  const legs = filletWeldLegs(source.size);
  const segment = filletWeldSegmentOptions(source.options);
  const length = source.options.length === undefined ? null : evaluateExpression(source.options.length);
  if (legs === null || segment === null || length === null || !length.ok || !(length.value.value > 0)) return null;
  // 版と欄が対で一致する時だけ組む(版 1 に内角の欄・版 2 に欄なしは崩れた台本)。
  const angle = segment.interiorAngleDegrees === undefined ? null : weldInteriorAngle(segment.interiorAngleDegrees);
  const radius = segment.cylindricalRadius;
  const curved = radius === undefined ? undefined : cylindricalWeldSection(radius, legs.legOnSecond, legs.legOnFirst, segment.cylindricalSide);
  if (curved === null) return null;
  const expectedRevision = filletWeldSegmentRevision(segment);
  // 計画と同じ条件(直角も同じ基準): 平行に近い内角はこの脚長では断面を許容差の中で決められず、細すぎる断面は
  // 許容差より薄いので組まない。
  if (source.generatorRevision !== expectedRevision || weldCrossSectionIssue(legs.legOnSecond, legs.legOnFirst, angle) !== null) return null;
  let document = createEmptyPartDocument();
  let sketch = document.sketches.find((candidate) => candidate.id === document.activeSketchId);
  if (sketch === undefined) return null;
  const pointIds: string[] = [];
  // 断面: 直角の角(0,0)、2 つ目の面の上の脚の先(legOnSecond,0)、1 つ目の面の上の脚の先。直角でない時の最後の点は
  // 内角の向きの実座標(legOnFirst cos θ, legOnFirst sin θ)で、座標系は歪めない。
  const firstLegTip: readonly [number, number] = angle === null ? [0, legs.legOnFirst]
    : [legs.legOnFirst * angle.cos, legs.legOnFirst * angle.sin];
  if (curved !== undefined && radius !== undefined) {
    const arc: SketchArcFeature = {
      id: nextFeatureId(sketch, 'arc'), name: nextFeatureName(sketch, 'arc'), planeId: DEFAULT_WORK_PLANE_ID,
      kind: 'arc', construction: false, center: absoluteCoordinate(0, segment.cylindricalSide === 'interior' ? radius : -radius, 0),
      radius: exactExpressionValueFromNumber(radius),
      startAngle: exactExpressionValueFromNumber(segment.cylindricalSide === 'interior' ? -90 : 90),
      endAngle: exactExpressionValueFromNumber(segment.cylindricalSide === 'interior'
        ? -90 + curved.angleRadians * 180 / Math.PI : 90 - curved.angleRadians * 180 / Math.PI),
    };
    sketch = appendFeature(sketch, arc);
    pointIds.push(arc.id);
    const endpoints = [curved.toe, [0, legs.legOnFirst], [0, 0]] as const;
    for (let index = 0; index < 2; index += 1) {
      const from = endpoints[index], to = endpoints[index + 1];
      const line: SketchLineFeature = {
        id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), planeId: DEFAULT_WORK_PLANE_ID,
        kind: 'line', construction: false,
        from: absoluteCoordinate(from[0], from[1], 0), to: absoluteCoordinate(to[0], to[1], 0),
      };
      sketch = appendFeature(sketch, line);
      pointIds.push(line.id);
    }
  } else {
    for (const [x, y] of [[0, 0], [legs.legOnSecond, 0], firstLegTip] as const) {
      const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
      sketch = appendFeature(sketch, point);
      pointIds.push(point.id);
    }
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'), name: nextFeatureName(sketch, 'face'), planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face', boundary: pointIds.map((featureId) => ({ featureId })), color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  document = replaceSketch(document, sketch);
  const extrude: ExtrudeFeature = {
    id: nextSolidId(document, 'extrude'), name: nextSolidName(document, 'extrude'), suppressed: false, kind: 'extrude',
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: length.value, reversed: false, symmetric: false,
  };
  document = appendSolid(document, extrude);
  // 名前は表示だけ(内角は 0.1° で丸めて見せる。保存した値・形は丸めない)。
  const angleText = angle === null ? '' : ` ${String(Math.round(angle.degrees * 10) / 10)}°`;
  return { ...document, name: `すみ肉溶接 ${numberText(legs.legOnSecond)}×${numberText(legs.legOnFirst)}${angleText} 長さ${length.value.source}` };
}

/**
 * ビードの公称体積(mm³)= 三角形の面積 × 長さ。面積は直角なら脚の積 / 2、直角でなければ脚の積 × sin θ / 2。
 * 実カーネルの体積検査の独立した期待値。
 */
export function filletWeldNominalVolume(
  legOnSecond: number, legOnFirst: number, length: number, angle: WeldInteriorAngle | null = null,
): number {
  return angle === null ? legOnSecond * legOnFirst / 2 * length : legOnSecond * legOnFirst * angle.sin / 2 * length;
}
