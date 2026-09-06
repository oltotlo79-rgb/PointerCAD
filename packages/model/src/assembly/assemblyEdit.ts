/**
 * 部品を置く・消す・固定・表示の履歴操作(計画書 docs/plans/P7-アセンブリ.md タスク7)。
 * FR-601(部品を置く)/ FR-602(固定)/ FR-505(取り消し)/ FR-605(表示と色分け)/
 * FR-606(同じ部品を何個でも置ける)。
 *
 * **すべて新しい文書を返す純関数**にする(`part/createPartDocument.ts` とまったく同じ流儀)。
 * 文書を書き換えないので、Undo / Redo は既存の `history/undoStack.ts` がそのまま効く——
 * **1 回の操作 = 1 段**で、呼び出し側が結果を `pushUndo` へ積むだけでよい。
 * `pushUndo` は `next === present`(同じ値)なら積まないので、**何も変わらない操作は
 * 元の文書をそのまま返す**ようにしてある(空の段を Undo に作らないため)。
 *
 * 見つからない id を渡されたときも**投げずに元の文書をそのまま返す**
 * (`removeSolid` / `setActiveSketch` と同じ約束。FR-504「止めずに警告する」)。
 *
 * ここに置くのは「置いた部品(インスタンス)」への操作だけで、合致・ジョイント・分解の
 * ステップを**足す**操作は、それぞれの担当(P7 タスク17・タスク35 ほか)が書く。
 * ただし**消すときの巻き添え**だけはここが担う(`removeComponent` の注釈)。
 */

import type { AppearanceSpec } from '../appearance/types.js';
import { nextSerialName } from '../sketch/createSketchDocument.js';

import { DEFAULT_COMPONENT_PLACEMENT, nextComponentId } from './createAssemblyDocument.js';
import { normalizeQuaternion } from './placementMath.js';
import type {
  AssemblyComponent,
  AssemblyDocument,
  ComponentSource,
  MateTarget,
  Placement,
  PresentationStep,
} from './types.js';

/**
 * 名前の既定 `<部品名>:<n>` の区切り(§0.a-0.8)。
 *
 * 「ブラケット:1」「ブラケット:2」のように、**同じ部品を何個置いても番号だけが増える**。
 * 連番の読み方は `nextSerialName`(「点1」「押し出し3」と同じ仕組み)を使うので、
 * 途中の 1 つを消しても残りと重ならない。
 */
export const COMPONENT_NAME_SEPARATOR = ':';

/**
 * 部品の名前が分からないときの既定の名前の元。
 *
 * 抱き込んだ部品文書には名前があるので普段は使わないが、規格部品(呼び寸法だけを持ち、
 * 形は後から組む。§0.a-0.35)のように呼び出し側が名前を決められる前でも
 * 名前が必ず付くようにしておく。`DEFAULT_ASSEMBLY_NAME` と同じ**文書の既定データ**なので、
 * UI 文字列の `ja.json` ではなくここに置く(`createSketchDocument.ts` の注釈と同じ扱い)。
 */
export const DEFAULT_COMPONENT_LABEL = '部品';

/** 置いた部品 1 つを id で引く。無ければ `undefined`。 */
export function findComponent(
  document: AssemblyDocument,
  componentId: string,
): AssemblyComponent | undefined {
  return document.components.find((component) => component.id === componentId);
}

/**
 * 次に置く部品の名前(§0.a-0.8)。`<部品名>:<n>`。
 *
 * 数えるのは**文書の全部の名前**で、利用者が改名した名前とも重ならない
 * (`nextSolidName` と同じ理由)。
 */
export function nextComponentName(document: AssemblyDocument, partName: string): string {
  return nextSerialName(
    document.components.map((component) => component.name),
    `${partName}${COMPONENT_NAME_SEPARATOR}`,
  );
}

/** `createComponentFor` に添える指定。どれも省略できる。 */
export interface CreateComponentOptions {
  /** 木と部品表に出す名前。省くと `<部品名>:<n>`(`partName` から作る)。 */
  readonly name?: string;
  /** 名前の既定に使う部品の名前(「ブラケット」→「ブラケット:1」)。省くと `部品`。 */
  readonly partName?: string;
  /** 置く場所と向き。省くと原点に、回さずに置く。 */
  readonly placement?: Placement;
}

/**
 * この文書へ置ける部品(インスタンス)を 1 つ作る。**まだ足してはいない**
 * (足すのは `addComponent`。`createSketchFor` と `addSketch` の関係と同じ)。
 *
 * **最初に置く部品は自動で固定する**(§0.a-0.7。他 CAD と同じ既定)。固定が 1 つも無いと
 * 組み立て全体が 6 自由度ぶん浮くので、1 つ目を地面にしておく。**自動で固定するのは
 * 1 つ目だけ**なので、利用者が固定を外してから 3 つ目を置いても、その 3 つ目は固定されない。
 * 後から `setFixed` で付け外しできる。
 */
