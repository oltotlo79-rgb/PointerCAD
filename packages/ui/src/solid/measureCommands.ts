/**
 * 「測る」の道具の組み立て(計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク32、
 * §2.10、§0.a-0.29〜0.32、§0.a-0.68、§0.a-0.69)。
 *
 * 対応要件: FR-1101(体積・質量・重心・慣性モーメント)、FR-1102(距離・角度・長さ・面積)、
 * FR-905、NFR-UX-1、NFR-UX-5、NFR-PF-4。
 *
 * **判断は `solid/measure.ts`(タスク30)、描き方は `viewport/createMeasureLayer.ts`
 * (タスク31)にある。この場はその 2 つをつなぐ。** つまり
 * ①何を測れるか(`measureReadiness`)を押せる条件へ直し、
 * ②一覧から出せるものは往復せずに測り(`measureLocally`)、
 * ③出せないものだけカーネルへ聞き(`KernelBridge.measure`)、
 * ④どちらの結果も画面へ出す 1 つの形(`MeasurementState`)へそろえる。
 *
 * DOM にも three.js にもストアにも触れない(`createPartMeasurer` だけが橋渡しの関数を
 * 受け取るが、それも呼ぶ相手を渡してもらうだけで、自分では何も掴まない)。
 * 判断を Node の単体検査で固定できるようにするため
 * (`docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して検査する」)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  DEFAULT_DENSITY_MATERIAL_ID,
  densityMaterialFor,
  findDensityMaterial,
  formatLength,
  inertiaWithDensity,
  massFromVolume,
  type AppearancePresetId,
  type LengthUnit,
  type MeasureOutcome,
  type MeasureTarget as ModelMeasureTarget,
  type PartDocument,
  type ResolvedSolidStep,
  type Vec3,
  type WoodSpecies,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { MeasureAngleSpec, MeasurementState } from '../viewport/createMeasureLayer.js';

import {
  formatMeasure,
  measureKindLabel,
  measureLocally,
  measureReadiness,
  measureRejectionMessageKey,
  MEASURE_FAILED_MESSAGE_KEY,
  type LocalMeasureResult,
  type MeasureBody,
  type MeasureKind,
  type MeasureReadiness,
  type MeasureTarget,
} from './measure.js';
import { resolveCachedSteps, type CachedResolveDeps } from './resolveCachedSteps.js';
import type { SolidToolReadiness } from './solidCommands.js';
import {
  parseSubShapeId,
  type SelectionKind,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

/* ---------------------------------------------------------------------------
 * 押せる条件(NFR-UX-5)
 * ------------------------------------------------------------------------- */

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/**
 * 「測る」がいま押せるか(NFR-UX-5「実行してから失敗させない」)。
 *
 * 判断そのものは `measureReadiness`(タスク30)の 1 か所だけに置き、ここは
 * ツールバーが読む形(`SolidToolReadiness`)へ詰め替える。断りの文言も
 * `measureRejectionMessageKey` が持つものをそのまま使うので、ツールチップ・帯・
 * プロパティ欄のどこで見ても同じ日本語になる(NFR-MA-5)。
 *
 * **体積を持たない一覧でも判定できる。** ツールバーが持っているのは
 * `subShapeBodiesOf` が作った `SubShapeBody` の一覧で、体積は測る段になって初めて要る。
 */
export function measureToolReadiness(
  selection: readonly string[],
  bodies: readonly SubShapeBody[],
): SolidToolReadiness {
  const readiness = measureReadiness(selection, bodies);
  if (readiness.ready) {
    return READY;
  }
  return { ready: false, reasonKey: measureRejectionKeyOf(readiness) };
}

/**
 * 断りの文言キー。**理由と文言の対応は `measure.ts` の 1 か所だけ**にあるので、
 * ここはそれを引くだけにする(同じ表を 2 か所に書かない、NFR-MA-5)。
 * 理由が無い(= 測れる)ときは、カーネルが測れなかったときと同じ断りへ落とす。
 */
