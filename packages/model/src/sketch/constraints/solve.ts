/**
 * 拘束の連立の解き方(FR-313、NFR-PF-2、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §2.2「解き方(タスク8)」、タスク6)。
 *
 * ここに置くのは**数値計算の道具だけ**で、拘束の意味を 1 つも知らない。
 * 残差とヤコビアン(タスク5 の `residuals.ts`)は**呼び出し側から関数として受け取る**ので、
 * このファイルは `constraints/types.ts` にも `variables.ts` にも依存しない。
 * 分けた理由は 2 つある。①数値の道具は拘束の種類が増えても変わらないので、
 * 種類を足すたびにここを読み直さなくてよくする。②検査でこのファイルだけを
 * 教科書どおりの小さな連立(2 元・過剰決定・特異)で確かめられる。
 *
 * 3 つの道具を置く。
 *
 * 1. `solveLinearSystem`: 部分ピボット付きガウス消去。正方の連立を解き、**特異なら `null`**。
 *    Levenberg–Marquardt の 1 歩(`(JᵀJ + λI) Δ = −Jᵀf`)がこれを呼ぶ。
 * 2. `qrDecomposition` / `matrixRank` / `solveLeastSquares`: 列ピボット付きハウスホルダー QR。
 *    **階数**(= 残った自由度と冗長な拘束の判定。タスク7)と**過剰決定の最小二乗**に使う。
 *    ガウス消去とは別の分解なので、片方の結果をもう片方の判定に使わない(タスク6 の落とし穴)。
 * 3. `solveLevenbergMarquardt`: 減衰つき Gauss–Newton。非線形の連立を反復で解く。
 *
 * **外部依存は 0 件**(§0.a-0.1。案 C の外部ライブラリは非線形を扱えないか LGPL のため不採用)。
 * すべて倍精度のまま計算し、**途中で丸めない**(NFR-RE-4、rules/04-設計の規律.md)。
 * 乱数・時刻・`Map` の反復順に頼らないので、**同じ入力からは必ず同じ解**が出る(§2.2)。
 */

/**
 * 線形化した式 1 本。`value` が残差、`gradient` が「変数の列番号 → 偏微分」で、
 * **0 の項は入れない**(疎な行)。1 行あたりの項は拘束の種類によって 2〜8 個で、
 * `JᵀJ` を素朴な n×n の二重ループで組むと変数 400 で 16 万回 × 行数になるため、
 * 非ゼロの組み合わせだけを足せるようにこの形で受け取る(タスク6 の落とし穴)。
 *
 * タスク5 の `ResidualRow` は `constraintId` を余分に持つだけなので、そのまま渡せる
 * (TypeScript は構造で型を見るため、ここで `residuals.ts` を import しなくてよい)。
 */
export interface LinearizedRow {
  readonly value: number;
  readonly gradient: ReadonlyMap<number, number>;
}

/**
 * 収束したと見なす残差の大きさ(‖f‖∞ の上限)。
 *
 * `SKETCH_TOLERANCE_MM`(1e-6。`vec3.ts`)より 3 桁厳しくしてある。解いた座標を
 * 丸めずに保存しても(ドラッグの確定。§2.3)、開き直したときの形の差が
 * 既存の許容誤差の 1/1000 に収まり、目に見えないため。
 * 倍精度の刻みは mm の量なら 1e-16 前後なので、1e-9 は桁として十分に手前にある。
 */
export const CONSTRAINT_TOLERANCE = 1e-9;

/**
 * 反復の上限。**超えても例外を投げず、収束しなかったことだけを返す**(NFR-RE-1)。
 *
 * 50 の根拠: 収束するときの実測は本ファイルの検査で 1〜8 回に収まる(拘束を 3 つ重ねた
 * 直角+等しい+一致でも 5 回)。減衰 λ を増やしてやり直す道(1 反復あたり最大
 * `DAMPING_ATTEMPT_LIMIT` 回)を数えても、実用規模で 50 を使い切るのは
 * 「同時に成り立たない拘束」のときだけである。上限を大きくしても解けない組は解けず、
 * ドラッグ中(1 コマ 16.6ms)の最悪時間だけが延びる(§2.9)。
 */
