/**
 * アセンブリの木の行の組み立て(計画書 docs/plans/P7-アセンブリ.md タスク9。
 * FR-501 / FR-604 / FR-605、要件§7.1 の「ツリー」の欄)。
 *
 * 部品のときの木(`solid/solidSummary.ts` の `buildTreeSections`)とまったく同じ流儀で、
 * **行の組み立てはここ(純関数)**、`AssemblyTree.tsx` は**並べるだけ**にする。
 * three にもストアにも触れないので、Node の Vitest だけで検査できる。
 *
 * 束(節)は**部品 / 合致 / ジョイント / 分解ステップの 4 つ**で、中身が空でも必ず 4 つ返す
 * (空のときの案内を呼び手が出せるようにするため。部品側の `buildTreeSections` と同じ約束)。
 * **部品を 1 つも置いていないアセンブリ全体の案内は `AppShell` が出す**(`assembly.emptyState`。
 * P7 タスク5)ので、ここでは束ごとの短い案内だけを持ち、二重に出さない。
 *
 * **行の `key` には必ず種類の接頭辞を付ける**(`rules/06` 10.9)。部品の id・合致の id・
 * ジョイントの id・ステップの id は別々に採番される(`component-1` / `mate-1` …)ので
 * 普段は重ならないが、**壊れたファイル・古いファイルでは重なりうる**。重なった瞬間に
 * 「消したはずの行が残る」事故が起きる(10.9 が外観の節で実際に起こした)ので、
 * 接頭辞を `assemblyRowKey` の 1 か所で付け、`assemblyTreeRows.test.ts` が
 * 「兄弟の鍵が必ず食い違う」ことを機械的に固定する。
 */

