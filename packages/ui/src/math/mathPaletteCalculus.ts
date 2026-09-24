import { t } from '../i18n/t.js';
import { mathPaletteItem as item, type MathPaletteCatalogItem } from './mathPaletteGroups.js';

/**
 * 数学の目録の分野別ファイル: 微積分・線形代数・数列と級数。
 * 分野（group）が calculus・linear-algebra・series の項目を置く。文言は i18n/ja/mathPaletteCalculus.json、
 * 公開パレットの実例は mathPaletteCalculusExamples.ts にある（実例と受入IDが揃った項目だけを公開する）。
 * 各項目は名前・記号・ひな形・必要な演算・意味・検索語と、引数型・結果型・計算方式・関数作図での利用・
 * 説明の節（mathPaletteGroups.ts の MathPaletteFields）を持つ。欄の正しさは mathPaletteExamples.test.ts が実計算で照合する。
 */
/** 説明「構造化した数式と係数を入力する」の見出し（この分野の項目が参照する節）。 */
const HELP = {
  limitBounds: t('math.paletteHelp.calculus.limitBounds'),
  limits: t('math.paletteHelp.calculus.limits'),
  fourierSeries: t('math.paletteHelp.calculus.fourierSeries'),
  seriesCoefficient: t('math.paletteHelp.calculus.seriesCoefficient'),
  taylor: t('math.paletteHelp.calculus.taylor'),
  sequences: t('math.paletteHelp.calculus.sequences'),
  sums: t('math.paletteHelp.calculus.sums'),
  integrals: t('math.paletteHelp.calculus.integrals'),
  derivatives: t('math.paletteHelp.calculus.derivatives'),
  svd: t('math.paletteHelp.calculus.svd'),
  eigenspace: t('math.paletteHelp.calculus.eigenspace'),
  tensors: t('math.paletteHelp.calculus.tensors'),
  singularValues: t('math.paletteHelp.calculus.singularValues'),
  eigenvalues: t('math.paletteHelp.calculus.eigenvalues'),
  linear: t('math.paletteHelp.calculus.linear'),
  qr: t('math.paletteHelp.calculus.qr'),
  lu: t('math.paletteHelp.calculus.lu'),
  characteristic: t('math.paletteHelp.calculus.characteristic'),
  paletteArguments: t('math.paletteHelp.calculus.paletteArguments'),
  vectorCalculus: t('math.paletteHelp.calculus.vectorCalculus'),
  vectorCalculusAt: t('math.paletteHelp.calculus.vectorCalculusAt'),
  lineIntegrals: t('math.paletteHelp.calculus.lineIntegrals'),
  regionIntegrals: t('math.paletteHelp.calculus.regionIntegrals'),
  derivativeAt: t('math.paletteHelp.calculus.derivativeAt'),
  infiniteSeries: t('math.paletteHelp.calculus.infiniteSeries'),
  indefiniteIntegral: t('math.paletteHelp.calculus.indefiniteIntegral'),
  closedIntegrals: t('math.paletteHelp.calculus.closedIntegrals'),
} as const;

