"""Algebraic QR/LU use exact field arithmetic, including tiny nonzero pivots.

The Worker owns the finite calculation deadline and the shared encoder bounds
the result. No approximate equality or floating-point decomposition is used.
"""
import sympy as s
from sympy.polys.matrices import DomainMatrix


DECOMPOSITION_OPERATIONS = frozenset(('qr-q', 'qr-r', 'lu-p', 'lu-l', 'lu-u',
                                     'characteristic-coefficients'))


def decomposition(operation, matrix, problem):
    if operation == 'characteristic-coefficients':
        if matrix.rows != matrix.cols:
            raise problem('domain', 'Characteristic coefficients require a square matrix')
        exact = DomainMatrix.from_Matrix(matrix, extension=True).to_field()
        return tuple(exact.domain.to_sympy(value) for value in exact.charpoly())
    # Include conjugates when constructing the coefficient field. A complex
    # algebraic extension need not contain every conjugate automatically.
    extended = DomainMatrix.from_Matrix(matrix.row_join(matrix.conjugate()), extension=True).to_field()
    field = extended.domain
    if not (field.is_QQ or field.is_AlgebraicField or field.is_GaussianField):
        raise problem('unsupported', 'An exact algebraic coefficient field is required')
    rows = [[field.from_sympy(matrix[row, col]) for col in range(matrix.cols)]
            for row in range(matrix.rows)]
    if operation in ('qr-q', 'qr-r'):
        return qr(operation, rows, field)
    return lu(operation, rows, field)


def qr(operation, rows, field):
    height, width = len(rows), len(rows[0])
    columns = [[rows[row][col] for row in range(height)] for col in range(width)]
    basis, conjugates, norms = [], [], []

    def conjugate(vector):
        return [field.from_sympy(s.conjugate(field.to_sympy(value))) for value in vector]

    def dot(left_conjugate, right):
        return sum((a*b for a, b in zip(left_conjugate, right)), field.zero)

    def append(candidate):
        if len(basis) == height:
            return
        residual = list(candidate)
        for direction, opposite, norm in zip(basis, conjugates, norms):
            factor = dot(opposite, residual)/norm
            residual = [entry-factor*axis for entry, axis in zip(residual, direction)]
        opposite = conjugate(residual)
        squared_norm = dot(opposite, residual)
        if squared_norm == field.zero:
            return
        basis.append(residual)
        conjugates.append(opposite)
        norms.append(squared_norm)

    for column in columns:
        append(column)
    # Return full square Q even for a deficient or rectangular input. Complete
    # after all source columns, preserving their order and triangular R.
    for axis in range(height):
        append([field.one if row == axis else field.zero for row in range(height)])
    roots = [s.sqrt(field.to_sympy(norm)) for norm in norms]
    if operation == 'qr-q':
        return s.ImmutableMatrix(height, height,
            lambda row, col: field.to_sympy(basis[col][row])/roots[col])
    return s.ImmutableMatrix(height, width,
        lambda row, col: field.to_sympy(dot(conjugates[row], columns[col]))/roots[row])


def lu(operation, rows, field):
    height, width = len(rows), len(rows[0])
    upper = [list(row) for row in rows]
    lower = [[field.one if row == col else field.zero for col in range(height)]
             for row in range(height)]
    order, pivot_row = list(range(height)), 0
    for column in range(width):
        if pivot_row == height:
            break
        selected = next((row for row in range(pivot_row, height)
                         if upper[row][column] != field.zero), None)
        if selected is None:
            continue
        if selected != pivot_row:
            upper[selected], upper[pivot_row] = upper[pivot_row], upper[selected]
            order[selected], order[pivot_row] = order[pivot_row], order[selected]
            for previous in range(pivot_row):
                lower[selected][previous], lower[pivot_row][previous] = (
                    lower[pivot_row][previous], lower[selected][previous])
        pivot = upper[pivot_row][column]
        for row in range(pivot_row+1, height):
            if upper[row][column] == field.zero:
                continue
            factor = upper[row][column]/pivot
            lower[row][pivot_row] = factor
            upper[row][column] = field.zero
            for col in range(column+1, width):
                upper[row][col] -= factor*upper[pivot_row][col]
        pivot_row += 1
    if operation == 'lu-p':
        return s.ImmutableMatrix(height, height, lambda row, col: s.Integer(1 if order[row] == col else 0))
    result = lower if operation == 'lu-l' else upper
    return s.ImmutableMatrix([[field.to_sympy(entry) for entry in row] for row in result])