export const CONSTRAINT_MAX_ITERATIONS = 50;

/**
 * 減衰 λ の初期値。**0 にしない**のが要で、式が足りない(自由度が残る)ときも
 * `JᵀJ + λI` が正則になり、**いまの位置から最も近い解**(最小ノルムの歩幅)が得られる。
 * これが「拘束を付けても他の要素が勝手に動かない」という利用者の期待に合う(§2.2)。
 *
 * 1e-6 の根拠: 線形な拘束(一致・同心など)では 1 歩あたり残差が λ/(σ+λ) 倍しか残らない。
 * σ(= JᵀJ の固有値)が 1 前後なら 1 歩で 1e-6 倍、λ を 1/3 にしながら 2〜3 歩で
 * `CONSTRAINT_TOLERANCE`(1e-9)を下回る。これより大きいと歩数が増え、
 * これより小さいと階数落ちのときの対角が `LINEAR_PIVOT_TOLERANCE`(1e-12)へ近づいて
 * ガウス消去が特異と報告してしまう。
 */
export const CONSTRAINT_INITIAL_DAMPING = 1e-6;

/**
 * 減衰 λ の下限。0 まで下げると階数落ちのときに `JᵀJ` が特異になり、
 * せっかく減らした λ を増やし直すぶん反復が無駄になるので、1e-9 で止める。
 * 勾配が 1 前後のとき、この大きさの減衰が歩幅へ与える差は 1e-9 倍で、
 * 収束の判定(1e-9)に届かない。
 */
export const CONSTRAINT_MIN_DAMPING = 1e-9;

/**
 * 減衰 λ の上限。ここまで増えても残差が減らないなら、その方向には解が無い
 * (同時に成り立たない拘束)。1e12 は「歩幅が倍精度で意味を持つ最小の割合」の目安。
 */
export const CONSTRAINT_MAX_DAMPING = 1e12;

/**
 * 歩幅がこれを下回ったら、それ以上は動けないと見なして打ち切る(‖Δx‖∞ の下限)。
 *
 * 動けないのに反復を続けても残差は変わらないので、**矛盾した拘束のときに
 * 上限の 50 回を使い切らずに済む**(ドラッグ中の最悪時間を縮める)。
 * 1e-12mm は `CONSTRAINT_TOLERANCE`(1e-9)より 3 桁小さく、
 * この幅だけ動いても残差の判定は変わらない。
 */
export const CONSTRAINT_STEP_TOLERANCE = 1e-12;

/** 1 反復のうちに λ を増やしてやり直す回数の上限(無限に増やし続けないための歯止め)。 */
export const DAMPING_ATTEMPT_LIMIT = 24;

/** λ を増やすときの倍率。**10 にすると歩幅が振れて収束しにくい**(タスク6 の落とし穴)。 */
const DAMPING_INCREASE = 3;

/** λ を減らすときの割る数。増やす倍率と同じにして、行き来しても元の値へ戻るようにする。 */
const DAMPING_DECREASE = 3;

/**
 * ガウス消去の対角がこれ以下なら特異と報告する。
 * `JᵀJ + λI` は λ ≥ `CONSTRAINT_MIN_DAMPING`(1e-9)のぶんだけ必ず正定値なので、
 * 減衰つきの 1 歩がこの判定に掛かることはない。
 */
export const LINEAR_PIVOT_TOLERANCE = 1e-12;

/**
 * 階数を数えるときの打ち切り。QR の対角の絶対値が「最大値 × これ」を下回ったら、
 * そこから先は 0 と見なす。列ピボットのおかげで対角は絶対値の大きい順に並ぶ。
 */
export const RANK_RELATIVE_TOLERANCE = 1e-9;

/* ------------------------------------------------------------------ *
 * 1. ガウス消去(部分ピボット)
 * ------------------------------------------------------------------ */

/**
 * 拡大係数行列を平らな `Float64Array` で持って消去する。
 * 行の配列(`number[][]`)のままだと 400 元で 2.1×10⁷ 回の要素参照が
 * すべて配列の配列を経由し、実測で数倍遅くなるため(§2.9 の 20ms の目安)。
 *
 * `a` と `b` は書き換える(呼ぶ側が複製を渡す)。
 */
