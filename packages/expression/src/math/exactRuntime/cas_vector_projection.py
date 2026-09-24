"""Exact orthogonal projection of one finite real vector onto another."""


def projection(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    # The dispatch table is also imported by a lightweight registry check without wheels.
    import sympy as s
    u, v = (decoder.node(operand, scope, depth + 1) for operand in operands)
    if type(u) is not tuple or type(v) is not tuple or not u or len(u) != len(v):
        raise problem('dimension', 'Projection requires nonempty vectors of equal dimension')
    if any(not isinstance(item, s.Expr) for item in (*u, *v)):
        raise problem('dimension', 'Projection requires scalar vector components')
    if any(item.is_real is not True or item.is_finite is not True for item in (*u, *v)):
        raise problem('domain', 'Projection requires finite real scalar components')
    denominator = sum((item * item for item in v), s.Integer(0))
    if denominator.is_zero is True:
        raise problem('domain', 'Projection onto the zero vector is undefined')
    if denominator.is_zero is not False:
        raise problem('unsupported', 'Projection requires a provably nonzero target vector')
    numerator = sum((left * right for left, right in zip(u, v)), s.Integer(0))
    return tuple(numerator * item / denominator for item in v)


IMPLEMENTATIONS = {'projection': projection}
