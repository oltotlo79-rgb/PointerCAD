/**
 * 選択とその場入力から「面をつなぐ」(罫線面)とロフトを作る純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27、§2.9、§2.15)。
 *
 * 対応要件: FR-430(面と面をつなぐ、球へもつなぐ、立体の面も輪郭に使える)、FR-410(ロフト)、
 * FR-201/202(式のまま持つ)、FR-502(あとから式で直せる)、FR-504(止めずに警告する)、
 * NFR-UX-1(対象を選んでから操作)、NFR-UX-4(Enter 連打で意味のある結果)、
 * NFR-UX-5(できない操作は実行前に理由を示す)。
 *
 * `solidCommands.ts`(P2 タスク18)・`primitiveCommands.ts`(P5 タスク18)と同じ流儀に揃える。
 * ストアにも DOM にも触れない純関数だけを置き、操作の判断を Node の単体検査で固定できる
 * ようにする(`docs/報告記録.md` 2026-09-02 23:09 の教訓)。文書は不変で、断るときは元の
 * 文書をそのまま返す(FR-504)。
 *
 * **どちらも対象を消費しない「作る」フィーチャー**(§0.a-0.27)。輪郭を貸した立体・球は
 * そのまま画面に残るので、要るなら和(FR-404)でまとめられる。だから加工
 * (`machiningCommands.ts`)ではなく「作る」側に置く。
 *
 * **断りの文言は model の解決(`resolvePart.ts`)と同じ内容**にしてある。同じ入力から画面と
 * 保存後で違う理由が出ないようにするためで、こちらは文言キーで持つ決まり(NFR-MA-5)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  DEFAULT_RULED_SPHERE_SEGMENTS,
  DEFAULT_RULED_TWIST,
  findSolid,
  nextSolidId,
  nextSolidName,
  type LoftFeature,
  type PartDocument,
  type RuledFeature,
  type RuledSection,
  type RuledSphereSegments,
  type SketchFeature,
  type SolidFeature,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import { findSketchFeatureAt } from './sketchRefs.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import {
  parseSubShapeId,
  subShapeRefOf,
  type SubShapeBody,
} from './subShapeSelection.js';

/** 面をつなぐ・ロフトの道具(§2.15 のツールバー「作る」の一覧のうち 2 つ)。 */
export type RuledToolId = 'ruled' | 'loft';

/** 罫線面が結ぶ断面の数。ちょうど 2 つ(§2.9.1。3 つ以上つなぐならロフト)。 */
const RULED_SECTION_COUNT = 2;

/** ロフトに要る断面の最小数(model の `MIN_THRU_SECTIONS` と同じ 2)。 */
const MIN_LOFT_SECTIONS = 2;

/** ねじれの補正の既定値(model の定数を式へ直したもの、§0.a-0.28)。 */
export const DEFAULT_RULED_TWIST_VALUE: ExpressionValue =
  expressionValueFromNumber(DEFAULT_RULED_TWIST);

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/** 面フィーチャーだけを当たりとする種類の集合(`findSketchFeatureAt` へ渡す)。 */
const SECTION_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['face', 'spline']);

