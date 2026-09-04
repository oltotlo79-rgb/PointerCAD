/**
 * 拘束の診断(足りない・足しすぎ・矛盾。FR-313、NFR-UX-5、FR-504、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §2.2「診断」、タスク7)。
 *
 * ヤコビアン(タスク5 が作る残差の行)を 1 度だけ走査して、次の 4 つを分けて返す。
 *
 * | 見るもの | 何を意味するか | 画面に出すもの |
 * |---|---|---|
 * | 変数の数 − 階数 | まだ決まっていない自由度 | 「あと N か所決まっていません」 |
 * | 足しても階数が増えない行 | 足しすぎ(冗長) | 「○○1 は、ほかの拘束ですでに決まっています。」 |
 * | 足しても階数が増えず、残差の食い違いが残る行 | 矛盾(同時には成り立たない) | 「○○1 と ○○2 は同時には成り立ちません。」 |
 * | 材料の足りない拘束(タスク5 の `skipped`) | 指していた要素が消えた | タスク5 が作った日本語の理由をそのまま |
 *
 * **冗長と矛盾の見分け方は「階数」と「残差」の 2 段。**
 * ある行 aᵢ が先行の独立な行 a_{j₁}…a_{j_k} の線形結合 Σ w a_j で書けるなら、その行は階数を
 * 増やさない = **冗長**。そのうえで、残差の側にも同じ関係が成り立つか(fᵢ = Σ w f_j か)を見る。
 * 成り立つなら「同じことを 2 度言っただけ」で解ける。**成り立たなければ、その連立には解が無い**
 * ので **矛盾**であり、原因は「その行」と「結合に加わった先行の行」である。この判定は x の取り方に
 * よらない(線形な拘束なら厳密に、非線形な拘束なら x のまわりの線形化について成り立つ)。
 *
 * 線形化では捕まらない矛盾(階数は満ちているのに解が無い非線形の組)もあるので、残差が
 * 許容量を超えたまま矛盾が 1 件も見つからなかったときだけ、**残差の大きい順に最大 3 つ**を
 * 原因として挙げる(計画書 §2.2 の表の規則)。
 *
 * **x には「解いた後の値」を渡す**(タスク8 の 3 段の解決の②の結果)。初期値のまま渡すと、
 * まだ解いていないだけの残差を「矛盾」と読み違える(上の線形結合の判定だけは x に依らない)。
 *
 * ここは純関数だけを置く。乱数・時刻・`Map` の反復順に頼らず、同じ入力からは必ず同じ診断を返す。
 */

import {
  buildResidualReport,
  isImplicitConstraintId,
  type ResidualRow,
  type SkippedResidual,
} from './residuals.js';
import { CONSTRAINT_TOLERANCE, RANK_RELATIVE_TOLERANCE } from './solve.js';
import type { SketchConstraint } from './types.js';
import {
  countDegreesOfFreedom,
  MAX_CONSTRAINT_VARIABLES,
  type FrozenReason,
  type VariableSet,
} from './variables.js';

/**
 * 矛盾の原因として画面へ挙げる拘束の数の上限(計画書 §2.2「残差が大きい順に上位 3 つ」)。
 * 全部を並べると帯に収まらず、どれから直せばよいか分からなくなるため。
 */
export const CONFLICT_REPORT_LIMIT = 3;

/** 足しすぎ(冗長)の種類。 */
export type RedundantReason =
  /** ほかの拘束の組み合わせで同じことが既に決まっている。 */
  | 'duplicate'
  /** 指している要素が 1 つも動かせない(式・固定・導出)ので、形に効かない。 */
  | 'noVariable';

/** 足しすぎと判定した拘束 1 つ。 */
export interface RedundantConstraint {
  readonly constraintId: string;
  readonly reason: RedundantReason;
  /** その拘束を決めている先行の拘束の id(`noVariable` のときは空)。 */
  readonly dependsOn: readonly string[];
  /** 画面へそのまま出せる日本語。 */
  readonly message: string;
}

/** 同時に成り立たないと判定した拘束 1 つ。 */
export interface ConflictingConstraint {
  readonly constraintId: string;
  /** その行の残差(絶対値が大きいほど合っていない)。 */
  readonly residual: number;
  /** 同時には成り立たない相手の拘束の id。 */
  readonly partners: readonly string[];
  /** 画面へそのまま出せる日本語。 */
  readonly message: string;
}