export function eliminate(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  // 内側の列走査は同じ行のviewで行い、各要素での行オフセット加算を省く。
  // 不正な寸法や短い配列は従来の添字アクセスを保つ。viewは元のaと同じ領域を指す。
  const rows = Number.isInteger(n) && n >= 0 && n * n <= a.length
    ? Array.from({ length: n }, (_, i) => a.subarray(i * n, (i + 1) * n)) : null;
  for (let k = 0; k < n; k += 1) {
    // 部分ピボット: k 列目の絶対値が最大の行を k 行目へ持ってくる。
    let pivot = k;
    let best = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i += 1) {
      const candidate = Math.abs(a[i * n + k]);
      if (candidate > best) {
        best = candidate;
        pivot = i;
      }
    }
    // NaN のときも「特異」として断る(`>` は NaN で偽になる)。
    if (!(best > LINEAR_PIVOT_TOLERANCE)) {
      return null;
    }
    if (pivot !== k) {
      for (let j = k; j < n; j += 1) {
        const swap = a[k * n + j];
        a[k * n + j] = a[pivot * n + j];
        a[pivot * n + j] = swap;
      }
      const swapRhs = b[k];
      b[k] = b[pivot];
      b[pivot] = swapRhs;
    }
    const diagonal = a[k * n + k];
    for (let i = k + 1; i < n; i += 1) {
      const factor = a[i * n + k] / diagonal;
      if (factor === 0) {
        continue;
      }
      a[i * n + k] = 0;
      if (rows === null) {
        for (let j = k + 1; j < n; j += 1) a[i * n + j] -= factor * a[k * n + j];
      } else {
        const target = rows[i];
        const source = rows[k];
        let j = k + 1;
        // 各列の更新順・乗算と減算はそのままに、内側ループの比較を4列に1回へ減らす。
        for (; j + 3 < n; j += 4) {
          target[j] -= factor * source[j];
          target[j + 1] -= factor * source[j + 1];
          target[j + 2] -= factor * source[j + 2];
          target[j + 3] -= factor * source[j + 3];
        }
        for (; j < n; j += 1) target[j] -= factor * source[j];
      }
      b[i] -= factor * b[k];
    }
  }

  // 後退代入。
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = b[i];
    for (let j = i + 1; j < n; j += 1) {
      sum -= a[i * n + j] * x[j];
    }
    x[i] = sum / a[i * n + i];
  }
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(x[i])) {
      return null;
    }
  }
  return x;
}

/**
 * 正方の連立 `matrix · x = rhs` を部分ピボット付きガウス消去で解く。
 * **特異(解が一意に決まらない)なら `null`** を返す。例外は投げない。
 * 入力は書き換えない。
 */
export function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | null {
  const n = rhs.length;
  if (matrix.length !== n) {
    return null;
  }
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const row = matrix[i];
    if (row.length !== n) {
      return null;
    }
    for (let j = 0; j < n; j += 1) {
      a[i * n + j] = row[j];
    }
  }
  const b = Float64Array.from(rhs);
  const solved = eliminate(a, b, n);
  return solved === null ? null : Array.from(solved);
}

/* ------------------------------------------------------------------ *
 * 2. 列ピボット付きハウスホルダー QR(階数と最小二乗)
 * ------------------------------------------------------------------ */

export interface QrDecomposition {
  readonly rowCount: number;
  readonly columnCount: number;
  /** 上三角の R(行数 × 列数)。列は `columnOrder` の順に入れ替わっている。 */
  readonly r: readonly (readonly number[])[];
  /** `r` の j 列目がもとの何列目か(列ピボットの並び)。 */
  readonly columnOrder: readonly number[];
  /** R の対角(min(行数, 列数) 個)。列ピボットにより絶対値の大きい順に並ぶ。 */
  readonly diagonal: readonly number[];
  /** 階数(対角の絶対値が「最大値 × `RANK_RELATIVE_TOLERANCE`」を下回るところで打ち切る)。 */
  readonly rank: number;
  /**
   * ハウスホルダーの反射ベクトル(k 段目、長さ = 行数、長さ 1 に正規化済み)。
   * `Qᵀb` を作るのに使う(最小二乗)。反射が要らなかった段は全て 0。
   */
  readonly reflectors: readonly (readonly number[])[];
}

