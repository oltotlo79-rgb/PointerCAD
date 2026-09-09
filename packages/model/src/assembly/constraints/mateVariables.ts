/**
 * 合致の変数(剛体の 6 自由度)と自由度の数え方、連結成分の分割
 * (計画書 docs/plans/P7-アセンブリ.md タスク13、§2.5.1・§2.5.3。FR-603 / FR-602 / FR-604)。
 *
 * ソルバー(P7 タスク15)が動かしてよい数を、アセンブリ文書から**決め打ちの順**で並べる。
 * 書き方は 2D の拘束(`sketch/constraints/variables.ts`)にそろえてある——同じ役目のものを
 * 2 通りの流儀で書かないため。そちらとの違いは 3 つだけである。
 *
 *  ① **変数は「増分」**(§2.5.1 の再パラメータ化)。2D は点の座標そのものを変数にするが、
 *     3D の向きは四元数の 4 成分をそのまま動かすと `|q| = 1` の式が 1 本余分に要り、
 *     `JᵀJ` が特異になりやすい。オイラー角はジンバルロックがある。そこで
 *     **「いまの向きからの小さな回転 `ω`」**を変数にし、1 反復ごとに配置へ畳み込んで 0 へ戻す。
 *     平行移動も同じ流儀で増分にそろえる(片方だけ絶対値にすると畳み込みが 2 通りになる)。
 *     このため初期値(`initial`)は**必ず全部 0** である。
 *  ② **変数の単位は部品**(1 部品 = 6 変数)。2D のように成分ごとに凍る場面が無い
 *     (固定 FR-602 は部品まるごとを止める)。
 *  ③ **式で書かれた位置も変数にする。** 2D は「式で書かれた座標は動かすと式を壊す」ので
 *     定数にしたが(FR-202)、3D の合致は**解を保存しない**(§0.a-0.6)。解いた配置は
 *     文書へ書き戻らないので式は壊れない。書き戻すのは引っぱって離した瞬間だけで、
 *     そこで断るかどうかは操作の側(P7 タスク18)が決める。
 *
 * **ここは純関数だけを置く。** 乱数・時刻・`Map` の反復順に頼らず、同じ文書からは必ず同じ
 * 並びの変数と同じ順の連結成分を返す(§0.a-0.54 の決定性)。**例外を投げない**(FR-504)。
 */

import { evaluateExpression, type ExpressionValue, type EvaluateOptions } from '@pointercad/expression';

import type { AssemblyDocument, Joint, JointKind, Mate, MateKind } from '../types.js';
import type { MateTargetKind } from './mateTargets.js';

/* ------------------------------------------------------------------ *
 * 1. 上限と断りの文言
 * ------------------------------------------------------------------ */

/** 1 つの部品が持つ変数の数(`tx, ty, tz, rx, ry, rz`)。 */
export const MATE_VARIABLES_PER_COMPONENT = 6;

/**
 * 変数の上限(§0.a-0.17)。超えたら解かずに断る(判定は P7 タスク15。ここでは印を立てるだけ)。
 *
 * 600 は動かせる部品 100 個ぶんで、`JᵀJ` のガウス消去が 600³/3 = 7.2×10⁷ 回になる大きさ。
 * これを超えると 1 反復が NFR-PF-2(単一操作 500ms)を割り込む(§2.13-1 の見積り)。
 */
export const MAX_ASSEMBLY_VARIABLES = 600;

/** 上限を「部品」の数で言う(変数は 1 部品につき 6 つ)。 */
export const MAX_MOVABLE_COMPONENTS = MAX_ASSEMBLY_VARIABLES / MATE_VARIABLES_PER_COMPONENT;

/**
 * 動かせる部品が多すぎる(§2.12 の断りの文言)。**1 字も変えない。**
 *
 * 置き場をここにしたのは、上限そのもの(`MAX_ASSEMBLY_VARIABLES`)と同じファイルに
 * 数と文を並べておくためである(2D は `diagnose.ts` に文を置くが、そちらは上限を
 * 「点」の数へ言い換える計算がもう 1 つ挟まる)。診断(P7 タスク16)はここから読む。
 */