export function createComponentFor(
  document: AssemblyDocument,
  source: ComponentSource,
  options: CreateComponentOptions = {},
): AssemblyComponent {
  const placement = options.placement ?? DEFAULT_COMPONENT_PLACEMENT;
  return {
    id: nextComponentId(document),
    name:
      options.name ??
      nextComponentName(document, options.partName ?? DEFAULT_COMPONENT_LABEL),
    source,
    placement: normalizedPlacement(placement),
    // 1 つも置いていないときだけ固定する(§0.a-0.7)。
    fixed: document.components.length === 0,
    visible: true,
    suppressed: false,
  };
}

/**
 * 部品を 1 つ置く(FR-601、FR-606)。並びの末尾へ足す。
 *
 * 並び順は部品表の番号と連結成分の順を決める(§2.10、§2.5.3)ので、**足した順を保つ**。
 * すでに同じ id があれば足さずに元の文書をそのまま返す——id は合致・ジョイント・分解の
 * ステップから指される識別子で、重複すると別の部品を掴むため(`appendSolid` と同じ約束)。
 */
export function addComponent(
  document: AssemblyDocument,
  component: AssemblyComponent,
): AssemblyDocument {
  if (findComponent(document, component.id) !== undefined) {
    return document;
  }
  return { ...document, components: [...document.components, component] };
}

/**
 * 置いた部品 1 つを差し替える。見つからなければ元の文書をそのまま返す。
 * id は変えない前提(id は合致・ジョイント・分解のステップからの指し先)。
 */
export function replaceComponent(
  document: AssemblyDocument,
  componentId: string,
  next: AssemblyComponent,
): AssemblyDocument {
  if (findComponent(document, componentId) === undefined) {
    return document;
  }
  return {
    ...document,
    components: document.components.map((component) =>
      component.id === componentId ? next : component,
    ),
  };
}

/** 合致・ジョイントの対象が、この部品を指しているか。 */
function targetsComponent(target: MateTarget, componentId: string): boolean {
  return target.componentId === componentId;
}

/**
 * 分解・アニメーションのステップから、消える部品(とそれに伴って消えるジョイント)を抜く。
 * 中身が空になったステップは `null`(=そのステップごと消す)。
 */
function stepWithoutComponent(
  step: PresentationStep,
  componentId: string,
  removedJointIds: ReadonlySet<string>,
): PresentationStep | null {
  if (step.body.kind === 'joint') {
    // ジョイントを駆動するステップは、そのジョイントが消えたら意味を失う。
    return removedJointIds.has(step.body.jointId) ? null : step;
  }
  if (!step.body.componentIds.includes(componentId)) {
    return step;
  }
  const componentIds = step.body.componentIds.filter((id) => id !== componentId);
  // 残りの部品があるなら**ステップは残す**(1 つ消えただけで、他の部品の分解まで失わない)。
  return componentIds.length === 0 ? null : { ...step, body: { ...step.body, componentIds } };
}

/**
 * 置いた部品を 1 つ取り除く(FR-601)。
 *
 * **その部品を指していた合致・ジョイント・分解のステップも一緒に消す。**
 * `resolveAssembly` は「消えた部品を指している合致」を検知しない(部品の解決しか見ない)ので、
 * ここで消さないと**指し先の無い合致が残り続ける**——合致を解く側(P7 タスク12 以降)が
 * 毎回「部品が見つかりません」を出し、利用者には消す手立てが無い行が木に並ぶことになる。
 *
 * 部品の側の「参照していたものは履歴に残して解決のときに断る」(`removeSolid`)とは
 * 扱いを変えている。あちらは**同じ履歴の中の順序**があり後から直せるが、合致は
 * 2 つの部品を結ぶ辺であり、**片方が消えた辺は直しようがない**ためである。
 */
export function removeComponent(
  document: AssemblyDocument,
  componentId: string,
): AssemblyDocument {
  if (findComponent(document, componentId) === undefined) {
    return document;
  }
  // 消えるジョイントの id を控えながら絞る。分解のステップがそれを駆動していたら
  // そのステップも消すので、2 回数え直さずにここで集めておく。
  const removedJointIds = new Set<string>();
  const joints = document.joints.filter((joint) => {
    if (targetsComponent(joint.a, componentId) || targetsComponent(joint.b, componentId)) {
      removedJointIds.add(joint.id);
      return false;
    }
    return true;
  });
  const presentation: PresentationStep[] = [];
  for (const step of document.presentation) {
    const next = stepWithoutComponent(step, componentId, removedJointIds);
    if (next !== null) {
      presentation.push(next);
    }
  }
  return {
    ...document,
    components: document.components.filter((component) => component.id !== componentId),
    mates: document.mates.filter(
      (mate) => !targetsComponent(mate.a, componentId) && !targetsComponent(mate.b, componentId),
    ),
    joints,
    presentation,
  };
}