/**
 * 列ピボット付きハウスホルダー QR 分解。行数 < 列数、行数 0、列数 0 でも例外を投げない。
 * `columns` を引数で受けるのは、行が 1 本も無いときに列数が決まらないため。
 */
export function qrDecomposition(
  matrix: readonly (readonly number[])[],
  columns: number,
  options?: { readonly rankTolerance?: number },
): QrDecomposition {
  const rowCount = matrix.length;
  const columnCount = Math.max(0, Math.trunc(columns));
  // 旧来の行コピーは、行があるときだけnew Array(NaN)で例外を投げていた。
  if (rowCount > 0 && Number.isNaN(columnCount)) throw new RangeError('Invalid array length');
  // QRの内側は列を縦に走査する。列ごとの配列にして、各要素での行配列の参照を省く。
  // 算術・加算・ピボット選択の順序は保ち、公開するRだけ最後に行配列へ戻す。
  const a = Array.from({ length: columnCount }, () => new Array<number>(rowCount).fill(0));
  for (let i = 0; i < rowCount; i += 1) {
    const row = matrix[i];
    const limit = Math.min(columnCount, row.length);
    for (let j = 0; j < limit; j += 1) {
      a[j][i] = row[j];
    }
  }
  const columnOrder = Array.from({ length: columnCount }, (_, index) => index);
  // 次のピボットに必要な列の長さを、反射後の書き戻しと同時に求める。
  // 差引き更新は桁落ちで列順・階数が変わるので使わず、従来と同じ順で足す。
  const remainingNorms = a.map((column) => {
    let sum = 0;
    for (const value of column) sum += value * value;
    return sum;
  });
  const steps = Math.min(rowCount, columnCount);
  const diagonal: number[] = [];
  const reflectors: number[][] = [];

  for (let k = 0; k < steps; k += 1) {
    // 列ピボット: 残りの列のうち、k 行目以降の長さが最大の列を前へ出す。
    // これで対角が絶対値の大きい順に並び、階数を「前から数える」だけで済む。
    let bestColumn = k;
    let bestNorm = -1;
    for (let j = k; j < columnCount; j += 1) {
      const sum = remainingNorms[j];
      if (sum > bestNorm) {
        bestNorm = sum;
        bestColumn = j;
      }
    }
    if (bestColumn !== k) {
      const swap = a[k];
      a[k] = a[bestColumn];
      a[bestColumn] = swap;
      const swapOrder = columnOrder[k];
      columnOrder[k] = columnOrder[bestColumn];
      columnOrder[bestColumn] = swapOrder;
      const swapNorm = remainingNorms[k];
      remainingNorms[k] = remainingNorms[bestColumn];
      remainingNorms[bestColumn] = swapNorm;
    }

    const pivotColumn = a[k];
    const reflector = new Array<number>(rowCount).fill(0);
    const norm = Math.sqrt(remainingNorms[k]);
    let updatedNorms = false;
    if (norm > 0) {
      // 桁落ちを避けるため、先頭成分と逆の符号を選ぶ。
      const alpha = pivotColumn[k] >= 0 ? -norm : norm;
      for (let i = k; i < rowCount; i += 1) {
        reflector[i] = pivotColumn[i];
      }
      reflector[k] -= alpha;
      let reflectorNorm = 0;
      for (let i = k; i < rowCount; i += 1) {
        reflectorNorm += reflector[i] * reflector[i];
      }
      reflectorNorm = Math.sqrt(reflectorNorm);
      if (reflectorNorm > 0) {
        for (let i = k; i < rowCount; i += 1) {
          reflector[i] /= reflectorNorm;
        }
        for (let j = k; j < columnCount; j += 1) {
          const column = a[j];
          let dot = 0;
          for (let i = k; i < rowCount; i += 1) {
            dot += reflector[i] * column[i];
          }
          dot *= 2;
          let nextNorm = 0;
          for (let i = k; i < rowCount; i += 1) {
            column[i] -= dot * reflector[i];
            if (i > k) nextNorm += column[i] * column[i];
          }
          remainingNorms[j] = nextNorm;
        }
        updatedNorms = true;
      } else {
        // すでに e1 の向きに揃っている段。反射は要らない。
        for (let i = k; i < rowCount; i += 1) {
          reflector[i] = 0;
        }
      }
      // 丸めの残りかすを消し、下三角を厳密に 0 にする。
      pivotColumn[k] = alpha;
      for (let i = k + 1; i < rowCount; i += 1) {
        pivotColumn[i] = 0;
      }
    }
    if (!updatedNorms) {
      // 反射しなかった段も次の部分列の実値を使う。非有限値の扱いも変えない。
      for (let j = k + 1; j < columnCount; j += 1) {
        let sum = 0;
        for (let i = k + 1; i < rowCount; i += 1) sum += a[j][i] * a[j][i];
        remainingNorms[j] = sum;
      }
    }
    reflectors.push(reflector);
    diagonal.push(pivotColumn[k]);
  }

  const rankTolerance = options?.rankTolerance ?? RANK_RELATIVE_TOLERANCE;
  let maxDiagonal = 0;
  for (const value of diagonal) {
    maxDiagonal = Math.max(maxDiagonal, Math.abs(value));
  }
  const threshold = maxDiagonal * rankTolerance;
  let rank = 0;
  for (const value of diagonal) {
    const size = Math.abs(value);
    if (size > 0 && size > threshold) {
      rank += 1;
    } else {
      break;
    }
  }

  const r = Array.from({ length: rowCount }, (_, i) => a.map((column) => column[i]));
  return { rowCount, columnCount, r, columnOrder, diagonal, rank, reflectors };
}

