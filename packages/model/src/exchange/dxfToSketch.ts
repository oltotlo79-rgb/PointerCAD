/**
 * DXF の実体をスケッチの要素へ写す(要件 FR-813・FR-301〜318・FR-202、計画書
 * docs/plans/P6-入出力.md §2.7・§0.a-0.32〜0.33、タスク26)。
 *
 * 読み込みの 3 段のうちの 3 段目にあたる(計画書 §2.7)。
 *
 * ```
 * テキスト → parseDxfTags(text)      : DxfTag[]         … 字句(タスク22。io)
 *          → readDxf(tags)           : DxfReadResult    … 実体(タスク24。io)
 *          → dxfToSketch(entities, …): SketchFeature[]  … この段(model)
 * ```
 *
 * ## 何をして、何をしないか
 *
 * - **新しい `SketchFeature` の種類を 1 つも作らない**(計画書 タスク26)。DXF の 5 種は
 *   既にある `point` / `line` / `arc` / `ellipse` / `spline` へそのまま写る。
 *   多角形(`LWPOLYLINE` / `POLYLINE`)と `INSERT` は `io` の段で線分・円弧へ開かれ、
 *   円は「開始 0 度・終了 360 度の円弧」になっているので、ここでの分岐は 5 つで済む。
 * - **単位の換算はここでする**(`io` の段は「ファイルに書かれた数のまま」返す)。
 *   `$INSUNITS` が inch なら 25.4 倍、`'other'`(フィート・メートル等)なら
 *   **呼び手が利用者へ訊いた倍率**(`unitOverrideMm`)を掛ける(計画書 §0.a-0.6)。
 * - **座標の式は小数の文字列そのまま**(FR-202)。式を作るのは既存の
 *   `expressionValueFromNumber`(有効数字 12 桁)で、**吸い付いた座標を保存するときと
 *   同じ書式にそろえる**(統括の決定 2026-09-06)。取り込んだ数そのものが式になるので
 *   「丸めた表示値を式に書かない」の対象ではなく、12 桁の相対誤差 1e-12 は幾何の許容
 *   (`SKETCH_TOLERANCE_MM` = 1e-6mm、カーネルの 1e-9)より十分小さい。
 *   inch の換算(`3.5in` → 25.4 倍)も、この丸めのおかげで `'88.9'` という読める式になる。
 * - **平面から外れた図形の案内はここで出す。** Z 座標を落とすのは `io` の段だが、
 *   件数(`DxfReadResult.offPlaneCount`)を文言にするのは「利用者へ見せる材料」を
 *   組み立てるこの段の役目(計画書 §0.a-0.33)。**断らない**(取り込めるほうが親切)。
 * - **画面は持たない。** 作図面をどう選ばせるか、案内をどこへ出すか、単位を訊く窓は
 *   `packages/ui`(タスク32)の仕事。ここは純関数だけを置く。
 *
 * ## 断りと、案内だけで済ませるものの線引き
 *
 * **形が決まらない実体だけを落とす**(半径が 0 以下、数が有限でない、スプラインの点が
 * 少なすぎる・多すぎる)。落とした数は `droppedEntityCount` に残し、**残りは取り込む**
 * (FR-504「止めずに警告する」。1 つの図形のせいで図全体が入らないほうが困る)。
 * 一方、**形がわずかに変わるだけのもの**(4 次以上のスプライン、重み付きスプライン)は
 * 取り込んだうえで案内を 1 行出す(`docs/報告記録.md` 2026-09-06 04:55 の統括の決定)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { nextFeatureId, nextFeatureName } from '../sketch/createSketchDocument.js';
import { planeToWorld, type WorkPlane } from '../sketch/planeMath.js';
import {
  MAX_SPLINE_POINTS,
  MIN_CLOSED_SPLINE_POINTS,
  MIN_SPLINE_POINTS,
  SPLINE_TOO_FEW_CLOSED_MESSAGE,
  SPLINE_TOO_FEW_OPEN_MESSAGE,
  SPLINE_TOO_MANY_MESSAGE,
} from '../sketch/splineMath.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFeature,
  SketchFeatureKind,
} from '../sketch/types.js';
import { MM_PER_INCH } from '../units/length.js';
import type { SketchDxfEntity, SketchDxfLengthUnit, SketchDxfPoint2d } from './dxfTypes.js';

/**
 * 平面から外れた図形があったときの案内(計画書 §0.a-0.33 の文言そのまま)。
 * 文言を組み立てる場所を 1 か所にして、画面(タスク32)と検査で同じ文にする。
 */