/**
 * 固定(グラウンド)を付け外しする(FR-602)。
 *
 * 固定した部品は合致の連立で変数を持たない(動かない)が、**合致の対象にはなる**(§2.11)。
 * 固定を全部外しても止めない(§0.a-0.7。案内はステータスバーが出す)。
 * すでに同じ値なら元の文書をそのまま返す(Undo に空の段を作らない)。
 */
export function setFixed(
  document: AssemblyDocument,
  componentId: string,
  fixed: boolean,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined || component.fixed === fixed) {
    return document;
  }
  return replaceComponent(document, componentId, { ...component, fixed });
}

/**
 * 表示 / 非表示を切り替える(FR-605)。
 *
 * 非表示でも**組み立ての一部**なので合致の変数は持ち続ける(`types.ts` の注釈)。
 * 干渉チェックの対象からは外れる(§0.a-0.28)。
 */
export function setVisible(
  document: AssemblyDocument,
  componentId: string,
  visible: boolean,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined || component.visible === visible) {
    return document;
  }
  return replaceComponent(document, componentId, { ...component, visible });
}

/**
 * 抑制を付け外しする(FR-503 と同じ流儀。統括の決定 2026-09-06、木の行の切替から呼ぶ)。
 *
 * **非表示(`setVisible`)とは別物。** 非表示は「描かないだけ」で組み立ての一部として
 * 残る(合致の変数を持ち続ける)が、抑制は**置かなかったことにする**——`resolveAssembly` が
 * その部品を丸ごと飛ばすので、形も配置も作られない(`resolveAssembly.ts` の注釈。
 * 抑制は失敗ではないので `errors` にも入らない)。
 *
 * 抑制した部品を指している合致・ジョイント・分解のステップは**消さない**
 * (`removeComponent` の巻き添え削除とはここが違う)。抑制はいつでも戻せる一時的な指定で、
 * 戻したときに合致が消えていては元へ戻らないためである。指し先が一時的に置かれていない
 * 合致をどう扱うかは、合致を解く側(P7 タスク15)が決める。
 *
 * すでに同じ値なら元の文書をそのまま返す(Undo に空の段を作らない)。
 */
export function setComponentSuppressed(
  document: AssemblyDocument,
  componentId: string,
  suppressed: boolean,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined || component.suppressed === suppressed) {
    return document;
  }
  return replaceComponent(document, componentId, { ...component, suppressed });
}

/**
 * 木と部品表に出す名前を変える(FR-601)。
 *
 * **空の名前は受け付けない**(木の行が読めなくなるため。元の文書をそのまま返す)。
 * 同じ名前が他にあっても断らない——名前は表示のためのもので、指し先は id だからである
 * (部品文書のフィーチャーの改名と同じ扱い)。
 */
export function renameComponent(
  document: AssemblyDocument,
  componentId: string,
  name: string,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined || name === '' || component.name === name) {
    return document;
  }
  return replaceComponent(document, componentId, { ...component, name });
}

/**
 * 組図での色分けを付け外しする(FR-605)。
 *
 * `undefined` を渡すと**指定を外す**(部品自身の外観で描く)。欄そのものを消さずに
 * `undefined` を書くのは `solidSummary.ts` の `radiusEnd` と同じ流儀で、保存の JSON からは
 * 同じように消える(`JSON.stringify` は `undefined` の欄を書かない)。
 */
export function setComponentAppearance(
  document: AssemblyDocument,
  componentId: string,
  appearance: AppearanceSpec | undefined,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined) {
    return document;
  }
  return replaceComponent(document, componentId, { ...component, appearance });
}

/**
 * 向きの符号を `w >= 0` へ揃えた配置(§0.a-0.54)。
 *
 * 揃える計算そのものは `placementMath.ts` の `normalizeQuaternion` 1 か所にあり、ここは
 * **保存する形に入れる前に必ず通す**役目だけを持つ。`q` と `−q` は同じ回転なので、
 * 揃えておかないと同じ操作をした文書どうしが数の上で食い違い、決定性の検査が落ちる。
 */
function normalizedPlacement(placement: Placement): Placement {
  return { ...placement, rotation: normalizeQuaternion(placement.rotation) };
}

/**
 * 置いた場所と向きを書き換える(FR-601)。
 *
 * **合致を解いた結果はここへ書き戻さない**(§0.a-0.6)。書き換えるのは、利用者が
 * プロパティに打った値と、**引っぱって離した瞬間**だけである(§2.5.4。引っぱっている間は
 * 文書を変えず、離したときに 1 回だけこれを呼んで Undo 1 段にする)。
 */
export function moveComponent(
  document: AssemblyDocument,
  componentId: string,
  placement: Placement,
): AssemblyDocument {
  const component = findComponent(document, componentId);
  if (component === undefined) {
    return document;
  }
  return replaceComponent(document, componentId, {
    ...component,
    placement: normalizedPlacement(placement),
  });
}
