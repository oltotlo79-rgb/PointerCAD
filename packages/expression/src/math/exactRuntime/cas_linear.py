"""Exact algebraic linear systems: no numeric tolerance or assumed pivot."""
import sympy as s
from sympy.polys.matrices import DomainMatrix


LINEAR_OPERATIONS = frozenset(('row-reduce', 'null-space', 'column-space',
                              'row-space', 'linear-solve', 'linear-solution-space'))


def linear_operation(operation, args, to_matrix, problem):
    solving = operation in ('linear-solve', 'linear-solution-space')
    if len(args) != (2 if solving else 1):
        raise problem('domain', 'Invalid linear operation arguments')
    matrix = to_matrix(args[0]) if type(args[0]) is tuple else args[0]
    if not isinstance(matrix, s.MatrixBase) or not matrix.rows or not matrix.cols:
        raise problem('domain', 'A nonempty rectangular matrix is required')
    if max(matrix.rows, matrix.cols) > 16:
        raise problem('budget', 'Exact algebraic matrices are limited to 16 rows and columns')
    if solving:
        right = args[1]
        if (type(right) is not tuple or len(right) != matrix.rows
                or any(not isinstance(entry, s.Expr) for entry in right)):
            raise problem('domain', 'The right-hand vector must match the matrix rows')
        augmented = matrix.row_join(s.ImmutableMatrix(right))
    else:
        augmented = matrix
    # Symbols and transcendental identities may need assumptions. Accept only
    # finite algebraic numbers so the coefficient field has decidable equality.
    for entry in augmented:
        if not isinstance(entry, s.Expr) or entry.is_finite is False:
            raise problem('domain', 'Finite scalar matrix entries are required')
        if entry.free_symbols or entry.is_finite is not True or entry.is_algebraic is not True:
            raise problem('unsupported', 'Algebraic entries with resolved conditions are required')
    domain = DomainMatrix.from_Matrix(augmented, extension=True).to_field()
    if not (domain.domain.is_QQ or domain.domain.is_AlgebraicField or domain.domain.is_GaussianField):
        raise problem('unsupported', 'An exact algebraic coefficient field is required')
    reduced, all_pivots = domain.rref()
    rows = reduced.to_Matrix()
    width = matrix.cols
    pivots = tuple(column for column in all_pivots if column < width)
    if solving and width in all_pivots:
        if operation == 'linear-solve':
            raise problem('domain', 'The linear system is inconsistent')
        return s.S.EmptySet
    if operation == 'row-reduce':
        return s.ImmutableMatrix(rows)
    if operation == 'column-space':
        return tuple(tuple(matrix[row, column] for row in range(matrix.rows)) for column in pivots)
    if operation == 'row-space':
        return tuple(tuple(rows[row, column] for column in range(width)) for row in range(len(pivots)))
    basis = []
    for free in range(width):
        if free in pivots:
            continue
        vector = [s.Integer(0)] * width
        vector[free] = s.Integer(1)
        for row, column in enumerate(pivots):
            vector[column] = -rows[row, free]
        basis.append(tuple(vector))
    if operation == 'null-space':
        return tuple(basis)
    particular = [s.Integer(0)] * width
    for row, column in enumerate(pivots):
        particular[column] = rows[row, width]
    if operation == 'linear-solution-space':
        return (tuple(particular), *basis)
    if basis:
        raise problem('domain', 'The linear system has more than one solution')
    return tuple(particular)


def component(args, problem):
    if not 2 <= len(args) <= 3:
        raise problem('domain', 'A value and one or two component indices are required')
    value = args[0]
    if isinstance(value, s.MatrixBase):
        value = tuple(tuple(value[row, column] for column in range(value.cols)) for row in range(value.rows))
    for index in args[1:]:
        if not isinstance(index, s.Integer) or not 1 <= index <= 256:
            raise problem('domain', 'Component indices must be positive integers')
        if type(value) is not tuple or index > len(value):
            raise problem('domain', 'The selected component does not exist')
        value = value[int(index) - 1]
    return value
