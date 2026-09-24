/**
 * 計画 `docs/plans/追加-数学入力.md` §1（分野別の網羅表、L134〜L165の32行・256記号。幾何9件〔L165〕を除く）と、
 * 公開目録（`mathPaletteExamples.ts` の `MATH_INPUT_PALETTE`）の機械照合（MC-04、`scratchpad/claude/plans/math-add-coverage.md` §7.2）。
 *
 * 各記号は次のどちらか一方だけを持つ。
 * - `catalogIds`（{@link MathCoverageAccepted}）: 公開目録（`MATH_INPUT_PALETTE`）の項目ID。1個以上。
 *   1つの記号が複数の目録項目にまたがる場合（例: L152「SVD」→ svd-u/svd-s/svd-v/singular-values）は全て列挙する。
 * - `reason`（{@link MathCoveragePending}）: 未実装・範囲外の理由。計画の利用者回答・後続タスク名（MC-02d・MC-19b・
 *   MC-19c・MC-12・MC-20 等）・設計上パレット化しない理由のいずれかを明記する（空文字列は不可）。
 *   後続タスクが目録へ項目を追加したら、対応する `reason` を `catalogIds` へ書き換えるだけで済む。
 *
 * 幾何9記号（L165）は図形参照（CAD参照）として `scratchpad/claude/plans/geomref-plan.md`（w1d の計画）を参照先にする。
 *
 * このファイルは対応表を保持し、計画ファイルとの整合を検査する純粋関数（`node:fs` 等の入出力は行わない。
 * 実ファイルの読み取りは `mathCatalogCoverage.test.ts` が行い、文字列として渡す）を提供するだけで、
 * `mathPalette*.ts`・`mathExtendedOperations.ts` など他ファイルは一切変更しない。
 */

/** 公開目録に実在する記号（1個以上の目録ID）。 */
export interface MathCoverageAccepted {
  readonly symbol: string;
  /** 公開目録（`MATH_INPUT_PALETTE`）の項目ID。重複無し、1個以上。 */
  readonly catalogIds: readonly string[];
}

/** まだ「受入済み」にできない記号。 */
export interface MathCoveragePending {
  readonly symbol: string;
  /** 未実装・範囲外の理由。空文字列は不可。 */
  readonly reason: string;
}

export type MathCoverageSymbol = MathCoverageAccepted | MathCoveragePending;

/** `catalogIds` を持つ（受入済みの）記号かどうか。 */
export function isMathCoverageAccepted(entry: MathCoverageSymbol): entry is MathCoverageAccepted {
  return 'catalogIds' in entry;
}

export interface MathCoverageRow {
  /** 計画 `追加-数学入力.md` の行番号（§1 の表の1行、L134〜L165）。 */
  readonly line: number;
  /** 計画の「分野」列。 */
  readonly domain: string;
  /** 計画の「記法・演算」列の原文（読み違い検出用。計画側の行が変わればここと食い違い、検査が落ちる）。 */
  readonly planNotation: string;
  readonly symbols: readonly MathCoverageSymbol[];
}

/**
 * 計画 §1（L134〜L165）の32行・256記号（幾何9件を除く）の対応表。
 * 生成の経緯: `scratchpad/claude/agents/w2b-math-coverage/symbols.json`（計画§1を265記号へ分けた機械集計）を
 * 基に、`packages/ui/src/math/mathPaletteExamples.ts` が公開する現在の目録ID（`MATH_INPUT_PALETTE`）と
 * `packages/ui/src/math/mathPalette{Basic,Calculus,SetsLogic}.ts` の演算参照（`requiredOperations`）を実ファイルから
 * 読み直して照合した（2026-09-24 09時台時点）。目録IDを持たない記号は、後続タスク名または設計上の理由を記す。
 * MC-04b（w23b、同日10時台）が、MC-02d・MC-02e公開後の目録（308項目）へ照合し直し、23件のreasonをcatalogIdsへ
 * 置き換えた（範囲外3・図形参照9・不定積分1・設計上パレット化しない14の27件がreasonのまま残る）。
 * MC-04c（w29b）が、目録に追加した不定積分（原始関数、309項目目）へ照合し、「不定積分」1件のreasonを
 * catalogIdsへ置き換えた（範囲外3・図形参照9・設計上パレット化しない14の26件がreasonのまま残る）。
 */
