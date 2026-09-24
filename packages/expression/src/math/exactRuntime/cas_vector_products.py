"""Exact products of explicit vectors and the selection of one cell of an explicit array.

dot, cross and norm never infer a row/column orientation. The application keeps a
component or tensor-element selection for this runtime when an unselected sibling
(for example a vector product) could only be checked here; every original cell is
decoded before the selected one is returned.
"""
import sympy as s
from cas_sequences import check_size, before_operation

OPERATIONS = frozenset(('dot', 'cross', 'norm', 'tensor-element'))


def vector_operation(decoder, operation, args, problem):
    """Exact products of explicit vectors; never infer a row/column orientation."""
    if operation == 'tensor-element':
        return tensor_element(args, problem)
    if not (1 <= len(args) <= 2 if operation == 'norm' else len(args) == 2):
        raise problem('syntax', 'Invalid vector operation argument count')
    vectors = args[:1] if operation == 'norm' else args
    for vector in vectors:
        if type(vector) is not tuple or not vector:
            raise problem('dimension', 'An explicit nonempty vector is required')
        if len(vector) > 256:
            raise problem('budget', 'A vector may contain at most 256 components')
        for value in vector:
            if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
                raise problem('domain', 'Vector components must be scalar expressions')
            if value.is_finite is False or value.has(s.nan, s.zoo, s.oo, -s.oo):
                raise problem('domain', 'Vector components must be finite')
            if not value.free_symbols and value.is_finite is not True:
                raise problem('unsupported', 'The component must be provably finite')
            check_size(value, problem)
    left = vectors[0]
    if operation != 'norm':
        right = vectors[1]
        if len(left) != len(right) or operation == 'cross' and len(left) != 3:
            raise problem('dimension', 'Dot needs equal dimensions; cross needs two 3D vectors')
        if operation == 'dot':
            for value in (*left, *right):
                if value.is_real is False:
                    raise problem('domain', 'Dot accepts real vectors; complex inner products are unsupported')
                if value.is_real is not True:
                    # Do not silently assign a real type to an unresolved declared symbol.
                    decoder.domain_conditions.append(s.Eq(s.im(value), 0, evaluate=False))
            result = sum((a*b for a, b in zip(left, right)), s.Integer(0))
        else:
            result = tuple(left[j]*right[k]-left[k]*right[j]
                           for j, k in ((1, 2), (2, 0), (0, 1)))
    else:
        order = args[1] if len(args) == 2 else s.Integer(2)
        if not isinstance(order, s.Expr) or isinstance(order, s.MatrixBase):
            raise problem('domain', 'The norm order must be a real scalar')
        magnitudes = [s.Abs(value) for value in left]
        if order == s.oo:
            # Equivalent to max(abs(v_i)), using operations the result encoder supports.
            result = magnitudes[0]
            for value in magnitudes[1:]:
                result = (result+value+s.Abs(result-value))/2
                check_size(result, problem)
        else:
            if order.is_real is not True or order.is_finite is not True or (order-1).is_nonnegative is not True:
                raise problem('domain', 'The norm order must be finite real p >= 1, or positive infinity')
            # Bound algebraic powers too (sqrt(2)**p can allocate a huge integer).
            if order.free_symbols or (16384-order).is_nonnegative is not True:
                raise problem('budget', 'The norm order exceeds the exact power budget')
            terms = []
            for value in magnitudes:
                before_operation('power', [value, order], problem)
                terms.append(value**order)
            result = sum(terms, s.Integer(0))**(1/order)
    for value in result if type(result) is tuple else (result,):
        check_size(value, problem)
    return result


def tensor_element(args, problem):
    """One cell of a nonempty rectangular array of finite scalars: one 1-based index per axis."""
    if len(args) != 2 or type(args[1]) is not tuple or not args[1]:
        raise problem('domain', 'Explicit component indices are required')
    array = args[0]
    if isinstance(array, s.MatrixBase):
        # Only an explicit matrix wrapper at the top is an array; a matrix cell is not a scalar.
        array = tuple(tuple(array[row, column] for column in range(array.cols)) for row in range(array.rows))
    shape, level = [], [array]
    while any(type(item) is tuple for item in level):
        if (len(shape) >= 8 or not all(type(item) is tuple and item for item in level)
                or len({len(item) for item in level}) != 1):
            raise problem('domain', 'A nonempty rectangular array of at most 8 axes is required')
        shape.append(len(level[0]))
        level = [cell for item in level for cell in item]
    # Check every original cell, not only the selected one.
    for cell in level:
        if not isinstance(cell, s.Expr) or isinstance(cell, s.MatrixBase) or cell.has(s.nan, s.zoo, s.oo, -s.oo):
            raise problem('domain', 'Array cells must be finite scalar expressions')
    indices = args[1]
    if not shape or len(indices) != len(shape) or any(
            not isinstance(index, s.Integer) or not 1 <= index <= length for index, length in zip(indices, shape)):
        raise problem('domain', 'Give one index per axis, from 1 to the length of that axis')
    for index in indices:
        array = array[int(index) - 1]
    return array