export const TOO_MANY_COMPONENTS_MESSAGE =
  `組める部品が多すぎます(上限 ${MAX_MOVABLE_COMPONENTS} 個)。組を入れ子にして分けてください。`;

/* ------------------------------------------------------------------ *
 * 2. 変数
 * ------------------------------------------------------------------ */

/**
 * 1 つの部品が持つ 6 つの数(§2.5.1 の表)。
 *
 * `tx, ty, tz` は平行移動の増分(mm)、`rx, ry, rz` は**いまの向きからの小さな回転**
 * (回転ベクトル。長さが角度(rad)、向きが軸)。
 */
export type MateVariableAxis = 'tx' | 'ty' | 'tz' | 'rx' | 'ry' | 'rz';

/**
 * 変数の並び順(§2.5.1)。**`components` の並び順 → この順**で決め打ちする。
 * `Map` の反復順に頼らないので、同じ文書からは必ず同じ列が出る(§0.a-0.54)。
 */
export const MATE_VARIABLE_AXES: readonly MateVariableAxis[] = [
  'tx',
  'ty',
  'tz',
  'rx',
  'ry',
  'rz',
];

/** 軸 → 部品の先頭の列からの隔たり。`MATE_VARIABLE_AXES` の並びが唯一の正本。 */
const AXIS_COLUMN_OFFSET: ReadonlyMap<MateVariableAxis, number> = new Map(
  MATE_VARIABLE_AXES.map((axis, offset): readonly [MateVariableAxis, number] => [axis, offset]),
);

/** 1 つの変数。 */
export interface MateVariable {
  readonly componentId: string;
  readonly axis: MateVariableAxis;
}

/** 変数にしなかった理由(画面が「なぜこの部品は動かないのか」を出せるように。NFR-UX-7)。 */
export type FrozenComponentReason =
  /** 固定(グラウンド、FR-602)。**合致の対象にはなる**が動かない。 */
  | 'fixed'
  /** 抑制(FR-503)。無いものとして扱うので、合致の対象にもならない。 */
  | 'suppressed';

/**
 * 変数の一式。残差(P7 タスク14)とソルバー(タスク15)が列を引くための表。
 *
 * `columnOf` / `componentOf` を関数で持つのは計画書のタスク13 のとおり。中身は `Map` と
 * 配列だが、**呼ぶ側に鍵の作り方(部品の先頭の列 + 軸の隔たり)を知らせない**ためである。
 */
export interface MateVariableSet {
  /** 決め打ちの順(`components` の順 → `tx, ty, tz, rx, ry, rz`)。ソルバーの列の順。 */
  readonly variables: readonly MateVariable[];
  /**
   * 初期値。**必ず全部 0**(変数はいまの配置からの増分。§2.5.1 の再パラメータ化)。
   * それでも配列で持つのは、ソルバーが `x` の長さと初期値をこの 1 か所から取れるようにして、
   * 「長さは `variables.length`、値は 0」という同じ約束を呼ぶ側ごとに書かせないためである。
   */
  readonly initial: readonly number[];
  /** 動かせる部品の id(`components` の順)。連結成分の節でもある。 */
  readonly movableComponentIds: readonly string[];
  /** 変数にしなかった部品 → その理由。 */
  readonly frozen: ReadonlyMap<string, FrozenComponentReason>;
  /** 変数が上限(`MAX_ASSEMBLY_VARIABLES`)を超えた。真なら解かずに断る(§0.a-0.17)。 */
  readonly tooMany: boolean;
  /** その部品のその軸は何列目か。動かせない部品・知らない部品なら `null`。 */
  readonly columnOf: (componentId: string, axis: MateVariableAxis) => number | null;
  /** その列はどの部品のものか。範囲の外なら `null`。 */
  readonly componentOf: (column: number) => string | null;
}