export function dxfOffPlaneMessage(count: number): string {
  return `平面から外れた図形が ${String(count)} 個あります。平らにして取り込みます。`;
}

/**
 * 写し先の自由曲線が扱える次数の上限(`sketch/splineMath.ts` の 3 次まで)。
 * DXF はこれより高い次数を書けるので、超えていたら案内を 1 行出す。
 */
export const MAX_SUPPORTED_SPLINE_DEGREE = 3;

/**
 * 4 次以上のスプラインを 3 次までの曲線へ写したときの案内(統括の決定、
 * `docs/報告記録.md` 2026-09-06 04:55)。`io` の
 * `DXF_SPLINE_WEIGHT_IGNORED_MESSAGE`(重みを捨てたときの案内)と同じ言い回しにそろえる。
 */
export const DXF_SPLINE_DEGREE_REDUCED_MESSAGE = '次数の高い曲線は形が少し変わります。';

/**
 * 取り込めなかった図形の件数の案内(統括の決定 2026-09-06、計画書 §0.a-0.30)。
 *
 * 数えるのは 2 種類あわせた数——**この段が落としたもの**(半径 0、点が多すぎるスプライン等)と、
 * **`io` の段が飛ばした知らない実体**(`DxfReadResult.skippedEntityCount`。`HATCH` / `TEXT` /
 * `DIMENSION` など)。利用者から見ればどちらも「読み込んだら図形が減った」という同じ 1 つの
 * 事実なので、文も 1 つにする。**文言の正本はここ**(`ja.json` には入れない。計画書 §2.8 の
 * 「文言の正本の層」)。
 */
export function dxfDroppedEntitiesMessage(count: number): string {
  return `取り込めなかった図形が ${String(count)} 個あります。`;
}

/** `dxfToSketch` の選択肢。**単位と、`io` が数えた件数**を受け取る。 */
export interface DxfToSketchOptions {
  /** `DxfReadResult.unit`。座標に掛ける倍率をこれで決める。 */
  readonly unit: SketchDxfLengthUnit;
  /**
   * `unit` が `'other'` のときの「1 単位あたりの mm」。**呼び手(タスク32 の窓)が
   * 利用者へ訊いた値**を渡す。渡されない・0 以下・有限でないときは 1(無単位として
   * mm と同じに扱う)。mm / inch のときは見ない。
   */
  readonly unitOverrideMm?: number;
  /**
   * `DxfReadResult.offPlaneCount`(Z が 0 でなかった実体の数)。1 以上なら案内を 1 行出す。
   * **この段には 2 次元の実体しか来ない**(Z を落とすのは `io` の段)ので、数は受け取る。
   */
  readonly offPlaneCount?: number;
  /**
   * `DxfReadResult.skippedEntityCount`(`io` の段が飛ばした知らない実体の数)。
   * この段が落とした数(`droppedEntityCount`)と**合算して 1 行の案内**にする
   * (`dxfDroppedEntitiesMessage`)。
   */
  readonly skippedEntityCount?: number;
  /**
   * 既にスケッチにある要素。**id と名前の連番の続きを決めるためだけ**に使う
   * (取り込んだ要素が既存の要素と同じ id を持たないようにする)。省略すると 1 から始まる。
   */
  readonly existingFeatures?: readonly SketchFeature[];
}

