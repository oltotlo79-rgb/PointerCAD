"""Exact set relations, explicit-universe complements and ordered products.

The dispatch registry is inspected without the optional runtime installed.
Only calculation entry points load SymPy, never importing this module itself.
"""
from itertools import product


def subset_truth(left, right):
    """Keep SymPy's fuzzy answer; structural inequality is not set inequality."""
    import sympy as s
    try:
        result = left.is_subset(right)
    except NotImplementedError:
        return None
    if result is True or result is s.true:
        return True
    if result is False or result is s.false:
        return False
    return None


def established(value, problem):
    import sympy as s
    if value is True or value is s.true:
        return s.true
    if value is False or value is s.false:
        return s.false
    raise problem('unevaluated', 'The set relation is not established')


def membership_element(value, problem):
    import sympy as s
    if type(value) is tuple:
        return s.Tuple(*(membership_element(item, problem) for item in value))
    if isinstance(value, s.Expr) and not isinstance(value, s.MatrixBase):
        return value
    raise problem('domain', 'Membership requires a scalar or an ordered tuple of scalars')


def cartesian_product(sets, problem):
    import sympy as s
    # Check all operands before calling this function, including after an empty
    # factor. The output limits also apply before allocating the tuple product.
    if any(values.is_empty is True for values in sets):
        return s.S.EmptySet
    if not all(isinstance(values, s.FiniteSet) for values in sets):
        return s.ProductSet(*sets)
    count = 1
    for values in sets:
        count *= len(values)
        if count > 256 or 1 + count * (len(sets) + 1) > 4096:
            raise problem('budget', 'The Cartesian product exceeds the result budget')
    return s.FiniteSet(*(s.Tuple(*items) for items in product(*(values.args for values in sets))))


def set_relation(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    import sympy as s
    maximum = 16 if operation == 'cartesian-product' else 2
    if not 2 <= len(operands) <= maximum:
        raise problem('syntax', 'Invalid set relation operand count')
    args = [decoder.node(value, scope, depth + 1) for value in operands]
    if operation == 'not-element':
        element, values = args
        if not isinstance(values, s.Set):
            raise problem('domain', 'Nonmembership requires an element and a set')
        element = membership_element(element, problem)
        try:
            member = values.contains(element)
        except NotImplementedError:
            member = None
        return s.Not(established(member, problem))
    if any(not isinstance(value, s.Set) for value in args):
        raise problem('domain', 'Set relations and constructions require sets')
    if operation == 'cartesian-product':
        return cartesian_product(args, problem)
    left, right = args
    if operation == 'complement':
        contained = established(subset_truth(left, right), problem)
        if contained is s.false:
            raise problem('domain', 'The complemented set must be contained in its universe')
        if isinstance(right, s.FiniteSet) and isinstance(left, s.FiniteSet):
            # SymPy's own Complement can silently assume an unknown element of
            # the complemented set differs from another listed universe
            # element; reuse the proved-or-unevaluated construction (MC-23b).
            from cas_sets import finite_set_minus
            return finite_set_minus(right, left, problem)
        return s.Complement(right, left)
    if operation in ('superset', 'superset-equal'):
        left, right = right, left
    contained = subset_truth(left, right)
    if operation in ('subset-equal', 'superset-equal'):
        return established(contained, problem)
    if contained is False:
        return s.false
    reverse = subset_truth(right, left)
    if reverse is True:
        return s.false
    # A proper inclusion requires a proved inclusion and a proved difference.
    # In particular {0} and {0,x} are not known to be different when x is unknown.
    return established(True if contained is True and reverse is False else None, problem)


IMPLEMENTATIONS = {operation: set_relation for operation in (
    'not-element', 'subset', 'subset-equal', 'superset', 'superset-equal',
    'complement', 'cartesian-product',
)}
