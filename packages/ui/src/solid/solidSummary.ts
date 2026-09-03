/**
 * 立体1つを「モデルブラウザとプロパティが表に出せる形」へ直す
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク22)。
 *
 * 対応要件: FR-501(ツリーの種類と名前)、FR-502(参照は id で持つ)、FR-503(抑制・改名・削除)、
 * FR-504(失敗の明示)、FR-202(入れた式をそのまま再表示する)、FR-311(直すと下流が追従する)。
 *
 * `packages/ui/src/sketch/featureSummary.ts` と同じ作りにする。DOM にも React にもストアにも
 * 触れない純関数だけを置き、表示する文言は持たず必ず ja.json のキー(MessageKey)で返す
 * (NFR-MA-5)。書き戻しは元のフィーチャーを変えずに新しいフィーチャーを作る(FR-505 の土台)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  consumedBodyIds,
  findFeature,
  findSketch,
  findSolid,
  type PartDocument,
  type PartRecomputeError,
  type SketchError,
  type SketchFaceRef,
  type SketchFeatureKind,
  type SolidFeature,
  type SolidLabelKey,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { FEATURE_KIND_LABEL_KEYS } from '../sketch/featureSummary.js';
import { TOGGLE_LABEL_KEYS, type FieldUnit, type NumericToggleKey } from '../sketch/numericInput.js';

/** プロパティ欄で式のまま直せる欄の種類。種類ごとに1つだけ持つ。 */
export type SolidFieldKey = 'distance' | 'angle' | 'tolerance';

/**
 * プロパティ欄の1行。式は source をそのまま出す(FR-202)。
 *
 * 計画書は `unitKey: MessageKey` としていたが、欄を描く `ExpressionField` が受け取るのは
 * `FieldUnit`(numericInput.ts の UNIT_KEYS がキーへ直す)なので、同じ対応表を2度持たずに
 * 済むよう `unit: FieldUnit` で返す。スケッチ側の `FeatureFieldSummary` とも形がそろう。
 */
export interface SolidFieldSummary {
  readonly key: SolidFieldKey;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly unit: FieldUnit;
  readonly value: ExpressionValue;
}

/** 入切のつまみ(向きを反転・両側へ)。式ではないので値は真偽。 */
export interface SolidToggleSummary {
  readonly key: NumericToggleKey;
  readonly labelKey: MessageKey;
  readonly value: boolean;
}

/**
 * 参照しているもの(もとの面・組み合わせる立体)。座標も形も複製せず、名前だけを引く(FR-311)。
 * 計画書の `{ labelKey, name }` に、クリックでその要素を選べるよう `elementId` を足した。
 */
export interface SolidReferenceSummary {
  readonly labelKey: MessageKey;
  /** 表示名。参照先が見つからないときは参照先の id をそのまま出す。 */
  readonly name: string;
  /** クリックで選べる要素の id。参照先が見つからなければ null(FR-504)。 */
  readonly elementId: string | null;
}

/**
 * 回転軸(FR-402、§0.a-0.9)。ワールドの軸は X / Y / Z を選び直せるが、
 * 線分を軸にしたものは線分そのものを選び直す操作が要るので、名前を読み取り専用で出す。
 */
export type SolidAxisSummary =
  | { readonly kind: 'world'; readonly axis: 'x' | 'y' | 'z' }
  | { readonly kind: 'line'; readonly name: string; readonly elementId: string | null };

/** ツリーの行とプロパティ欄が共有する、立体1つの見え方。 */
export interface SolidSummary {
  readonly featureId: string;
  readonly name: string;
  /** 連番の単位で見た種類。ブーリアンは演算ごとに分かれる(和・差・積)。 */
  readonly kind: SolidLabelKey;
  readonly kindLabelKey: MessageKey;
  /** 抑制中(FR-503)。true なら形は計算されない。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
  readonly fields: readonly SolidFieldSummary[];
  readonly toggles: readonly SolidToggleSummary[];
  readonly references: readonly SolidReferenceSummary[];
  /** 回転軸。回転以外は null。 */
  readonly axis: SolidAxisSummary | null;
}