/** `dxfToSketch` の結果。**画面が案内を組み立てるための材料をすべて持つ。** */
export interface DxfToSketchResult {
  /** 写せた要素。履歴へそのまま積める(並びは DXF の実体の並びのまま)。 */
  readonly features: readonly SketchFeature[];
  /**
   * 利用者へ見せる案内(FR-504「止めずに警告する」)。**同じ文は 1 回だけ**入る。
   * 断りではないので、案内があっても `features` は取り込める分だけ入っている。
   */
  readonly notices: readonly string[];
  /**
   * 形が決まらず**この段が**落とした実体の数。0 なら渡された実体は全部写せた。
   * `io` が飛ばした知らない実体は含まない(あちらの `skippedEntityCount`)。
   * 案内の文(`dxfDroppedEntitiesMessage`)は両方を足した数で出る。
   */
  readonly droppedEntityCount: number;
}

/** 取り込む要素の種類(この段が作るのはこの 5 つだけ。新しい種類は作らない)。 */
const IMPORTED_KINDS: readonly SketchFeatureKind[] = ['point', 'line', 'arc', 'ellipse', 'spline'];

/**
 * 既定名(「点1」「線分3」)を見出しと連番へ分ける。名前が「見出し + 連番」であることは
 * `createSketchDocument.ts` の `nameSerial` の約束なので、**見出しの表(`KIND_LABELS`)を
 * こちらへ写さずに済む**(同じ規約を 2 か所に書かない)。
 */
const NAME_SERIAL_PATTERN = /^(.*?)([0-9]+)$/;

/** 種類ごとの id と名前の連番。1 要素ごとに文書を作り直すと点の数の 2 乗になるので、続きを持つ。 */
interface SerialCounter {
  readonly idPrefix: string;
  readonly nameLabel: string;
  next: number;
}

/**
 * 既存の要素の続きになる連番を、種類ごとに 1 回だけ求める。
 *
 * `nextFeatureId` / `nextFeatureName` は毎回すべての要素を走るので、実体 1 つごとに
 * 呼ぶと実体の数の 2 乗になる(DXF は 10 万実体まで読める)。**種類ごとに 1 回だけ呼び、
 * あとは 1 ずつ増やす。**
 */
function serialCountersFor(
  existing: readonly SketchFeature[],
): Map<SketchFeatureKind, SerialCounter> {
  const document: SketchDocument = { id: 'dxf', name: 'dxf', features: existing };
  const counters = new Map<SketchFeatureKind, SerialCounter>();
  for (const kind of IMPORTED_KINDS) {
    const idPrefix = `${kind}-`;
    const idSerial = Number(nextFeatureId(document, kind).slice(idPrefix.length));
    const name = nextFeatureName(document, kind);
    const matched = NAME_SERIAL_PATTERN.exec(name);
    // 既定名は必ず「見出し + 連番」だが、型では保証されないので読めない形は名前ごと使う。
    const nameLabel = matched === null ? name : matched[1];
    const nameSerial = matched === null ? 1 : Number(matched[2]);
    // id と名前の連番は別々に数えられているので、大きいほうへそろえて両方を空けておく。
    counters.set(kind, { idPrefix, nameLabel, next: Math.max(idSerial, nameSerial) });
  }
  return counters;
}

/** 次の id と名前を 1 組取り出し、連番を 1 つ進める。 */
function takeSerial(
  counters: Map<SketchFeatureKind, SerialCounter>,
  kind: SketchFeatureKind,
): { readonly id: string; readonly name: string } {
  const counter = counters.get(kind);
  if (counter === undefined) {
    // `IMPORTED_KINDS` を回して作ってあるので通らない。作らない種類を頼まれたら 1 番から。
    return { id: `${kind}-1`, name: `${kind}1` };
  }
  const serial = counter.next;
  counter.next = serial + 1;
  return {
    id: `${counter.idPrefix}${String(serial)}`,
    name: `${counter.nameLabel}${String(serial)}`,
  };
}

/**
 * `$INSUNITS` の単位から、座標に掛ける倍率(mm / 単位)を決める。
 *
 * `'other'` は「単位は書いてあるが mm でも inch でもない」ので、倍率は呼び手が
 * 利用者へ訊いた値を使う(計画書 §0.a-0.6)。訊けていなければ 1 にする——
 * 無単位の DXF を mm として読むのは他の CAD と同じ既定で、断るより取り込めるほうが親切。
 */