function measureRejectionKeyOf(readiness: MeasureReadiness): MessageKey {
  return readiness.reason === null
    ? MEASURE_FAILED_MESSAGE_KEY
    : measureRejectionMessageKey(readiness.reason);
}

/* ---------------------------------------------------------------------------
 * 選んでいるものの要約(プロパティ欄の「選んでいるもの」)
 * ------------------------------------------------------------------------- */

/** 選択の種類の札の文言キー(`statusText.ts` の `SELECTION_KIND_LABEL_KEYS` と同じ表)。 */
const SELECTION_KIND_LABEL_KEYS: Readonly<Record<SelectionKind, MessageKey>> = {
  vertex: 'selection.kind.vertex',
  edge: 'selection.kind.edge',
  face: 'selection.kind.face',
  body: 'selection.kind.body',
};

/** 要約をつなぐ区切り。言葉に依らない記号なので `ja.json` へ分けない。 */
const SUMMARY_SEPARATOR = ' / ';

/**
 * 測る相手の要約(「面 / 面」「立体 / 立体」)。選んだ順に並べる。
 * 何も選んでいなければ空文字を返し、呼び出し側は欄そのものを出さない。
 */
export function describeMeasureTargets(targets: readonly MeasureTarget[]): string {
  return targets.map((target) => t(SELECTION_KIND_LABEL_KEYS[target.kind])).join(SUMMARY_SEPARATOR);
}

/** 測れる種類の要約(「面と面の距離 / 面と面の角度」)。 */
export function describeMeasureKinds(kinds: readonly MeasureKind[]): string {
  return kinds.map((kind) => measureKindLabel(kind)).join(SUMMARY_SEPARATOR);
}

/* ---------------------------------------------------------------------------
 * 値の表示(プロパティ欄。§2 の決定)
 * ------------------------------------------------------------------------- */

/** 角度の小数の桁数(統括の指示: 角度は度で小数 2 桁)。 */
const ANGLE_FRACTION_DIGITS = 2;

/**
 * プロパティ欄に出す値(FR-1101、FR-1102)。
 *
 * **画面の札(`formatMeasure`、小数 3 桁)とは書式が違う。** 札は「ひと目で読む」ための
 * 幅の揃った数で、こちらは「読み取って書き写す」ための数だから(統括の指示: 距離は
 * `formatLength`、面積は mm²、角度は度で小数 2 桁)。長さは 1000mm 以上で m へ、
 * 面積・体積は式エンジンの表示規則(有効数字 12 桁)に任せる。
 */
export function formatMeasureValue(result: LocalMeasureResult): string {
  switch (result.unit) {
    case 'mm':
      return formatLength(result.value);
    case 'degree':
      return `${result.value.toFixed(ANGLE_FRACTION_DIGITS)} ${t('measure.unit.degree')}`;
    case 'mm2':
      return `${displayNumber(result.value)} ${t('measure.unit.squareMillimeter')}`;
    case 'mm3':
      return `${displayNumber(result.value)} ${t('measure.unit.cubicMillimeter')}`;
  }
}

/** 数を並べるときの区切り。言葉に依らない記号なので `ja.json` へ分けない。 */
const NUMBER_SEPARATOR = ', ';

/** 数 1 つの表示。式エンジンの表示規則(有効数字 12 桁、指数表記にしない)に任せる。 */
function displayNumber(value: number): string {
  return expressionValueFromNumber(value).display;
}

/**
 * 重心の**表示だけ**を丸める桁(小数 6 桁 = 1nm)。
 *
 * カーネルの重心は積分で求まるので、左右対称な箱でも 0 のはずの成分に
 * `1.22e-17` のような計算誤差が残る(2026-09-05 のヘッドレスで実測)。有効数字 12 桁の
 * 表示規則をそのまま当てると「0.0000000000000000122124532709」という読めない数になり、
 * 「真ん中にある」という肝心のことが伝わらない。**保存値も計算も 1 つも丸めない**
 * (rules/04)。表示だけを丸めるのは、拘束で決まった座標を 9 桁で丸めているのと同じ扱い
 * (`PropertyPanel.tsx` の `roundSolvedCoordinateText`、利用者の決定 2026-09-05 10:43)。
 */
