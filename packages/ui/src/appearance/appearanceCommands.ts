/**
 * 外観(色・材質・柄・透過率/光沢/粗さ)の割り当てを、選択と文書から確定する純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク11、§2.2.2、§0.a-0.11)。
 *
 * 対応要件: FR-1106(立体ごと・面ごとの色)、FR-1107(材質プリセット)、FR-1108(柄)、
 * FR-1109(個別の調整)、FR-1110(既定と取り消し)、FR-505(Undo)、NFR-UX-5。
 *
 * `parameterCommands.ts` / `referenceCommands.ts` / `shapeCommands.ts` と同じ流儀にそろえる。
 * DOM にも three.js にもストアにも触れず、文書は不変で、断るときは**文書を 1 バイトも
 * 変えずに**理由の文言キーだけを返す(FR-504「止めずに警告する」、NFR-UX-5「実行してから
 * 失敗させない」)。ストア(`useAppStore.ts`)はここが返した文書を `applyDocument` へ
 * 渡すだけでよく、Undo(FR-505)と保存はそれで自動的に効く。
 *
 * **外観の変更は再計算を起こさない。** `PartDocument.appearance` しか変えないので
 * `affectsShape`(model の `part/documentChange.ts`)が偽になり、ストアの購読も
 * `isComputing` の札も動かない(§2.3、タスク10 で配線済み)。ここでは形に関わる欄
 * (`solids` / `sketches` / `activeSketchId`)を一切触らないことがその前提になる。
 *
 * **上限の断りは「割り当てを作る前」に行う**(§0.a-0.11、NFR-UX-5)。描画側
 * (`buildFaceGroups` → `buildSolidGeometry`)は上限を超えても止まらず既定 1 色へ落とすが、
 * それは「作れてしまった文書」への保険であって、利用者への返事にはならない。上限の**数**は
 * `buildFaceGroups.ts` の `MAX_MATERIALS_PER_BODY` / `MAX_GROUPS_PER_BODY` を import して
 * 使い、2 か所に書かない(同じ判断材料を 1 か所に置く。docs/報告記録.md 2026-09-04 03:20 ②)。
 */