function millimetersPerUnit(options: DxfToSketchOptions): number {
  switch (options.unit) {
    case 'mm':
      return 1;
    case 'inch':
      return MM_PER_INCH;
    case 'other': {
      const override = options.unitOverrideMm;
      return override !== undefined && Number.isFinite(override) && override > 0 ? override : 1;
    }
  }
}

/** 作図面の上の 2 次元の点を、ワールドの絶対座標の指定へ写す(式は有効数字 12 桁)。 */
function coordinateOf(plane: WorkPlane, point: SketchDxfPoint2d, scale: number): CoordinateInput {
  const world = planeToWorld(plane, point.x * scale, point.y * scale);
  return {
    mode: 'absolute',
    x: expressionValueFromNumber(world[0]),
    y: expressionValueFromNumber(world[1]),
    z: expressionValueFromNumber(world[2]),
  };
}

/** 角度(度)の式。長さと違って倍率を掛けない。 */
function angleOf(degrees: number): ExpressionValue {
  return expressionValueFromNumber(degrees);
}

/** 2 次元の点の座標が両方とも有限か。倍率を掛けた後に確かめる。 */
function isFinitePoint(point: SketchDxfPoint2d, scale: number): boolean {
  return Number.isFinite(point.x * scale) && Number.isFinite(point.y * scale);
}

/** 同じ案内を 2 行出さないように足す。並びは最初に出会った順。 */
function pushNotice(notices: string[], message: string): void {
  if (!notices.includes(message)) {
    notices.push(message);
  }
}

/**
 * スプラインの点の数が写し先の決まり(`splineMath.ts`)に合うか。合わなければ案内の文言を返す。
 * 上限・下限の値も文言も `splineMath.ts` の 1 か所から借りる(スケッチの中で作った曲線と
 * 同じ理由・同じ言葉で断るため)。
 */
function splinePointCountIssue(count: number, closed: boolean): string | null {
  if (count > MAX_SPLINE_POINTS) {
    return SPLINE_TOO_MANY_MESSAGE;
  }
  if (closed && count < MIN_CLOSED_SPLINE_POINTS) {
    return SPLINE_TOO_FEW_CLOSED_MESSAGE;
  }
  if (!closed && count < MIN_SPLINE_POINTS) {
    return SPLINE_TOO_FEW_OPEN_MESSAGE;
  }
  return null;
}

/**
 * DXF の実体をスケッチの要素へ写す(計画書 §2.7 の表)。
 *
 * @param entities `io` の `readDxf` が返した実体(`INSERT` は展開済み、多角形は開き済み)。
 * @param plane 取り込み先の作図面(既定は XY 面。計画書 §0.a-0.33)。要素の座標は
 *   この作図面の 2 次元の点をワールドへ写した**絶対座標**になり、角度は作図面の第1軸から測る。
 * @param options 単位と、`io` が数えた件数。
 */