/**
 * 立体の種類の名前。ツールバーの道具の名前と同じ言葉にする(FR-501)。
 *
 * P3 のタスク13 で種類が13個に増えたが、加工6種とばねの道具の名前(ツールバーの文言)は
 * タスク18 でまとめて `ja.json` へ入る。それまでの7つは共通の「未対応」の文言を指す。
 * **タスク18・26・27 がこの7行をそれぞれの道具の名前へ置き換える。**
 * 画面からこれらのフィーチャーを作れるようになるのはタスク25 以降なので、
 * それまでこの文言が実際にツリーへ出ることはない。
 */
export const SOLID_KIND_LABEL_KEYS: Readonly<Record<SolidLabelKey, MessageKey>> = {
  extrude: 'toolbar.solid.extrude',
  revolve: 'toolbar.solid.revolve',
  sew: 'toolbar.solid.sew',
  union: 'toolbar.solid.union',
  subtract: 'toolbar.solid.subtract',
  intersect: 'toolbar.solid.intersect',
  hole: 'featureTree.unsupportedKind',
  threadHole: 'featureTree.unsupportedKind',
  fillet: 'featureTree.unsupportedKind',
  chamfer: 'featureTree.unsupportedKind',
  linearPattern: 'featureTree.unsupportedKind',
  circularPattern: 'featureTree.unsupportedKind',
  spring: 'featureTree.unsupportedKind',
};

/** プロパティ欄で選び直せるワールドの軸(§0.a-0.9)。線分の軸はここでは選べない。 */
export const WORLD_AXIS_CHOICES: readonly {
  readonly axis: 'x' | 'y' | 'z';
  readonly labelKey: MessageKey;
}[] = [
  { axis: 'x', labelKey: 'numericInput.axis.x' },
  { axis: 'y', labelKey: 'numericInput.axis.y' },
  { axis: 'z', labelKey: 'numericInput.axis.z' },
];

/** 欄の見出し・説明・単位。その場数値入力(numericInput.ts)と同じ言葉を使う。 */
const FIELD_DEFINITIONS: Readonly<
  Record<
    SolidFieldKey,
    { readonly labelKey: MessageKey; readonly tooltipKey: MessageKey; readonly unit: FieldUnit }
  >
> = {
  distance: {
    labelKey: 'numericInput.field.distance',
    tooltipKey: 'numericInput.tooltip.extrudeDistance',
    unit: 'mm',
  },
  angle: {
    labelKey: 'numericInput.field.angle',
    tooltipKey: 'numericInput.tooltip.angle',
    unit: 'degree',
  },
  tolerance: {
    labelKey: 'numericInput.field.tolerance',
    tooltipKey: 'numericInput.tooltip.tolerance',
    unit: 'mm',
  },
};

function fieldSummary(key: SolidFieldKey, value: ExpressionValue): SolidFieldSummary {
  const definition = FIELD_DEFINITIONS[key];
  return {
    key,
    labelKey: definition.labelKey,
    tooltipKey: definition.tooltipKey,
    unit: definition.unit,
    value,
  };
}

function toggleSummary(key: NumericToggleKey, value: boolean): SolidToggleSummary {
  return { key, labelKey: TOGGLE_LABEL_KEYS[key], value };
}

/**
 * 連番の単位で見た種類。ブーリアンは演算名(union / subtract / intersect)を返し、
 * パターンは配置名(linearPattern / circularPattern)を返す。
 * 名前(和1・差1・直線パターン1)を作る model の `SolidLabelKey` と同じ粒度にして、
 * ツリーの絵と種類の名前が実際の名前と食い違わないようにする。
 */
export function solidKindOf(feature: SolidFeature): SolidLabelKey {
  if (feature.kind === 'boolean') {
    return feature.operation;
  }
  if (feature.kind === 'pattern') {
    return feature.placement.kind === 'linear' ? 'linearPattern' : 'circularPattern';
  }
  return feature.kind;
}

