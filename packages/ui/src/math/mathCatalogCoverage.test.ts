import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CANDIDATE_MATH_BY_ID } from '@pointercad/expression/math/contracts';
import { MATH_PALETTE_DRAFT } from './mathPalette.js';
import { MATH_INPUT_PALETTE } from './mathPaletteExamples.js';
import {
  assertMathPlanRowsMatch, isMathCoverageAccepted, parseMathPlanCoverageTable,
  validateMathCatalogCoverage,
} from './mathCatalogCoverage.js';

type MathCoverageRow = Parameters<typeof assertMathPlanRowsMatch>[0][number];

/**
 * 計画 §1（L134〜L165）の32行・256記号（幾何9件を除く）の対応表。
 * 生成の経緯: 計画§1を265記号へ分けた機械集計を
 * 基に、`packages/ui/src/math/mathPaletteExamples.ts` が公開する現在の目録ID（`MATH_INPUT_PALETTE`）と
 * `packages/ui/src/math/mathPalette{Basic,Calculus,SetsLogic}.ts` の演算参照（`requiredOperations`）を実ファイルから
 * 読み直して照合した（2026-09-24 09時台時点）。目録IDを持たない記号は、後続タスク名または設計上の理由を記す。
 * MC-04b（目録の再照合、同日10時台）が、MC-02d・MC-02e公開後の目録（308項目）へ照合し直し、23件のreasonをcatalogIdsへ
 * 置き換えた（範囲外3・図形参照9・不定積分1・設計上パレット化しない14の27件がreasonのまま残る）。
 * MC-04c（不定積分の再照合）が、目録に追加した不定積分（原始関数、309項目目）へ照合し、「不定積分」1件のreasonを
 * catalogIdsへ置き換えた（範囲外3・図形参照9・設計上パレット化しない14の26件がreasonのまま残る）。
 * ADD-17（数の表記の再照合、2026-09-25）が、循環小数・%・比の3件（当時「MC-19cが実装中」だった理由）を、完了した
 * MC-19c（構造入力の往復・百分率・比の読み取り）の実装に合わせて書き直した。catalogIdsは持たず、四則演算・
 * 括弧・区間記法と同様「数の表記は直接入力が前提で目録の項目化対象外」の理由へ移した
 * （範囲外0・図形参照9・設計上パレット化しない17の26件がreasonのまま残る）。
 */
const MATH_CATALOG_COVERAGE: readonly MathCoverageRow[] = [
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
    { symbol: '循環小数', reason: '通常入力0.1(6)等・構造入力の上線（\\overline{}）の往復とも、丸めない有理数として読み書きする実装済みの機能。数の表記自体は直接入力が前提で、目録（パレット）の項目化対象外（計画§2の直接入力の方針）。' },
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
    { symbol: '百分率 %', reason: 'テキスト入力・構造入力の両方で÷100として読み書きする実装済みの機能（mathTextSyntax.ts・parseMathLatex.ts）。数の表記の記号は直接入力が前提で、目録の項目化対象外（計画§2の直接入力の方針）。' },
    { symbol: '比', reason: 'a:bをa÷bとして読む実装済みの機能。区間・時刻表記と紛らわしいものは理由付きで断る。比の記法は直接入力が前提で、目録の項目化対象外（計画§2の直接入力の方針）。' },
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

/** 幾何（この対応表が扱う）の行番号。 */
const MATH_CATALOG_COVERAGE_GEOMETRY_LINE = 165;

/** 対応表の記号の総数（既定は幾何9件を含む265）。 */
function countMathCatalogSymbols(rows: readonly MathCoverageRow[] = MATH_CATALOG_COVERAGE): number {
  return rows.reduce((total, row) => total + row.symbols.length, 0);
}

/**
 * 計画 §1（分野別の網羅表）を実ファイルから読む。`node:fs` を使うのはこのテストだけで、
 * `mathCatalogCoverage.ts` 自体は純粋関数のみを持つ（読み取りはテストが担う）。
 */
const planMarkdown = readFileSync(new URL('../../../../docs/plans/追加-数学入力.md', import.meta.url), 'utf8');
const planRows = parseMathPlanCoverageTable(planMarkdown);

/** 実データでの「公開目録に実在」「演算が implemented」の判定に使う集合。 */
const registeredOperationIds = new Set(CANDIDATE_MATH_BY_ID.keys());
const catalogIds = new Set(MATH_INPUT_PALETTE.map(item => item.id));
const implementedCatalogIds = new Set(
  MATH_PALETTE_DRAFT.filter(item => item.requiredOperations.every(operationId => registeredOperationIds.has(operationId)))
    .map(item => item.id),
);

describe('計画§1の32行と公開目録の機械照合（MC-04）', () => {
  it('計画から読み取った行数が32で、対応表と分野・記法が一致する（計画の行が変われば失敗）', () => {
    expect(planRows.length).toBe(32);
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE, planRows)).not.toThrow();
  });

  it('記号の総数は265（幾何9件を含む）・256（幾何を除く）で欠落0', () => {
    const geometry = MATH_CATALOG_COVERAGE.find(row => row.line === MATH_CATALOG_COVERAGE_GEOMETRY_LINE);
    if (geometry === undefined) throw new Error(`幾何(L${String(MATH_CATALOG_COVERAGE_GEOMETRY_LINE)})の行がありません。`);
    expect(geometry.symbols.length).toBe(9);
    expect(countMathCatalogSymbols(MATH_CATALOG_COVERAGE)).toBe(265);
    expect(countMathCatalogSymbols(MATH_CATALOG_COVERAGE) - geometry.symbols.length).toBe(256);
    for (const row of MATH_CATALOG_COVERAGE) {
      for (const entry of row.symbols) {
        const hasReason = !isMathCoverageAccepted(entry) && entry.reason.trim() !== '';
        expect(isMathCoverageAccepted(entry) || hasReason, `L${String(row.line)} ${entry.symbol}`).toBe(true);
      }
    }
  });

  it('幾何9記号(L165)は目録IDを持たず、w1dの計画を参照する理由を持つ', () => {
    const geometry = MATH_CATALOG_COVERAGE.find(row => row.line === MATH_CATALOG_COVERAGE_GEOMETRY_LINE);
    if (geometry === undefined) throw new Error('幾何(L165)の行がありません。');
    for (const entry of geometry.symbols) {
      expect(isMathCoverageAccepted(entry), entry.symbol).toBe(false);
      if (!isMathCoverageAccepted(entry)) expect(entry.reason, entry.symbol).toContain('w1d');
    }
  });

  it('目録IDを持つ記号は公開目録に実在し、演算がimplementedである（実データ）', () => {
    expect(() => validateMathCatalogCoverage({ rows: MATH_CATALOG_COVERAGE, catalogIds, implementedCatalogIds })).not.toThrow();
  });

  it('後続タスク待ちの記号数が想定どおり（MC-02dはMC-04bで、MC-20はMC-04cで全件catalogIds化。MC-19cはADD-17で完了し循環小数・%・比の理由を書き直した。書き換え対象の集計）', () => {
    const pendingReasons: string[] = [];
    for (const row of MATH_CATALOG_COVERAGE) {
      for (const entry of row.symbols) {
        if (!isMathCoverageAccepted(entry)) pendingReasons.push(entry.reason);
      }
    }
    const countByTask = (task: string) => pendingReasons.filter(reason => reason.includes(task)).length;
    expect(countByTask('MC-02d')).toBe(0);
    expect(countByTask('MC-19c')).toBe(0);
    expect(countByTask('MC-20')).toBe(0);
    expect(pendingReasons.length).toBe(26);
  });
});