/**
 * 行列の階数。自由度(= 変数の数 − 階数)と冗長な拘束の判定に使う(タスク7)。
 * 行が 1 本も無ければ 0。
 */
export function matrixRank(rows: readonly (readonly number[])[], columns: number): number {
  return qrDecomposition(rows, columns).rank;
}

/**
 * 過剰決定の連立を最小二乗で解く(`‖matrix · x − rhs‖` を最小にする x)。
 * **列の階数が足りない(解が一意に決まらない)ときは `null`**。
 * 一意に決まらない連立は、いまの位置から最も近い解を選ぶ必要があり、それは
 * `solveLevenbergMarquardt` の減衰 λ が受け持つ(ここでは黙って 1 つ選ばない)。
 */
export function solveLeastSquares(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
  columns: number,
): number[] | null {
  const qr = qrDecomposition(matrix, columns);
  if (qr.rowCount !== rhs.length) {
    return null;
  }
  if (qr.columnCount === 0) {
    return [];
  }
  if (qr.rank < qr.columnCount) {
    return null;
  }
  // Qᵀ を右辺へ掛ける(反射を順に当てる)。
  const c = [...rhs];
  for (let k = 0; k < qr.reflectors.length; k += 1) {
    const reflector = qr.reflectors[k];
    let dot = 0;
    for (let i = k; i < qr.rowCount; i += 1) {
      dot += reflector[i] * c[i];
    }
    dot *= 2;
    for (let i = k; i < qr.rowCount; i += 1) {
      c[i] -= dot * reflector[i];
    }
  }
  const n = qr.columnCount;
  const y = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = c[i];
    for (let j = i + 1; j < n; j += 1) {
      sum -= qr.r[i][j] * y[j];
    }
    y[i] = sum / qr.r[i][i];
  }
  // 列ピボットで入れ替えた順をもとへ戻す。
  const x = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    x[qr.columnOrder[j]] = y[j];
  }
  for (const value of x) {
    if (!Number.isFinite(value)) {
      return null;
    }
  }
  return x;
}

/* ------------------------------------------------------------------ *
 * 3. Levenberg–Marquardt
 * ------------------------------------------------------------------ */