export const MATH_PALETTE_CALCULUS: readonly MathPaletteCatalogItem[] = [
  item('limit-supremum', 'calculus', t('math.palette.limit-supremum.label'), 'limsup', String.raw`\limsup_{#?\to #?}{#0}`, ['limit-supremum', 'lambda'], t('math.palette.limit-supremum.meaning'), [],
    { domain: t('math.paletteDomain.calculus.limit-supremum'), argumentTypes: ['expression', 'variable', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.limitBounds }),
  item('limit-infimum', 'calculus', t('math.palette.limit-infimum.label'), 'liminf', String.raw`\liminf_{#?\to #?}{#0}`, ['limit-infimum', 'lambda'], t('math.palette.limit-infimum.meaning'), [],
    { domain: t('math.paletteDomain.calculus.limit-infimum'), argumentTypes: ['expression', 'variable', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.limitBounds }),
  item('fourier-series', 'series', t('math.palette.fourier-series.label'), 'fourierseries', String.raw`\operatorname{fourierseries}\left(#0,#?,#?,#?,#?\right)`, ["fourier-series", "lambda"], t('math.palette.fourier-series.meaning'), [],
    { domain: t('math.paletteDomain.calculus.fourier-series'), argumentTypes: ['expression', 'variable', 'real', 'real', 'natural'], resultType: 'fourier-series', method: 'exact-runtime', functionUse: false, help: HELP.fourierSeries }),
  item('fourier-value', 'series', t('math.palette.fourier-value.label'), 'fourierat', String.raw`\operatorname{fourierat}\left(#0,#?\right)`, ["fourier-value"], t('math.palette.fourier-value.meaning'), [],
    { domain: t('math.paletteDomain.calculus.fourier-value'), argumentTypes: ['fourier-series', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.fourierSeries }),
  item('fourier-cosine', 'series', t('math.palette.fourier-cosine.label'), 'fouriercos', String.raw`\operatorname{fouriercos}\left(#0,#?\right)`, ["fourier-cosine"], t('math.palette.fourier-cosine.meaning'), [],
    { domain: t('math.paletteDomain.calculus.fourier-cosine'), argumentTypes: ['fourier-series', 'natural'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.fourierSeries }),
  item('fourier-sine', 'series', t('math.palette.fourier-sine.label'), 'fouriersin', String.raw`\operatorname{fouriersin}\left(#0,#?\right)`, ["fourier-sine"], t('math.palette.fourier-sine.meaning'), [],
    { domain: t('math.paletteDomain.calculus.fourier-sine'), argumentTypes: ['fourier-series', 'natural'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.fourierSeries }),
  item('series-coefficient', 'series', t('math.palette.series-coefficient.label'), 'seriescoefficient', String.raw`\operatorname{seriescoefficient}\left(#0,#?\right)`, ['series-coefficient'], t('math.palette.series-coefficient.meaning'), [],
    { domain: t('math.paletteDomain.calculus.series-coefficient'), argumentTypes: ['series', 'natural'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.seriesCoefficient }),
  item('taylor', 'series', t('math.palette.taylor.label'), 'taylor', String.raw`\operatorname{taylor}\left(#0,#?,#?,#?\right)`, ['taylor'], t('math.palette.taylor.meaning'), [],
    { domain: t('math.paletteDomain.calculus.taylor'), argumentTypes: ['expression', 'variable', 'real', 'natural'], resultType: 'series', method: 'exact-runtime', functionUse: false, help: HELP.taylor }),
  item('maclaurin', 'series', t('math.palette.maclaurin.label'), 'maclaurin', String.raw`\operatorname{maclaurin}\left(#0,#?,#?\right)`, ['maclaurin'], t('math.palette.maclaurin.meaning'), [],
    { domain: t('math.paletteDomain.calculus.maclaurin'), argumentTypes: ['expression', 'variable', 'natural'], resultType: 'series', method: 'exact-runtime', functionUse: false, help: HELP.taylor }),
  item('sequence-value', 'series', t('math.palette.sequence-value.label'), 'sequencevalue', String.raw`\operatorname{sequencevalue}\left(#0,#?,#?\right)`, ['sequence-value'], t('math.palette.sequence-value.meaning'), [],
    { domain: t('math.paletteDomain.calculus.sequence-value'), argumentTypes: ['expression', 'variable', 'integer'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.sequences }),
  item('difference-at', 'series', t('math.palette.difference-at.label'), 'differenceat', String.raw`\operatorname{differenceat}\left(#0,#?,#?,#?,#?\right)`, ['difference-at'], t('math.palette.difference-at.meaning'), [],
    { domain: t('math.paletteDomain.calculus.difference-at'), argumentTypes: ['expression', 'variable', 'integer', 'natural', 'natural'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.sequences }),
  item('recurrence-value', 'series', t('math.palette.recurrence-value.label'), 'recurrencevalue', String.raw`\operatorname{recurrencevalue}\left(#0,#?,#?,#?,#?\right)`, ['recurrence-value'], t('math.palette.recurrence-value.meaning'), [],
    { domain: t('math.paletteDomain.calculus.recurrence-value'), argumentTypes: ['expression', 'variable-list', 'integer', 'list', 'integer'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.sequences }),
  item('svd-u', 'linear-algebra', t('math.palette.svd-u.label'), 'U', String.raw`\operatorname{svdu}\left(#0\right)`, ['svd-u'], t('math.palette.svd-u.meaning'), [],
    { domain: t('math.paletteDomain.calculus.svd-u'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.svd }),
  item('svd-s', 'linear-algebra', t('math.palette.svd-s.label'), 'Σ', String.raw`\operatorname{svds}\left(#0\right)`, ['svd-s'], t('math.palette.svd-s.meaning'), [],
    { domain: t('math.paletteDomain.calculus.svd-s'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.svd }),
  item('svd-v', 'linear-algebra', t('math.palette.svd-v.label'), 'V', String.raw`\operatorname{svdv}\left(#0\right)`, ['svd-v'], t('math.palette.svd-v.meaning'), [],
    { domain: t('math.paletteDomain.calculus.svd-v'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.svd }),
  item('eigenspace', 'linear-algebra', t('math.palette.eigenspace.label'), 'ker(A−λI)', String.raw`\operatorname{eigenspace}\left(#0,#?\right)`, ['eigenspace'], t('math.palette.eigenspace.meaning'), [],
    { domain: t('math.paletteDomain.calculus.eigenspace'), argumentTypes: ['matrix', 'complex'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.eigenspace }),
  item('tensor-product', 'linear-algebra', t('math.palette.tensor-product.label'), 'A⊗B', String.raw`\operatorname{tensorproduct}\left(#0,#?\right)`, ['tensor-product'], t('math.palette.tensor-product.meaning'), [],
    { domain: t('math.paletteDomain.calculus.tensor-product'), argumentTypes: ['tensor', 'tensor'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.tensors }),
  item('hadamard-product', 'linear-algebra', t('math.palette.hadamard-product.label'), 'A⊙B', String.raw`\operatorname{hadamardproduct}\left(#0,#?\right)`, ['hadamard-product'], t('math.palette.hadamard-product.meaning'), [],
    { domain: t('math.paletteDomain.calculus.hadamard-product'), argumentTypes: ['tensor', 'tensor'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.tensors }),
  item('tensor-contract', 'linear-algebra', t('math.palette.tensor-contract.label'), 'ΣTᵢᵢ', String.raw`\operatorname{tensorcontract}\left(#0,#?,#?\right)`, ['tensor-contract'], t('math.palette.tensor-contract.meaning'), [],
    { domain: t('math.paletteDomain.calculus.tensor-contract'), argumentTypes: ['tensor', 'natural', 'natural'], resultType: 'real', method: 'native', functionUse: true, help: HELP.tensors }),
  item('tensor-permute', 'linear-algebra', t('math.palette.tensor-permute.label'), 'Tσ', String.raw`\operatorname{tensorpermute}\left(#0,#?\right)`, ['tensor-permute'], t('math.palette.tensor-permute.meaning'), [],
    { domain: t('math.paletteDomain.calculus.tensor-permute'), argumentTypes: ['tensor', 'vector'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.tensors }),
  item('tensor-shape', 'linear-algebra', t('math.palette.tensor-shape.label'), 'shape(T)', String.raw`\operatorname{tensorshape}\left(#0\right)`, ['tensor-shape'], t('math.palette.tensor-shape.meaning'), [],
    { domain: t('math.paletteDomain.calculus.tensor-shape'), argumentTypes: ['tensor'], resultType: 'vector', method: 'native', functionUse: false, help: HELP.tensors }),
  item('tensor-element', 'linear-algebra', t('math.palette.tensor-element.label'), 'Tᵢⱼₖ', String.raw`\operatorname{tensorelement}\left(#0,#?\right)`, ['tensor-element'], t('math.palette.tensor-element.meaning'), [],
    { domain: t('math.paletteDomain.calculus.tensor-element'), argumentTypes: ['tensor', 'vector'], resultType: 'real', method: 'native', functionUse: true, help: HELP.tensors }),
  item('kronecker-delta', 'linear-algebra', t('math.palette.kronecker-delta.label'), 'δᵢⱼ', String.raw`\operatorname{kroneckerdelta}\left(#0,#?\right)`, ['kronecker-delta'], t('math.palette.kronecker-delta.meaning'), [],
    { domain: t('math.paletteDomain.calculus.kronecker-delta'), argumentTypes: ['integer', 'integer'], resultType: 'real', method: 'native', functionUse: false, help: HELP.tensors }),
  item('levi-civita', 'linear-algebra', t('math.palette.levi-civita.label'), 'εᵢⱼₖ', String.raw`\operatorname{levicivita}\left(#0\right)`, ['levi-civita'], t('math.palette.levi-civita.meaning'), [],
    { domain: t('math.paletteDomain.calculus.levi-civita'), argumentTypes: ['vector'], resultType: 'real', method: 'native', functionUse: false, help: HELP.tensors }),
  item('singular-values', 'linear-algebra', t('math.palette.singular-values.label'), 'σ', String.raw`\operatorname{singularvalues}\left(#0\right)`, ['singular-values'], t('math.palette.singular-values.meaning'), [],
    { domain: t('math.paletteDomain.calculus.singular-values'), argumentTypes: ['matrix'], resultType: 'vector', method: 'native', functionUse: false, help: HELP.singularValues }),
  item('eigenvalues', 'linear-algebra', t('math.palette.eigenvalues.label'), 'λ', String.raw`\operatorname{eigenvalues}\left(#0\right)`, ['eigenvalues'], t('math.palette.eigenvalues.meaning'), [],
    { domain: t('math.paletteDomain.calculus.eigenvalues'), argumentTypes: ['matrix'], resultType: 'vector', method: 'native', functionUse: false, help: HELP.eigenvalues }),
  item('row-reduce', 'linear-algebra', t('math.palette.row-reduce.label'), 'rref', String.raw`\operatorname{rowreduce}\left(#0\right)`, ['row-reduce'], t('math.palette.row-reduce.meaning'), [],
    { domain: t('math.paletteDomain.calculus.row-reduce'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  item('qr-q', 'linear-algebra', t('math.palette.qr-q.label'), 'Q', String.raw`\operatorname{qrq}\left(#0\right)`, ['qr-q'], t('math.palette.qr-q.meaning'), [],
    { domain: t('math.paletteDomain.calculus.qr-q'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.qr }),
  item('qr-r', 'linear-algebra', t('math.palette.qr-r.label'), 'R', String.raw`\operatorname{qrr}\left(#0\right)`, ['qr-r'], t('math.palette.qr-r.meaning'), [],
    { domain: t('math.paletteDomain.calculus.qr-r'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.qr }),
  item('lu-p', 'linear-algebra', t('math.palette.lu-p.label'), 'P', String.raw`\operatorname{lup}\left(#0\right)`, ['lu-p'], t('math.palette.lu-p.meaning'), [],
    { domain: t('math.paletteDomain.calculus.lu-p'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.lu }),
  item('lu-l', 'linear-algebra', t('math.palette.lu-l.label'), 'L', String.raw`\operatorname{lul}\left(#0\right)`, ['lu-l'], t('math.palette.lu-l.meaning'), [],
    { domain: t('math.paletteDomain.calculus.lu-l'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.lu }),
  item('lu-u', 'linear-algebra', t('math.palette.lu-u.label'), 'U', String.raw`\operatorname{luu}\left(#0\right)`, ['lu-u'], t('math.palette.lu-u.meaning'), [],
    { domain: t('math.paletteDomain.calculus.lu-u'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.lu }),
  item('characteristic-coefficients', 'linear-algebra', t('math.palette.characteristic-coefficients.label'), 'det(tI−A)', String.raw`\operatorname{characteristiccoefficients}\left(#0\right)`, ['characteristic-coefficients'], t('math.palette.characteristic-coefficients.meaning'), [],
    { domain: t('math.paletteDomain.calculus.characteristic-coefficients'), argumentTypes: ['matrix'], resultType: 'vector', method: 'native', functionUse: false, help: HELP.characteristic }),
  item('null-space', 'linear-algebra', t('math.palette.null-space.label'), 'ker A', String.raw`\operatorname{nullspace}\left(#0\right)`, ['null-space'], t('math.palette.null-space.meaning'), [],
    { domain: t('math.paletteDomain.calculus.null-space'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  item('column-space', 'linear-algebra', t('math.palette.column-space.label'), 'col A', String.raw`\operatorname{columnspace}\left(#0\right)`, ['column-space'], t('math.palette.column-space.meaning'), [],
    { domain: t('math.paletteDomain.calculus.column-space'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  item('row-space', 'linear-algebra', t('math.palette.row-space.label'), 'row A', String.raw`\operatorname{rowspace}\left(#0\right)`, ['row-space'], t('math.palette.row-space.meaning'), [],
    { domain: t('math.paletteDomain.calculus.row-space'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  item('linear-solve', 'linear-algebra', t('math.palette.linear-solve.label'), 'Ax=b', String.raw`\operatorname{linearsolve}\left(#0,#?\right)`, ['linear-solve'], t('math.palette.linear-solve.meaning'), [],
    { domain: t('math.paletteDomain.calculus.linear-solve'), argumentTypes: ['matrix', 'vector'], resultType: 'vector', method: 'native', functionUse: false, help: HELP.linear }),
  item('linear-solution-space', 'linear-algebra', t('math.palette.linear-solution-space.label'), 'x₀+Σtᵢvᵢ', String.raw`\operatorname{linearsolutionspace}\left(#0,#?\right)`, ['linear-solution-space'], t('math.palette.linear-solution-space.meaning'), [],
    { domain: t('math.paletteDomain.calculus.linear-solution-space'), argumentTypes: ['matrix', 'vector'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  item('component', 'linear-algebra', t('math.palette.component.label'), 'Aᵢⱼ', String.raw`\operatorname{component}\left(#0,#?,#?\right)`, ['component'], t('math.palette.component.meaning'), [t('math.palette.component.keyword0'), t('math.palette.component.keyword1'), t('math.palette.component.keyword2'), t('math.palette.component.keyword3')],
    { domain: t('math.paletteDomain.calculus.component'), argumentTypes: ['matrix', 'natural', 'natural'], resultType: 'real', method: 'native', functionUse: true, help: HELP.paletteArguments }),
  item('sum', 'series', t('math.palette.sum.label'), 'Σ', String.raw`\sum_{i=1}^{#?}{#0}`, ['sum'], t('math.palette.sum.meaning'), [t('math.palette.sum.keyword0'), t('math.palette.sum.keyword1')],
    { domain: t('math.paletteDomain.calculus.sum'), argumentTypes: ['expression', 'integer'], resultType: 'real', method: 'native', functionUse: false, help: HELP.sums }),
  item('product', 'series', t('math.palette.product.label'), '∏', String.raw`\prod_{i=1}^{#?}{#0}`, ['product'], t('math.palette.product.meaning'), [t('math.palette.product.keyword0')],
    { domain: t('math.paletteDomain.calculus.product'), argumentTypes: ['expression', 'integer'], resultType: 'real', method: 'native', functionUse: false, help: HELP.sums }),
  item('integral', 'calculus', t('math.palette.integral.label'), '∫', String.raw`\int_{#?}^{#?}{#0}\,\mathrm{d}x`, ['integrate'], t('math.palette.integral.meaning'), [t('math.palette.integral.keyword0'), t('math.palette.integral.keyword1')],
    { domain: t('math.paletteDomain.calculus.integral'), argumentTypes: ['expression', 'real', 'real'], resultType: 'real', method: 'native', functionUse: false, help: HELP.integrals }),
  // MC-19b (Q4=A): plain D differentiates with respect to an existing plotting variable or a differential
  // problem's independent variable and never binds a free name; a standalone value uses derivative-at.
  // Both are published with plotting examples whose values the geometry runtime samples (mathPaletteCalculusExamples.ts).
  item('derivative', 'calculus', t('math.palette.derivative.label'), 'd/dx', String.raw`\frac{\mathrm{d}}{\mathrm{d}#?}{#0}`, ['differentiate'], t('math.palette.derivative.meaning'), [t('math.palette.derivative.keyword0'), t('math.palette.derivative.keyword1')],
    { domain: t('math.paletteDomain.calculus.derivative'), argumentTypes: ['expression', 'variable'], resultType: 'real', method: 'native', functionUse: true, help: HELP.derivatives }),
  item('partial', 'calculus', t('math.palette.partial.label'), '∂/∂x', String.raw`\frac{\partial}{\partial #?}{#0}`, ['differentiate'], t('math.palette.partial.meaning'), [t('math.palette.partial.keyword0')],
    { domain: t('math.paletteDomain.calculus.partial'), argumentTypes: ['expression', 'variable'], resultType: 'real', method: 'native', functionUse: true, help: HELP.derivatives }),
  item('limit', 'calculus', t('math.palette.limit.label'), 'lim', String.raw`\lim_{x\to #?}{#0}`, ['limit'], t('math.palette.limit.meaning'), [t('math.palette.limit.keyword0')],
    { domain: t('math.paletteDomain.calculus.limit'), argumentTypes: ['expression', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.limits }),
  item('matrix', 'linear-algebra', t('math.palette.matrix.label'), '[A]', String.raw`\begin{pmatrix}#?&#?\\#?&#?\end{pmatrix}`, ['matrix', 'list'], t('math.palette.matrix.meaning'), [t('math.palette.matrix.keyword0'), t('math.palette.matrix.keyword1')],
    { domain: t('math.paletteDomain.calculus.matrix'), argumentTypes: ['real', 'real', 'real', 'real'], resultType: 'matrix', method: 'native', functionUse: false, help: HELP.linear }),
  // determinant: exactRuntime/cas_input.py computes it (matrix.det() via SymPy); the native box has no handler and
  // leaves a bare Determinant node, decoding to unresolved/unevaluated. method corrected from the prior draft's
  // 'native' (never verified: this item had no example, like the other 12 in ADD-17-15's "13 unpublished" count).
  item('determinant', 'linear-algebra', t('math.palette.determinant.label'), 'det', String.raw`\det\left(#0\right)`, ['determinant'], t('math.palette.determinant.meaning'), [t('math.palette.determinant.keyword0')],
    { domain: t('math.paletteDomain.calculus.determinant'), argumentTypes: ['matrix'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  // Exact vector products share the validated matrix runtime.
  item('dot', 'linear-algebra', t('math.palette.dot.label'), 'a·b', String.raw`#0\cdot #?`, ['dot'], t('math.palette.dot.meaning'), [t('math.palette.dot.keyword0')],
    { domain: t('math.paletteDomain.calculus.dot'), argumentTypes: ['vector', 'vector'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.paletteArguments }),
  item('cross', 'linear-algebra', t('math.palette.cross.label'), 'a×b', String.raw`#0\times #?`, ['cross'], t('math.palette.cross.meaning'), [t('math.palette.cross.keyword0')],
    { domain: t('math.paletteDomain.calculus.cross'), argumentTypes: ['vector', 'vector'], resultType: 'vector', method: 'exact-runtime', functionUse: false, help: HELP.paletteArguments }),
  // MC-02b: matrix basics (transpose・adjoint・inverse・trace・rank), registered but previously absent from the
  // catalog. Like determinant, transpose/conjugate-transpose/inverse-matrix/trace are computed by
  // exactRuntime/cas_input.py (matrix.T/.H/.inv()/.trace()); only rank has a native fast path (reduceExactMatrixRank
  // in exactMatrixOperation.ts, invoked from prepareMathCalculation.ts before the generic engine runs).
  item('transpose', 'linear-algebra', t('math.palette.transpose.label'), 'Aᵀ', String.raw`\operatorname{transpose}\left(#0\right)`, ['transpose'], t('math.palette.transpose.meaning'), [],
    { domain: t('math.paletteDomain.calculus.transpose'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  item('conjugate-transpose', 'linear-algebra', t('math.palette.conjugate-transpose.label'), 'Aᴴ', String.raw`\operatorname{conjugatetranspose}\left(#0\right)`, ['conjugate-transpose'], t('math.palette.conjugate-transpose.meaning'), [t('math.palette.conjugate-transpose.keyword0')],
    { domain: t('math.paletteDomain.calculus.conjugate-transpose'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  item('inverse-matrix', 'linear-algebra', t('math.palette.inverse-matrix.label'), 'A⁻¹', String.raw`\operatorname{inverse}\left(#0\right)`, ['inverse-matrix'], t('math.palette.inverse-matrix.meaning'), [t('math.palette.inverse-matrix.keyword0')],
    { domain: t('math.paletteDomain.calculus.inverse-matrix'), argumentTypes: ['matrix'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  item('trace', 'linear-algebra', t('math.palette.trace.label'), 'tr A', String.raw`\operatorname{trace}\left(#0\right)`, ['trace'], t('math.palette.trace.meaning'), [],
    { domain: t('math.paletteDomain.calculus.trace'), argumentTypes: ['matrix'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  item('rank', 'linear-algebra', t('math.palette.rank.label'), 'rank A', String.raw`\operatorname{rank}\left(#0\right)`, ['rank'], t('math.palette.rank.meaning'), [],
    { domain: t('math.paletteDomain.calculus.rank'), argumentTypes: ['matrix'], resultType: 'real', method: 'native', functionUse: false, help: HELP.linear }),
  item('norm', 'linear-algebra', t('math.palette.norm.label'), '‖v‖', String.raw`\operatorname{norm}\left(#0\right)`, ['norm'], t('math.palette.norm.meaning'), [],
    { domain: t('math.paletteDomain.calculus.norm'), argumentTypes: ['vector'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.paletteArguments }),
  // MC-02b: vector calculus at an explicit point (usable directly in the coordinate/coefficient fields).
  item('gradient-at', 'calculus', t('math.palette.gradient-at.label'), '∇f(p)', String.raw`\operatorname{gradientat}\left(#0,#?,#?\right)`, ['gradient-at'], t('math.palette.gradient-at.meaning'), [t('math.palette.gradient-at.keyword0')],
    { domain: t('math.paletteDomain.calculus.gradient-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'vector', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  item('divergence-at', 'calculus', t('math.palette.divergence-at.label'), '∇·F(p)', String.raw`\operatorname{divergenceat}\left(#0,#?,#?\right)`, ['divergence-at'], t('math.palette.divergence-at.meaning'), [t('math.palette.divergence-at.keyword0')],
    { domain: t('math.paletteDomain.calculus.divergence-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  item('curl-at', 'calculus', t('math.palette.curl-at.label'), '∇×F(p)', String.raw`\operatorname{curlat}\left(#0,#?,#?\right)`, ['curl-at'], t('math.palette.curl-at.meaning'), [],
    { domain: t('math.paletteDomain.calculus.curl-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'vector', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  item('laplacian-at', 'calculus', t('math.palette.laplacian-at.label'), '∇²f(p)', String.raw`\operatorname{laplacianat}\left(#0,#?,#?\right)`, ['laplacian-at'], t('math.palette.laplacian-at.meaning'), [],
    { domain: t('math.paletteDomain.calculus.laplacian-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  item('jacobian-at', 'calculus', t('math.palette.jacobian-at.label'), 'J(p)', String.raw`\operatorname{jacobianat}\left(#0,#?,#?\right)`, ['jacobian-at'], t('math.palette.jacobian-at.meaning'), [],
    { domain: t('math.paletteDomain.calculus.jacobian-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  item('hessian-at', 'calculus', t('math.palette.hessian-at.label'), 'H(p)', String.raw`\operatorname{hessianat}\left(#0,#?,#?\right)`, ['hessian-at'], t('math.palette.hessian-at.meaning'), [],
    { domain: t('math.paletteDomain.calculus.hessian-at'), argumentTypes: ['expression', 'variable-list', 'list'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  // MC-02b: vector calculus for function curves/surfaces only (X・Y・Z・T・U・V). No coordinate-field example exists;
  // The six function forms need explicit axis/parameter roles. MC-03b supplies that scope and
  // verifies actual component values in the geometry runtime before publishing their examples.
  item('gradient', 'calculus', t('math.palette.gradient.label'), '∇f', String.raw`\operatorname{gradient}\left(#0,#?\right)`, ['gradient'], t('math.palette.gradient.meaning'), [t('math.palette.gradient.keyword0')],
    { domain: t('math.paletteDomain.calculus.gradient'), argumentTypes: ['expression', 'variable-list'], resultType: 'vector', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  item('divergence', 'calculus', t('math.palette.divergence.label'), '∇·F', String.raw`\operatorname{divergence}\left(#0,#?\right)`, ['divergence'], t('math.palette.divergence.meaning'), [t('math.palette.divergence.keyword0')],
    { domain: t('math.paletteDomain.calculus.divergence'), argumentTypes: ['expression', 'variable-list'], resultType: 'real', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  item('curl', 'calculus', t('math.palette.curl.label'), '∇×F', String.raw`\operatorname{curl}\left(#0,#?\right)`, ['curl'], t('math.palette.curl.meaning'), [],
    { domain: t('math.paletteDomain.calculus.curl'), argumentTypes: ['expression', 'variable-list'], resultType: 'vector', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  item('laplacian', 'calculus', t('math.palette.laplacian.label'), '∇²f', String.raw`\operatorname{laplacian}\left(#0,#?\right)`, ['laplacian'], t('math.palette.laplacian.meaning'), [],
    { domain: t('math.paletteDomain.calculus.laplacian'), argumentTypes: ['expression', 'variable-list'], resultType: 'real', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  item('jacobian', 'calculus', t('math.palette.jacobian.label'), 'J', String.raw`\operatorname{jacobian}\left(#0,#?\right)`, ['jacobian'], t('math.palette.jacobian.meaning'), [],
    { domain: t('math.paletteDomain.calculus.jacobian'), argumentTypes: ['expression', 'variable-list'], resultType: 'matrix', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  item('hessian', 'calculus', t('math.palette.hessian.label'), 'H', String.raw`\operatorname{hessian}\left(#0,#?\right)`, ['hessian'], t('math.palette.hessian.meaning'), [],
    { domain: t('math.paletteDomain.calculus.hessian'), argumentTypes: ['expression', 'variable-list'], resultType: 'matrix', method: 'native', functionUse: true, help: HELP.vectorCalculus }),
  // MC-02b: line/surface/volume integrals, circulation and flux.
  item('line-integral', 'calculus', t('math.palette.line-integral.label'), '∫C f ds', String.raw`\operatorname{lineintegral}\left(#0,#?,#?,#?,#?,#?\right)`, ['line-integral'], t('math.palette.line-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.line-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable', 'real', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.lineIntegrals }),
  item('circulation', 'calculus', t('math.palette.circulation.label'), '∮C F·dr', String.raw`\operatorname{circulation}\left(#0,#?,#?,#?,#?,#?\right)`, ['circulation'], t('math.palette.circulation.meaning'), [],
    { domain: t('math.paletteDomain.calculus.circulation'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable', 'real', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.lineIntegrals }),
  item('surface-integral', 'calculus', t('math.palette.surface-integral.label'), '∬S f dS', String.raw`\operatorname{surfaceintegral}\left(#0,#?,#?,#?,#?,#?\right)`, ['surface-integral'], t('math.palette.surface-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.surface-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable-list', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.regionIntegrals }),
  item('flux-integral', 'calculus', t('math.palette.flux-integral.label'), '∬S F·dS', String.raw`\operatorname{fluxintegral}\left(#0,#?,#?,#?,#?,#?\right)`, ['flux-integral'], t('math.palette.flux-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.flux-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable-list', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.regionIntegrals }),
  item('volume-integral', 'calculus', t('math.palette.volume-integral.label'), '∭V f dV', String.raw`\operatorname{volumeintegral}\left(#0,#?,#?,#?,#?,#?\right)`, ['volume-integral'], t('math.palette.volume-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.volume-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable-list', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.regionIntegrals }),
  // MC-02e (MC-19d): closed line/surface integrals, calculated only after closedIntegrals.ts proves the
  // parametrized curve/surface is closed (confirmed by closedIntegrals.test.ts's own analytic values).
  // MC-04b (2026-09-24, real check): structural input uses \oint\left(...\right) / \oiint\left(...\right)
  // directly. parseMathLatex.ts's CLOSED_INTEGRALS branch accepts \oint(/\oiint( followed by an argument
  // list; \left/\right are spacing tokens the tokenizer drops (mathLatexTokens.ts), so \oint\left(...\right)
  // reaches that branch exactly like \oint(...). Confirmed both by closedIntegrals.test.ts's own round trip
  // (\oint\left(/\oiint\left( serialization re-parses to the same meaning) and by this file's own examples
  // (below) re-evaluating to the same analytic values through this template via mathPaletteExamples.test.ts.
  // \oint dispatches to closed-line-integral or closed-circulation (and \oiint likewise) by whether the field
  // argument is an explicit vector (closedIntegralHead in lineIntegrals.ts), so both share this template.
  item('closed-line-integral', 'calculus', t('math.palette.closed-line-integral.label'), '∮ f ds', String.raw`\oint\left(#0,#?,#?,#?,#?,#?\right)`, ['closed-line-integral'], t('math.palette.closed-line-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.closed-line-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable', 'real', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.closedIntegrals }),
  item('closed-circulation', 'calculus', t('math.palette.closed-circulation.label'), '∮ F·dr', String.raw`\oint\left(#0,#?,#?,#?,#?,#?\right)`, ['closed-circulation'], t('math.palette.closed-circulation.meaning'), [],
    { domain: t('math.paletteDomain.calculus.closed-circulation'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable', 'real', 'real'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.closedIntegrals }),
  item('closed-surface-integral', 'calculus', t('math.palette.closed-surface-integral.label'), '∯ f dS', String.raw`\oiint\left(#0,#?,#?,#?,#?,#?\right)`, ['closed-surface-integral'], t('math.palette.closed-surface-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.closed-surface-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable-list', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.closedIntegrals }),
  item('closed-flux-integral', 'calculus', t('math.palette.closed-flux-integral.label'), '∯ F·dS', String.raw`\oiint\left(#0,#?,#?,#?,#?,#?\right)`, ['closed-flux-integral'], t('math.palette.closed-flux-integral.meaning'), [],
    { domain: t('math.paletteDomain.calculus.closed-flux-integral'), argumentTypes: ['expression', 'variable-list', 'expression', 'variable-list', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.closedIntegrals }),
  // MC-02b: value at a specified point, of a specified differentiation order. requiresExactCalculus()
  // (mathExactCalculus.ts) lists 'differentiate-at' explicitly, so this always resolves via exact-runtime.
  item('derivative-at', 'calculus', t('math.palette.derivative-at.label'), 'f⁽ⁿ⁾(a)', String.raw`\operatorname{derivativeat}\left(#0,#?,#?,#?\right)`, ['differentiate-at'], t('math.palette.derivative-at.meaning'), [t('math.palette.derivative-at.keyword0')],
    { domain: t('math.paletteDomain.calculus.derivative-at'), argumentTypes: ['expression', 'variable', 'real', 'natural'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.derivativeAt }),
  // MC-02b: infinite sums/products (the existing sum/product items only carry finite-range examples).
  item('infinite-sum', 'series', t('math.palette.infinite-sum.label'), 'Σ_{k=1}^∞', String.raw`\sum_{k=1}^{\infty}{#0}`, ['sum'], t('math.palette.infinite-sum.meaning'), [],
    { domain: t('math.paletteDomain.calculus.infinite-sum'), argumentTypes: ['expression'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.infiniteSeries }),
  item('infinite-product', 'series', t('math.palette.infinite-product.label'), 'Π_{k=1}^∞', String.raw`\prod_{k=1}^{\infty}{#0}`, ['product'], t('math.palette.infinite-product.meaning'), [],
    { domain: t('math.paletteDomain.calculus.infinite-product'), argumentTypes: ['expression'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.infiniteSeries }),
  // MC-02d (MC-16): exact vector projection, sharing the validated matrix runtime like dot/cross/norm.
  item('projection', 'linear-algebra', t('math.palette.projection.label'), 'proj', String.raw`\operatorname{projection}\left(#0,#?\right)`, ['projection'], t('math.palette.projection.meaning'), [t('math.palette.projection.keyword0')],
    { domain: t('math.paletteDomain.calculus.projection'), argumentTypes: ['vector', 'vector'], resultType: 'vector', method: 'exact-runtime', functionUse: false, help: HELP.paletteArguments }),
  // MC-02d (MC-18): fixed-size identity/zero matrix constructors.
  item('identity-matrix', 'linear-algebra', t('math.palette.identity-matrix.label'), 'I', String.raw`\operatorname{identitymatrix}\left(#0\right)`, ['identity-matrix'], t('math.palette.identity-matrix.meaning'), [t('math.palette.identity-matrix.keyword0')],
    { domain: t('math.paletteDomain.calculus.identity-matrix'), argumentTypes: ['natural'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  item('zero-matrix', 'linear-algebra', t('math.palette.zero-matrix.label'), '0', String.raw`\operatorname{zeromatrix}\left(#0,#?\right)`, ['zero-matrix'], t('math.palette.zero-matrix.meaning'), [t('math.palette.zero-matrix.keyword0')],
    { domain: t('math.paletteDomain.calculus.zero-matrix'), argumentTypes: ['natural', 'natural'], resultType: 'matrix', method: 'exact-runtime', functionUse: false, help: HELP.linear }),
  // MC-02d (MC-30/MC-31b): total differential at an explicit point, lowered into gradient-at's components dot the
  // increments. The nested Function(...) call is a literal value (this operation's own operand, not an auto-wrap).
  item('total-differential-at', 'calculus', t('math.palette.total-differential-at.label'), 'df(p)', String.raw`\operatorname{totaldifferentialat}\left(\operatorname{Function}\left(#0,#?,#?\right),#?,#?\right)`, ['total-differential-at'], t('math.palette.total-differential-at.meaning'), [t('math.palette.total-differential-at.keyword0')],
    { domain: t('math.paletteDomain.calculus.total-differential-at'), argumentTypes: ['expression', 'variable', 'variable', 'list', 'list'], resultType: 'real', method: 'exact-runtime', functionUse: false, help: HELP.vectorCalculusAt }),
  // MC-04c: integrate(f,x) with no bound (structural: \int{f}\,\mathrm{d}x with no _/^ range, confirmed accepted by
  // exactIndefiniteIntegrals.test.ts:117-123). The answer is the antiderivative family F+C (mathIndefiniteIntegralResult
  // .test.ts): the exact runtime finds a closed-form primitive and proves it by differentiating it back, delivered as
  // a 'function' lambda over the integral's own variable (MC-20). 'antiderivative' (mathPaletteGroups.ts) keeps this
  // distinct from an ordinary mapping's 'function' result. Never usable in coordinates/components/coefficients or
  // function plots because the constant C is never determined; a definite integral (existing 'integral' item) or a
  // written-out antiderivative with a chosen constant is required there instead.
  item('indefinite-integral', 'calculus', t('math.palette.indefinite-integral.label'), '∫f dx', String.raw`\int{#0}\,\mathrm{d}#?`, ['integrate'], t('math.palette.indefinite-integral.meaning'), [t('math.palette.indefinite-integral.keyword0'), t('math.palette.indefinite-integral.keyword1')],
    { domain: t('math.paletteDomain.calculus.indefinite-integral'), argumentTypes: ['expression', 'variable'], resultType: 'antiderivative', method: 'exact-runtime', functionUse: false, help: HELP.indefiniteIntegral }),
];
