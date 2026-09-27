"""MC-12: the number of elements of a set (operation 'cardinality').

A count is returned only for a set that is proved finite, after every listed
element is proved equal to, or different from, each kept element. An infinite
set has no finite count ('domain'). An undecided finiteness or equality stays
unevaluated and never becomes a guess. cas_extended_dispatch.py merges
IMPLEMENTATIONS and localExactMathEngine.ts ships this module. The dispatch
registry is also imported without the optional runtime, so SymPy is loaded
only while counting.
"""
from fractions import Fraction

# A set literal has at most 256 operands and a product result at most 256 tuples.
MAX_ELEMENTS = 256
# Comparisons that need simplification are slow; bound them per count.
MAX_SIMPLIFIED_COMPARISONS = 64
# SymPy may simplify these operations on unknown elements as if the unknowns
# were different values ({1, x} minus {x} becomes {1}), so no count follows.
UNKNOWN_SENSITIVE = frozenset(('union', 'intersection', 'set-minus', 'complement'))
# Values evaluated to 30 guaranteed digits that differ in their first 20 are different.
NUMERIC_DIGITS = 30
SEPARATION = 10 ** 20


def cardinality(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    """Decode the operand first, so an invalid element is never hidden by the count."""
    import sympy as s
    if len(operands) != 1:
        raise problem('syntax', 'The number of elements needs one set')
    values = decoder.node(operands[0], scope, depth + 1)
    if not isinstance(values, s.Set):
        raise problem('domain', 'The number of elements requires a set')
    if unknown_set_operation(operands[0], problem):
        raise problem('unevaluated', 'A set operation on unknown elements is not a proved set')
    try:
        # Compare finished values: a finite sum or product element is evaluated first.
        values = values.doit(deep=True)
    except NotImplementedError:
        pass
    return s.Integer(count(values, problem, [MAX_SIMPLIFIED_COMPARISONS]))


def unknown_set_operation(value, problem):
    """Whether the operand combines an unknown symbol with an operation SymPy may simplify unsoundly.

    A variable bound by a sum or integral inside the operand is not unknown there;
    an outer local variable, an axis or a parameter is.
    """
    pending, symbol, sensitive, remaining = [(value, frozenset())], False, False, 4096
    while pending:
        node, local = pending.pop()
        remaining -= 1
        if remaining < 0:
            raise problem('budget', 'The set structure exceeds the budget')
        if type(node) is not dict:
            continue
        kind = node.get('kind')
        if kind == 'symbol':
            reference = node.get('reference')
            symbol = symbol or not (type(reference) is dict and reference.get('role') == 'bound'
                                    and reference.get('id') in local)
        elif kind == 'operation':
            sensitive = sensitive or node.get('operation') in UNKNOWN_SENSITIVE
            if type(node.get('operands')) is list:
                pending.extend((child, local) for child in node['operands'])
        elif kind == 'binder':
            bindings = node.get('bindings') if type(node.get('bindings')) is list else []
            inner = local | {binding['variable'].get('id') for binding in bindings
                             if type(binding) is dict and type(binding.get('variable')) is dict}
            pending.append((node.get('body'), inner))
            for binding in bindings:
                domain = binding.get('domain') if type(binding) is dict else None
                if type(domain) is dict:
                    pending.extend((domain.get(key), inner) for key in ('value', 'lower', 'upper', 'step'))
    return symbol and sensitive


def count(values, problem, budget):
    import sympy as s
    if values.is_empty is True:
        return 0
    if isinstance(values, s.FiniteSet):
        return distinct(values.args, problem, budget)
    if isinstance(values, s.ProductSet):
        if values.is_empty is not False:
            raise problem('unevaluated', 'Emptiness of a factor is not established')
        total = 1
        for factor in values.sets:
            total *= count(factor, problem, budget)
        return total
    if isinstance(values, s.Range):
        if values.is_finite_set is False:
            raise problem('domain', 'An infinite set has no finite number of elements')
        try:
            size = values.size
        except (ValueError, TypeError, NotImplementedError):
            size = None
        if isinstance(size, s.Integer) and size >= 0:
            return int(size)
        raise problem('unevaluated', 'The number of elements is not established')
    if values.is_finite_set is False:
        raise problem('domain', 'An infinite set has no finite number of elements')
    raise problem('unevaluated', 'The number of elements is not established')


def canonical(value):
    """An exact rational, or an ordered tuple of them, is written in one way only."""
    import sympy as s
    return isinstance(value, s.Rational) or isinstance(value, s.Tuple) and all(canonical(item) for item in value.args)


def distinct(elements, problem, budget):
    """Count listed elements once each; an undecided pair leaves the count unevaluated."""
    if len(elements) > MAX_ELEMENTS:
        raise problem('budget', 'Too many elements to compare')
    # FiniteSet removed identical entries, so different canonical entries are different values.
    if all(canonical(value) for value in elements):
        return len(elements)
    keys = {}

    def key(value):
        if value not in keys:
            keys[value] = numeric_key(value)
        return keys[value]
    kept = []
    for value in elements:
        duplicate = undecided = False
        for other in kept:
            same = equal(value, other, key, problem, budget)
            if same is True:
                duplicate = True
                break
            if same is None:
                undecided = True
        if duplicate:
            continue
        if undecided:
            raise problem('unevaluated', 'Two elements are not proved equal or different')
        kept.append(value)
    return len(kept)


def equal(left, right, key, problem, budget):
    """True, False, or None when neither is proved."""
    import sympy as s
    if isinstance(left, s.Tuple) or isinstance(right, s.Tuple):
        # An ordered tuple never equals a scalar or a tuple of another length.
        if not (isinstance(left, s.Tuple) and isinstance(right, s.Tuple)) or len(left) != len(right):
            return False
        undecided = False
        for a, b in zip(left.args, right.args):
            result = equal(a, b, key, problem, budget)
            if result is False:
                return False
            undecided = undecided or result is None
        return None if undecided else True
    if isinstance(left, s.Rational) and isinstance(right, s.Rational):
        return left == right
    left_key, right_key = key(left), key(right)
    if left_key is not None and right_key is not None and separated(left_key, right_key):
        return False
    difference = left - right
    zero = difference.is_zero
    if zero is not None:
        return zero
    if difference.free_symbols:
        return None
    if budget[0] <= 0:
        raise problem('budget', 'Too many elements need a simplified comparison')
    budget[0] -= 1
    try:
        return difference.equals(0)
    except (NotImplementedError, ValueError, TypeError, AttributeError):
        return None


def numeric_key(value):
    """Exact rational real and imaginary parts of a 30-digit evaluation, or None."""
    import sympy as s
    from sympy.core.evalf import PrecisionExhausted
    if not isinstance(value, s.Expr) or value.free_symbols or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return None
    try:
        approximate = value.evalf(NUMERIC_DIGITS, strict=True)
    except (PrecisionExhausted, ValueError, TypeError, NotImplementedError):
        return None
    parts = approximate.as_real_imag()
    if not all(part.is_Number and part.is_finite for part in parts):
        return None
    return tuple(fraction(part) for part in parts)


def fraction(number):
    import sympy as s
    exact = s.Rational(number)
    return Fraction(int(exact.p), int(exact.q))


def separated(left, right):
    """Proved different: some part differs beyond the guaranteed evaluation error."""
    scale = sum(abs(part) for part in (*left, *right))
    return any(abs(a - b) * SEPARATION > scale for a, b in zip(left, right))


IMPLEMENTATIONS = {'cardinality': cardinality}