/** 反復を打ち切った理由。画面の断り文(タスク7・8)がこれを見て言葉を選ぶ。 */
export type SolveStopReason =
  /** 残差が `tolerance` を下回った。 */
  | 'converged'
  /** 反復の上限に達した。 */
  | 'maxIterations'
  /** 歩幅が `stepTolerance` を下回った(これ以上は動けない = 同時に成り立たない)。 */
  | 'step'
  /** 減衰 λ が上限に達しても残差が減らなかった。 */
  | 'damping'
  /** 減衰を上限まで増やしても連立が解けなかった(通常は起きない)。 */
  | 'singular';

/** 1 反復の記録(タスク7 の診断と、性能の実測の材料)。 */
export interface SolveIterationRecord {
  /** 1 から数えた反復の番号。 */
  readonly iteration: number;
  /** その反復の後の ‖f‖∞。 */
  readonly maxResidual: number;
  /** その反復の後の ‖f‖₂。減ったかどうかの判定はこの値で行う。 */
  readonly norm: number;
  /** 採用した歩の減衰 λ。 */
  readonly damping: number;
  /** 採用した歩の ‖Δx‖∞。 */
  readonly stepSize: number;
  /** 歩を採用したか(false なら λ を増やしても残差が減らなかった)。 */
  readonly accepted: boolean;
  /** λ を増やしてやり直した回数(1 なら 1 回目で採用)。 */
  readonly attempts: number;
}

export interface SolveOutcome {
  readonly x: readonly number[];
  /** 収束したか(残差の最大値が `tolerance` 未満)。 */
  readonly converged: boolean;
  readonly iterations: number;
  readonly maxResidual: number;
  /** 打ち切った理由。 */
  readonly stop: SolveStopReason;
  /** 最後の減衰 λ。 */
  readonly damping: number;
  /** 各反復の記録(§「各反復の記録」)。 */
  readonly trace: readonly SolveIterationRecord[];
}

export interface SolveOptions {
  readonly maxIterations?: number;
  readonly tolerance?: number;
  readonly initialDamping?: number;
  readonly stepTolerance?: number;
}

/** ‖f‖∞ と ‖f‖₂ をまとめて測る。 */
function measure(rows: readonly LinearizedRow[]): { max: number; norm: number } {
  let max = 0;
  let sum = 0;
  for (const row of rows) {
    const size = Math.abs(row.value);
    if (!(size <= max)) {
      // NaN のときもここへ来る(発散の検出)。
      max = size;
    }
    sum += row.value * row.value;
  }
  return { max, norm: Math.sqrt(sum) };
}

/**
 * 非線形の連立 `f(x) = 0` を Gauss–Newton + Levenberg–Marquardt で解く(§2.2)。
 *
 * ```
 * 繰り返し:
 *   ‖f‖∞ < tolerance なら収束
 *   (JᵀJ + λI) Δ = −Jᵀf を密行列のガウス消去(部分ピボット)で解く
 *   ‖f(x+Δ)‖ が減れば x ← x+Δ、λ ← λ/3。減らなければ λ ← λ×3 でやり直す
 * ```
 *
 * **例外を投げない。** 解けない組(同時に成り立たない拘束)でも、そこまでで最も
 * 残差の小さかった x と `converged: false` を返す(FR-504、NFR-RE-1「止めずに警告する」)。
 *
 * **階数が落ちている(自由度が残る)ときは、いまの位置から最も近い解へ動く。**
 * λ > 0 のおかげで 1 歩 Δ が `‖Δ‖` の最も小さい向き(擬似逆に近い歩)になるため、
 * 拘束で決まらない座標は動かない(§0.a-0.4「引っぱったときに他が勝手に動かない」)。
 *
 * `evaluate` は純関数であること(同じ x からは同じ行)。`initial` は書き換えない。
 */