/** 診断の 1 文の種類(画面がどこへ出すかを選ぶのに使う)。 */
export type ConstraintDiagnosisMessageKind =
  /** 「あと N か所決まっていません」 */
  | 'remaining'
  /** 「すべて決まりました」 */
  | 'solved'
  /** 「付けすぎの拘束が N 件あります」 */
  | 'excess'
  /** 足しすぎの拘束 1 つぶん。 */
  | 'redundant'
  /** 矛盾の拘束 1 つぶん。 */
  | 'conflict'
  /** 材料が足りない・縮退などで式を作れなかった拘束 1 つぶん(タスク5 の文をそのまま)。 */
  | 'skipped'
  /** 変数が上限を超えた。 */
  | 'tooMany';

/** 診断の 1 文。 */
export interface ConstraintDiagnosisMessage {
  readonly kind: ConstraintDiagnosisMessageKind;
  readonly text: string;
  /** その文が指している拘束の id(利用者の拘束だけ。円弧の暗黙の式は含めない)。 */
  readonly constraintIds: readonly string[];
}

export interface ConstraintDiagnosis {
  /** 動かせる数の個数。 */
  readonly variables: number;
  /** 立った式の本数(利用者の拘束+円弧の暗黙の式)。 */
  readonly equations: number;
  /** ヤコビアンの階数。重なっている拘束を差し引いた「効いている式の本数」。 */
  readonly rank: number;
  /**
   * 残った自由度(= 変数の数 − 階数)。0 なら完全に決まっている
   * (FR-313 の「足りない拘束の数を示し」の N)。
   */
  readonly degreesOfFreedom: number;
  /** 足しすぎの件数(= `redundantDetails.length`)。「あと N か所」とは別に数える。 */
  readonly excess: number;
  /** 冗長(階数を増やさない)な拘束の id。 */
  readonly redundant: readonly string[];
  /** 同時に成り立たない拘束の id(最大 `CONFLICT_REPORT_LIMIT` 件)。 */
  readonly conflicting: readonly string[];
  /** 材料が足りない拘束の id(指していた要素が消えた)。 */
  readonly dangling: readonly string[];
  /** 動けない要素と理由(画面が「なぜ動かないか」を出す)。 */
  readonly frozen: ReadonlyMap<string, FrozenReason>;
  /** 冗長の内訳。 */
  readonly redundantDetails: readonly RedundantConstraint[];
  /** 矛盾の内訳。 */
  readonly conflictDetails: readonly ConflictingConstraint[];
  /** 式を作れなかった拘束(`dangling` を含む。理由と日本語の文つき)。 */
  readonly skipped: readonly SkippedResidual[];
  /** 変数が `MAX_CONSTRAINT_VARIABLES` を超えたので診断しなかった。 */
  readonly tooMany: boolean;
  /** x での残差の最大値(‖f‖∞)。 */
  readonly maxResidual: number;
  /** 残差が許容量に収まっているか。 */
  readonly satisfied: boolean;
  /** 画面へそのまま出せる日本語の一覧(先頭は必ず自由度の 1 文)。 */
  readonly messages: readonly ConstraintDiagnosisMessage[];
  /** 帯に出す 1 文(`messages` の要約)。 */
  readonly summary: string;
}

export interface DiagnoseOptions {
  /** 残差が 0 と見なせる大きさ。既定は `CONSTRAINT_TOLERANCE`(1e-9)。 */
  readonly tolerance?: number;
}

/* ------------------------------------------------------------------ *
 * 1. 行の従属関係を 1 度の走査で調べる
 * ------------------------------------------------------------------ */

/** 従属していた行 1 本と、その内訳。 */
interface DependentRow {
  readonly rowIndex: number;
  /** 先行の独立な行の添字 → 係数(0 でないものだけ)。 */
  readonly combination: readonly { readonly rowIndex: number; readonly weight: number }[];
  /** 残差の食い違い `fᵢ − Σ w f_j`。0 なら解ける重複、0 でなければ矛盾。 */
  readonly mismatch: number;
  /** 残差の食い違いを測るときの大きさの目安(許容量を掛ける相手)。 */
  readonly scale: number;
  /** 動かせる数を 1 つも含まない行(勾配が空)。 */
  readonly empty: boolean;
}