/**
 * 合致の変数を切り出す(§2.5.1)。
 *
 * **変数にしない条件は 2 つだけ**——`fixed === true`(FR-602)と `suppressed === true`
 * (FR-503)。**`visible === false` は変数にする**(見えなくても組み立ての一部で、
 * 非表示にしただけで部品が動かなくなるのは利用者の期待に反する)。
 *
 * 上限を超えても**変数は作って返す**(印を `tooMany` に立てるだけ)。断るかどうかを決めるのは
 * 解く側で、画面は上限を超えた文書でも木と部品表を出せなければならないためである(FR-504)。
 */
export function collectMateVariables(assembly: AssemblyDocument): MateVariableSet {
  const variables: MateVariable[] = [];
  const movableComponentIds: string[] = [];
  const frozen = new Map<string, FrozenComponentReason>();
  /** 部品の id → その部品の先頭の列(`tx` の列)。 */
  const baseColumn = new Map<string, number>();

  for (const component of assembly.components) {
    if (component.suppressed) {
      frozen.set(component.id, 'suppressed');
      continue;
    }
    if (component.fixed) {
      frozen.set(component.id, 'fixed');
      continue;
    }
    baseColumn.set(component.id, variables.length);
    movableComponentIds.push(component.id);
    for (const axis of MATE_VARIABLE_AXES) {
      variables.push({ componentId: component.id, axis });
    }
  }

  return {
    variables,
    initial: variables.map(() => 0),
    movableComponentIds,
    frozen,
    tooMany: variables.length > MAX_ASSEMBLY_VARIABLES,
    columnOf: (componentId, axis): number | null => {
      const base = baseColumn.get(componentId);
      const offset = AXIS_COLUMN_OFFSET.get(axis);
      return base === undefined || offset === undefined ? null : base + offset;
    },
    componentOf: (column): string | null =>
      Number.isInteger(column) && column >= 0 && column < variables.length
        ? variables[column].componentId
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * 3. 合致・ジョイントの数値の欄
 * ------------------------------------------------------------------ */

/**
 * 合致の距離・角度、ジョイントの可動範囲、分解の距離を数にする(§0.a-0.9、FR-202)。
 *
 * 変数表は**アセンブリのパラメータ表**(`resolveAssembly.ts` の `assemblyVariables`)を
 * そのまま渡す——配置の式と合致の値で別の表を使うと、同じ名前が 2 つの意味を持つため
 * (タスク6 の申し送り「距離・角度も同じ表」)。
 *
 * **評価できない式は保存された評価値をそのまま使う**(`reevaluatePart.ts` の
 * `reevaluateValue` と同じ約束。開いた瞬間に値が消えるより、最後に決まっていた数で
 * 組み立てて理由を出すほうがよい)。**数にならなければ `null`** で、断りは呼ぶ側が出す
 * ——置いた位置(`resolveAssembly.ts`)は 0mm へ落として開くが、合致の距離を 0 へ落とすと
 * 利用者が指定していない位置へ部品が動いてしまうので、こちらは落とさない。
 */
export function mateValueOf(
  value: ExpressionValue | null | undefined,
  variables: ReadonlyMap<string, number>,
  options: Omit<EvaluateOptions, 'variables'> = {},
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = evaluateExpression(value.source, { ...options, variables });
  const number = result.ok ? result.value.value : value.value;
  return Number.isFinite(number) ? number : null;
}

/* ------------------------------------------------------------------ *
 * 4. 式の本数
 * ------------------------------------------------------------------ */

/**
 * 合致 1 本が出す式の本数(§2.5.2 の表)。**一致(`coincident`)だけ対象の種類で変わる**ので
 * ここには入れず、`coincidentEquationCount` が決める。
 */
const MATE_EQUATION_COUNTS: Readonly<Record<Exclude<MateKind, 'coincident'>, number>> = {
  parallel: 2,
  concentric: 4,
  distance: 1,
  angle: 1,
  tangent: 2,
};

/** ジョイント 1 つが出す式の本数(§2.6 の表)。残る自由度は 6 − この数。 */
const JOINT_EQUATION_COUNTS: Readonly<Record<JointKind, number>> = {
  revolute: 5,
  slider: 5,
  cylindrical: 4,
  ball: 3,
};

/** 向きを持つ対象か(面・軸・円筒面)。頂点と部品の原点だけが向きを持たない。 */
function hasDirection(kind: MateTargetKind): boolean {
  return kind !== 'point';
}

/**
 * 一致の式の本数(§2.5.2 の 3 行)。**向きを持つかどうかだけで決まる。**
 *
 *  - 点と点 → `p₁ − p₂` の 3 成分で **3**
 *  - 点と面 → 面に載せる 1 本だけで **1**(面の上をすべる 2 自由度は残る)
 *  - 面と面 → 向きの 2 本 + 隔たりの 1 本で **3**
 *
 * 軸・円筒面を一致の対象にしたときも「向きを持つもの」として面と同じに数える。
 * 軸どうしを重ねたいときは同心(`concentric`、4 本)を使うのが本筋だが、
 * ここで数を落とすと同じ組み合わせに 2 通りの数え方ができてしまうため。
 */
export function coincidentEquationCount(a: MateTargetKind, b: MateTargetKind): number {
  if (!hasDirection(a) && !hasDirection(b)) {
    return 3;
  }
  return hasDirection(a) && hasDirection(b) ? 3 : 1;
}

/**
 * 合致 1 本の式の本数。一致のときだけ対象の種類が要る(分からなければ `null`)。
 * 固定(FR-602)は種類に無い——式を出さずに部品の 6 変数を外すので、ここへは来ない。
 */
export function mateEquationCount(
  kind: MateKind,
  kinds: readonly [MateTargetKind, MateTargetKind] | null,
): number | null {
  if (kind !== 'coincident') {
    return MATE_EQUATION_COUNTS[kind];
  }
  return kinds === null ? null : coincidentEquationCount(kinds[0], kinds[1]);
}

/** ジョイント 1 つの式の本数(対象の種類には依らない)。 */
export function jointEquationCount(kind: JointKind): number {
  return JOINT_EQUATION_COUNTS[kind];
}

/* ------------------------------------------------------------------ *
 * 5. 自由度の数え上げ
 * ------------------------------------------------------------------ */

/** 数えなかった合致・ジョイントと、その理由。 */
export interface SkippedMate {
  /** `Mate.id` または `Joint.id`。 */
  readonly id: string;
  readonly reason:
    /** 抑制されている(FR-503)。利用者が意図して外したので失敗ではない。 */
    | 'suppressed'
    /** 動かせる部品を 1 つも含まない(固定どうし・消された部品・抑制された部品)。 */
    | 'grounded'
    /** 一致の対象の種類が分からない(対象が解決できなかった)。 */
    | 'unknownTargets';
}

/** 自由度の数え上げ(FR-604 の「あと何か所決まっていないか」)。 */
export interface MateDegreesOfFreedom {
  /** 動かせる数の個数。 */
  readonly variables: number;
  /** 式の本数の合計(効いている合致とジョイントのぶん)。 */
  readonly equations: number;
  /**
   * 決まらなくてよい自由度(§0.a-0.20)。**固定された部品が 1 つも無いときの 6**
   * (全体の平行移動 3 + 回転 3)で、あれば 0。これを引かないと、正しく組めていても
   * 常に「あと 6 か所決まっていません」と誤報する。
   */
  readonly ground: number;
  /** あと何か所決まっていないか(0 以上。ステータスバーに出す N)。 */
  readonly remaining: number;
  /** 式が多すぎる分(0 以上)。合致の付けすぎの目安。 */
  readonly excess: number;
  /** 数えなかった合致・ジョイント(FR-504。**消さずに理由を残す**)。 */
  readonly skipped: readonly SkippedMate[];
}

/** 自由度の数え上げに添える設定。 */
export interface CountMateDegreesOfFreedomOptions {
  /**
   * 合致の id → 解決した対象 2 つの種類(`resolveMateTarget` の結果の `kind`)。
   * **一致(`coincident`)の式の本数は種類で変わる**(§2.5.2)ので、一致を数えるには要る。
   * 無い合致は数えず `skipped` に `unknownTargets` として残す(黙って 3 本と決めない)。
   */
  readonly targetKinds?: ReadonlyMap<string, readonly [MateTargetKind, MateTargetKind]>;
}

/** その合致・ジョイントが動かせる部品を含むか(片方だけでも動けば式は効く)。 */
function touchesVariable(
  variableSet: MateVariableSet,
  entry: Mate | Joint,
): boolean {
  return (
    variableSet.columnOf(entry.a.componentId, 'tx') !== null ||
    variableSet.columnOf(entry.b.componentId, 'tx') !== null
  );
}

/**
 * 自由度を数える(§2.5.5 の「足りない」「足しすぎ」の目安)。
 *
 * **変数の数 − 式の本数**の素朴な数え方で、合致どうしが同じことを言っている(線形従属)か
 * どうかは見ない。重なりまで見た正確な自由度はヤコビアンの階数から出す(P7 タスク16 の
 * `diagnoseMates`)。2D の `countDegreesOfFreedom` と同じ役割・同じ言葉づかいにしてある。
 *
 * **動かせる部品を 1 つも含まない式は数えない。** 固定どうしを合致で結んでも動く数は 1 つも
 * 減らないので、数えると「合致が多すぎます」と誤報する(2D が定数だけの円弧の暗黙の式を
 * 落としているのと同じ理由)。
 *
 * 足りない分(`remaining`)と足しすぎの分(`excess`)は別々に数え、負の数にしない
 * (「あと −2 か所決まっていません」は利用者に意味が通らないため)。
 */
export function countMateDegreesOfFreedom(
  variableSet: MateVariableSet,
  mates: readonly Mate[],
  joints: readonly Joint[],
  options: CountMateDegreesOfFreedomOptions = {},
): MateDegreesOfFreedom {
  const skipped: SkippedMate[] = [];
  let equations = 0;

  for (const mate of mates) {
    if (mate.suppressed) {
      skipped.push({ id: mate.id, reason: 'suppressed' });
      continue;
    }
    if (!touchesVariable(variableSet, mate)) {
      skipped.push({ id: mate.id, reason: 'grounded' });
      continue;
    }
    const count = mateEquationCount(mate.kind, options.targetKinds?.get(mate.id) ?? null);
    if (count === null) {
      skipped.push({ id: mate.id, reason: 'unknownTargets' });
      continue;
    }
    equations += count;
  }

  for (const joint of joints) {
    if (joint.suppressed) {
      skipped.push({ id: joint.id, reason: 'suppressed' });
      continue;
    }
    if (!touchesVariable(variableSet, joint)) {
      skipped.push({ id: joint.id, reason: 'grounded' });
      continue;
    }
    equations += jointEquationCount(joint.kind);
  }

  const variables = variableSet.variables.length;
  // 動かせる部品が 1 つも無ければ、決まらなくてよい自由度も無い(引く相手がいない)。
  const hasFixed = [...variableSet.frozen.values()].includes('fixed');
  const ground = variables === 0 || hasFixed ? 0 : 6;
  return {
    variables,
    equations,
    ground,
    remaining: Math.max(0, variables - ground - equations),
    excess: Math.max(0, equations - (variables - ground)),
    skipped,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 連結成分(union-find)
 * ------------------------------------------------------------------ */

/**
 * 合致でつながった部品の塊 1 つ(§2.5.3、§0.a-0.18)。**成分ごとに別々の連立を解く。**
 *
 * 塊が k 個に分かれれば、ガウス消去が n³ で効くぶん概ね k² 倍速くなる。
 */
export interface MateComponentGroup {
  /** この塊に入る動かせる部品(`components` の順)。 */
  readonly componentIds: readonly string[];
  /** この塊の中で解く合致(`mates` の順)。 */
  readonly mateIds: readonly string[];
  /** この塊の中で解くジョイント(`joints` の順)。 */
  readonly jointIds: readonly string[];
}

/**
 * union-find の親の表(節は `movableComponentIds` の添字)。根を引く(経路圧縮つき)。
 *
 * `parent` を書き換えるので純関数ではないが、表そのものが `mateComponentGroups` の
 * 中だけで作られて外へ出ないため、外から見た関数は純関数のままである。
 */
function findRoot(parent: number[], node: number): number {
  let root = node;
  while (parent[root] !== root) {
    root = parent[root];
  }
  // 経路圧縮。次からの `findRoot` を短くするだけで、答えは変えない。
  let walk = node;
  while (parent[walk] !== root) {
    const next = parent[walk];
    parent[walk] = root;
    walk = next;
  }
  return root;
}

/**
 * 2 つの節を同じ塊にする。
 *
 * **小さい番号を根にする。** 根が `components` の順で最も早い部品になるので、塊の並びが
 * 文書の順だけで決まる(§0.a-0.54 の決定性)。木の高さで根を選ぶと、同じ文書でも
 * 辺をつなぐ順で根が変わってしまう。
 */
function unite(parent: number[], a: number, b: number): void {
  const rootA = findRoot(parent, a);
  const rootB = findRoot(parent, b);
  if (rootA === rootB) {
    return;
  }
  parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
}

/** 組み立て中の塊(外へ出すときに読み取り専用の `MateComponentGroup` になる)。 */
interface MutableGroup {
  readonly componentIds: string[];
  readonly mateIds: string[];
  readonly jointIds: string[];
}

/**
 * 合致とジョイントでつながった部品を連結成分へ分ける(§2.5.3、§0.a-0.18)。
 *
 * **節は動かせる部品だけ、辺は合致とジョイント。固定された部品につながる辺は「地面への辺」
 * として無視する**——固定は動かないので、固定を挟んだ 2 つの部品は互いの位置に影響しない。
 * 無視しないと、地面に付けた合致だけで全部の部品が 1 つの塊になり、分けた意味が無くなる。
 *
 * 抑制された合致・ジョイント(FR-503)は辺にならない。指し先が消された部品のものも、
 * その部品が節に無いので自然と辺にならない(投げない。FR-504)。
 *
 * **成分の順序も、成分の中の並びも `components` の順**で決まる(§0.a-0.54)。
 */
export function mateComponentGroups(
  variableSet: MateVariableSet,
  mates: readonly Mate[],
  joints: readonly Joint[],
): readonly MateComponentGroup[] {
  const nodes = variableSet.movableComponentIds;
  const nodeOf = new Map<string, number>(
    nodes.map((id, index): readonly [string, number] => [id, index]),
  );
  const parent = Array.from({ length: nodes.length }, (_unused, index) => index);

  /** 辺 1 本。両端が節ならつなぎ、そうでなければ何もしない(地面への辺)。 */
  const connect = (entry: Mate | Joint): void => {
    if (entry.suppressed) {
      return;
    }
    const a = nodeOf.get(entry.a.componentId);
    const b = nodeOf.get(entry.b.componentId);
    if (a !== undefined && b !== undefined) {
      unite(parent, a, b);
    }
  };
  for (const mate of mates) {
    connect(mate);
  }
  for (const joint of joints) {
    connect(joint);
  }

  /** 根の節 → その塊。`components` の順に積むので、塊の並びも中の並びも文書の順になる。 */
  const groups = new Map<number, MutableGroup>();
  const order: MutableGroup[] = [];
  nodes.forEach((id, index) => {
    const root = findRoot(parent, index);
    const known = groups.get(root);
    if (known !== undefined) {
      known.componentIds.push(id);
      return;
    }
    const created: MutableGroup = { componentIds: [id], mateIds: [], jointIds: [] };
    groups.set(root, created);
    order.push(created);
  });

  /** 合致・ジョイントは「動かせる側の端」が属する塊で解く。両端が固定なら誰も解かない。 */
  const groupOf = (entry: Mate | Joint): MutableGroup | null => {
    if (entry.suppressed) {
      return null;
    }
    const node = nodeOf.get(entry.a.componentId) ?? nodeOf.get(entry.b.componentId);
    return node === undefined ? null : (groups.get(findRoot(parent, node)) ?? null);
  };
  for (const mate of mates) {
    groupOf(mate)?.mateIds.push(mate.id);
  }
  for (const joint of joints) {
    groupOf(joint)?.jointIds.push(joint.id);
  }

  return order;
}
