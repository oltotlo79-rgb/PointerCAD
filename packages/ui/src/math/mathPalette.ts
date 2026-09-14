import { t } from '../i18n/t.js';
/** The future palette/help catalogue starts from the same entries; activation requires acceptance IDs. */
export type MathPaletteGroup = 'basic' | 'functions' | 'calculus' | 'linear-algebra' | 'complex'
  | 'series' | 'statistics' | 'sets-logic' | 'equations' | 'symbols';
export interface MathPaletteItem {
  readonly id: string;
  readonly group: MathPaletteGroup;
  readonly label: string;
  readonly symbol: string;
  readonly template: string;
  readonly keywords: readonly string[];
  readonly requiredOperations: readonly string[];
  readonly acceptanceIds: readonly string[];
  readonly meaning: string;
}

function item(id: string, group: MathPaletteGroup, label: string, symbol: string, template: string,
  operations: readonly string[], meaning: string, keywords: readonly string[] = []): MathPaletteItem {
  // Empty acceptanceIds intentionally prevents a draft entry from claiming tested availability.
  return { id, group, label, symbol, template, requiredOperations: operations, acceptanceIds: [], meaning, keywords };
}
export const MATH_PALETTE_DRAFT: readonly MathPaletteItem[] = [
  item('svd-u', 'linear-algebra', t('math.palette.svd-u.label'), 'U', String.raw`\operatorname{svdu}\left(#0\right)`, ['svd-u'], t('math.palette.svd-u.meaning')),
  item('svd-s', 'linear-algebra', t('math.palette.svd-s.label'), 'Σ', String.raw`\operatorname{svds}\left(#0\right)`, ['svd-s'], t('math.palette.svd-s.meaning')),
  item('svd-v', 'linear-algebra', t('math.palette.svd-v.label'), 'V', String.raw`\operatorname{svdv}\left(#0\right)`, ['svd-v'], t('math.palette.svd-v.meaning')),
  item('eigenspace', 'linear-algebra', t('math.palette.eigenspace.label'), 'ker(A−λI)', String.raw`\operatorname{eigenspace}\left(#0,#?\right)`, ['eigenspace'], t('math.palette.eigenspace.meaning')),
  item('tensor-product', 'linear-algebra', t('math.palette.tensor-product.label'), 'A⊗B', String.raw`\operatorname{tensorproduct}\left(#0,#?\right)`, ['tensor-product'], t('math.palette.tensor-product.meaning')),
  item('hadamard-product', 'linear-algebra', t('math.palette.hadamard-product.label'), 'A⊙B', String.raw`\operatorname{hadamardproduct}\left(#0,#?\right)`, ['hadamard-product'], t('math.palette.hadamard-product.meaning')),
  item('tensor-contract', 'linear-algebra', t('math.palette.tensor-contract.label'), 'ΣTᵢᵢ', String.raw`\operatorname{tensorcontract}\left(#0,#?,#?\right)`, ['tensor-contract'], t('math.palette.tensor-contract.meaning')),
  item('tensor-permute', 'linear-algebra', t('math.palette.tensor-permute.label'), 'Tσ', String.raw`\operatorname{tensorpermute}\left(#0,#?\right)`, ['tensor-permute'], t('math.palette.tensor-permute.meaning')),
  item('tensor-shape', 'linear-algebra', t('math.palette.tensor-shape.label'), 'shape(T)', String.raw`\operatorname{tensorshape}\left(#0\right)`, ['tensor-shape'], t('math.palette.tensor-shape.meaning')),
  item('tensor-element', 'linear-algebra', t('math.palette.tensor-element.label'), 'Tᵢⱼₖ', String.raw`\operatorname{tensorelement}\left(#0,#?\right)`, ['tensor-element'], t('math.palette.tensor-element.meaning')),
  item('kronecker-delta', 'linear-algebra', t('math.palette.kronecker-delta.label'), 'δᵢⱼ', String.raw`\operatorname{kroneckerdelta}\left(#0,#?\right)`, ['kronecker-delta'], t('math.palette.kronecker-delta.meaning')),
  item('levi-civita', 'linear-algebra', t('math.palette.levi-civita.label'), 'εᵢⱼₖ', String.raw`\operatorname{levicivita}\left(#0\right)`, ['levi-civita'], t('math.palette.levi-civita.meaning')),
  item('integer-quotient', 'basic', t('math.palette.integer-quotient.label'), 'q', String.raw`\operatorname{integerquotient}\left(#0,#?\right)`, ['integer-quotient'], t('math.palette.integer-quotient.meaning')),
  item('integer-remainder', 'basic', t('math.palette.integer-remainder.label'), 'r', String.raw`\operatorname{integerremainder}\left(#0,#?\right)`, ['integer-remainder'], t('math.palette.integer-remainder.meaning')),
  item('divides', 'sets-logic', t('math.palette.divides.label'), 'a|b', String.raw`\operatorname{divides}\left(#0,#?\right)`, ['divides'], t('math.palette.divides.meaning')),
  item('congruent-modulo', 'sets-logic', t('math.palette.congruent-modulo.label'), 'a≡b (mod m)', String.raw`\operatorname{congruentmodulo}\left(#0,#?,#?\right)`, ['congruent-modulo'], t('math.palette.congruent-modulo.meaning')),
  item('is-prime', 'sets-logic', t('math.palette.is-prime.label'), 'prime?', String.raw`\operatorname{isprime}\left(#0\right)`, ['is-prime'], t('math.palette.is-prime.meaning')),
  item('next-prime', 'basic', t('math.palette.next-prime.label'), 'next prime', String.raw`\operatorname{nextprime}\left(#0\right)`, ['next-prime'], t('math.palette.next-prime.meaning')),
  item('prime-factors', 'basic', t('math.palette.prime-factors.label'), 'n=∏pᵏ', String.raw`\operatorname{primefactors}\left(#0\right)`, ['prime-factors'], t('math.palette.prime-factors.meaning')),
  item('divisors', 'basic', t('math.palette.divisors.label'), 'd|n', String.raw`\operatorname{divisors}\left(#0\right)`, ['divisors'], t('math.palette.divisors.meaning')),
  item('euler-totient', 'basic', t('math.palette.euler-totient.label'), 'φ(n)', String.raw`\operatorname{eulertotient}\left(#0\right)`, ['euler-totient'], t('math.palette.euler-totient.meaning')),
  item('singular-values', 'linear-algebra', t('math.palette.singular-values.label'), 'σ', String.raw`\operatorname{singularvalues}\left(#0\right)`, ['singular-values'], t('math.palette.singular-values.meaning')),
  item('eigenvalues', 'linear-algebra', t('math.palette.eigenvalues.label'), 'λ', String.raw`\operatorname{eigenvalues}\left(#0\right)`, ['eigenvalues'], t('math.palette.eigenvalues.meaning')),
  item('row-reduce', 'linear-algebra', t('math.palette.row-reduce.label'), 'rref', String.raw`\operatorname{rowreduce}\left(#0\right)`, ['row-reduce'], t('math.palette.row-reduce.meaning')),
  item('qr-q', 'linear-algebra', t('math.palette.qr-q.label'), 'Q', String.raw`\operatorname{qrq}\left(#0\right)`, ['qr-q'], t('math.palette.qr-q.meaning')),
  item('qr-r', 'linear-algebra', t('math.palette.qr-r.label'), 'R', String.raw`\operatorname{qrr}\left(#0\right)`, ['qr-r'], t('math.palette.qr-r.meaning')),
  item('lu-p', 'linear-algebra', t('math.palette.lu-p.label'), 'P', String.raw`\operatorname{lup}\left(#0\right)`, ['lu-p'], t('math.palette.lu-p.meaning')),
  item('lu-l', 'linear-algebra', t('math.palette.lu-l.label'), 'L', String.raw`\operatorname{lul}\left(#0\right)`, ['lu-l'], t('math.palette.lu-l.meaning')),
  item('lu-u', 'linear-algebra', t('math.palette.lu-u.label'), 'U', String.raw`\operatorname{luu}\left(#0\right)`, ['lu-u'], t('math.palette.lu-u.meaning')),
  item('characteristic-coefficients', 'linear-algebra', t('math.palette.characteristic-coefficients.label'), 'det(tI−A)', String.raw`\operatorname{characteristiccoefficients}\left(#0\right)`, ['characteristic-coefficients'], t('math.palette.characteristic-coefficients.meaning')),
  item('null-space', 'linear-algebra', t('math.palette.null-space.label'), 'ker A', String.raw`\operatorname{nullspace}\left(#0\right)`, ['null-space'], t('math.palette.null-space.meaning')),
  item('column-space', 'linear-algebra', t('math.palette.column-space.label'), 'col A', String.raw`\operatorname{columnspace}\left(#0\right)`, ['column-space'], t('math.palette.column-space.meaning')),
  item('row-space', 'linear-algebra', t('math.palette.row-space.label'), 'row A', String.raw`\operatorname{rowspace}\left(#0\right)`, ['row-space'], t('math.palette.row-space.meaning')),
  item('linear-solve', 'linear-algebra', t('math.palette.linear-solve.label'), 'Ax=b', String.raw`\operatorname{linearsolve}\left(#0,#?\right)`, ['linear-solve'], t('math.palette.linear-solve.meaning')),
  item('linear-solution-space', 'linear-algebra', t('math.palette.linear-solution-space.label'), 'x₀+Σtᵢvᵢ', String.raw`\operatorname{linearsolutionspace}\left(#0,#?\right)`, ['linear-solution-space'], t('math.palette.linear-solution-space.meaning')),
  item('reciprocal', 'basic', t('math.palette.reciprocal.label'), '1/x', String.raw`\operatorname{reciprocal}\left(#0\right)`, ['reciprocal'], t('math.palette.reciprocal.meaning'), [t('math.palette.reciprocal.keyword0'), t('math.palette.reciprocal.keyword1')]),
  item('double-factorial', 'basic', t('math.palette.double-factorial.label'), 'n!!', String.raw`{#0}!!`, ['double-factorial'], t('math.palette.double-factorial.meaning')),
  item('permutations', 'basic', t('math.palette.permutations.label'), 'nPr', String.raw`\operatorname{permutations}\left(#0,#?\right)`, ['permutations'], t('math.palette.permutations.meaning'), [t('math.palette.permutations.keyword0'), t('math.palette.permutations.keyword1')]),
  item('clamp', 'basic', t('math.palette.clamp.label'), 'clamp', String.raw`\operatorname{clamp}\left(#0,#?,#?\right)`, ['clamp'], t('math.palette.clamp.meaning')),
  item('arccot', 'functions', t('math.palette.arccot.label'), 'arccot', String.raw`\operatorname{arccot}\left(#0\right)`, ['arccot'], t('math.palette.arccot.meaning'), [t('math.palette.arccot.keyword0'), t('math.palette.arccot.keyword1')]),
  item('arcsec', 'functions', t('math.palette.arcsec.label'), 'arcsec', String.raw`\operatorname{arcsec}\left(#0\right)`, ['arcsec'], t('math.palette.arcsec.meaning'), [t('math.palette.arcsec.keyword0'), t('math.palette.arcsec.keyword1')]),
  item('arccsc', 'functions', t('math.palette.arccsc.label'), 'arccsc', String.raw`\operatorname{arccsc}\left(#0\right)`, ['arccsc'], t('math.palette.arccsc.meaning'), [t('math.palette.arccsc.keyword0'), t('math.palette.arccsc.keyword1')]),
  item('atan2', 'functions', t('math.palette.atan2.label'), 'atan2(y,x)', String.raw`\operatorname{arctan2}\left(#0,#?\right)`, ['arctan-two'], t('math.palette.atan2.meaning'), [t('math.palette.atan2.keyword0'), t('math.palette.atan2.keyword1'), t('math.palette.atan2.keyword2')]),
  item('coth', 'functions', t('math.palette.coth.label'), 'coth', String.raw`\operatorname{coth}\left(#0\right)`, ['coth'], t('math.palette.coth.meaning')),
  item('sech', 'functions', t('math.palette.sech.label'), 'sech', String.raw`\operatorname{sech}\left(#0\right)`, ['sech'], t('math.palette.sech.meaning')),
  item('csch', 'functions', t('math.palette.csch.label'), 'csch', String.raw`\operatorname{csch}\left(#0\right)`, ['csch'], t('math.palette.csch.meaning')),
  item('arcoth', 'functions', t('math.palette.arcoth.label'), 'acoth', String.raw`\operatorname{arcoth}\left(#0\right)`, ['arcoth'], t('math.palette.arcoth.meaning'), [t('math.palette.arcoth.keyword0')]),
  item('arsech', 'functions', t('math.palette.arsech.label'), 'asech', String.raw`\operatorname{arsech}\left(#0\right)`, ['arsech'], t('math.palette.arsech.meaning'), [t('math.palette.arsech.keyword0')]),
  item('arcsch', 'functions', t('math.palette.arcsch.label'), 'acsch', String.raw`\operatorname{arcsch}\left(#0\right)`, ['arcsch'], t('math.palette.arcsch.meaning'), [t('math.palette.arcsch.keyword0')]),
  item('component', 'linear-algebra', t('math.palette.component.label'), 'Aᵢⱼ', String.raw`\operatorname{component}\left(#0,#?,#?\right)`, ['component'], t('math.palette.component.meaning'), [t('math.palette.component.keyword0'), t('math.palette.component.keyword1'), t('math.palette.component.keyword2'), t('math.palette.component.keyword3')]),
  item('fraction', 'basic', t('math.palette.fraction.label'), 'a/b', String.raw`\frac{#0}{#?}`, ['divide'], t('math.palette.fraction.meaning'), [t('math.palette.fraction.keyword0'), t('math.palette.fraction.keyword1')]),
  item('power', 'basic', t('math.palette.power.label'), 'xⁿ', String.raw`{#0}^{#?}`, ['power'], t('math.palette.power.meaning'), [t('math.palette.power.keyword0'), t('math.palette.power.keyword1')]),
  item('square-root', 'basic', t('math.palette.square-root.label'), '√', String.raw`\sqrt{#0}`, ['sqrt'], t('math.palette.square-root.meaning'), [t('math.palette.square-root.keyword0'), t('math.palette.square-root.keyword1')]),
  item('nth-root', 'basic', t('math.palette.nth-root.label'), 'ⁿ√', String.raw`\sqrt[#?]{#0}`, ['root'], t('math.palette.nth-root.meaning'), [t('math.palette.nth-root.keyword0'), t('math.palette.nth-root.keyword1')]),
  item('factorial', 'basic', t('math.palette.factorial.label'), 'n!', String.raw`{#0}!`, ['factorial'], t('math.palette.factorial.meaning'), [t('math.palette.factorial.keyword0')]),
  item('absolute', 'basic', t('math.palette.absolute.label'), '|x|', String.raw`\left|#0\right|`, ['absolute'], t('math.palette.absolute.meaning'), [t('math.palette.absolute.keyword0'), t('math.palette.absolute.keyword1')]),
  item('sin', 'functions', t('math.palette.sin.label'), 'sin', String.raw`\sin\left(#0\right)`, ['sin'], t('math.palette.sin.meaning'), [t('math.palette.sin.keyword0')]),
  item('cos', 'functions', t('math.palette.cos.label'), 'cos', String.raw`\cos\left(#0\right)`, ['cos'], t('math.palette.cos.meaning'), [t('math.palette.cos.keyword0')]),
  item('tan', 'functions', t('math.palette.tan.label'), 'tan', String.raw`\tan\left(#0\right)`, ['tan'], t('math.palette.tan.meaning'), [t('math.palette.tan.keyword0')]),
  item('arcsin', 'functions', t('math.palette.arcsin.label'), 'arcsin', String.raw`\arcsin\left(#0\right)`, ['arcsin'], t('math.palette.arcsin.meaning'), [t('math.palette.arcsin.keyword0'), t('math.palette.arcsin.keyword1')]),
  item('log-natural', 'functions', t('math.palette.log-natural.label'), 'ln', String.raw`\ln\left(#0\right)`, ['natural-log'], t('math.palette.log-natural.meaning'), [t('math.palette.log-natural.keyword0'), t('math.palette.log-natural.keyword1')]),
  item('log-ten', 'functions', t('math.palette.log-ten.label'), 'log₁₀', String.raw`\log_{10}\left(#0\right)`, ['log-ten'], t('math.palette.log-ten.meaning'), [t('math.palette.log-ten.keyword0'), t('math.palette.log-ten.keyword1')]),
  item('log-base', 'functions', t('math.palette.log-base.label'), 'logₐ', String.raw`\log_{#?}\left(#0\right)`, ['log-base'], t('math.palette.log-base.meaning'), [t('math.palette.log-base.keyword0'), t('math.palette.log-base.keyword1')]),
  item('sinh', 'functions', t('math.palette.sinh.label'), 'sinh', String.raw`\sinh\left(#0\right)`, ['sinh'], t('math.palette.sinh.meaning'), [t('math.palette.sinh.keyword0')]),
  item('sum', 'series', t('math.palette.sum.label'), 'Σ', String.raw`\sum_{i=1}^{#?}{#0}`, ['sum'], t('math.palette.sum.meaning'), [t('math.palette.sum.keyword0'), t('math.palette.sum.keyword1')]),
  item('product', 'series', t('math.palette.product.label'), '∏', String.raw`\prod_{i=1}^{#?}{#0}`, ['product'], t('math.palette.product.meaning'), [t('math.palette.product.keyword0')]),
  item('integral', 'calculus', t('math.palette.integral.label'), '∫', String.raw`\int_{#?}^{#?}{#0}\,\mathrm{d}x`, ['integrate'], t('math.palette.integral.meaning'), [t('math.palette.integral.keyword0'), t('math.palette.integral.keyword1')]),
  item('derivative', 'calculus', t('math.palette.derivative.label'), 'd/dx', String.raw`\frac{\mathrm{d}}{\mathrm{d}#?}{#0}`, ['differentiate'], t('math.palette.derivative.meaning'), [t('math.palette.derivative.keyword0'), t('math.palette.derivative.keyword1')]),
  item('partial', 'calculus', t('math.palette.partial.label'), '∂/∂x', String.raw`\frac{\partial}{\partial #?}{#0}`, ['differentiate'], t('math.palette.partial.meaning'), [t('math.palette.partial.keyword0')]),
  item('limit', 'calculus', t('math.palette.limit.label'), 'lim', String.raw`\lim_{x\to #?}{#0}`, ['limit'], t('math.palette.limit.meaning'), [t('math.palette.limit.keyword0')]),
  item('matrix', 'linear-algebra', t('math.palette.matrix.label'), '[A]', String.raw`\begin{pmatrix}#?&#?\\#?&#?\end{pmatrix}`, ['matrix', 'list'], t('math.palette.matrix.meaning'), [t('math.palette.matrix.keyword0'), t('math.palette.matrix.keyword1')]),
  item('determinant', 'linear-algebra', t('math.palette.determinant.label'), 'det', String.raw`\det\left(#0\right)`, ['determinant'], t('math.palette.determinant.meaning'), [t('math.palette.determinant.keyword0')]),
  item('dot', 'linear-algebra', t('math.palette.dot.label'), 'a·b', String.raw`#0\cdot #?`, ['dot'], t('math.palette.dot.meaning'), [t('math.palette.dot.keyword0')]),
  item('cross', 'linear-algebra', t('math.palette.cross.label'), 'a×b', String.raw`#0\times #?`, ['cross'], t('math.palette.cross.meaning'), [t('math.palette.cross.keyword0')]),
  item('real-part', 'complex', t('math.palette.real-part.label'), 'Re', String.raw`\operatorname{Re}\left(#0\right)`, ['real-part'], t('math.palette.real-part.meaning'), [t('math.palette.real-part.keyword0'), t('math.palette.real-part.keyword1')]),
  item('imaginary-part', 'complex', t('math.palette.imaginary-part.label'), 'Im', String.raw`\operatorname{Im}\left(#0\right)`, ['imaginary-part'], t('math.palette.imaginary-part.meaning'), [t('math.palette.imaginary-part.keyword0'), t('math.palette.imaginary-part.keyword1')]),
  item('conjugate', 'complex', t('math.palette.conjugate.label'), 'z̄', String.raw`\overline{#0}`, ['conjugate'], t('math.palette.conjugate.meaning'), [t('math.palette.conjugate.keyword0'), t('math.palette.conjugate.keyword1')]),
  item('mean', 'statistics', t('math.palette.mean.label'), 'mean', String.raw`\operatorname{mean}\left(#0\right)`, ['mean'], t('math.palette.mean.meaning'), [t('math.palette.mean.keyword0'), t('math.palette.mean.keyword1')]),
  item('median', 'statistics', t('math.palette.median.label'), 'median', String.raw`\operatorname{median}\left(#0\right)`, ['median'], t('math.palette.median.meaning')),
  item('modes', 'statistics', t('math.palette.modes.label'), 'modes', String.raw`\operatorname{modes}\left(#0\right)`, ['modes'], t('math.palette.modes.meaning')),
  item('quantile', 'statistics', t('math.palette.quantile.label'), 'quantile', String.raw`\operatorname{quantile}\left(#0,#?\right)`, ['quantile'], t('math.palette.quantile.meaning')),
  item('population-variance', 'statistics', t('math.palette.population-variance.label'), 'σ²', String.raw`\operatorname{populationvariance}\left(#0\right)`, ['population-variance'], t('math.palette.population-variance.meaning')),
  item('sample-variance', 'statistics', t('math.palette.sample-variance.label'), 's²', String.raw`\operatorname{samplevariance}\left(#0\right)`, ['sample-variance'], t('math.palette.sample-variance.meaning')),
  item('population-standard-deviation', 'statistics', t('math.palette.population-standard-deviation.label'), 'σ', String.raw`\operatorname{populationstandarddeviation}\left(#0\right)`, ['population-standard-deviation'], t('math.palette.population-standard-deviation.meaning')),
  item('sample-standard-deviation', 'statistics', t('math.palette.sample-standard-deviation.label'), 's', String.raw`\operatorname{samplestandarddeviation}\left(#0\right)`, ['sample-standard-deviation'], t('math.palette.sample-standard-deviation.meaning')),
  item('population-covariance', 'statistics', t('math.palette.population-covariance.label'), 'covₙ', String.raw`\operatorname{populationcovariance}\left(#0,#?\right)`, ['population-covariance'], t('math.palette.population-covariance.meaning')),
  item('sample-covariance', 'statistics', t('math.palette.sample-covariance.label'), 'covₙ₋₁', String.raw`\operatorname{samplecovariance}\left(#0,#?\right)`, ['sample-covariance'], t('math.palette.sample-covariance.meaning')),
  item('correlation', 'statistics', t('math.palette.correlation.label'), 'r', String.raw`\operatorname{correlation}\left(#0,#?\right)`, ['correlation'], t('math.palette.correlation.meaning')),
  item('regression-slope', 'statistics', t('math.palette.regression-slope.label'), 'a', String.raw`\operatorname{regressionslope}\left(#0,#?\right)`, ['regression-slope'], t('math.palette.regression-slope.meaning')),
  item('regression-intercept', 'statistics', t('math.palette.regression-intercept.label'), 'b', String.raw`\operatorname{regressionintercept}\left(#0,#?\right)`, ['regression-intercept'], t('math.palette.regression-intercept.meaning')),
  item('r-squared', 'statistics', t('math.palette.r-squared.label'), 'R²', String.raw`\operatorname{rsquared}\left(#0,#?\right)`, ['r-squared'], t('math.palette.r-squared.meaning')),
  item('intersection', 'sets-logic', t('math.palette.intersection.label'), '∩', String.raw`#0\cap #?`, ['intersection'], t('math.palette.intersection.meaning'), [t('math.palette.intersection.keyword0'), t('math.palette.intersection.keyword1')]),
  item('union', 'sets-logic', t('math.palette.union.label'), '∪', String.raw`#0\cup #?`, ['union'], t('math.palette.union.meaning'), [t('math.palette.union.keyword0'), t('math.palette.union.keyword1')]),
  item('cases', 'sets-logic', t('math.palette.cases.label'), 'cases', String.raw`\begin{cases}#?&#?\\#?&#?\end{cases}`, ['which'], t('math.palette.cases.meaning'), [t('math.palette.cases.keyword0'), t('math.palette.cases.keyword1')]),
  item('equal', 'equations', t('math.palette.equal.label'), '=', String.raw`#0=#?`, ['equal'], t('math.palette.equal.meaning'), [t('math.palette.equal.keyword0')]),
  item('pi', 'symbols', t('math.palette.pi.label'), 'π', String.raw`\pi`, [], t('math.palette.pi.meaning'), [t('math.palette.pi.keyword0'), t('math.palette.pi.keyword1')]),
  item('imaginary-unit', 'symbols', t('math.palette.imaginary-unit.label'), 'ⅈ', String.raw`\mathrm{i}`, [], t('math.palette.imaginary-unit.meaning'), [t('math.palette.imaginary-unit.keyword0'), t('math.palette.imaginary-unit.keyword1')]),
];

export function searchMathPalette(query: string, entries: readonly MathPaletteItem[]): readonly MathPaletteItem[] {
  const terms = query.normalize('NFKC').toLocaleLowerCase('ja').trim().split(/\s+/u).filter(Boolean);
  return entries.filter(entry => {
    const content = [entry.label, entry.symbol, entry.id, entry.meaning, ...entry.keywords].join(' ').normalize('NFKC').toLocaleLowerCase('ja');
    return terms.every(term => content.includes(term));
  });
}

export function mathPaletteAvailability(entry: MathPaletteItem, verifiedOperations: ReadonlySet<string>,
  passedAcceptanceIds: ReadonlySet<string>): boolean {
  return entry.acceptanceIds.length > 0 && entry.acceptanceIds.every(id => passedAcceptanceIds.has(id))
    && entry.requiredOperations.every(id => verifiedOperations.has(id));
}