interface RowAnalysis {
  readonly rank: number;
  readonly dependents: readonly DependentRow[];
}

/**
 * 2 度目の直交化を行うかどうかの境目。1 度引いただけで長さが元の 0.7 倍を切ったら、
 * 桁落ちが起きている可能性があるのでもう一度引く(古典的な "twice is enough")。
 * 直交している行がほとんどの実際の拘束では 2 度目がほぼ起きないので、速さを損なわない。
 */
const REORTHOGONALIZE_RATIO = 0.7;

/**
 * 行を順に見て、階数を増やす行(独立)と増やさない行(従属)に分ける。
 *
 * **後から足した行のほうを「従属」と呼ぶ**のは、利用者が最後に付けた拘束を
 * 「これは要りません」と指すのが自然だから(先に付けた拘束を消せとは言わない)。
 *
 * 判定は行ごとの相対値で行う。ある行を先行の行と直交化した残りの長さが、もとの長さの
 * `RANK_RELATIVE_TOLERANCE`(1e-9)倍を下回ったら従属とする。**行の大きさで割る**ので、
 * mm の量(距離・一致)と無次元の量(平行・角度)が混ざっても判定が偏らない
 * (計画書 §2.2 の落とし穴「単位が混ざったら列を正規化」に対する答え。列は
 * すべて mm の量なので列の正規化は要らず、行の側を正規化すれば足りる)。
 */
function analyzeRows(rows: readonly ResidualRow[], columnCount: number): RowAnalysis {
  const n = Math.max(0, columnCount);
  /** 直交化した基底(長さ 1)。 */
  const basis: Float64Array[] = [];
  /** 基底 q_k を「独立な行」の線形結合で表した係数。`coefficients[k][j]`。 */
  const coefficients: Float64Array[] = [];
  /** 独立だった行の添字(`coefficients` の列の順)。 */
  const independent: number[] = [];
  const dependents: DependentRow[] = [];

  const dense = new Float64Array(n);
  const projections = new Float64Array(rows.length);

  rows.forEach((row, rowIndex) => {
    dense.fill(0);
    let squared = 0;
    for (const [column, value] of row.gradient) {
      if (column >= 0 && column < n) {
        dense[column] += value;
      }
    }
    for (let i = 0; i < n; i += 1) {
      squared += dense[i] * dense[i];
    }
    const originalNorm = Math.sqrt(squared);
    if (originalNorm === 0) {
      // 動かせる数を 1 つも含まない行。階数を増やさず、残差はそのまま食い違いになる。
      dependents.push({
        rowIndex,
        combination: [],
        mismatch: row.value,
        scale: Math.abs(row.value),
        empty: true,
      });
      return;
    }

    const rank = basis.length;
    projections.fill(0, 0, rank);
    // 1 度目は勾配が疎なことを利用して内積を安く取る(1 行あたりの項は 2〜8 個)。
    for (let k = 0; k < rank; k += 1) {
      const q = basis[k];
      let dot = 0;
      for (const [column, value] of row.gradient) {
        if (column >= 0 && column < n) {
          dot += q[column] * value;
        }
      }
      projections[k] = dot;
      if (dot !== 0) {
        for (let i = 0; i < n; i += 1) {
          dense[i] -= dot * q[i];
        }
      }
    }
    let remaining = 0;
    for (let i = 0; i < n; i += 1) {
      remaining += dense[i] * dense[i];
    }
    let remainingNorm = Math.sqrt(remaining);
    if (remainingNorm < REORTHOGONALIZE_RATIO * originalNorm && rank > 0) {
      // 2 度目の直交化(桁落ちの補正)。
      for (let k = 0; k < rank; k += 1) {
        const q = basis[k];
        let dot = 0;
        for (let i = 0; i < n; i += 1) {
          dot += q[i] * dense[i];
        }
        projections[k] += dot;
        if (dot !== 0) {
          for (let i = 0; i < n; i += 1) {
            dense[i] -= dot * q[i];
          }
        }
      }
      remaining = 0;
      for (let i = 0; i < n; i += 1) {
        remaining += dense[i] * dense[i];
      }
      remainingNorm = Math.sqrt(remaining);
    }

    if (remainingNorm > RANK_RELATIVE_TOLERANCE * originalNorm) {
      // 独立: 基底を 1 本増やす。
      const q = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        q[i] = dense[i] / remainingNorm;
      }
      // q = (aᵢ − Σ_k p_k q_k) / ‖残り‖ を「独立な行」の係数へ書き直す。
      const nextColumn = independent.length;
      const coefficient = new Float64Array(nextColumn + 1);
      coefficient[nextColumn] = 1 / remainingNorm;
      for (let k = 0; k < basis.length; k += 1) {
        const p = projections[k];
        if (p === 0) {
          continue;
        }
        const previous = coefficients[k];
        for (let j = 0; j < previous.length; j += 1) {
          coefficient[j] -= (p * previous[j]) / remainingNorm;
        }
      }
      basis.push(q);
      coefficients.push(coefficient);
      independent.push(rowIndex);
      return;
    }

    // 従属: aᵢ ≒ Σ_k p_k q_k = Σ_j w_j a_{independent[j]}。
    const weights = new Float64Array(independent.length);
    for (let k = 0; k < basis.length; k += 1) {
      const p = projections[k];
      if (p === 0) {
        continue;
      }
      const previous = coefficients[k];
      for (let j = 0; j < previous.length; j += 1) {
        weights[j] += p * previous[j];
      }
    }
    let largest = 0;
    for (const weight of weights) {
      largest = Math.max(largest, Math.abs(weight));
    }
    const threshold = largest * RANK_RELATIVE_TOLERANCE;
    const combination: { rowIndex: number; weight: number }[] = [];
    let expected = 0;
    let scale = Math.abs(row.value);
    for (let j = 0; j < weights.length; j += 1) {
      const weight = weights[j];
      if (Math.abs(weight) <= threshold) {
        continue;
      }
      const source = independent[j];
      combination.push({ rowIndex: source, weight });
      expected += weight * rows[source].value;
      scale += Math.abs(weight * rows[source].value);
    }
    dependents.push({
      rowIndex,
      combination,
      mismatch: row.value - expected,
      scale,
      empty: false,
    });
  });

  return { rank: basis.length, dependents };
}

