/** 演算名と引数の数だけを共有する。計算処理や外部エンジンを読み込まない。 */
export const LINEAR_DEFINITIONS = [
  ['row-reduce', 'RowReduce', 1], ['null-space', 'NullSpace', 1],
  ['column-space', 'ColumnSpace', 1], ['row-space', 'RowSpace', 1],
  ['linear-solve', 'LinearSolve', 2], ['linear-solution-space', 'LinearSolutionSpace', 2],
  ['qr-q', 'QrQ', 1], ['qr-r', 'QrR', 1],
  ['lu-p', 'LuP', 1], ['lu-l', 'LuL', 1], ['lu-u', 'LuU', 1],
  ['characteristic-coefficients', 'CharacteristicCoefficients', 1],
  ['eigenvalues', 'Eigenvalues', 1],
  ['eigenspace', 'Eigenspace', 2],
  ['singular-values', 'SingularValues', 1],
  ['svd-u', 'SvdU', 1], ['svd-s', 'SvdS', 1], ['svd-v', 'SvdV', 1],
] as const;

export const STATISTICS_DEFINITIONS = [
  ['binomial-pmf', 'BinomialPmf', 3], ['binomial-cdf', 'BinomialCdf', 3],
  ['mean', 'Mean', 1], ['median', 'Median', 1], ['modes', 'Modes', 1], ['quantile', 'Quantile', 2],
  ['population-variance', 'PopulationVariance', 1], ['sample-variance', 'SampleVariance', 1],
  ['population-standard-deviation', 'PopulationStandardDeviation', 1],
  ['sample-standard-deviation', 'SampleStandardDeviation', 1],
  ['population-covariance', 'PopulationCovariance', 2], ['sample-covariance', 'SampleCovariance', 2],
  ['correlation', 'Correlation', 2], ['regression-slope', 'RegressionSlope', 2],
  ['regression-intercept', 'RegressionIntercept', 2], ['r-squared', 'RSquared', 2],
] as const;

export const TENSOR_DEFINITIONS = [
  ['tensor-product', 'TensorProduct', 2],
  ['hadamard-product', 'HadamardProduct', 2],
  ['tensor-contract', 'TensorContract', 3],
  ['tensor-permute', 'TensorPermute', 2],
  ['tensor-shape', 'TensorShape', 1],
  ['tensor-element', 'TensorElement', 2],
  ['kronecker-delta', 'KroneckerDelta', 2],
  ['levi-civita', 'LeviCivita', 1],
] as const;

export const INTEGER_DEFINITIONS = [
  ['integer-quotient', 'IntegerQuotient', 2], ['integer-remainder', 'IntegerRemainder', 2],
  ['divides', 'Divides', 2], ['congruent-modulo', 'CongruentModulo', 3],
  ['is-prime', 'IsPrime', 1], ['next-prime', 'NextPrime', 1],
  ['prime-factors', 'PrimeFactors', 1], ['divisors', 'Divisors', 1], ['euler-totient', 'EulerTotient', 1],
] as const;