/** 面をつなぐ・ロフトのコマンドが必要とする文脈。 */
export interface RuledContext {
  readonly document: PartDocument;
  /**
   * カーネルが返した立体の一覧。**立体の面を輪郭にするときの指紋**を作るのに要る
   * (`MachiningContext` / `PrimitiveContext` と同じ欄・同じ理由)。
   */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。並びがそのまま断面の並びになる。 */
  readonly selection: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 選択 → 断面の並び(FR-430、FR-410)
 * ------------------------------------------------------------------ */

/**
 * そのフィーチャーが**基本形状の球**か(FR-429)。
 *
 * `RuledSection` の `sphere` に置けるのは球の基本形状だけである(中心と半径が一意に
 * 決まるのがこれだけのため。`part/types.ts` の注釈)。ばね・回転で作った丸い形は
 * 球ではないので、面を選んでもらう(`solidFace`)ことになる。
 */
function isSphereFeature(feature: SolidFeature | undefined): boolean {
  return feature !== undefined && feature.kind === 'primitive' && feature.shape.kind === 'sphere';
}

/**
 * 選んだ要素 1 つを断面へ直す。断面にならない要素(線分・点・球でない立体そのもの)は null。
 *
 * 見る順は **立体の部分形状 → 立体そのもの → スケッチの面**。
 *
 * - 立体の面(`extrude-1#face:3`)… その立体が球なら `sphere`、そうでなければ `solidFace`。
 *   **球の面を選んでも球のボディを選んでも同じ結果**にする(NFR-UX-1。球の面は 1 枚しか
 *   無く、利用者にとって「球を選んだ」以外の意味を持たないため。タスク27 手順3)。
 * - 立体そのもの(`sphere-1`)… **球のときだけ**断面になる。球以外の立体は「どの面か」が
 *   決まらないので、面を選んでもらう(選択の種類は道具が `face` に切り替える、§2.15)。
 * - スケッチの面 … `sketchFace`。編集中のスケッチを先に見る(`sketchRefs.ts` の説明)。
 */
function ruledSectionOf(context: RuledContext, elementId: string): RuledSection | null {
  const parsed = parseSubShapeId(elementId);
  if (parsed !== null) {
    if (parsed.kind !== 'face') {
      // 辺・頂点には外周が無い(model の `THRU_SECTIONS_NOT_FACE_MESSAGE` と同じ守り)。
      return null;
    }
    if (isSphereFeature(findSolid(context.document, parsed.bodyFeatureId))) {
      return { kind: 'sphere', sphereFeatureId: parsed.bodyFeatureId };
    }
    const ref = subShapeRefOf(context.bodies, elementId);
    return ref === null ? null : { kind: 'solidFace', ref };
  }
  const solid = findSolid(context.document, elementId);
  if (solid !== undefined) {
    return isSphereFeature(solid) ? { kind: 'sphere', sphereFeatureId: solid.id } : null;
  }
  const found = findSketchFeatureAt(context.document, elementId, SECTION_KINDS);
  if (found?.feature.kind === 'spline') {
    return found.feature.closed && !found.feature.construction
      ? { kind: 'sketchCurves', ref: { sketchId: found.sketchId, curveIds: [found.featureId] } }
      : null;
  }
  return found === undefined
    ? null
    : { kind: 'sketchFace', ref: { sketchId: found.sketchId, faceFeatureId: found.featureId } };
}

/**
 * 選択を**選んだ順のまま**断面の並びへ直す(FR-430、FR-410)。
 * 断面にならない要素は黙って読み飛ばす(縫合の `selectedFaceRefs` と同じ約束で、
 * 混ざった選択のまま押しても意図どおりに作れる)。
 *
 * 罫線面はこの並びの 1 つ目が `first`、2 つ目が `second` になり、ロフトはこの並びが
 * そのまま `sections` になる(**選んだ順が形の順**、§2.15)。
 */
export function ruledSectionsOf(context: RuledContext): readonly RuledSection[] {
  const sections: RuledSection[] = [];
  for (const elementId of context.selection) {
    const section = ruledSectionOf(context, elementId);
    if (section !== null) {
      sections.push(section);
    }
  }
  return sections;
}

/**
 * 選んだ断面に球が含まれるか(§0.a-0.87)。その場入力の「なめらかさ」の選択肢を出すか
 * どうかを、ツールバーがこれで見込む(球を含まない断面では点の数が形に効かない)。
 */
export function ruledSelectionHasSphere(context: RuledContext): boolean {
  return ruledSectionsOf(context).some((section) => section.kind === 'sphere');
}

/**
 * 断面に選んだ球が、いま輪郭の相手にできるか(§2.9.3)。
 *
 * **中心を立体の頂点で決めた球は断る。** model は頂点の座標を持たず(選び直せるのは
 * カーネルだけ)、段へ渡せるのは中心の座標そのものなので、解決のときに必ず失敗する
 * (`resolvePart.ts` の `THRU_SECTIONS_SPHERE_ORIGIN_MESSAGE`)。押した後に失敗させず、
 * 押す前に理由を出す(NFR-UX-5)。座標・スケッチの点で置いた球は通る。
 */
function sphereSectionRejection(
  document: PartDocument,
  sections: readonly RuledSection[],
): MessageKey | null {
  for (const section of sections) {
    if (section.kind !== 'sphere') {
      continue;
    }
    const sphere = findSolid(document, section.sphereFeatureId);
    if (sphere !== undefined && sphere.kind === 'primitive' && sphere.origin.kind === 'vertex') {
      return 'ruledError.sphereOrigin';
    }
  }
  return null;
}

/**
 * 断面の並びが罫線面として成り立つかを確かめる(NFR-UX-5)。成り立てば null。
 *
 * 見る順は model の `planRuled` と同じ「数 → 球どうし → 球の中心」。同じ入力から必ず同じ
 * 理由が出るようにするためで、片方だけ順序を変えると「画面は赤いのに保存したファイルを
 * 開くと別の理由が出る」ことになる。
 */
export function ruledSectionsRejection(
  document: PartDocument,
  sections: readonly RuledSection[],
): MessageKey | null {
  if (sections.length !== RULED_SECTION_COUNT) {
    return 'ruledError.needTwoSections';
  }
  if (sections.every((section) => section.kind === 'sphere')) {
    // 球どうしは直線で結べない(§2.9.3。接する直線の相手になる輪郭が無い)。
    return 'ruledError.twoSpheres';
  }
  return sphereSectionRejection(document, sections);
}

/**
 * 断面の並びがロフトとして成り立つかを確かめる(NFR-UX-5)。成り立てば null。
 * 見る順は model の `planLoft` と同じ「数 → 球の混入」(罫線面と同じ理由)。
 */
export function loftSectionsRejection(sections: readonly RuledSection[]): MessageKey | null {
  if (sections.length < MIN_LOFT_SECTIONS) {
    return 'loftError.needTwoSections';
  }
  // 球は縁を持たないので、なめらかにつなぐ相手にできない(model の `LOFT_SPHERE_MESSAGE`)。
  return sections.some((section) => section.kind === 'sphere') ? 'loftError.sphere' : null;
}

/* ------------------------------------------------------------------ *
 * 値の先出し検査(§0.a-0.28、NFR-UX-5)
 * ------------------------------------------------------------------ */

/**
 * ねじれの補正が作れる値かを**カーネルを呼ぶ前に**確かめる(§0.a-0.28)。
 *
 * **整数でなければ断る(切り捨てない)。** model の `resolveThruSectionsTwist` と同じ判定で、
 * 「1.5 個ぶんずらす」に意味が無いのに黙って 1 個ぶんにすると、利用者は書いた式と形の
 * 食い違いに気付けないためである。負の数は「逆向きに回す」意味で正しいので断らない
 * (カーネルが輪郭の頂点数で割った余りを使う)。
 */
export function ruledTwistRejection(twist: ExpressionValue): MessageKey | null {
  return Number.isInteger(twist.value) ? null : 'ruledError.twistNotInteger';
}

/* ------------------------------------------------------------------ *
 * 押せる条件(NFR-UX-5)
 * ------------------------------------------------------------------ */

/**
 * 面をつなぐがいま押せるか(FR-430、NFR-UX-5)。
 *
 * 押せるのは断面がちょうど 2 つ選ばれているときで、その組み合わせは
 * 「スケッチの面 2 つ」「スケッチの面 + 球」「立体の面 + スケッチの面」「立体の面 2 つ」
 * 「立体の面 + 球」のいずれか。球どうしだけが作れない。
 *
 * ねじれは欄の既定が 0 なので押せる条件には入らない(NFR-UX-4。値の検査は確定のとき)。
 */
export function ruledToolReadiness(context: RuledContext): SolidToolReadiness {
  const rejection = ruledSectionsRejection(context.document, ruledSectionsOf(context));
  return rejection === null ? READY : { ready: false, reasonKey: rejection };
}

/** ロフトがいま押せるか(FR-410、NFR-UX-5)。断面が 2 つ以上で、球を含まないこと。 */
export function loftToolReadiness(context: RuledContext): SolidToolReadiness {
  const rejection = loftSectionsRejection(ruledSectionsOf(context));
  return rejection === null ? READY : { ready: false, reasonKey: rejection };
}

/**
 * 道具 id が面をつなぐ・ロフトかどうか(`as` を使わずに絞り込む)。
 * `SolidInputCommit.tool` は押し出し・加工も含む `SolidToolId` なので、確定を受けるときに
 * ここで 1 度だけ絞る(`primitiveCommands.ts` の `primitiveToolOf` と同じ形)。
 */
export function ruledToolOf(tool: string): RuledToolId | null {
  switch (tool) {
    case 'ruled':
    case 'loft':
      return tool;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 確定(その場入力 → フィーチャー)
 * ------------------------------------------------------------------ */

/**
 * 面をつなぐを 1 つ作って履歴へ積む(FR-430)。**履歴は 1 段**(押し出し・基本形状と同じ)。
 *
 * 断面は**決めた時点の選択**から拾い直す(ポップアップを開いたまま選び直せるので、
 * 最後に選ばれていたものを使うのが利用者の期待に合う。NFR-UX-1)。
 * 断面が揃わない・ねじれが整数でないときは**履歴を変えずに断る**(NFR-UX-5)。
 */
export function commitRuled(
  context: RuledContext,
  params: {
    readonly twist: ExpressionValue;
    readonly sphereSegments: RuledSphereSegments;
  },
): SolidCommandOutcome {
  const sections = ruledSectionsOf(context);
  const rejection = ruledSectionsRejection(context.document, sections);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const twistRejection = ruledTwistRejection(params.twist);
  if (twistRejection !== null) {
    return { ok: false, reasonKey: twistRejection };
  }
  const [first, second] = sections;
  if (first === undefined || second === undefined) {
    // `ruledSectionsRejection` が数を確かめた後なので通らないが、添字の絞り込みに要る。
    return { ok: false, reasonKey: 'ruledError.needTwoSections' };
  }
  const id = nextSolidId(context.document, 'ruled');
  const feature: RuledFeature = {
    id,
    name: nextSolidName(context.document, 'ruled'),
    suppressed: false,
    kind: 'ruled',
    first,
    second,
    twist: params.twist,
    sphereSegments: params.sphereSegments,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * ロフトを 1 つ作って履歴へ積む(FR-410)。**履歴は 1 段**。
 * 断面の並びは**選んだ順**そのままで、球は使えない(§2.9.3)。
 */
export function commitLoft(
  context: RuledContext,
  params: { readonly twist: ExpressionValue; readonly smooth?: boolean },
): SolidCommandOutcome {
  const sections = ruledSectionsOf(context);
  const rejection = loftSectionsRejection(sections);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const twistRejection = ruledTwistRejection(params.twist);
  if (twistRejection !== null) {
    return { ok: false, reasonKey: twistRejection };
  }
  const id = nextSolidId(context.document, 'loft');
  const feature: LoftFeature = {
    id,
    name: nextSolidName(context.document, 'loft'),
    suppressed: false,
    kind: 'loft',
    smooth: params.smooth ?? false,
    sections,
    twist: params.twist,
  };
  return { ok: true, document: appendSolid(context.document, feature), featureId: id };
}

/**
 * その場入力の確定結果から、面をつなぐかロフトを 1 つ作る(タスク24 の `SolidInputCommit`)。
 * 欄が空のまま決めたときは既定値で作る(NFR-UX-4。ねじれ 0、なめらかさ ふつう)。
 */
export function commitRuledInput(
  context: RuledContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const tool = ruledToolOf(commit.tool);
  const twist = commit.values.ruledTwist ?? DEFAULT_RULED_TWIST_VALUE;
  switch (tool) {
    case 'ruled':
      return commitRuled(context, {
        twist,
        // 球を含まない断面では選択肢そのものを出さないので、既定が入る(形には効かない)。
        sphereSegments: commit.ruledSphereSegments ?? DEFAULT_RULED_SPHERE_SEGMENTS,
      });
    case 'loft':
      return commitLoft(context, { twist, smooth: commit.flags.loftSmooth });
    case null:
      // 面をつなぐ・ロフトでない道具の確定が回ってきた(呼び出し側の振り分けの誤り)。
      return { ok: false, reasonKey: 'ruledError.notRuledTool' };
  }
}

/* ------------------------------------------------------------------ *
 * プロパティ(FR-502、FR-201)
 * ------------------------------------------------------------------ */

/**
 * 「ねじれが効かない」旨の注記を出すか(§0.a-0.87、タスク24b の実装)。
 *
 * カーネルは**立体の面から取り出した外周を元の並びのまま結び、ずらしを断りもしない**。
 * 効かない欄を黙って出すと「値を変えたのに形が変わらない」ことになり、利用者は理由を
 * 推し量れない(NFR-UX-5 の裏返し)ので、断面に立体の面が 1 つでもあれば注記を添える。
 * 効かないだけで**間違いではない**ので、赤い断りではなく淡い注記にする(rules/04
 * 「止めずに警告する」)。
 */
export function ruledTwistNoteKey(feature: RuledFeature | LoftFeature): MessageKey | null {
  const sections =
    feature.kind === 'ruled' ? [feature.first, feature.second] : feature.sections;
  return sections.some((section) => section.kind === 'solidFace')
    ? 'propertyPanel.ruledTwistSolidFaceNote'
    : null;
}