/* ------------------------------------------------------------------ *
 * 2. 日本語の文
 * ------------------------------------------------------------------ */

/** 上限を「点」の数で言う(変数は 1 点につき u, v の 2 つ)。 */
const MAX_CONSTRAINT_POINTS = MAX_CONSTRAINT_VARIABLES / 2;

export const CONSTRAINT_TOO_MANY_MESSAGE = `拘束を付けられる要素が多すぎます(上限 ${MAX_CONSTRAINT_POINTS} 点)。スケッチを分けてください。`;

/** 「あと N か所決まっていません」/「すべて決まりました」。 */
export function remainingMessage(degreesOfFreedom: number): string {
  return degreesOfFreedom > 0
    ? `あと ${degreesOfFreedom} か所決まっていません`
    : 'すべて決まりました';
}

/** 「A、B」(並べるだけ)。 */
function joinNames(names: readonly string[]): string {
  return names.join('、');
}

/** 「A と B」(同時には成り立たない相手を並べるとき)。 */
function joinWithAnd(names: readonly string[]): string {
  return names.join(' と ');
}

/* ------------------------------------------------------------------ *
 * 3. 入口
 * ------------------------------------------------------------------ */

/**
 * 拘束を診断する(§2.2 の表)。**例外を投げない**(FR-504、NFR-RE-1)。
 *
 * `x` は変数の現在値(`VariableSet.variables` と同じ並び)。タスク8 は連立を解いた後の値を渡す。
 */