export const MATH_CATALOG_COVERAGE: readonly MathCoverageRow[] = [
  { line: 134, domain: '数・定数', planNotation: '自然数/整数/有理数/実数/複素数、π、e、i、∞、科学表記、循環小数', symbols: [
    { symbol: '自然数 ℕ', reason: '値としては実装済みだが公開目録の単独項目なし。集合としての利用はL155のnatural-numbersを参照。後続タスク未定。' },
    { symbol: '整数 ℤ', reason: '値としては実装済みだが公開目録の単独項目なし。集合としての利用はL155のinteger-numbersを参照。後続タスク未定。' },
    { symbol: '有理数（丸めず保持）', reason: '丸めず保持する内部表現はあるが公開目録の単独項目なし。後続タスク未定。' },
    { symbol: '実数 ℝ', reason: '値としては実装済みだが公開目録の単独項目なし。集合としての利用はL155のreal-numbersを参照。後続タスク未定。' },
    { symbol: '複素数', catalogIds: ['imaginary-unit'] },
    { symbol: 'π', catalogIds: ['pi'] },
    { symbol: 'e', catalogIds: ['e'] },
    { symbol: 'i', catalogIds: ['imaginary-unit'] },
    { symbol: '∞', reason: '極限・区間端では実装済み（座標としての利用は拒否が正しい受入）。公開目録の単独項目なし。後続タスク未定。' },
    { symbol: '科学表記', reason: '数値の入力表記として実装済みだが公開目録の単独項目なし。後続タスク未定。' },
    { symbol: '循環小数', reason: 'MC-19cが実装中（通常入力0.1(6)等・構造入力の小数点以下の上線を丸めない有理数として読む）。' },
  ] },
  { line: 135, domain: '算術', planNotation: '+ − ± ∓ × · ÷ / 分数、括弧、百分率、比', symbols: [
    { symbol: '+', reason: '四則演算の基本記号は直接入力が前提で、目録（パレット）の項目化対象外（計画§2の直接入力の方針）。実装は確認済み。' },
    { symbol: '−', reason: '四則演算の基本記号は直接入力が前提で、目録（パレット）の項目化対象外（計画§2）。実装は確認済み。' },
    { symbol: '±', catalogIds: ['plus-minus'] },
    { symbol: '∓', catalogIds: ['minus-plus'] },
    { symbol: '×', reason: '四則演算の基本記号は直接入力が前提で、目録（パレット）の項目化対象外（計画§2）。実装は確認済み。' },
    { symbol: '·', reason: '四則演算の基本記号は直接入力が前提で、目録（パレット）の項目化対象外（計画§2）。実装は確認済み。' },
    { symbol: '÷', catalogIds: ['fraction'] },
    { symbol: '/', catalogIds: ['fraction'] },
    { symbol: '分数', catalogIds: ['fraction'] },
    { symbol: '括弧', reason: '四則演算の基本記号は直接入力が前提で、目録（パレット）の項目化対象外（計画§2）。実装は確認済み。' },
    { symbol: '百分率 %', reason: 'テキスト入力の÷100変換は実装済み（mathTextSyntax.ts）。構造入力の往復はMC-19cが実装中。' },
    { symbol: '比', reason: 'MC-19cが実装中（a:bをa÷bとして読み、区間・時刻との曖昧性は候補提示で解決予定、Q1採用）。' },
  ] },
  { line: 136, domain: '冪・根', planNotation: 'xⁿ、x^y、√、∛、n乗根、逆数', symbols: [
    { symbol: 'xⁿ', catalogIds: ['power'] },
    { symbol: 'x^y（実数指数）', catalogIds: ['power'] },
    { symbol: '√', catalogIds: ['square-root'] },
    { symbol: '∛', catalogIds: ['nth-root'] },
    { symbol: 'n乗根', catalogIds: ['nth-root'] },
    { symbol: '逆数', catalogIds: ['reciprocal'] },
  ] },
  { line: 137, domain: '整数演算', planNotation: '!、!!、nPk、nCk、二項係数、mod、gcd、lcm', symbols: [
    { symbol: '!', catalogIds: ['factorial'] },
    { symbol: '!!', catalogIds: ['double-factorial'] },
    { symbol: 'nPk', catalogIds: ['permutations'] },
    { symbol: 'nCk', catalogIds: ['binomial'] },
    { symbol: '二項係数', catalogIds: ['binomial'] },
    { symbol: 'mod', catalogIds: ['modulo'] },
    { symbol: 'gcd', catalogIds: ['gcd'] },
    { symbol: 'lcm', catalogIds: ['lcm'] },
  ] },
  { line: 138, domain: '初等関数', planNotation: 'abs/縦棒、sgn、床⌊⌋、天井⌈⌉、round、min/max、clamp', symbols: [
    { symbol: 'abs・|x|', catalogIds: ['absolute'] },
    { symbol: 'sgn', catalogIds: ['sign'] },
    { symbol: '床 ⌊⌋', catalogIds: ['floor'] },
    { symbol: '天井 ⌈⌉', catalogIds: ['ceiling'] },
    { symbol: 'round', catalogIds: ['round'] },
    { symbol: 'min', catalogIds: ['minimum'] },
    { symbol: 'max', catalogIds: ['maximum'] },
    { symbol: 'clamp', catalogIds: ['clamp'] },
  ] },
  { line: 139, domain: '指数・対数', planNotation: 'exp、ln、log10、log₂、log底指定', symbols: [
    { symbol: 'exp', catalogIds: ['exponential'] },
    { symbol: 'ln', catalogIds: ['log-natural'] },
    { symbol: 'log10', catalogIds: ['log-ten'] },
    { symbol: 'log₂', catalogIds: ['log-two'] },
    { symbol: 'log（底指定）', catalogIds: ['log-base'] },
  ] },
  { line: 140, domain: '三角', planNotation: 'sin/cos/tan/cot/sec/csc、逆関数、atan2', symbols: [
    { symbol: 'sin', catalogIds: ['sin'] },
    { symbol: 'cos', catalogIds: ['cos'] },
    { symbol: 'tan', catalogIds: ['tan'] },
    { symbol: 'cot', catalogIds: ['cot'] },
    { symbol: 'sec', catalogIds: ['sec'] },
    { symbol: 'csc', catalogIds: ['csc'] },
    { symbol: 'arcsin', catalogIds: ['arcsin'] },
    { symbol: 'arccos', catalogIds: ['arccos'] },
    { symbol: 'arctan', catalogIds: ['arctan'] },
    { symbol: 'arccot', catalogIds: ['arccot'] },
    { symbol: 'arcsec', catalogIds: ['arcsec'] },
    { symbol: 'arccsc', catalogIds: ['arccsc'] },
    { symbol: 'atan2', catalogIds: ['atan2'] },
  ] },
  { line: 141, domain: '双曲線', planNotation: 'sinh/cosh/tanh/coth/sech/csch、逆関数', symbols: [
    { symbol: 'sinh', catalogIds: ['sinh'] },
    { symbol: 'cosh', catalogIds: ['cosh'] },
    { symbol: 'tanh', catalogIds: ['tanh'] },
    { symbol: 'coth', catalogIds: ['coth'] },
    { symbol: 'sech', catalogIds: ['sech'] },
    { symbol: 'csch', catalogIds: ['csch'] },
    { symbol: 'arsinh', catalogIds: ['arsinh'] },
    { symbol: 'arcosh', catalogIds: ['arcosh'] },
    { symbol: 'artanh', catalogIds: ['artanh'] },
    { symbol: 'arcoth', catalogIds: ['arcoth'] },
    { symbol: 'arsech', catalogIds: ['arsech'] },
    { symbol: 'arcsch', catalogIds: ['arcsch'] },
  ] },
  { line: 142, domain: '複素演算', planNotation: 'Re/Im、共役、偏角arg、絶対値、極形式、cis', symbols: [
    { symbol: 'Re', catalogIds: ['real-part'] },
    { symbol: 'Im', catalogIds: ['imaginary-part'] },
    { symbol: '共役', catalogIds: ['conjugate'] },
    { symbol: 'arg', catalogIds: ['argument'] },
    { symbol: '絶対値（複素）', catalogIds: ['absolute'] },
    { symbol: '極形式', catalogIds: ['cis'] },
    { symbol: 'cis', catalogIds: ['cis'] },
  ] },
  { line: 143, domain: '数列', planNotation: 'aₙ、漸化式、差分Δ、部分和、総和Σ、総積Π', symbols: [
    { symbol: 'aₙ（指定項）', catalogIds: ['sequence-value'] },
    { symbol: '漸化式', catalogIds: ['recurrence-value'] },
    { symbol: '差分 Δ', catalogIds: ['difference-at'] },
    { symbol: '部分和', catalogIds: ['sum'] },
    { symbol: '総和 Σ', catalogIds: ['sum'] },
    { symbol: '総積 Π', catalogIds: ['product'] },
  ] },
  { line: 144, domain: '級数', planNotation: '無限和/積、べき級数、Taylor/Maclaurin', symbols: [
    { symbol: '無限和', catalogIds: ['infinite-sum', 'sum'] },
    { symbol: '無限積', catalogIds: ['infinite-product', 'product'] },
    { symbol: 'べき級数', catalogIds: ['series-coefficient', 'taylor'] },
    { symbol: 'Taylor', catalogIds: ['taylor'] },
    { symbol: 'Maclaurin', catalogIds: ['maclaurin'] },
  ] },
  { line: 145, domain: '極限', planNotation: 'lim、左右極限、x→a、x→±∞、sup/inf、limsup/liminf', symbols: [
    { symbol: 'lim', catalogIds: ['limit'] },
    { symbol: '左右極限', catalogIds: ['limit'] },
    { symbol: 'x→a', catalogIds: ['limit'] },
    { symbol: 'x→±∞', catalogIds: ['limit'] },
    { symbol: 'sup（集合）', catalogIds: ['set-supremum'] },
    { symbol: 'inf（集合）', catalogIds: ['set-infimum'] },
    { symbol: 'limsup', catalogIds: ['limit-supremum'] },
    { symbol: 'liminf', catalogIds: ['limit-infimum'] },
  ] },
  { line: 146, domain: '常微分', planNotation: 'd/dx、高階微分、f′/f″、ドット表記', symbols: [
    { symbol: 'd/dx', catalogIds: ['derivative'] },
    { symbol: '高階微分', catalogIds: ['derivative', 'partial'] },
    { symbol: 'f′/f″', catalogIds: ['solve-ode', 'ode-value'] },
    { symbol: 'ドット表記', catalogIds: ['solve-ode', 'ode-value'] },
  ] },
  { line: 147, domain: '偏微分', planNotation: '∂/∂x、多重偏導関数、全微分、Jacobian/Hessian', symbols: [
    { symbol: '∂/∂x', catalogIds: ['partial'] },
    { symbol: '多重偏導関数', catalogIds: ['derivative', 'partial'] },
    { symbol: '全微分', catalogIds: ['total-differential-at'] },
    { symbol: 'Jacobian', catalogIds: ['jacobian', 'jacobian-at'] },
    { symbol: 'Hessian', catalogIds: ['hessian', 'hessian-at'] },
  ] },
  { line: 148, domain: '積分', planNotation: '不定/定積分、広義積分、二重/三重/反復積分', symbols: [
    { symbol: '不定積分', catalogIds: ['indefinite-integral'] },
    { symbol: '定積分', catalogIds: ['integral'] },
    { symbol: '広義積分', catalogIds: ['integral'] },
    { symbol: '二重積分', catalogIds: ['integral'] },
    { symbol: '三重積分', catalogIds: ['integral'] },
    { symbol: '反復積分', catalogIds: ['integral'] },
  ] },
  { line: 149, domain: 'ベクトル解析', planNotation: '∇、grad/div/curl、∇²/Δ、線積分、面積分、体積積分、閉路∮/∯', symbols: [
    { symbol: '∇', catalogIds: ['gradient', 'divergence', 'curl', 'laplacian'] },
    { symbol: 'grad', catalogIds: ['gradient', 'gradient-at'] },
    { symbol: 'div', catalogIds: ['divergence', 'divergence-at'] },
    { symbol: 'curl', catalogIds: ['curl', 'curl-at'] },
    { symbol: '∇²/Δ（ラプラシアン）', catalogIds: ['laplacian', 'laplacian-at'] },
    { symbol: '線積分', catalogIds: ['circulation', 'line-integral'] },
    { symbol: '面積分', catalogIds: ['flux-integral', 'surface-integral'] },
    { symbol: '体積積分', catalogIds: ['volume-integral'] },
    { symbol: '閉路 ∮/∯', catalogIds: ['closed-line-integral', 'closed-circulation', 'closed-surface-integral', 'closed-flux-integral'] },
  ] },
  { line: 150, domain: 'ベクトル', planNotation: '行/列ベクトル、成分、長さ‖ ‖、内積⟨,⟩/·、外積×、射影', symbols: [
    { symbol: '行ベクトル', catalogIds: ['matrix'] },
    { symbol: '列ベクトル', catalogIds: ['matrix'] },
    { symbol: '成分', catalogIds: ['component', 'tensor-element'] },
    { symbol: '長さ ‖ ‖', catalogIds: ['norm'] },
    { symbol: '内積 ⟨,⟩/·', catalogIds: ['dot'] },
    { symbol: '外積 ×', catalogIds: ['cross'] },
    { symbol: '射影', catalogIds: ['projection'] },
  ] },
  { line: 151, domain: '行列', planNotation: '配列、Aᵀ、A*、A⁻¹、det/行列式、trace、rank、単位/零行列', symbols: [
    { symbol: '配列（行列）', catalogIds: ['matrix'] },
    { symbol: 'Aᵀ', catalogIds: ['transpose'] },
    { symbol: 'A*（随伴）', catalogIds: ['conjugate-transpose'] },
    { symbol: 'A⁻¹', catalogIds: ['inverse-matrix'] },
    { symbol: 'det', catalogIds: ['determinant'] },
    { symbol: 'trace', catalogIds: ['trace'] },
    { symbol: 'rank', catalogIds: ['rank'] },
    { symbol: '単位行列', catalogIds: ['identity-matrix'] },
    { symbol: '零行列', catalogIds: ['zero-matrix'] },
  ] },
  { line: 152, domain: '線形代数', planNotation: '連立一次式、行基本変形、固有値/ベクトル、SVD、QR、基底/kernel/image', symbols: [
    { symbol: '連立一次式', catalogIds: ['linear-solution-space', 'linear-solve'] },
    { symbol: '行基本変形', catalogIds: ['row-reduce'] },
    { symbol: '固有値', catalogIds: ['eigenvalues'] },
    { symbol: '固有ベクトル', catalogIds: ['eigenspace'] },
    { symbol: 'SVD', catalogIds: ['singular-values', 'svd-s', 'svd-u', 'svd-v'] },
    { symbol: 'QR', catalogIds: ['qr-q', 'qr-r'] },
    { symbol: '基底', catalogIds: ['column-space', 'null-space', 'row-space'] },
    { symbol: 'kernel', catalogIds: ['null-space'] },
    { symbol: 'image', catalogIds: ['column-space'] },
  ] },
  { line: 153, domain: 'テンソル', planNotation: '添字、縮約、テンソル積⊗、Hadamard積⊙、Levi-Civita ε、Kronecker δ', symbols: [
    { symbol: '添字', catalogIds: ['tensor-element'] },
    { symbol: '縮約', catalogIds: ['tensor-contract'] },
    { symbol: '⊗', catalogIds: ['tensor-product'] },
    { symbol: '⊙', catalogIds: ['hadamard-product'] },
    { symbol: 'Levi-Civita ε', catalogIds: ['levi-civita'] },
    { symbol: 'Kronecker δ', catalogIds: ['kronecker-delta'] },
  ] },
  { line: 154, domain: '区間・場合分け', planNotation: '[a,b]、(a,b)、端点開閉、piecewise、条件付き式', symbols: [
    { symbol: '[a,b]', reason: '区間の記法は他演算（set-supremum等）の引数として使う構造要素であり、独立した目録項目は無い。実装は確認済み。' },
    { symbol: '(a,b)', reason: '区間の記法は他演算の引数として使う構造要素であり、独立した目録項目は無い。実装は確認済み。' },
    { symbol: '端点開閉（半開）', reason: '区間の開閉（半開区間含む）は他演算の引数として使う構造要素であり、独立した目録項目は無い。実装は確認済み。' },
    { symbol: 'piecewise', catalogIds: ['cases'] },
    { symbol: '条件付き式', catalogIds: ['cases'] },
  ] },
  { line: 155, domain: '集合', planNotation: '∅、ℕ/ℤ/ℚ/ℝ/ℂ、∈/∉、⊂/⊆/⊃/⊇、∪/∩/差/補集合、直積', symbols: [
    { symbol: '∅', catalogIds: ['empty-set'] },
    { symbol: 'ℕ', catalogIds: ['natural-numbers'] },
    { symbol: 'ℤ', catalogIds: ['integer-numbers'] },
    { symbol: 'ℚ', catalogIds: ['rational-numbers'] },
    { symbol: 'ℝ', catalogIds: ['real-numbers'] },
    { symbol: 'ℂ', catalogIds: ['complex-numbers'] },
    { symbol: '∈', catalogIds: ['element'] },
    { symbol: '∉', catalogIds: ['not-element'] },
    { symbol: '⊂', catalogIds: ['subset'] },
    { symbol: '⊆', catalogIds: ['subset-equal'] },
    { symbol: '⊃', catalogIds: ['superset'] },
    { symbol: '⊇', catalogIds: ['superset-equal'] },
    { symbol: '∪', catalogIds: ['union'] },
    { symbol: '∩', catalogIds: ['intersection'] },
    { symbol: '差 ∖', catalogIds: ['set-minus'] },
    { symbol: '補集合', catalogIds: ['complement'] },
    { symbol: '直積', catalogIds: ['cartesian-product'] },
  ] },
  { line: 156, domain: '論理', planNotation: '= ≠ < ≤ > ≥、≈、∧/∨/¬、⇒/⇔、∀/∃、真偽', symbols: [
    { symbol: '=', catalogIds: ['equal'] },
    { symbol: '≠', catalogIds: ['not-equal'] },
    { symbol: '<', catalogIds: ['less'] },
    { symbol: '≤', catalogIds: ['less-equal'] },
    { symbol: '>', catalogIds: ['greater'] },
    { symbol: '≥', catalogIds: ['greater-equal'] },
    { symbol: '≈（許容差明示）', catalogIds: ['approximately-equal'] },
    { symbol: '∧', catalogIds: ['and'] },
    { symbol: '∨', catalogIds: ['or'] },
    { symbol: '¬', catalogIds: ['not'] },
    { symbol: '⇒', catalogIds: ['implies'] },
    { symbol: '⇔', catalogIds: ['equivalent'] },
    { symbol: '∀', catalogIds: ['for-all'] },
    { symbol: '∃', catalogIds: ['exists'] },
    { symbol: '真偽', catalogIds: ['true', 'false'] },
  ] },
  { line: 157, domain: '方程式', planNotation: '等式、不等式、連立、多項式の根、数値根探索', symbols: [
    { symbol: '等式', catalogIds: ['solution-value', 'solve-equation'] },
    { symbol: '不等式', catalogIds: ['solve-equation'] },
    { symbol: '連立', catalogIds: ['solve-system', 'system-solution'] },
    { symbol: '多項式の根', catalogIds: ['polynomial-roots'] },
    { symbol: '数値根探索', catalogIds: ['numerical-roots', 'root-interval'] },
  ] },
  { line: 158, domain: '確率', planNotation: 'P(A)、条件付きP(A|B)、独立、E/Var/Cov/Corr、確率変数', symbols: [
    { symbol: 'P(A)', catalogIds: ['event-probability'] },
    { symbol: 'P(A|B)', catalogIds: ['conditional-probability', 'given-probability'] },
    { symbol: '独立', catalogIds: ['independent-events', 'independent-variables'] },
    { symbol: 'E', catalogIds: ['expectation', 'random-expectation'] },
    { symbol: 'Var', catalogIds: ['probability-variance', 'random-variance'] },
    { symbol: 'Cov', catalogIds: ['random-covariance'] },
    { symbol: 'Corr', catalogIds: ['random-correlation'] },
    { symbol: '確率変数（分布宣言）', catalogIds: ['finite-distribution', 'independent-distributions', 'joint-finite-distribution', 'normal-distribution'] },
  ] },
  { line: 159, domain: '統計', planNotation: '平均、中央値、最頻値、分位数、標準偏差、標本/母分散、回帰', symbols: [
    { symbol: '平均', catalogIds: ['mean'] },
    { symbol: '中央値', catalogIds: ['median'] },
    { symbol: '最頻値', catalogIds: ['modes'] },
    { symbol: '分位数', catalogIds: ['quantile'] },
    { symbol: '標準偏差', catalogIds: ['population-standard-deviation', 'sample-standard-deviation'] },
    { symbol: '標本分散', catalogIds: ['sample-variance'] },
    { symbol: '母分散', catalogIds: ['population-variance'] },
    { symbol: '回帰', catalogIds: ['r-squared', 'regression-intercept', 'regression-slope'] },
  ] },
  { line: 160, domain: '分布', planNotation: '二項、Poisson、一様、正規、指数、Gamma/Beta、χ²、t、F', symbols: [
    { symbol: '二項', catalogIds: ['binomial-cdf', 'binomial-pmf', 'binomial-quantile'] },
    { symbol: 'Poisson', catalogIds: ['poisson-cdf', 'poisson-pmf', 'poisson-quantile'] },
    { symbol: '一様', catalogIds: ['uniform-cdf', 'uniform-pdf', 'uniform-quantile'] },
    { symbol: '正規', catalogIds: ['normal-cdf', 'normal-pdf', 'normal-quantile'] },
    { symbol: '指数', catalogIds: ['exponential-cdf', 'exponential-pdf', 'exponential-quantile'] },
    { symbol: 'Gamma分布', catalogIds: ['gamma-cdf', 'gamma-pdf', 'gamma-quantile'] },
    { symbol: 'Beta分布', catalogIds: ['beta-cdf', 'beta-pdf', 'beta-quantile'] },
    { symbol: 'χ²', catalogIds: ['chi-square-cdf', 'chi-square-pdf', 'chi-square-quantile'] },
    { symbol: 't', catalogIds: ['t-cdf', 't-pdf', 't-quantile'] },
    { symbol: 'F', catalogIds: ['f-cdf', 'f-pdf', 'f-quantile'] },
  ] },
  { line: 161, domain: '特殊関数', planNotation: 'Γ/B、erf/erfc、Bessel、Legendre、Airy、楕円積分、ζ、Lambert W', symbols: [
    { symbol: 'Γ（polygamma含む）', catalogIds: ['gamma', 'polygamma'] },
    { symbol: 'B', catalogIds: ['beta'] },
    { symbol: 'erf', catalogIds: ['erf'] },
    { symbol: 'erfc', catalogIds: ['erfc'] },
    { symbol: 'Bessel J/Y/I/K', catalogIds: ['besseli', 'besselj', 'besselk', 'bessely'] },
    { symbol: 'Legendre', catalogIds: ['legendre'] },
    { symbol: 'Airy', catalogIds: ['airyai', 'airyaiprime', 'airybi', 'airybiprime'] },
    { symbol: '楕円積分', catalogIds: ['elliptice', 'ellipticeinc', 'ellipticf', 'elliptick', 'ellipticpi', 'ellipticpiinc'] },
    { symbol: 'ζ', catalogIds: ['zeta', 'zetaderivative'] },
    { symbol: 'Lambert W', catalogIds: ['lambertw'] },
  ] },
  { line: 162, domain: '変換', planNotation: 'Fourier級数/変換/逆変換、DFT/FFT、Laplace/逆変換、Z変換', symbols: [
    { symbol: 'Fourier級数', catalogIds: ['fourier-cosine', 'fourier-series', 'fourier-sine', 'fourier-value'] },
    { symbol: 'Fourier変換', catalogIds: ['fourier-transform'] },
    { symbol: '逆Fourier変換', catalogIds: ['inverse-fourier-transform'] },
    { symbol: 'DFT', catalogIds: ['dft', 'idft'] },
    { symbol: 'FFT', catalogIds: ['fft', 'ifft'] },
    { symbol: 'Laplace変換', catalogIds: ['laplace-transform'] },
    { symbol: '逆Laplace変換', catalogIds: ['inverse-laplace-transform'] },
    { symbol: 'Z変換', catalogIds: ['z-transform'] },
  ] },
  { line: 163, domain: '微分方程式', planNotation: 'dy/dx、y″、初期値/境界値、連立ODE、PDEの記法', symbols: [
    { symbol: 'dy/dx', catalogIds: ['solve-ode'] },
    { symbol: 'y″', catalogIds: ['solve-ode'] },
    { symbol: '初期値', catalogIds: ['ode-value', 'solve-ode'] },
    { symbol: '境界値', catalogIds: ['solve-ode'] },
    { symbol: '連立ODE', catalogIds: ['solve-ode'] },
    { symbol: 'PDEの記法', catalogIds: ['partial-equations'] },
  ] },
  { line: 164, domain: '数論・抽象記号', planNotation: '整除、合同≡(mod n)、素数、商/剰余、写像↦/→、合成∘、逆写像', symbols: [
    { symbol: '整除', catalogIds: ['divides'] },
    { symbol: '合同 ≡ (mod n)', catalogIds: ['congruent-modulo'] },
    { symbol: '素数', catalogIds: ['is-prime', 'next-prime', 'prime-factors'] },
    { symbol: '商', catalogIds: ['integer-quotient'] },
    { symbol: '剰余', catalogIds: ['integer-remainder'] },
    { symbol: '写像 ↦/→', catalogIds: ['mapping', 'mapping-value'] },
    { symbol: '合成 ∘', catalogIds: ['mapping-compose'] },
    { symbol: '逆写像', catalogIds: ['mapping-inverse'] },
  ] },
  { line: 165, domain: '幾何', planNotation: '∠、平行∥、垂直⊥、合同≅、相似∼、弧、距離、面積、体積', symbols: [
    { symbol: '∠', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '∥', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '⊥', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '≅', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '∼', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '弧', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '距離', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '面積', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
    { symbol: '体積', reason: 'w1d の計画（GR-09〜GR-11ほか）で扱う' },
  ] },
];

/** 幾何（w1d の計画が扱う）の行番号。 */
export const MATH_CATALOG_COVERAGE_GEOMETRY_LINE = 165;

/** 対応表の記号の総数（既定は幾何9件を含む265）。 */
export function countMathCatalogSymbols(rows: readonly MathCoverageRow[] = MATH_CATALOG_COVERAGE): number {
  return rows.reduce((total, row) => total + row.symbols.length, 0);
}

/** 計画 §1 の1行分（分野・記法列の原文だけ。境界の受入列は対応表に使わないため含まない）。 */
export interface MathPlanCoverageRow {
  readonly domain: string;
  readonly notation: string;
}

const PLAN_TABLE_HEADER = /^\|\s*分野\s*\|\s*記法・演算\s*\|\s*利用と境界の受入\s*\|$/u;
const PLAN_TABLE_SEPARATOR = /^\|[-: |]+\|$/u;
/** 1セル分: エスケープした `\|`（セル内の縦棒）を1単位として消費し、素の `|`（区切り）の手前で止まる。 */
const PLAN_TABLE_ROW = /^\|\s*((?:[^|\\]|\\.)+?)\s*\|\s*((?:[^|\\]|\\.)+?)\s*\|\s*(?:[^|\\]|\\.)*\|\s*$/u;

function unescapePlanCell(cell: string): string {
  // Markdown表のセル内の縦棒は「\|」と書く（例: "P(A\|B)"）。素のテキストへ戻す。
  return cell.replace(/\\(.)/gu, '$1');
}

/**
 * 計画 §1（分野別の網羅表）を実ファイルのテキストから読む。表の見出し行に続く32行を、
 * 分野・記法列（原文）だけ取り出す。読み取れない行・表が見つからない場合は投げる。
 * 副作用（ファイル読み取り）は持たない。呼び出し側（テスト）が `readFileSync` 等で渡す。
 */
export function parseMathPlanCoverageTable(markdown: string): readonly MathPlanCoverageRow[] {
  const rows: MathPlanCoverageRow[] = [];
  let inTable = false;
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!inTable) { if (PLAN_TABLE_HEADER.test(line)) inTable = true; continue; }
    if (PLAN_TABLE_SEPARATOR.test(line)) continue;
    if (line === '' || !line.startsWith('|')) break;
    const match = PLAN_TABLE_ROW.exec(line);
    if (match === null) throw new Error(`計画 §1 の行を読み取れません: ${line}`);
    const [, domain, notation] = match;
    rows.push({ domain: unescapePlanCell(domain), notation: unescapePlanCell(notation) });
  }
  if (rows.length === 0) throw new Error('計画 §1（分野別の網羅表）が見つかりません。');
  return Object.freeze(rows);
}

