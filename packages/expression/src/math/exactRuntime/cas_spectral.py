"""Exact algebraic spectral candidates; no approximate rank or root ordering.

Uses the fixed SymPy 1.14.0 condensed SVD, then returns the application's full
U/S/V shapes and descending singular values. Unresolved roots are never replaced by numerical approximations.
"""
from functools import cmp_to_key
import sympy as s
from sympy.matrices.exceptions import MatrixError
from sympy.polys.polyerrors import PolynomialError
from sympy.polys.matrices import DomainMatrix
from cas_decompositions import decomposition


SPECTRAL_OPERATIONS = frozenset(('eigenvalues', 'singular-values', 'svd-u', 'svd-s', 'svd-v'))


def spectral(operation, matrix, problem):
    # The common linear adapter validates dimensions, every scalar, and the
    # finite algebraic domain before dispatching here.
    if operation not in SPECTRAL_OPERATIONS:
        raise problem('unsupported', 'Unknown spectral operation')
    if operation == 'eigenvalues':
        if matrix.rows != matrix.cols:
            raise problem('domain', 'Eigenvalues require a square matrix')
        # Keep the same component order as the existing exact rational path.
        # Field equality detects algebraic zeros without a numeric tolerance.
        exact = DomainMatrix.from_Matrix(matrix, extension=True).to_field()
        entries, zero = exact.to_list(), exact.domain.zero
        upper = all(entries[row][col] == zero for row in range(matrix.rows) for col in range(row))
        lower = all(entries[row][col] == zero for row in range(matrix.rows) for col in range(row+1, matrix.cols))
        if upper or lower:
            return tuple(matrix[index, index] for index in range(matrix.rows))
        if matrix.rows == 2:
            trace = matrix.trace()
            root = s.sqrt(trace**2-4*matrix.det())
            return ((trace+root)/2, (trace-root)/2)
        try:
            values = matrix.eigenvals(multiple=True, error_when_incomplete=True)
        except (NotImplementedError, MatrixError, PolynomialError):
            raise problem('unsupported', 'The complete exact spectrum could not be resolved')
        if len(values) != matrix.rows:
            raise problem('unsupported', 'The complete spectrum with multiplicity is required')
        # The shared encoder refuses unsolved root objects instead of emitting
        # their approximate numerical value or pretending a partial list is complete.
        return tuple(values)
    return singular_decomposition(operation, matrix, problem)


def singular_decomposition(operation, matrix, problem):
    height, width = matrix.shape
    exact = DomainMatrix.from_Matrix(matrix, extension=True).to_field()
    rank = len(exact.rref()[1])
    if rank == 0:
        if operation == 'singular-values':
            return tuple(s.Integer(0) for _ in range(min(height, width)))
        return s.eye(height) if operation == 'svd-u' else s.eye(width) if operation == 'svd-v' else s.zeros(height, width)
    try:
        left, diagonal, right = matrix.singular_value_decomposition()
    except (NotImplementedError, MatrixError, PolynomialError):
        raise problem('unsupported', 'The complete exact singular decomposition could not be resolved')
    if left.shape != (height, rank) or right.shape != (width, rank) or diagonal.shape != (rank, rank):
        raise problem('unsupported', 'The decomposition does not retain the exact rank')
    singular = [diagonal[index, index] for index in range(rank)]
    if any(value.is_real is not True or value.is_positive is not True or value.has(s.Float) for value in singular):
        raise problem('unsupported', 'All nonzero singular values must be established positive exact reals')

    def compare(first, second):
        difference = s.simplify(singular[first]-singular[second])
        if difference.is_zero is True:
            return 0
        if difference.is_positive is True:
            return -1
        if difference.is_negative is True:
            return 1
        raise problem('unsupported', 'The exact singular-value order is unresolved')

    order = sorted(range(rank), key=cmp_to_key(compare))
    values = [singular[index] for index in order]
    if operation == 'singular-values':
        return tuple(values + [s.Integer(0)]*(min(height, width)-rank))
    if operation == 'svd-s':
        return s.ImmutableMatrix(height, width,
            lambda row, col: values[row] if row == col and row < rank else s.Integer(0))
    # The common exact QR completes after the already orthonormal source columns,
    # preserving each paired phase; the result satisfies A = U*S*V.H, also for complex A.
    primary = left[:, order] if operation == 'svd-u' else right[:, order]
    return decomposition('qr-q', primary, problem)