/** 面の参照を「スケッチ名 / 面の名前」へ直す。見つからなければ id をそのまま出す(FR-504)。 */
function profileReference(document: PartDocument, ref: SketchFaceRef): SolidReferenceSummary {
  const sketch = findSketch(document, ref.sketchId);
  const face = sketch === undefined ? undefined : findFeature(sketch, ref.faceFeatureId);
  if (sketch === undefined || face === undefined || face.kind !== 'face') {
    return { labelKey: 'propertyPanel.profile', name: ref.faceFeatureId, elementId: null };
  }
  return {
    labelKey: 'propertyPanel.profile',
    name: `${sketch.name} / ${face.name}`,
    elementId: face.id,
  };
}

/** 立体の参照を名前へ直す。見つからなければ id をそのまま出す(FR-504)。 */
function bodyReference(
  document: PartDocument,
  labelKey: MessageKey,
  featureId: string,
): SolidReferenceSummary {
  const found = findSolid(document, featureId);
  return found === undefined
    ? { labelKey, name: featureId, elementId: null }
    : { labelKey, name: found.name, elementId: found.id };
}

/** 回転軸の見え方。線分の軸は名前を引いて読み取り専用で出す(§0.a-0.9)。 */
function axisSummary(document: PartDocument, feature: SolidFeature): SolidAxisSummary | null {
  if (feature.kind !== 'revolve') {
    return null;
  }
  if (feature.axis.kind === 'world') {
    return { kind: 'world', axis: feature.axis.axis };
  }
  const { line } = feature.axis;
  const sketch = findSketch(document, line.sketchId);
  const found = sketch === undefined ? undefined : findFeature(sketch, line.lineFeatureId);
  if (found === undefined || found.kind !== 'line') {
    return { kind: 'line', name: line.lineFeatureId, elementId: null };
  }
  return { kind: 'line', name: found.name, elementId: found.id };
}

/**
 * ほかの立体に取り込まれた立体の id(§0.a-0.5)。
 *
 * 文書だけを見る `consumedBodyIds` と違い、**失敗したブーリアンは何も取り込まない**ものとして
 * 数える。再計算(resolvePart)が失敗した段では消費を確定させないので、失敗を数に入れると
 * 画面には出ているのにツリーだけ「統合済み」と出て食い違う(FR-504)。
 * 失敗が分からないとき(errors を渡さないとき)は文書どおりの判定になる。
 */
function consumedIds(
  document: PartDocument,
  errors: readonly PartRecomputeError[],
): ReadonlySet<string> {
  if (errors.length === 0) {
    return consumedBodyIds(document);
  }
  const failed = new Set(errors.map((error) => error.featureId));
  const survivors = document.solids.filter(
    (feature) => feature.kind !== 'boolean' || !failed.has(feature.id),
  );
  return consumedBodyIds({ ...document, solids: survivors });
}

/** 立体1つの見え方をまとめる。ツリーの行とプロパティ欄の両方がこれを読む。 */
export function summarizeSolid(
  document: PartDocument,
  feature: SolidFeature,
  errors: readonly PartRecomputeError[] = [],
): SolidSummary {
  const kind = solidKindOf(feature);
  const base = {
    featureId: feature.id,
    name: feature.name,
    kind,
    kindLabelKey: SOLID_KIND_LABEL_KEYS[kind],
    suppressed: feature.suppressed,
    consumed: consumedIds(document, errors).has(feature.id),
    axis: axisSummary(document, feature),
  };

  switch (feature.kind) {
    case 'extrude':
      return {
        ...base,
        fields: [fieldSummary('distance', feature.distance)],
        toggles: [
          toggleSummary('reversed', feature.reversed),
          toggleSummary('symmetric', feature.symmetric),
        ],
        references: [profileReference(document, feature.profile)],
      };
    case 'revolve':
      return {
        ...base,
        fields: [fieldSummary('angle', feature.angle)],
        toggles: [toggleSummary('reversed', feature.reversed)],
        references: [profileReference(document, feature.profile)],
      };
    case 'sew':
      return {
        ...base,
        fields: [fieldSummary('tolerance', feature.tolerance)],
        toggles: [],
        references: feature.faces.map((face) => profileReference(document, face)),
      };
    case 'boolean':
      return {
        ...base,
        fields: [],
        toggles: [],
        references: [
          bodyReference(document, 'propertyPanel.target', feature.targetFeatureId),
          bodyReference(document, 'propertyPanel.tool', feature.toolFeatureId),
        ],
      };
    case 'hole':
    case 'threadHole':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'spring':
      // P3 タスク13 で文書の型だけが先に増えたための暫定。式の欄・つまみ・参照の出し方は
      // タスク27〜29b の担当なので、それまでは行の名前と印だけを出す(欄は空)。
      // **タスク27・28・29・29b がこの節をそれぞれの種類の欄へ置き換える。**
      return { ...base, fields: [], toggles: [], references: [] };
  }
}