export function dxfToSketch(
  entities: readonly SketchDxfEntity[],
  plane: WorkPlane,
  options: DxfToSketchOptions,
): DxfToSketchResult {
  const scale = millimetersPerUnit(options);
  const counters = serialCountersFor(options.existingFeatures ?? []);
  const features: SketchFeature[] = [];
  const notices: string[] = [];
  let droppedEntityCount = 0;

  const offPlaneCount = options.offPlaneCount ?? 0;
  if (offPlaneCount > 0) {
    notices.push(dxfOffPlaneMessage(offPlaneCount));
  }

  for (const entity of entities) {
    switch (entity.kind) {
      case 'point': {
        if (!isFinitePoint(entity.position, scale)) {
          droppedEntityCount += 1;
          break;
        }
        const serial = takeSerial(counters, 'point');
        features.push({
          id: serial.id,
          name: serial.name,
          planeId: plane.id,
          kind: 'point',
          at: coordinateOf(plane, entity.position, scale),
        });
        break;
      }
      case 'line': {
        if (!isFinitePoint(entity.start, scale) || !isFinitePoint(entity.end, scale)) {
          droppedEntityCount += 1;
          break;
        }
        const serial = takeSerial(counters, 'line');
        features.push({
          id: serial.id,
          name: serial.name,
          planeId: plane.id,
          kind: 'line',
          from: coordinateOf(plane, entity.start, scale),
          to: coordinateOf(plane, entity.end, scale),
          // 取り込んだ線は実体として使える(構築線にするかは利用者が後で決める。FR-320)。
          construction: false,
        });
        break;
      }
      case 'arc': {
        const radius = entity.radius * scale;
        if (
          !isFinitePoint(entity.center, scale) ||
          !Number.isFinite(radius) ||
          radius <= 0 ||
          !Number.isFinite(entity.startAngle) ||
          !Number.isFinite(entity.endAngle)
        ) {
          droppedEntityCount += 1;
          break;
        }
        const serial = takeSerial(counters, 'arc');
        features.push({
          id: serial.id,
          name: serial.name,
          planeId: plane.id,
          kind: 'arc',
          center: coordinateOf(plane, entity.center, scale),
          radius: expressionValueFromNumber(radius),
          // 開始角と終了角の差がそのまま回る向きと量になる(差が ±360 なら円)。
          startAngle: angleOf(entity.startAngle),
          endAngle: angleOf(entity.endAngle),
          construction: false,
        });
        break;
      }
      case 'ellipse': {
        const majorRadius = entity.majorRadius * scale;
        const minorRadius = entity.minorRadius * scale;
        if (
          !isFinitePoint(entity.center, scale) ||
          !Number.isFinite(majorRadius) ||
          !Number.isFinite(minorRadius) ||
          majorRadius <= 0 ||
          minorRadius <= 0 ||
          // 長軸のほうが短いと `resolveSketch` が断るので、読めない形を履歴へ積まない。
          minorRadius > majorRadius ||
          !Number.isFinite(entity.rotation) ||
          !Number.isFinite(entity.startAngle) ||
          !Number.isFinite(entity.endAngle)
        ) {
          droppedEntityCount += 1;
          break;
        }
        const serial = takeSerial(counters, 'ellipse');
        features.push({
          id: serial.id,
          name: serial.name,
          planeId: plane.id,
          kind: 'ellipse',
          center: coordinateOf(plane, entity.center, scale),
          majorRadius: expressionValueFromNumber(majorRadius),
          minorRadius: expressionValueFromNumber(minorRadius),
          rotation: angleOf(entity.rotation),
          // DXF の段で媒介変数から方位角へ直してあるので、そのまま入れられる。
          startAngle: angleOf(entity.startAngle),
          endAngle: angleOf(entity.endAngle),
          construction: false,
        });
        break;
      }
      case 'spline': {
        for (const warning of entity.warnings) {
          pushNotice(notices, warning);
        }
        if (entity.degree > MAX_SUPPORTED_SPLINE_DEGREE) {
          pushNotice(notices, DXF_SPLINE_DEGREE_REDUCED_MESSAGE);
        }
        const issue = splinePointCountIssue(entity.points.length, entity.closed);
        if (issue !== null) {
          pushNotice(notices, issue);
          droppedEntityCount += 1;
          break;
        }
        if (!entity.points.every((point) => isFinitePoint(point, scale))) {
          droppedEntityCount += 1;
          break;
        }
        const serial = takeSerial(counters, 'spline');
        features.push({
          id: serial.id,
          name: serial.name,
          planeId: plane.id,
          kind: 'spline',
          mode: entity.mode,
          points: entity.points.map((point) => coordinateOf(plane, point, scale)),
          closed: entity.closed,
          construction: false,
        });
        break;
      }
    }
  }

  // 取り込めなかった数は最後にしか分からないので、案内はここで 1 行だけ足す
  // (この段が落とした数 + `io` が飛ばした知らない実体の数。統括の決定 2026-09-06)。
  const missingCount = droppedEntityCount + (options.skippedEntityCount ?? 0);
  if (missingCount > 0) {
    pushNotice(notices, dxfDroppedEntitiesMessage(missingCount));
  }

  return { features, notices, droppedEntityCount };
}