export function solveLevenbergMarquardt(
  initial: readonly number[],
  evaluate: (x: readonly number[]) => readonly LinearizedRow[],
  options?: SolveOptions,
): SolveOutcome {
  const n = initial.length;
  const tolerance = options?.tolerance ?? CONSTRAINT_TOLERANCE;
  const maxIterations = options?.maxIterations ?? CONSTRAINT_MAX_ITERATIONS;
  const stepTolerance = options?.stepTolerance ?? CONSTRAINT_STEP_TOLERANCE;
  let damping = Math.max(options?.initialDamping ?? CONSTRAINT_INITIAL_DAMPING, CONSTRAINT_MIN_DAMPING);

  const x = Float64Array.from(initial);
  let rows = evaluate(Array.from(x));
  let current = measure(rows);
  const trace: SolveIterationRecord[] = [];

  const finish = (stop: SolveStopReason, iterations: number): SolveOutcome => ({
    x: Array.from(x),
    converged: current.max < tolerance,
    iterations,
    maxResidual: current.max,
    stop,
    damping,
    trace,
  });

  // 変数が 1 つも無い、拘束が 1 つも無い、すでに解 — どれも計算せずに返す。
  if (n === 0 || rows.length === 0 || current.max < tolerance) {
    return finish('converged', 0);
  }

  const normal = new Float64Array(n * n);
  const gradient = new Float64Array(n);
  const work = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const candidate = new Float64Array(n);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    // JᵀJ と Jᵀf を疎な勾配から組む。1 行の非ゼロだけを回すので、
    // 変数 400・式 200 でも 200 × 4² = 3200 回で済む(素朴な組み方は 200 × 16 万回)。
    normal.fill(0);
    gradient.fill(0);
    for (const row of rows) {
      const entries = [...row.gradient];
      for (const [i, gi] of entries) {
        gradient[i] += gi * row.value;
        for (const [j, gj] of entries) {
          normal[i * n + j] += gi * gj;
        }
      }
    }

    let accepted = false;
    let attempts = 0;
    let stepSize = 0;
    let nextRows: readonly LinearizedRow[] = rows;
    let next = current;

    while (attempts < DAMPING_ATTEMPT_LIMIT) {
      attempts += 1;
      work.set(normal);
      for (let i = 0; i < n; i += 1) {
        work[i * n + i] += damping;
        rhs[i] = -gradient[i];
      }
      const step = eliminate(work, rhs, n);
      if (step === null) {
        // 減衰を増やせば必ず正定値になるので、増やしてやり直す。
        damping *= DAMPING_INCREASE;
        if (damping > CONSTRAINT_MAX_DAMPING) {
          trace.push({ iteration, maxResidual: current.max, norm: current.norm, damping, stepSize: 0, accepted: false, attempts });
          return finish('singular', iteration);
        }
        continue;
      }
      let size = 0;
      for (let i = 0; i < n; i += 1) {
        candidate[i] = x[i] + step[i];
        const move = Math.abs(step[i]);
        if (move > size) {
          size = move;
        }
      }
      const trialRows = evaluate(Array.from(candidate));
      const trial = measure(trialRows);
      if (Number.isFinite(trial.norm) && trial.norm < current.norm) {
        accepted = true;
        stepSize = size;
        nextRows = trialRows;
        next = trial;
        break;
      }
      // 減らなかった(発散した場合を含む)。歩幅を縮めてやり直す。
      damping *= DAMPING_INCREASE;
      if (damping > CONSTRAINT_MAX_DAMPING) {
        trace.push({ iteration, maxResidual: current.max, norm: current.norm, damping, stepSize: size, accepted: false, attempts });
        return finish('damping', iteration);
      }
    }

    if (!accepted) {
      trace.push({ iteration, maxResidual: current.max, norm: current.norm, damping, stepSize: 0, accepted: false, attempts });
      return finish('damping', iteration);
    }

    x.set(candidate);
    rows = nextRows;
    current = next;
    trace.push({ iteration, maxResidual: current.max, norm: current.norm, damping, stepSize, accepted: true, attempts });

    if (current.max < tolerance) {
      return finish('converged', iteration);
    }
    // 動けなくなった = 残差の 2 乗和の底に着いた。これ以上の反復は結果を変えない。
    if (stepSize < stepTolerance) {
      return finish('step', iteration);
    }
    damping = Math.max(damping / DAMPING_DECREASE, CONSTRAINT_MIN_DAMPING);
  }

  return finish('maxIterations', maxIterations);
}