/**
 * 式の欄を書き戻した新しいフィーチャーを作る(元は変えない、FR-311)。
 * 妥当な式になったときだけ呼ぶ。その種類が持たない欄なら同じものを返す。
 */
export function setSolidField(
  feature: SolidFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  if (feature.kind === 'extrude' && key === 'distance') {
    return { ...feature, distance: value };
  }
  if (feature.kind === 'revolve' && key === 'angle') {
    return { ...feature, angle: value };
  }
  if (feature.kind === 'sew' && key === 'tolerance') {
    return { ...feature, tolerance: value };
  }
  return feature;
}

/** つまみを切り替えた新しいフィーチャーを作る。持たないつまみなら同じものを返す。 */
export function setSolidToggle(
  feature: SolidFeature,
  key: NumericToggleKey,
  value: boolean,
): SolidFeature {
  if (feature.kind === 'extrude') {
    return key === 'reversed' ? { ...feature, reversed: value } : { ...feature, symmetric: value };
  }
  if (feature.kind === 'revolve' && key === 'reversed') {
    return { ...feature, reversed: value };
  }
  return feature;
}

/** 回転軸をワールドの X / Y / Z へ変えた新しいフィーチャーを作る。回転以外は同じものを返す。 */
export function setSolidAxis(feature: SolidFeature, axis: 'x' | 'y' | 'z'): SolidFeature {
  if (feature.kind !== 'revolve') {
    return feature;
  }
  return { ...feature, axis: { kind: 'world', axis } };
}

/** 抑制を切り替えた新しいフィーチャーを作る(FR-503)。 */
export function setSolidSuppressed(feature: SolidFeature, suppressed: boolean): SolidFeature {
  return suppressed === feature.suppressed ? feature : { ...feature, suppressed };
}

/** 名前を変えた新しいフィーチャーを作る(FR-503)。空白だけの名前は受け付けず元のまま返す。 */
export function renameSolid(feature: SolidFeature, name: string): SolidFeature {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === feature.name ? feature : { ...feature, name: trimmed };
}

/** 選択中の要素 id から、プロパティ欄に出す立体を決める。立体でなければ null。 */
export function solidForSelection(
  document: PartDocument,
  selection: readonly string[],
): SolidFeature | null {
  const first = selection[0];
  if (first === undefined) {
    return null;
  }
  return findSolid(document, first) ?? null;
}

/** その id の失敗の理由。無ければ null(FR-504)。 */
export function partErrorMessage(
  errors: readonly PartRecomputeError[],
  featureId: string,
): string | null {
  const found = errors.find((error) => error.featureId === featureId);
  return found === undefined ? null : found.message;
}

/**
 * 体積や三角形の数が出せないときに、代わりに出す理由の文言キー(FR-504、NFR-UX-5)。
 * 「—」とだけ出すと利用者が原因を推し量れないため、必ず言葉で理由を出す。
 */
export function missingValueKey(summary: SolidSummary): MessageKey {
  if (summary.suppressed) {
    return 'featureTree.suppressed';
  }
  if (summary.consumed) {
    return 'featureTree.consumed';
  }
  return 'propertyPanel.notComputed';
}