/**
 * 対応表（`rows`）の行数・分野・記法列が、計画から読み取った行（`planRows`）と1行ずつ一致することを確かめる。
 * 計画の行が増減・改名・並べ替え・文言変更されると、ここで具体的な行を示して投げる
 * （§1 の32行のどれかが変われば、この照合が失敗する）。
 */
export function assertMathPlanRowsMatch(rows: readonly MathCoverageRow[], planRows: readonly MathPlanCoverageRow[]): void {
  if (rows.length !== planRows.length) {
    throw new Error(`計画 §1 の行数(${String(planRows.length)})と対応表の行数(${String(rows.length)})が一致しません。`);
  }
  planRows.forEach((planRow, index) => {
    const row = rows[index];
    if (row === undefined) throw new Error(`対応表に${String(index)}番目の行がありません。`);
    if (row.domain !== planRow.domain) {
      throw new Error(`L${String(row.line)}: 分野が計画と一致しません（対応表「${row.domain}」/計画「${planRow.domain}」）。`);
    }
    if (row.planNotation !== planRow.notation) {
      throw new Error(`L${String(row.line)}「${row.domain}」: 記法・演算が計画と一致しません。対応表の planNotation を計画に合わせて更新してください`
        + `（対応表「${row.planNotation}」/計画「${planRow.notation}」）。`);
    }
  });
}