export function diagnoseConstraints(
  constraints: readonly SketchConstraint[],
  variableSet: VariableSet,
  x: readonly number[],
  options?: DiagnoseOptions,
): ConstraintDiagnosis {
  const tolerance = options?.tolerance ?? CONSTRAINT_TOLERANCE;
  const variables = variableSet.variables.length;

  if (variables > MAX_CONSTRAINT_VARIABLES) {
    // 解かないので、拘束は 1 つも効いていない = 全部の変数が未決定のまま。
    return {
      variables,
      equations: 0,
      rank: 0,
      degreesOfFreedom: variables,
      excess: 0,
      redundant: [],
      conflicting: [],
      dangling: [],
      frozen: variableSet.frozen,
      redundantDetails: [],
      conflictDetails: [],
      skipped: [],
      tooMany: true,
      maxResidual: 0,
      satisfied: false,
      messages: [{ kind: 'tooMany', text: CONSTRAINT_TOO_MANY_MESSAGE, constraintIds: [] }],
      summary: CONSTRAINT_TOO_MANY_MESSAGE,
    };
  }

  const report = buildResidualReport(constraints, variableSet, x);
  const rows = report.rows;
  const analysis = analyzeRows(rows, variables);

  const nameById = new Map<string, string>();
  for (const constraint of constraints) {
    nameById.set(constraint.id, constraint.name);
  }
  /** 利用者へ見せる id か(円弧の暗黙の式は見せない)。 */
  const visible = (constraintId: string): boolean => !isImplicitConstraintId(constraintId);
  const nameOf = (constraintId: string): string => nameById.get(constraintId) ?? constraintId;

  let maxResidual = 0;
  for (const row of rows) {
    const size = Math.abs(row.value);
    if (!(size <= maxResidual)) {
      // NaN もここへ来る。
      maxResidual = size;
    }
  }

  const redundantDetails: RedundantConstraint[] = [];
  const conflictDetails: ConflictingConstraint[] = [];
  const seenRedundant = new Set<string>();
  const seenConflict = new Set<string>();

  for (const dependent of analysis.dependents) {
    const row = rows[dependent.rowIndex];
    if (!visible(row.constraintId)) {
      // 円弧の暗黙の式が重なっただけ。利用者は付けた覚えがないので出さない。
      continue;
    }
    const partners: string[] = [];
    for (const term of dependent.combination) {
      const partnerId = rows[term.rowIndex].constraintId;
      if (!visible(partnerId) || partnerId === row.constraintId || partners.includes(partnerId)) {
        continue;
      }
      partners.push(partnerId);
    }
    // **階数を増やさない行は、まず「足しすぎ」として数える**(統括の指示・計画書 §2.2 の表)。
    // 矛盾はそのうえで残差の食い違いを見た結果なので、同じ拘束が両方に入ることがある
    // (長さ 10 と長さ 12 は「足しすぎ 1 件」かつ「矛盾 2 件」)。
    if (!seenRedundant.has(row.constraintId)) {
      seenRedundant.add(row.constraintId);
      redundantDetails.push(
        dependent.empty
          ? {
              constraintId: row.constraintId,
              reason: 'noVariable',
              dependsOn: [],
              message: `${nameOf(row.constraintId)} が指している要素は動かせないので、この拘束は形に効きません。`,
            }
          : {
              constraintId: row.constraintId,
              reason: 'duplicate',
              dependsOn: partners,
              message:
                partners.length > 0
                  ? `${nameOf(row.constraintId)} は、ほかの拘束(${joinNames(partners.map(nameOf))})ですでに決まっています。`
                  : `${nameOf(row.constraintId)} は、ほかの拘束ですでに決まっています。`,
            },
      );
    }

    const inconsistent = Math.abs(dependent.mismatch) > tolerance * (1 + dependent.scale);
    if (!inconsistent || seenConflict.has(row.constraintId)) {
      continue;
    }
    seenConflict.add(row.constraintId);
    const names = [nameOf(row.constraintId), ...partners.map(nameOf)];
    const message =
      partners.length > 0
        ? `${joinWithAnd(names)} は同時には成り立ちません。`
        : `${nameOf(row.constraintId)} は、いまの形では成り立ちません。`;
    conflictDetails.push({
      constraintId: row.constraintId,
      residual: row.value,
      partners,
      message,
    });
    for (const partnerId of partners) {
      if (seenConflict.has(partnerId)) {
        continue;
      }
      seenConflict.add(partnerId);
      const partnerRow = rows.find((candidate) => candidate.constraintId === partnerId);
      conflictDetails.push({
        constraintId: partnerId,
        residual: partnerRow?.value ?? 0,
        partners: [row.constraintId],
        message,
      });
    }
  }

  const satisfied = maxResidual <= tolerance;
  if (!satisfied && conflictDetails.length === 0) {
    // 線形化では捕まらない矛盾(階数は満ちているのに解が無い非線形の組)。
    // 残差の大きい順に上位 3 つを原因として挙げる(計画書 §2.2 の表)。
    const ordered = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter((entry) => visible(entry.row.constraintId) && Math.abs(entry.row.value) > tolerance)
      .sort((a, b) => {
        const difference = Math.abs(b.row.value) - Math.abs(a.row.value);
        return difference !== 0 ? difference : a.rowIndex - b.rowIndex;
      });
    for (const entry of ordered) {
      if (conflictDetails.length >= CONFLICT_REPORT_LIMIT) {
        break;
      }
      if (seenConflict.has(entry.row.constraintId)) {
        continue;
      }
      seenConflict.add(entry.row.constraintId);
      conflictDetails.push({
        constraintId: entry.row.constraintId,
        residual: entry.row.value,
        partners: [],
        message: `${nameOf(entry.row.constraintId)} は、いまの形では成り立ちません。`,
      });
    }
  }

  const conflicting = conflictDetails.slice(0, CONFLICT_REPORT_LIMIT).map((entry) => entry.constraintId);
  const redundant = redundantDetails.map((entry) => entry.constraintId);
  // 「材料が足りない」の判定は `countDegreesOfFreedom` の指し先の検査を正本にする。
  // タスク5 の `skipped` は残差を作れなかった理由(向きが読めない `unsupportedTarget` と
  // 要素が消えた場合の区別が付かない)なので、同じ規則を 2 か所に書かない。
  const dangling = countDegreesOfFreedom(
    variableSet,
    constraints.filter((constraint) => visible(constraint.id)),
  ).dangling;
  const degreesOfFreedom = Math.max(0, variables - analysis.rank);

  const messages: ConstraintDiagnosisMessage[] = [];
  messages.push(
    degreesOfFreedom > 0
      ? { kind: 'remaining', text: remainingMessage(degreesOfFreedom), constraintIds: [] }
      : { kind: 'solved', text: remainingMessage(0), constraintIds: [] },
  );
  if (redundantDetails.length > 0) {
    messages.push({
      kind: 'excess',
      text: `付けすぎの拘束が ${redundantDetails.length} 件あります`,
      constraintIds: redundant,
    });
  }
  for (const entry of conflictDetails.slice(0, CONFLICT_REPORT_LIMIT)) {
    messages.push({
      kind: 'conflict',
      text: entry.message,
      constraintIds: [entry.constraintId, ...entry.partners],
    });
  }
  for (const entry of redundantDetails) {
    if (conflicting.includes(entry.constraintId)) {
      // 「すでに決まっています(消してよい)」と「同時には成り立ちません(直してください)」を
      // 並べると助言が食い違うので、矛盾している拘束については矛盾の 1 文だけを出す。
      // 一覧と件数(`redundant` / `excess`)には残す。
      continue;
    }
    messages.push({
      kind: 'redundant',
      text: entry.message,
      constraintIds: [entry.constraintId, ...entry.dependsOn],
    });
  }
  for (const entry of report.skipped) {
    messages.push({
      kind: 'skipped',
      text: entry.message,
      constraintIds: visible(entry.constraintId) ? [entry.constraintId] : [],
    });
  }

  const parts: string[] = [];
  parts.push(
    conflictDetails.length > 0
      ? `同時に成り立たない拘束が ${conflictDetails.length} 件あります`
      : remainingMessage(degreesOfFreedom),
  );
  if (redundantDetails.length > 0) {
    parts.push(`付けすぎの拘束が ${redundantDetails.length} 件あります`);
  }
  if (report.skipped.length > 0) {
    parts.push(`材料の足りない拘束が ${report.skipped.length} 件あります`);
  }

  return {
    variables,
    equations: rows.length,
    rank: analysis.rank,
    degreesOfFreedom,
    excess: redundantDetails.length,
    redundant,
    conflicting,
    dangling,
    frozen: variableSet.frozen,
    redundantDetails,
    conflictDetails,
    skipped: report.skipped,
    tooMany: false,
    maxResidual,
    satisfied,
    messages,
    summary: `${parts.join('。')}。`,
  };
}