describe('対応表の自己検査（模擬入力で不正な変更を拒否する。5種以上）', () => {
  const acceptedEntry: MathCoverageRow['symbols'][number] = { symbol: 'x', catalogIds: ['x-op'] };
  const pendingEntry: MathCoverageRow['symbols'][number] = { symbol: 'y', reason: '未実装のためのテスト用の理由。' };
  const mockRow: MathCoverageRow = { line: 900, domain: 'テスト分野', planNotation: 'x、y', symbols: [acceptedEntry, pendingEntry] };
  const mockCatalogIds = new Set(['x-op']);
  const mockImplementedIds = new Set(['x-op']);

  it('1. 未実装(pending)の演算を受入済みにする変更を拒否する', () => {
    expect(() => validateMathCatalogCoverage({
      rows: [mockRow], catalogIds: mockCatalogIds, implementedCatalogIds: new Set(),
    })).toThrow(/未実装/u);
  });

  it('2. 存在しない目録IDを拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: ['no-such-id'] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/公開目録にありません/u);
  });

  it('3. 理由の空欄を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [acceptedEntry, { symbol: 'y', reason: '' }] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/理由が空/u);
  });

  it('4. 記号の重複を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [acceptedEntry, { symbol: 'x', reason: '重複したテスト用の理由。' }] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/重複/u);
  });

  it('5. 計画の行の削除・追加を拒否する（対応表と計画の行数が食い違う）', () => {
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE.slice(1), planRows)).toThrow();
    expect(() => assertMathPlanRowsMatch(MATH_CATALOG_COVERAGE, planRows.slice(1))).toThrow();
  });

  it('6. 空のcatalogIds配列を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: [] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/catalogIds が空/u);
  });

  it('7. 同一記号内での目録IDの重複を拒否する', () => {
    const row: MathCoverageRow = { ...mockRow, symbols: [{ symbol: 'x', catalogIds: ['x-op', 'x-op'] }, pendingEntry] };
    expect(() => validateMathCatalogCoverage({
      rows: [row], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds,
    })).toThrow(/目録ID.*重複/u);
  });

  it('8. 計画の行の文言変更（記法・演算列の書き換え）を拒否する', () => {
    const mutatedRows = MATH_CATALOG_COVERAGE.map((row, index) => (index === 0 ? { ...row, planNotation: '書き換えテスト' } : row));
    expect(() => assertMathPlanRowsMatch(mutatedRows, planRows)).toThrow();
  });

  it('9. 対応表が空の変更を拒否する', () => {
    expect(() => validateMathCatalogCoverage({ rows: [], catalogIds: mockCatalogIds, implementedCatalogIds: mockImplementedIds }))
      .toThrow(/空です/u);
  });
});