export interface MathCatalogValidationInput {
  readonly rows: readonly MathCoverageRow[];
  /** 公開目録（`MATH_INPUT_PALETTE`）に実在する項目ID。 */
  readonly catalogIds: ReadonlySet<string>;
  /** 演算が implemented である（未実装・pending の演算を要求しない）目録項目ID。 */
  readonly implementedCatalogIds: ReadonlySet<string>;
}

/**
 * 対応表の一貫性を検査する。違反を見つけ次第、具体的な記号・行を示す Error を投げる。
 * 実データ（公開目録から作った `catalogIds`・`implementedCatalogIds`）とモック入力（自己検査）の両方に使う。
 * 検査する内容:
 * - 記号が空（行に1つも無い）・記号名が空文字列・記号名の重複（対応表全体で一意）
 * - 受入済み（`catalogIds`）は1個以上、重複無し、公開目録に実在し、演算が implemented である
 * - 未実装・範囲外（`reason`）は空文字列でない
 */
export function validateMathCatalogCoverage(input: MathCatalogValidationInput): void {
  const { rows, catalogIds, implementedCatalogIds } = input;
  if (rows.length === 0) throw new Error('対応表が空です。');
  const seenSymbols = new Set<string>();
  for (const row of rows) {
    if (row.symbols.length === 0) throw new Error(`L${String(row.line)}「${row.domain}」: 記号がありません。`);
    for (const entry of row.symbols) {
      if (entry.symbol.trim() === '') throw new Error(`L${String(row.line)}「${row.domain}」: 空の記号名があります。`);
      if (seenSymbols.has(entry.symbol)) throw new Error(`記号「${entry.symbol}」が対応表内で重複しています。`);
      seenSymbols.add(entry.symbol);
      if (isMathCoverageAccepted(entry)) {
        if (entry.catalogIds.length === 0) {
          throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: catalogIds が空です。`);
        }
        const seenIds = new Set<string>();
        for (const id of entry.catalogIds) {
          if (seenIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」が重複しています。`);
          }
          seenIds.add(id);
          if (!catalogIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」は公開目録にありません。`);
          }
          if (!implementedCatalogIds.has(id)) {
            throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 目録ID「${id}」の演算は未実装(pending)です。`);
          }
        }
      } else if (entry.reason.trim() === '') {
        throw new Error(`L${String(row.line)}「${row.domain}」の記号「${entry.symbol}」: 理由が空です。`);
      }
    }
  }
}
