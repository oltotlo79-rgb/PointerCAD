"""Exact identity and zero matrices with dimensions from 1 through 16."""

def matrix_dimension(decoder, operand, scope, depth, problem):
    # The dispatch registry is also inspected without loading the bundled wheel.
    import sympy as s
    value = decoder.node(operand, scope, depth + 1)
    if not isinstance(value, s.Integer):
        raise problem('domain', 'A matrix dimension must be an integer')
    if value <= 0:
        raise problem('domain', 'A matrix dimension must be positive')
    if value > 16:
        raise problem('budget', 'A matrix dimension exceeds the limit of 16')
    return int(value)


def matrix_constructor(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    import sympy as s
    dimensions = [matrix_dimension(decoder, operand, scope, depth, problem) for operand in operands]
    if operation == 'identity-matrix':
        return s.eye(dimensions[0])
    rows = dimensions[0]
    columns = dimensions[1] if len(dimensions) == 2 else rows
    return s.zeros(rows, columns)


IMPLEMENTATIONS = {
    'identity-matrix': matrix_constructor,
    'zero-matrix': matrix_constructor,
}