/**
 * 体積の表示(mm³)。有効数字 12 桁で、指数表記にしない(§2.4)。
 * 式エンジンの表示規則をそのまま使い、欄ごとに丸め方が違う状態を作らない。
 */
export function formatVolume(volume: number): string {
  return expressionValueFromNumber(volume).display;
}

/** 選んでいるものの種類の見出しキー(重なりを除き、選んだ順)。複数選択のときに出す。 */
export function selectionKindLabelKeys(
  document: PartDocument,
  selection: readonly string[],
): readonly MessageKey[] {
  const keys: MessageKey[] = [];
  for (const id of selection) {
    const solid = findSolid(document, id);
    const key =
      solid === undefined
        ? sketchKindLabelKey(document, id)
        : SOLID_KIND_LABEL_KEYS[solidKindOf(solid)];
    if (key !== null && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** スケッチの要素 id から種類の見出しキーを引く。見つからなければ null。 */
function sketchKindLabelKey(document: PartDocument, elementId: string): MessageKey | null {
  const separator = elementId.indexOf('#');
  const featureId = separator < 0 ? elementId : elementId.slice(0, separator);
  for (const sketch of document.sketches) {
    const found = findFeature(sketch, featureId);
    if (found !== undefined) {
      return FEATURE_KIND_LABEL_KEYS[found.kind];
    }
  }
  return null;
}

/** ツリーの節。スケッチの節とソリッドの節に分ける(FR-501)。 */
export type TreeSectionKey = 'sketch' | 'solid';

/** ツリーの行。スケッチの要素と立体を同じ形で並べる。 */
export interface TreeRow {
  readonly id: string;
  readonly name: string;
  /** 行の頭の絵と種類の名前を決める種類。立体のブーリアンは演算ごとに分かれる。 */
  readonly kind: SketchFeatureKind | SolidLabelKey;
  readonly kindLabelKey: MessageKey;
  /** 計算できていない(FR-504)。 */
  readonly hasError: boolean;
  /** 計算できていない理由。ホバーの吹き出しに出す。無ければ null。 */
  readonly errorMessage: string | null;
  /** 抑制中(FR-503)。スケッチの要素は常に false。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
}

export interface TreeSection {
  readonly key: TreeSectionKey;
  readonly titleKey: MessageKey;
  readonly rows: readonly TreeRow[];
}

/**
 * ツリーの並びを作る(FR-501)。節は必ず「スケッチ」「ソリッド」の2つを返す。
 * 中身が空でも節は返し、呼び手が空のときの案内を出せるようにする(NFR-UX-6)。
 */
export function buildTreeSections(
  document: PartDocument,
  activeSketchId: string,
  sketchErrors: readonly SketchError[],
  partErrors: readonly PartRecomputeError[],
): readonly TreeSection[] {
  // 指し先が消えていたら先頭のスケッチを使う(ストアの activeSketchOf と同じ決め方)。
  const sketch = findSketch(document, activeSketchId) ?? document.sketches[0];
  const sketchRows: TreeRow[] = sketch.features.map((feature) => {
    const message = partErrorMessage(sketchErrors, feature.id);
    return {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      kindLabelKey: FEATURE_KIND_LABEL_KEYS[feature.kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: false,
      consumed: false,
    };
  });

  const consumed = consumedIds(document, partErrors);
  const solidRows: TreeRow[] = document.solids.map((feature) => {
    const message = partErrorMessage(partErrors, feature.id);
    const kind = solidKindOf(feature);
    return {
      id: feature.id,
      name: feature.name,
      kind,
      kindLabelKey: SOLID_KIND_LABEL_KEYS[kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: feature.suppressed,
      consumed: consumed.has(feature.id),
    };
  });

  return [
    { key: 'sketch', titleKey: 'featureTree.sketchGroup', rows: sketchRows },
    { key: 'solid', titleKey: 'featureTree.solidGroup', rows: solidRows },
  ];
}