const POINT_DISPLAY_DECIMALS = 6;

/** 表示のために 1nm まで丸める。−0 は 0 と書く(「-0」と出さない)。 */
function roundForDisplay(value: number): number {
  const factor = Math.pow(10, POINT_DISPLAY_DECIMALS);
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 重心の表示(「10, 10, 10 mm」)。3 つの数と単位を 1 つの読み物にする。
 * 座標の書き方は `featureSummary.ts` の「= (x, y, z)」と違うが、あちらは**入力の解**で、
 * こちらは**測った値**なので、括弧で囲まずに単位を添える書き方にそろえる。
 */
export function formatMeasurePoint(point: Vec3): string {
  const numbers = [point[0], point[1], point[2]].map((value) =>
    displayNumber(roundForDisplay(value)),
  );
  return `${numbers.join(NUMBER_SEPARATOR)} ${t('measure.unit.millimeter')}`;
}

/** 主軸まわりの慣性モーメント 3 つの表示(単位は g·mm²、§0.a-0.32)。 */
export function formatMoments(moments: readonly [number, number, number]): string {
  const numbers = moments.map((value) => displayNumber(value));
  return `${numbers.join(NUMBER_SEPARATOR)} ${t('propertyPanel.unitGramMillimeterSquared')}`;
}

/* ---------------------------------------------------------------------------
 * 画面へ出す 1 件を組み立てる(§2.10.3)
 * ------------------------------------------------------------------------- */

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * 弧の半径の最小値(mm)。測った相手が小さくても弧が見えるように下限を置く。
 * 立体の大きさに比べて大きすぎないよう、上は相手の寸法から決める(下の `ANGLE_RADIUS_RATIO`)。
 */
const MIN_ANGLE_RADIUS_MM = 2;

/** 弧の半径を、相手の寸法(重心どうしの距離・辺の長さ)の何割にするか。 */
const ANGLE_RADIUS_RATIO = 0.3;

/** 同じ点とみなす距離(mm)。辺どうしが角を共有しているかの判定に使う。 */
const SHARED_POINT_TOLERANCE_MM = 1e-6;

/** 一覧から面 1 枚を引く。指していないときは null。 */
function faceOf(bodies: readonly MeasureBody[], target: MeasureTarget): SolidFaceEntry | null {
  const parsed = parseSubShapeId(target.elementId);
  if (parsed === null || parsed.kind !== 'face') {
    return null;
  }
  const body = bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
  return body?.faces.find((face) => face.index === parsed.index) ?? null;
}

/** 一覧から辺 1 本を引く。指していないときは null。 */
function edgeOf(bodies: readonly MeasureBody[], target: MeasureTarget): SolidEdgeEntry | null {
  const parsed = parseSubShapeId(target.elementId);
  if (parsed === null || parsed.kind !== 'edge') {
    return null;
  }
  const body = bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
  return body?.edges.find((edge) => edge.index === parsed.index) ?? null;
}

/** 立体 1 つの中心(頂点の平均)。頂点を持たない立体では null。 */
function bodyCenterOf(bodies: readonly MeasureBody[], featureId: string): Vec3 | null {
  const body = bodies.find((candidate) => candidate.featureId === featureId);
  if (body === undefined || body.vertices.length === 0) {
    return null;
  }
  const sum = body.vertices.reduce<Vec3>(
    (current, vertex) => [
      current[0] + vertex.position[0],
      current[1] + vertex.position[1],
      current[2] + vertex.position[2],
    ],
    [0, 0, 0],
  );
  const count = body.vertices.length;
  return [sum[0] / count, sum[1] / count, sum[2] / count];
}

/**
 * 面 2 枚のなす角の描き方(頂・2 本の向き・弧の半径)。
 *
 * 頂は 2 枚の重心の中点に置く。法線そのものを 2 本の線にすると、面が向かい合っている
 * ときに線が逆を向いて角が読めないので、**2 枚目の法線は 1 枚目と鋭角になる向きへ
 * そろえる**(`measure.ts` の角度が 0〜90 度で裏表を区別しないのと同じ扱い)。
 */
function faceAngleSpec(first: SolidFaceEntry, second: SolidFaceEntry): MeasureAngleSpec | null {
  if (first.axis === null || second.axis === null) {
    return null;
  }
  const apex = midpoint(first.centroid, second.centroid);
  const gap = norm(subtract(second.centroid, first.centroid));
  const dot =
    first.axis[0] * second.axis[0] + first.axis[1] * second.axis[1] + first.axis[2] * second.axis[2];
  const to: Vec3 =
    dot < 0 ? [-second.axis[0], -second.axis[1], -second.axis[2]] : second.axis;
  return {
    apex,
    from: first.axis,
    to,
    radius: Math.max(MIN_ANGLE_RADIUS_MM, gap * ANGLE_RADIUS_RATIO),
  };
}

/**
 * 辺 2 本のなす角の描き方。**角を共有しているならその点を頂にする**(利用者が見ている
 * 「角」そのものの上に弧が乗る)。共有していなければ中点どうしの中点に置く。
 * 向きは頂から辺の遠い側の端点へ向けてそろえる。
 */
function edgeAngleSpec(first: SolidEdgeEntry, second: SolidEdgeEntry): MeasureAngleSpec | null {
  if (first.axis === null || second.axis === null) {
    return null;
  }
  const shared = sharedEndpointOf(first, second);
  const apex = shared ?? midpoint(first.midpoint, second.midpoint);
  const radius = Math.max(
    MIN_ANGLE_RADIUS_MM,
    Math.min(first.length, second.length) * ANGLE_RADIUS_RATIO,
  );
  return {
    apex,
    from: directionFrom(apex, first),
    to: directionFrom(apex, second),
    radius,
  };
}

/** 2 本の辺が共有している端点。共有していなければ null。 */
function sharedEndpointOf(first: SolidEdgeEntry, second: SolidEdgeEntry): Vec3 | null {
  for (const a of [first.start, first.end]) {
    for (const b of [second.start, second.end]) {
      if (norm(subtract(a, b)) <= SHARED_POINT_TOLERANCE_MM) {
        return a;
      }
    }
  }
  return null;
}

/** 頂から見て、その辺が伸びていく向き(遠いほうの端点へ)。 */
function directionFrom(apex: Vec3, edge: SolidEdgeEntry): Vec3 {
  const toStart = subtract(edge.start, apex);
  const toEnd = subtract(edge.end, apex);
  return norm(toEnd) >= norm(toStart) ? toEnd : toStart;
}

/**
 * 一覧から出せた結果を、画面へ出す 1 件(`MeasurementState`)へ組み立てる(タスク31)。
 *
 * 線を引ける測定(距離・長さ)は `result.segment` がそのまま使われ、角度はここで
 * 描き方(`MeasureAngleSpec`)を組み立て、面積・体積は札を置く場所(`anchor`)だけを渡す。
 */
export function measurementOf(
  result: LocalMeasureResult,
  targets: readonly MeasureTarget[],
  bodies: readonly MeasureBody[],
  unit: LengthUnit = 'mm',
): MeasurementState {
  return {
    result,
    // 札の数だけを表示の単位で出す(FR-811、P6 タスク3)。省くと mm。
    text: formatMeasure(result, unit),
    angle: angleSpecOf(result.kind, targets, bodies),
    anchor: anchorOf(result.kind, targets, bodies),
  };
}

function angleSpecOf(
  kind: MeasureKind,
  targets: readonly MeasureTarget[],
  bodies: readonly MeasureBody[],
): MeasureAngleSpec | null {
  if (kind === 'faceAngle') {
    const first = targets[0] === undefined ? null : faceOf(bodies, targets[0]);
    const second = targets[1] === undefined ? null : faceOf(bodies, targets[1]);
    return first === null || second === null ? null : faceAngleSpec(first, second);
  }
  if (kind === 'edgeAngle') {
    const first = targets[0] === undefined ? null : edgeOf(bodies, targets[0]);
    const second = targets[1] === undefined ? null : edgeOf(bodies, targets[1]);
    return first === null || second === null ? null : edgeAngleSpec(first, second);
  }
  return null;
}

/** 線も角度も無い測定(面積・体積)で札を置く場所。置けなければ null(札を出さない)。 */
function anchorOf(
  kind: MeasureKind,
  targets: readonly MeasureTarget[],
  bodies: readonly MeasureBody[],
): Vec3 | null {
  const first = targets[0];
  if (first === undefined) {
    return null;
  }
  if (kind === 'faceArea') {
    return faceOf(bodies, first)?.centroid ?? null;
  }
  if (kind === 'bodyVolume' || kind === 'massProperties') {
    return bodyCenterOf(bodies, first.bodyFeatureId);
  }
  return null;
}

/**
 * カーネルが返した最短距離を、画面へ出す 1 件へ組み立てる(§0.a-0.30、§0.a-0.69)。
 * 線は 2 つの最近点を結ぶ 1 本になる(`buildMeasureShapes` がそのまま引く)。
 */
export function measurementFromDistance(
  kind: MeasureKind,
  distance: number,
  pointA: Vec3,
  pointB: Vec3,
  unit: LengthUnit = 'mm',
): MeasurementState {
  const result: LocalMeasureResult = {
    kind,
    value: distance,
    unit: 'mm',
    segment: [pointA, pointB],
  };
  return { result, text: formatMeasure(result, unit), angle: null, anchor: null };
}

/* ---------------------------------------------------------------------------
 * 質量特性(FR-1101、§0.a-0.31、§0.a-0.32)
 * ------------------------------------------------------------------------- */

/**
 * カーネルが測った質量特性(密度を掛けていない素の値)。
 *
 * **密度の掛け算はここでは行わない。** 材料は利用者がプロパティ欄で切り替えるものなので、
 * 掛けるのは表示の直前(`massPropertiesView`)で、しかも model の関数
 * (`massFromVolume` / `inertiaWithDensity`)だけを使う(統括の決定: 密度の掛け算は
 * model の 1 か所)。
 */
export interface MassPropertiesResult {
  /** 測った立体を作ったフィーチャーの id(= ボディの id)。 */
  readonly bodyFeatureId: string;
  /** 体積(mm³)。 */
  readonly volume: number;
  /** 表面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centreOfMass: Vec3;
  /** 重心を通る主軸まわりの体積の 2 次モーメント(mm⁵、密度なし)。 */
  readonly principalMoments: readonly [number, number, number];
}

/** 密度を掛けた質量特性(画面に出す値)。 */
export interface MassPropertiesView {
  /** 質量(g)。 */
  readonly mass: number;
  /** 主軸まわりの慣性モーメント(g·mm²)。 */
  readonly moments: readonly [number, number, number];
}

/**
 * 密度(g/cm³)を掛けて、画面に出す質量と慣性モーメントを求める(FR-1101、§0.a-0.32)。
 * 計算そのものは model の 2 関数に任せ、ここでは 1 つも数を丸めない(rules/04)。
 */
export function massPropertiesView(
  result: MassPropertiesResult,
  densityGPerCm3: number,
): MassPropertiesView {
  return {
    mass: massFromVolume(result.volume, densityGPerCm3),
    moments: [
      inertiaWithDensity(result.principalMoments[0], densityGPerCm3),
      inertiaWithDensity(result.principalMoments[1], densityGPerCm3),
      inertiaWithDensity(result.principalMoments[2], densityGPerCm3),
    ],
  };
}

/**
 * その立体の材料の既定(§0.a-0.31)。**外観のプリセットに対応する材料**を選ぶので、
 * アルミの外観を付けた立体はアルミの密度(2.68 g/cm³)で始まる。対応が無い外観
 * (既定・鏡など)では鋼(`DEFAULT_DENSITY_MATERIAL_ID`)にする。
 */
export function defaultDensityMaterialId(
  preset: AppearancePresetId,
  species: WoodSpecies | null,
): string {
  return densityMaterialFor(preset, species) ?? DEFAULT_DENSITY_MATERIAL_ID;
}

/** 材料 id から密度(g/cm³)を引く。知らない id は既定の材料の密度へ落とす。 */
export function densityOf(materialId: string): number {
  const material = findDensityMaterial(materialId);
  if (material !== undefined) {
    return material.density;
  }
  return findDensityMaterial(DEFAULT_DENSITY_MATERIAL_ID)?.density ?? 0;
}

/* ---------------------------------------------------------------------------
 * カーネルへの問い合わせ(§0.a-0.30)
 * ------------------------------------------------------------------------- */

/** 測る相手を model の橋渡しの言葉へ詰め替える(指紋つきの参照をそのまま渡す)。 */
export function toModelMeasureTargets(
  targets: readonly MeasureTarget[],
): readonly ModelMeasureTarget[] {
  return targets.map((target) => ({
    bodyFeatureId: target.bodyFeatureId,
    subShape: target.ref,
  }));
}

/**
 * 覚えてある形を測る手立て(ストアが持ち、`PointerCadApp` が差し出す)。
 *
 * `PartRecomputer` と同じ形で、カーネル(Worker)を持たない検査では偽物を差し込める。
 * **再計算は起こさない読み取り**(§0.a-0.30)なので、形がキャッシュに無ければ
 * カーネルは `kind: 'failed'` を返す(落とさない、NFR-RE-1)。
 */
export type PartMeasurer = (
  document: PartDocument,
  targets: readonly ModelMeasureTarget[],
  kind: 'distance' | 'massProperties',
) => Promise<MeasureOutcome>;

/**
 * `createPartMeasurer` に渡すもの。覚え書きは再計算と同じものを持ち回る(NFR-PF-2)。
 * 解くのに要るもの(覚え書き 3 つと読み込んだ形のバイト列)は書き出しと共通なので
 * `CachedResolveDeps` を継ぐ(同じ並びを 2 か所に書かない)。
 */
export interface PartMeasurerDeps extends CachedResolveDeps {
  /** 形を測る口(`KernelBridge.measure`)。 */
  readonly measure: (
    steps: readonly ResolvedSolidStep[],
    targets: readonly ModelMeasureTarget[],
    kind: 'distance' | 'massProperties',
  ) => Promise<MeasureOutcome>;
}

/**
 * 測る手立てを組み立てる(タスク32)。
 *
 * カーネルは**段の鍵**(`ResolvedSolidStep.key`)でしか形を引けないので、測る前に
 * 文書を解き直して段の一覧を作る。その解き方は `resolveCachedSteps`(書き出しと共有。
 * P6 タスク32b)にあり、ここは覚え書きを渡して測る相手を添えるだけにする。
 * 覚え書きに無いものがあれば鍵が食い違い、カーネルが「測れませんでした。もう一度
 * お試しください。」を返す(§0.a-0.30 の断りと同じ文言。落とさない)。
 */
export function createPartMeasurer(deps: PartMeasurerDeps): PartMeasurer {
  return (document, targets, kind) =>
    deps.measure(resolveCachedSteps(document, deps), targets, kind);
}

/* ---------------------------------------------------------------------------
 * 測る 1 手(ストアから呼ぶ)
 * ------------------------------------------------------------------------- */

/** 測った結果。断ったときは日本語の理由だけを返す(NFR-UX-5)。 */
export type MeasureOutcomeView =
  | {
      readonly ok: true;
      /** 画面に出す測定 1 件。 */
      readonly measurement: MeasurementState;
      /** 立体 1 つを測ったときの質量特性。それ以外は null。 */
      readonly massProperties: MassPropertiesResult | null;
    }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 測るのに要るもの一式(ストアが持っている値をそのまま渡せる形)。 */
export interface MeasureContext {
  readonly document: PartDocument;
  readonly selection: readonly string[];
  /** カーネルが返したボディの一覧(体積つき)。 */
  readonly bodies: readonly MeasureBody[];
  /** カーネルへ聞く手立て。差し出されていなければ null(往復の要る測定だけが断られる)。 */
  readonly measurer: PartMeasurer | null;
  /**
   * 画面に出している長さの単位(FR-811、P6 タスク3)。**札の文字だけ**に効き、測る値
   * そのものは mm のまま(NFR-RE-3)。省くと mm なので、P5 までの呼び出しは変わらない。
   */
  readonly lengthUnit?: LengthUnit;
}

/**
 * いま選んでいるものを測る(FR-1101、FR-1102)。**押したら必ず何かが起きる**
 * (測れなければ日本語の理由が返る、NFR-UX-5)。
 *
 * 順序は §2.10.2 のとおり。
 * ①測れる種類を決める(`measureReadiness`。既定は先頭の種類)。
 * ②一覧から出せるなら**カーネルを呼ばずに**測る(NFR-PF-4)。
 * ③出せない種類(辺どうし・立体どうしの最短距離)はカーネルへ 1 往復。
 * ④立体を 1 つ選んでいるときは、体積を一覧から出したうえで**質量特性だけ**を
 *   カーネルへ聞く(重心と慣性モーメントは一覧に無い、§0.a-0.30)。
 */
export async function runMeasure(context: MeasureContext): Promise<MeasureOutcomeView> {
  const readiness = measureReadiness(context.selection, context.bodies);
  if (!readiness.ready || readiness.kind === null) {
    return { ok: false, reasonKey: measureRejectionKeyOf(readiness) };
  }
  const kind = readiness.kind;
  const local = measureLocally(kind, readiness.targets, context.bodies);
  const measurement =
    local === null
      ? await measureThroughKernel(context, kind, readiness.targets)
      : measurementOf(local, readiness.targets, context.bodies, context.lengthUnit ?? 'mm');
  if (measurement === null) {
    return { ok: false, reasonKey: MEASURE_FAILED_MESSAGE_KEY };
  }
  const massProperties = readiness.kinds.includes('massProperties')
    ? await measureMassProperties(context, readiness.targets)
    : null;
  return { ok: true, measurement, massProperties };
}

/**
 * カーネルへ 1 往復する(§0.a-0.30)。
 *
 * **通信ごと失敗しても投げない**(Worker が壊れている、返事が来ない)。測るのは
 * 読み取りだけなので、失敗しても文書は 1 バイトも変わらず、呼び出し側は
 * 「測れませんでした。もう一度お試しください。」を出せばよい(FR-504、NFR-RE-1)。
 */
async function askKernel(
  context: MeasureContext,
  targets: readonly MeasureTarget[],
  kind: 'distance' | 'massProperties',
): Promise<MeasureOutcome | null> {
  const measurer = context.measurer;
  if (measurer === null) {
    return null;
  }
  try {
    return await measurer(context.document, toModelMeasureTargets(targets), kind);
  } catch {
    return null;
  }
}

/** 最短距離をカーネルへ聞く。測れなければ null(呼び出し側が断りへ直す)。 */
async function measureThroughKernel(
  context: MeasureContext,
  kind: MeasureKind,
  targets: readonly MeasureTarget[],
): Promise<MeasurementState | null> {
  if (context.measurer === null) {
    return null;
  }
  const outcome = await askKernel(context, targets, 'distance');
  if (outcome === null || outcome.kind !== 'distance') {
    return null;
  }
  return measurementFromDistance(
    kind,
    outcome.distance,
    outcome.pointA,
    outcome.pointB,
    context.lengthUnit ?? 'mm',
  );
}

/**
 * 質量特性をカーネルへ聞く(FR-1101)。測れなければ null を返すだけで、**測定そのものは
 * 断らない**(体積は一覧から出ているので、質量の欄が出ないだけで済む)。
 */
async function measureMassProperties(
  context: MeasureContext,
  targets: readonly MeasureTarget[],
): Promise<MassPropertiesResult | null> {
  const first = targets[0];
  if (context.measurer === null || first === undefined) {
    return null;
  }
  const outcome = await askKernel(context, [first], 'massProperties');
  if (outcome === null || outcome.kind !== 'massProperties') {
    return null;
  }
  return {
    bodyFeatureId: first.bodyFeatureId,
    volume: outcome.volume,
    area: outcome.area,
    centreOfMass: outcome.centreOfMass,
    principalMoments: outcome.principalMoments,
  };
}