import type { ExpressionValue } from '@pointercad/expression';
import {
  appearanceFromPreset,
  appearanceOf,
  assignBodyAppearance,
  assignFaceAppearance,
  clearDocumentAppearance,
  DEFAULT_APPEARANCE,
  findMaterialPreset,
  isSameAppearanceTarget,
  removeDocumentAppearance,
  resolveAppearanceFor,
  WOOD_SPECIES,
  type AppearanceMatchEntry,
  type AppearancePattern,
  type AppearancePresetId,
  type AppearanceSpec,
  type AppearanceTable,
  type AppearanceTarget,
  type PartDocument,
  type WoodSpecies,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import {
  selectedBodyIds,
  selectedSubShapeRefs,
  type SelectionKind,
  type SubShapeBody,
} from '../solid/subShapeSelection.js';
import type { AppearanceInput, BodyAppearanceInput } from '../viewport/buildSolidGeometry.js';
import { appearanceKeyText, buildFaceGroups, MAX_MATERIALS_PER_BODY } from './buildFaceGroups.js';

/* ---------------------------------------------------------------------------
 * 入力と結果の型
 * ------------------------------------------------------------------------- */

/**
 * 外観の操作が見るもの一式。ストアの欄をそのまま並べただけで、ここでは読むだけにする
 * (`machiningCommands.ts` の `MachiningContext` と同じ流儀)。
 */
export interface AppearanceContext {
  readonly document: PartDocument;
  /** いま画面に出ているボディ(面の一覧を持つ)。上限の先出し検査に使う。 */
  readonly bodies: readonly SubShapeBody[];
  /** 選んでいる要素の id(立体そのもの、または `extrude-1#face:3` の形)。 */
  readonly selection: readonly string[];
  /** いま選ぶ部分形状の種類(§0.a-0.6)。 */
  readonly selectionKind: SelectionKind;
  /** 直前の再計算でカーネルが選び直した面の対応(§2.2.3)。 */
  readonly matches: readonly AppearanceMatchEntry[];
}

/** 確定できた。`document` は外観だけが変わった新しい文書(何も変わらなければ同一参照)。 */
export interface AppearanceSuccess {
  readonly ok: true;
  readonly document: PartDocument;
}

/** 断った。文書は 1 バイトも変えず、理由の文言キーだけを返す(NFR-UX-5)。 */
export interface AppearanceRejection {
  readonly ok: false;
  readonly reasonKey: MessageKey;
}

export type AppearanceOutcome = AppearanceSuccess | AppearanceRejection;

/* ---------------------------------------------------------------------------
 * 値の比較(同じ外観をもう一度割り当てたときに文書を作り直さないため)
 * ------------------------------------------------------------------------- */

/**
 * 式が同じか。`display` は `value` から導けるので見ない(同じ値なら必ず同じ文字になる)。
 * `source` を見るのは、`10` と `5+5` を「同じ外観」とみなすと利用者が打ち直した式が
 * 文書へ残らなくなるため(FR-202「式は文字列のまま保存」)。
 */
function isSameExpression(a: ExpressionValue, b: ExpressionValue): boolean {
  return a.source === b.source && a.value === b.value;
}

/** 柄が同じか(FR-1108)。 */
function isSamePattern(a: AppearancePattern, b: AppearancePattern): boolean {
  switch (a.kind) {
    case 'none':
      return b.kind === 'none';
    case 'expandedMetal':
      return b.kind === 'expandedMetal' && isSameExpression(a.spacing, b.spacing);
    case 'checkerPlate':
      return b.kind === 'checkerPlate' && isSameExpression(a.spacing, b.spacing);
    case 'woodGrain':
      return (
        b.kind === 'woodGrain' &&
        isSameExpression(a.spacing, b.spacing) &&
        a.species === b.species
      );
  }
}

/**
 * 外観が全欄で同じか(FR-1107、FR-1109)。
 *
 * 描画の鍵(`appearanceKeyText`)と違い、**プリセットの id と式の文字も見る**。
 * 鍵は「同じ絵になるか」を判定して材質を使い回すためのもので、こちらは「文書を作り直す
 * 必要があるか」を判定するためのものなので、見るべき範囲が違う。
 */
export function isSameAppearanceSpec(a: AppearanceSpec, b: AppearanceSpec): boolean {
  return (
    a.preset === b.preset &&
    a.color === b.color &&
    isSameExpression(a.transmission, b.transmission) &&
    isSameExpression(a.gloss, b.gloss) &&
    isSameExpression(a.roughness, b.roughness) &&
    isSamePattern(a.pattern, b.pattern)
  );
}

/* ---------------------------------------------------------------------------
 * 値の範囲(FR-1109)
 * ------------------------------------------------------------------------- */

/** 透過率・光沢・粗さの下限・上限(%、§2.2.1 の型の注釈)。 */
const PERCENT_MIN = 0;
const PERCENT_MAX = 100;

function inPercentRange(value: ExpressionValue): boolean {
  return Number.isFinite(value.value) && value.value >= PERCENT_MIN && value.value <= PERCENT_MAX;
}

/**
 * 透過率・光沢・粗さが 0〜100 に収まっているか(FR-1109)。外れていれば理由の文言キー。
 *
 * **式そのものの検査(打っている途中の欄の赤)は `numericInput.ts` の `rangeErrorFor` が
 * 受け持つ**ので、ここでは二重に作らない。ここが見るのは「確定として渡ってきた値」だけで、
 * 欄を通らない入口(コマンドライン・復元した文書・検査)から外れ値が入るのを止める最後の
 * 一段になる。
 */
function rangeRefusalFor(spec: AppearanceSpec): MessageKey | null {
  const ok =
    inPercentRange(spec.transmission) &&
    inPercentRange(spec.gloss) &&
    inPercentRange(spec.roughness);
  return ok ? null : 'appearanceError.outOfRange';
}

/* ---------------------------------------------------------------------------
 * 選択 → 割り当て先
 * ------------------------------------------------------------------------- */

/** 対象が属するボディ(立体はそれ自身、面は参照先)。上限の先出し検査の単位になる。 */
function bodyIdOfTarget(target: AppearanceTarget): string {
  return target.kind === 'body' ? target.bodyFeatureId : target.ref.bodyFeatureId;
}

/**
 * いま選んでいるものを、外観の割り当て先へ直す(FR-1106)。
 *
 * 面が選ばれていれば面へ、そうでなければ立体へ割り当てる。面のほうを先に見るのは、
 * 面は「立体のこの 1 枚だけ」という細かい指定であり、両方が選択に入っているときに
 * 立体を選ぶと利用者の細かい指定を握りつぶすことになるため(NFR-UX-1)。
 *
 * ただし**選ぶ種類が面でないときは立体を優先する**。外観の道具を選ぶ前に立体を選んで
 * おいた場合(選ぶ種類が `body` のまま面 id が選択に残っている場合)に、意図しない面へ
 * 色が付くのを避けるため。どちらも無ければ空を返し、呼び出し側が `noTarget` で断る。
 */
export function appearanceTargetsOf(context: AppearanceContext): readonly AppearanceTarget[] {
  const faceRefs = selectedSubShapeRefs(context.bodies, context.selection, 'face');
  const liveIds = context.bodies.map((body) => body.featureId);
  const bodyIds = selectedBodyIds(context.selection, liveIds);
  const useFaces =
    faceRefs.length > 0 && (context.selectionKind === 'face' || bodyIds.length === 0);
  if (useFaces) {
    return faceRefs.map((ref) => ({ kind: 'face', ref }));
  }
  return bodyIds.map((bodyFeatureId) => ({ kind: 'body', bodyFeatureId }));
}

/**
 * 外観を割り当てられる状態か(NFR-UX-5)。ツールバーのボタンの押せる条件と、
 * 断りの文言をここ 1 か所で決める(同じ判断を画面側に書かない)。
 */
export function appearanceReadiness(context: AppearanceContext): {
  readonly ok: boolean;
  readonly reasonKey: MessageKey | null;
} {
  return appearanceTargetsOf(context).length > 0
    ? { ok: true, reasonKey: null }
    : { ok: false, reasonKey: 'appearanceError.noTarget' };
}

/* ---------------------------------------------------------------------------
 * 上限の先出し検査(§0.a-0.11)
 * ------------------------------------------------------------------------- */

/** 面の割り当てが 1 つも無いボディに使う空の表(呼び出しごとに Map を作らない)。 */
const NO_FACE_APPEARANCES: ReadonlyMap<number, AppearanceSpec> = new Map<number, AppearanceSpec>();

/**
 * そのボディで使うことになる材質の種類の数。
 *
 * `buildFaceGroups` は上限を超えた時点で `null` を返して数を教えないので、**断りの文言を
 * 材質とまとまりで言い分けるために**ここで数え直す。数え方(0 枚の面を飛ばす、見え方の
 * 鍵でまとめる)は `buildFaceGroups` と同じ材料(`appearanceKeyText`)を使う。
 */
function countMaterials(
  body: SubShapeBody,
  assignment: BodyAppearanceInput | undefined,
  base: AppearanceSpec,
): number {
  const keys = new Set<string>([appearanceKeyText(base)]);
  const faceAppearances = assignment?.faceAppearances ?? NO_FACE_APPEARANCES;
  for (const face of body.faces) {
    // 三角形が付かなかった面は描かれないので材質も要らない(`buildFaceGroups` と同じ判定)。
    if (!(face.triangleCount > 0)) {
      continue;
    }
    keys.add(appearanceKeyText(faceAppearances.get(face.index) ?? base));
  }
  return keys.size;
}

/**
 * そのボディが上限(材質 8 種 / まとまり 32 個)に収まるか。収まれば `null`、
 * 超えるなら断りの文言キー。判定そのものは描画と同じ `buildFaceGroups` に任せ、
 * ここでは「どちらの上限を超えたか」だけを決める(判定を 2 通り持たない)。
 */
function limitRefusalFor(
  body: SubShapeBody,
  input: AppearanceInput,
): MessageKey | null {
  const assignment = input.byBody.get(body.featureId);
  const bodyAppearance = assignment?.bodyAppearance ?? null;
  const base = bodyAppearance ?? input.defaultAppearance;
  const plan = buildFaceGroups(
    body.faces,
    assignment?.faceAppearances ?? NO_FACE_APPEARANCES,
    bodyAppearance,
    input.defaultAppearance,
  );
  if (plan !== null) {
    return null;
  }
  return countMaterials(body, assignment, base) > MAX_MATERIALS_PER_BODY
    ? 'appearanceError.tooManyMaterials'
    : 'appearanceError.tooManyGroups';
}

/* ---------------------------------------------------------------------------
 * 面の通し番号 → 外観(描画へ渡す一式)
 * ------------------------------------------------------------------------- */

/**
 * 外観の割り当て(文書の表)と、カーネルが選び直した面の対応から、組み立てへ渡す一式を作る
 * (FR-1106)。three.js にも DOM にも触れない純関数。
 *
 * ```
 * 立体の割り当て → byBody(featureId).bodyAppearance
 * 面の割り当て   → byBody(featureId).faceAppearances(面の通し番号)
 * ```
 *
 * **面の通し番号の決め方(3 段):**
 *
 * 1. 再計算のたびにカーネルが指紋で選び直した結果(`matches`)に同じ id があれば、その番号。
 * 2. 番号が `null`(選び直せなかった)なら**その割り当ては描かない**。既定の外観で描き、
 *    警告を出すのは呼び出し側(`missingAppearanceCount`。FR-1106「選び直せなかった割り当ては
 *    警告し既定へ戻す」)。
 * 3. `matches` に同じ id が 1 つも無いときは、**割り当てを作ったときの通し番号**
 *    (`SubShapeRef.index`)を使う。外観だけを変えても再計算は起きない(§2.3)ので、
 *    割り当てた直後は照合の結果がまだ無い。形はその瞬間から変わっていないため、
 *    保存された通し番号がそのまま正しい。これが無いと「色を付けたのに次に形を変えるまで
 *    色が出ない」ことになる。
 *
 * **置き場について:** タスク10 では `viewport/createSolidLayer.ts` にあったが、three.js に
 * 触れない純関数であり、上限の先出し検査(このファイル)からも同じものを使うため、
 * タスク11 でここへ移した(同じ組み立てを 2 か所に持たない)。
 */
export function buildAppearanceInput(
  table: AppearanceTable,
  matches: readonly AppearanceMatchEntry[],
): AppearanceInput {
  const matchById = new Map<string, AppearanceMatchEntry>();
  for (const match of matches) {
    matchById.set(match.id, match);
  }

  const byBody = new Map<string, BodyAppearanceInput>();
  const faceMaps = new Map<string, Map<number, AppearanceSpec>>();
  function slotFor(featureId: string): { faces: Map<number, AppearanceSpec> } {
    let faces = faceMaps.get(featureId);
    if (faces === undefined) {
      faces = new Map<number, AppearanceSpec>();
      faceMaps.set(featureId, faces);
      byBody.set(featureId, { bodyAppearance: null, faceAppearances: faces });
    }
    return { faces };
  }

  for (const entry of table.entries) {
    if (entry.target.kind === 'body') {
      const { bodyFeatureId } = entry.target;
      slotFor(bodyFeatureId);
      byBody.set(bodyFeatureId, {
        bodyAppearance: entry.appearance,
        faceAppearances: faceMaps.get(bodyFeatureId) ?? new Map<number, AppearanceSpec>(),
      });
      continue;
    }
    const { ref } = entry.target;
    const match = matchById.get(entry.id);
    const faceIndex = match === undefined ? ref.index : match.faceIndex;
    if (faceIndex === null) {
      continue;
    }
    const bodyFeatureId = match === undefined ? ref.bodyFeatureId : match.bodyFeatureId;
    slotFor(bodyFeatureId).faces.set(faceIndex, entry.appearance);
  }

  return { defaultAppearance: DEFAULT_APPEARANCE, byBody };
}

/* ---------------------------------------------------------------------------
 * 確定(割り当てる・外す・すべて戻す)
 * ------------------------------------------------------------------------- */

/** その対象を直接指す割り当ての外観。無ければ `null`(立体の割り当てや既定は見ない)。 */
function directAppearanceOf(
  table: AppearanceTable,
  target: AppearanceTarget,
): AppearanceSpec | null {
  const entry = table.entries.find((candidate) =>
    isSameAppearanceTarget(candidate.target, target),
  );
  return entry?.appearance ?? null;
}

/** 対象 1 つへ割り当てる。すでに同じ外観なら**元の文書を同一参照のまま返す**。 */
function assignOne(
  document: PartDocument,
  target: AppearanceTarget,
  spec: AppearanceSpec,
): PartDocument {
  const current = directAppearanceOf(appearanceOf(document), target);
  if (current !== null && isSameAppearanceSpec(current, spec)) {
    return document;
  }
  return target.kind === 'body'
    ? assignBodyAppearance(document, target.bodyFeatureId, spec)
    : assignFaceAppearance(document, target.ref, spec);
}

/**
 * 選んでいるものへ外観を割り当てる(FR-1106、FR-1107、FR-1109)。
 *
 * 断る条件は 3 つで、いずれも**割り当てを作る前**に判定する(NFR-UX-5)。
 *
 * | 断り | 文言キー |
 * |---|---|
 * | 透過率・光沢・粗さが 0〜100 の外 | `appearanceError.outOfRange` |
 * | 立体も面も選ばれていない | `appearanceError.noTarget` |
 * | そのボディの材質が 9 種以上になる | `appearanceError.tooManyMaterials` |
 * | そのボディのまとまりが 33 個以上になる | `appearanceError.tooManyGroups` |
 *
 * 上限の判定は**割り当てを足した後の文書**で行うが、断ったときはその文書を捨てて
 * 元の文書のまま返す(文書は 1 バイトも変わらない)。
 */
export function assignAppearanceToSelection(
  context: AppearanceContext,
  spec: AppearanceSpec,
): AppearanceOutcome {
  const rangeRefusal = rangeRefusalFor(spec);
  if (rangeRefusal !== null) {
    return { ok: false, reasonKey: rangeRefusal };
  }
  const targets = appearanceTargetsOf(context);
  if (targets.length === 0) {
    return { ok: false, reasonKey: 'appearanceError.noTarget' };
  }

  let next = context.document;
  for (const target of targets) {
    next = assignOne(next, target, spec);
  }
  if (next === context.document) {
    // すでに同じ外観だった。文書を作り直さないので Undo の段も増えない(FR-505)。
    return { ok: true, document: context.document };
  }

  // 上限は「割り当てを作る前」に断る(§0.a-0.11)。触ったボディだけを見ればよい。
  const input = buildAppearanceInput(appearanceOf(next), context.matches);
  const touched = new Set(targets.map(bodyIdOfTarget));
  for (const body of context.bodies) {
    if (!touched.has(body.featureId)) {
      continue;
    }
    const refusal = limitRefusalFor(body, input);
    if (refusal !== null) {
      return { ok: false, reasonKey: refusal };
    }
  }
  return { ok: true, document: next };
}

/**
 * 割り当てを 1 つ外す(FR-1110「割り当てを 1 つずつ…取り消せる」)。
 * 見つからなければ元の文書をそのまま返す(model の `removeDocumentAppearance` の約束)。
 */
export function removeAppearanceAt(document: PartDocument, id: string): PartDocument {
  return removeDocumentAppearance(document, id);
}

/** すべての割り当てを外して既定の外観に戻す(FR-1110「すべて既定に戻す」)。 */
export function clearAllAppearance(document: PartDocument): PartDocument {
  return clearDocumentAppearance(document);
}

/* ---------------------------------------------------------------------------
 * いま効いている外観(プロパティの欄の初期値)
 * ------------------------------------------------------------------------- */

/**
 * いま選んでいるものに効いている外観(§2.2.2 の 3 段の優先順位)。
 * 何も選んでいなければ既定の外観を返す(欄が空になるより、既定を出すほうが分かりやすい)。
 *
 * 複数選んでいるときは**最初の 1 つ**を出す。プロパティの欄は 1 組しかないので、
 * 全部の共通部分を取って空欄にするより、代表を出して打ち替えられるほうが操作が短い
 * (NFR-UX-4「既定値はいま測った値」と同じ考え方)。
 */
export function appearanceOfSelection(context: AppearanceContext): AppearanceSpec {
  const targets = appearanceTargetsOf(context);
  if (targets.length === 0) {
    return DEFAULT_APPEARANCE;
  }
  return resolveAppearanceFor(appearanceOf(context.document), targets[0]);
}

/* ---------------------------------------------------------------------------
 * 見つからない割り当て(FR-1106 の警告)
 * ------------------------------------------------------------------------- */

/**
 * 選び直せなかった割り当ての id(FR-1106)。形が変わって指紋が合わなくなった面を指す。
 *
 * 判定は「照合の結果が届いていて、その `faceIndex` が `null`」だけにする。照合の結果が
 * まだ届いていない割り当て(色を付けた直後。外観の変更は再計算を起こさないので照合も
 * 走らない)は**見つからない扱いにしない**。付けた瞬間に「見つかりません」と出るのは
 * 事実に反するため。
 *
 * 文書に無くなった id の照合(前の文書の残り)は数えない。
 */
export function missingAppearanceIds(
  document: PartDocument,
  matches: readonly AppearanceMatchEntry[],
): readonly string[] {
  const known = new Set(appearanceOf(document).entries.map((entry) => entry.id));
  return matches
    .filter((match) => match.faceIndex === null && known.has(match.id))
    .map((match) => match.id);
}

/** 選び直せなかった割り当ての数(帯の警告 `statusBar.appearanceMissing` の件数)。 */
export function missingAppearanceCount(
  document: PartDocument,
  matches: readonly AppearanceMatchEntry[],
): number {
  return missingAppearanceIds(document, matches).length;
}

/* ---------------------------------------------------------------------------
 * 外観 1 つの作り替え(プロパティの欄が使う。FR-1107〜1109)
 * ------------------------------------------------------------------------- */

/**
 * 値を個別に変えたときのプリセットの id。
 *
 * プリセットは「選ぶだけで 5 つがまとまって決まる」ためのもの(FR-1107)なので、
 * そのうち 1 つを打ち替えたら、もうそのプリセットそのものではない。id を
 * `'custom'`(自分で決める)へ移して、プリセットの一覧の選択状態と画面の値が食い違わない
 * ようにする(`appearance/types.ts` の `AppearancePresetId` の注釈)。
 *
 * 色だけは例外で、色を選べるプリセット(プラスチック・自分で決める)はプリセットのまま
 * 色を変えられる(FR-1107「プラスチック(色を選べる)」)。
 */
const CUSTOM_PRESET: AppearancePresetId = 'custom';

/** プリセットを選び直す(FR-1107)。色を選べるプリセットには今の色を引き継ぐ。 */
export function appearanceWithPreset(
  spec: AppearanceSpec,
  preset: AppearancePresetId,
): AppearanceSpec {
  return appearanceFromPreset(preset, spec.color);
}

/**
 * 色を差し替える(FR-1109)。色を選べるプリセットはプリセットのまま、
 * それ以外は「自分で決める」へ移る(上の `customized` の理由)。
 */
export function appearanceWithColor(spec: AppearanceSpec, color: string): AppearanceSpec {
  if (color === spec.color) {
    return spec;
  }
  const preset = findMaterialPreset(spec.preset);
  const colorEditable = preset !== undefined && preset.colorEditable;
  return { ...spec, color, preset: colorEditable ? spec.preset : CUSTOM_PRESET };
}

/** 透過率・光沢・粗さのどれを差し替えるか(FR-1109)。 */
export type AppearanceNumberField = 'transmission' | 'gloss' | 'roughness';

/** 透過率・光沢・粗さを 1 つ差し替える(FR-1109)。プリセットは「自分で決める」へ移る。 */
export function appearanceWithNumber(
  spec: AppearanceSpec,
  field: AppearanceNumberField,
  value: ExpressionValue,
): AppearanceSpec {
  if (isSameExpression(spec[field], value)) {
    return spec;
  }
  return { ...spec, [field]: value, preset: CUSTOM_PRESET };
}

/** 柄を差し替える(FR-1108)。プリセットは「自分で決める」へ移る。 */
export function appearanceWithPattern(
  spec: AppearanceSpec,
  pattern: AppearancePattern,
): AppearanceSpec {
  if (isSamePattern(spec.pattern, pattern)) {
    return spec;
  }
  return { ...spec, pattern, preset: CUSTOM_PRESET };
}

/**
 * 木材の樹種を選び直す(FR-1107、§0.a-0.5)。**地の色と木目の樹種を同時に差し替える**
 * (`materialPresets.ts` の `appearanceFromPreset` の注釈がこの操作をここへ割り当てている)。
 * 柄が木目でないときは何もしない(樹種は木目の柄が持つ値のため)。
 */
export function appearanceWithWoodSpecies(
  spec: AppearanceSpec,
  species: WoodSpecies,
): AppearanceSpec {
  if (spec.pattern.kind !== 'woodGrain' || spec.pattern.species === species) {
    return spec;
  }
  const info = WOOD_SPECIES.find((candidate) => candidate.id === species);
  if (info === undefined) {
    return spec;
  }
  return {
    ...spec,
    color: info.baseColor,
    pattern: { ...spec.pattern, species },
  };
}