import type {
  AssemblyDocument,
  AssemblyError,
  ComponentSource,
  JointKind,
  MateKind,
  MateTarget,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

/** 束(節)の種類。行の `key` の接頭辞にもなる(`rules/06` 10.9)。 */
export type AssemblyTreeSectionKey = 'component' | 'mate' | 'joint' | 'step';

/**
 * 行の頭の図柄と種類の名前を決める種類。
 *
 * 部品は**出どころ**ごと(抱き込んだ部品 / サブアセンブリ / 規格部品)、合致は 6 種、
 * ジョイントは 4 種、分解ステップは 2 種に分ける。どの語も他の枝と重ならない
 * (`ComponentSource` の `'part'` と `PresentationStep` の `'joint'` がぶつかるので、
 * ステップの側だけ `'jointStep'` と綴り分けてある)。
 */
export type AssemblyRowKind =
  | ComponentSource['kind']
  | MateKind
  | JointKind
  | 'explode'
  | 'jointStep';

/**
 * 行に出す状態の印(計画書タスク9 の「固定・非表示・抑制・未解決・矛盾」)。
 *
 * - `fixed`: 固定した部品(FR-602)。動かない。
 * - `hidden`: 画面に出していない部品(FR-605)。組み立ての一部としては残る。
 * - `suppressed`: 抑制した部品・合致(FR-503)。**置かなかったことにする**。
 * - `unresolved`: 指し先がいま引けない(§0.a-0.40。消えた部品を指す合致など)。
 * - `conflicting`: ほかの合致と同時には成り立たない(§0.a-0.20 の診断)。
 */
export type AssemblyRowBadge = 'fixed' | 'hidden' | 'suppressed' | 'unresolved' | 'conflicting';

/** 木の行 1 つ。部品・合致・ジョイント・分解ステップを同じ形で並べる。 */
export interface AssemblyTreeRow {
  /** React の `key`。**種類の接頭辞つき**(`component:` / `mate:` / `joint:` / `step:`)。 */
  readonly key: string;
  /** 文書の中の id(選択・操作の指し先)。 */
  readonly id: string;
  readonly name: string;
  readonly kind: AssemblyRowKind;
  /** 行の頭の絵に添える種類の名前(道具の名前と同じ語にする)。 */
  readonly kindLabelKey: MessageKey;
  /** 状態の印。並び順はここで決めるので、画面はそのまま並べるだけでよい。 */
  readonly badges: readonly AssemblyRowBadge[];
  /** 解決できなかった理由(`resolveAssembly` の `errors`)。無ければ null。 */
  readonly errorMessage: string | null;
  /** 薄く出す行か(抑制中・指し先が引けない)。判定を画面側へ持ち出さないための欄。 */
  readonly dimmed: boolean;
}

/** 木の束(節)1 つ。中身が空でも必ず返る。 */
export interface AssemblyTreeSection {
  readonly key: AssemblyTreeSectionKey;
  readonly titleKey: MessageKey;
  /** 中身が 0 件のときに束の下へ出す短い案内。 */
  readonly emptyKey: MessageKey;
  readonly rows: readonly AssemblyTreeRow[];
}

/**
 * 行の印を決めるのに使う、解いた結果のうちの 3 つ。
 *
 * `resolveAssembly` の戻り(`ResolvedAssembly`)をそのまま渡せる形にしてある(欄の名前も
 * 同じ)。**まだ解いていないときは省ける**——省くと、文書だけから分かること
 * (固定・非表示・抑制・指し先の無い合致)だけが印になる。
 */
export interface AssemblyTreeDiagnosis {
  /**
   * インスタンスの id → 部品の鍵。**中身を引けたインスタンスだけ**が入る
   * (`ResolvedAssembly.partKeys`)。抑制した部品も入らない。
   */
  readonly partKeys: ReadonlyMap<string, string>;
  /** 解決できなかった理由(`ResolvedAssembly.errors`)。`componentId` で行と対応づける。 */
  readonly errors: readonly AssemblyError[];
  /**
   * 同時には成り立たない合致・ジョイントの id(§0.a-0.20 の診断。P7 タスク16)。
   * その段が入るまでは誰も渡さないので、`conflicting` の印は付かない。
   */
  readonly conflictingIds?: ReadonlySet<string>;
}

/** 部品の出どころごとの種類の名前(「部品を置く」等の道具の名前と同じ語にそろえる)。 */
const COMPONENT_KIND_LABEL_KEYS: Readonly<Record<ComponentSource['kind'], MessageKey>> = {
  part: 'assembly.tree.componentPart',
  subAssembly: 'assembly.tree.componentSubAssembly',
  standardPart: 'assembly.tree.componentStandardPart',
};

/** 合致 6 種の名前。**道具の一覧とまったく同じ鍵**を引く(同じものを 2 通りに呼ばない)。 */
const MATE_KIND_LABEL_KEYS: Readonly<Record<MateKind, MessageKey>> = {
  coincident: 'assembly.tool.mateCoincident',
  concentric: 'assembly.tool.mateConcentric',
  distance: 'assembly.tool.mateDistance',
  angle: 'assembly.tool.mateAngle',
  parallel: 'assembly.tool.mateParallel',
  tangent: 'assembly.tool.mateTangent',
};

/** ジョイント 4 種の名前。こちらも道具の一覧と同じ鍵。 */
const JOINT_KIND_LABEL_KEYS: Readonly<Record<JointKind, MessageKey>> = {
  revolute: 'assembly.tool.jointRevolute',
  slider: 'assembly.tool.jointSlider',
  cylindrical: 'assembly.tool.jointCylindrical',
  ball: 'assembly.tool.jointBall',
};

/** 分解ステップ 2 種の名前(部品を離す / ジョイントを動かす)。 */
const STEP_KIND_LABEL_KEYS: Readonly<Record<'explode' | 'jointStep', MessageKey>> = {
  explode: 'assembly.tree.stepExplode',
  jointStep: 'assembly.tree.stepJoint',
};

/**
 * 印の札の文字。画面はこの表を引くだけで、印ごとの `if` を書かない。
 * 抑制の札だけは部品の木(`featureTree.suppressed`)と同じ語をそのまま使う
 * (同じ意味に 2 つの綴りを作らない)。
 */
export const ASSEMBLY_BADGE_LABEL_KEYS: Readonly<Record<AssemblyRowBadge, MessageKey>> = {
  fixed: 'assembly.tree.fixed',
  hidden: 'assembly.tree.hidden',
  suppressed: 'featureTree.suppressed',
  unresolved: 'assembly.tree.unresolved',
  conflicting: 'assembly.tree.conflicting',
};

/** 印にマウスを乗せたときの説明(FR-904)。 */
export const ASSEMBLY_BADGE_TOOLTIP_KEYS: Readonly<Record<AssemblyRowBadge, MessageKey>> = {
  fixed: 'assembly.tree.fixedTooltip',
  hidden: 'assembly.tree.hiddenTooltip',
  suppressed: 'assembly.tree.suppressedTooltip',
  unresolved: 'assembly.tree.unresolvedTooltip',
  conflicting: 'assembly.tree.conflictingTooltip',
};

/**
 * 行の `key`(`rules/06` 10.9)。**接頭辞を付ける場所はここ 1 か所だけ**にしてある。
 * 種類が違えば必ず食い違い、同じ種類の中では id が食い違う(文書の側が保証する)。
 */
export function assemblyRowKey(sectionKey: AssemblyTreeSectionKey, id: string): string {
  return `${sectionKey}:${id}`;
}

/**
 * その id の合致・ジョイント・ステップが「いま解ける」か。
 *
 * 指している部品が**文書に無い**(消えた)か、**中身が引けていない**(部品が見つからない・
 * 抑制中)なら未解決。診断を渡さないときは文書だけで分かる前者だけを見る。
 */
function targetResolved(
  target: MateTarget,
  componentIds: ReadonlySet<string>,
  diagnosis: AssemblyTreeDiagnosis | undefined,
): boolean {
  if (!componentIds.has(target.componentId)) {
    return false;
  }
  return diagnosis === undefined || diagnosis.partKeys.has(target.componentId);
}

/** 未解決・矛盾の印を、順序を決めて並べる(印の並びは全部の行で同じにする)。 */
function linkBadges(
  id: string,
  suppressed: boolean,
  resolved: boolean,
  diagnosis: AssemblyTreeDiagnosis | undefined,
): readonly AssemblyRowBadge[] {
  const badges: AssemblyRowBadge[] = [];
  if (suppressed) {
    badges.push('suppressed');
  }
  if (!resolved) {
    badges.push('unresolved');
  }
  if (diagnosis?.conflictingIds?.has(id) === true) {
    badges.push('conflicting');
  }
  return badges;
}

/**
 * アセンブリの木の並びを作る(FR-501)。**束は必ず 4 つ**返す。
 *
 * 並び順は文書の並びのまま(部品表の番号・連結成分の順もこの並びで決まる。§2.10)なので、
 * 同じ文書からは必ず同じ木ができる(§0.a-0.54 の決定性)。
 */
export function assemblyTreeRows(
  assembly: AssemblyDocument,
  diagnosis?: AssemblyTreeDiagnosis,
): readonly AssemblyTreeSection[] {
  const componentIds = new Set(assembly.components.map((component) => component.id));
  const jointIds = new Set(assembly.joints.map((joint) => joint.id));
  /*
   * 理由は**インスタンスごと**に 1 行へまとめる。同じ部品に 2 つ積まれることは
   * `resolveAssembly` の作りでは起きないが、起きても先に積まれたほうを出す
   * (行に同じ札を 2 つ並べない)。
   */
  const messages = new Map<string, string>();
  for (const error of diagnosis?.errors ?? []) {
    if (!messages.has(error.componentId)) {
      messages.set(error.componentId, error.message);
    }
  }

  const componentRows: readonly AssemblyTreeRow[] = assembly.components.map((component) => {
    /*
     * 中身が引けたか(`partKeys.has`)。**抑制した部品は解決の対象から外れる**ので
     * `partKeys` にも入らない——抑制は失敗ではないから、そこでは未解決の印を付けない。
     */
    const resolved =
      component.suppressed || diagnosis === undefined || diagnosis.partKeys.has(component.id);
    const badges: AssemblyRowBadge[] = [];
    if (component.fixed) {
      badges.push('fixed');
    }
    if (!component.visible) {
      badges.push('hidden');
    }
    if (component.suppressed) {
      badges.push('suppressed');
    }
    if (!resolved) {
      badges.push('unresolved');
    }
    return {
      key: assemblyRowKey('component', component.id),
      id: component.id,
      name: component.name,
      kind: component.source.kind,
      kindLabelKey: COMPONENT_KIND_LABEL_KEYS[component.source.kind],
      badges,
      errorMessage: messages.get(component.id) ?? null,
      dimmed: component.suppressed || !resolved,
    };
  });

  const mateRows: readonly AssemblyTreeRow[] = assembly.mates.map((mate) => {
    const resolved =
      targetResolved(mate.a, componentIds, diagnosis) &&
      targetResolved(mate.b, componentIds, diagnosis);
    return {
      key: assemblyRowKey('mate', mate.id),
      id: mate.id,
      name: mate.name,
      kind: mate.kind,
      kindLabelKey: MATE_KIND_LABEL_KEYS[mate.kind],
      badges: linkBadges(mate.id, mate.suppressed, resolved, diagnosis),
      errorMessage: null,
      dimmed: mate.suppressed || !resolved,
    };
  });

  const jointRows: readonly AssemblyTreeRow[] = assembly.joints.map((joint) => {
    const resolved =
      targetResolved(joint.a, componentIds, diagnosis) &&
      targetResolved(joint.b, componentIds, diagnosis);
    return {
      key: assemblyRowKey('joint', joint.id),
      id: joint.id,
      name: joint.name,
      kind: joint.kind,
      kindLabelKey: JOINT_KIND_LABEL_KEYS[joint.kind],
      badges: linkBadges(joint.id, joint.suppressed, resolved, diagnosis),
      errorMessage: null,
      dimmed: joint.suppressed || !resolved,
    };
  });

  const stepRows: readonly AssemblyTreeRow[] = assembly.presentation.map((step) => {
    /*
     * ステップの指し先は部品(離すもの)かジョイント(動かすもの)。**1 つでも消えていたら
     * 未解決**にする——中身が半分だけ動くステップは、見て分かるようにしておかないと
     * 「再生したのに何も動かない」になるため。
     */
    const resolved =
      step.body.kind === 'explode'
        ? step.body.componentIds.length > 0 &&
          step.body.componentIds.every((componentId) => componentIds.has(componentId))
        : jointIds.has(step.body.jointId);
    const kind = step.body.kind === 'explode' ? 'explode' : 'jointStep';
    return {
      key: assemblyRowKey('step', step.id),
      id: step.id,
      name: step.name,
      kind,
      kindLabelKey: STEP_KIND_LABEL_KEYS[kind],
      // ステップには抑制の欄が無い(`PresentationStep`)。区間の外し方は時間軸で決める。
      badges: linkBadges(step.id, false, resolved, diagnosis),
      errorMessage: null,
      dimmed: !resolved,
    };
  });

  return [
    {
      key: 'component',
      titleKey: 'assembly.tree.components',
      emptyKey: 'assembly.tree.componentsEmpty',
      rows: componentRows,
    },
    {
      key: 'mate',
      titleKey: 'assembly.tree.mates',
      emptyKey: 'assembly.tree.matesEmpty',
      rows: mateRows,
    },
    {
      key: 'joint',
      titleKey: 'assembly.tree.joints',
      emptyKey: 'assembly.tree.jointsEmpty',
      rows: jointRows,
    },
    {
      key: 'step',
      titleKey: 'assembly.tree.steps',
      emptyKey: 'assembly.tree.stepsEmpty',
      rows: stepRows,
    },
  ];
}

/**
 * 木に出る行の数。**束の見出しも 1 行として数える**(見出しは畳むために押せる行なので、
 * 「木に何行あるか」を数えるときに外すと画面と食い違う)。
 */
export function assemblyTreeRowCount(sections: readonly AssemblyTreeSection[]): number {
  return sections.reduce((total, section) => total + 1 + section.rows.length, 0);
}
