"""Exact set construction and ordered bounds; endpoints need not be members."""
from dataclasses import dataclass
import sympy as s

BOUNDS = frozenset(('set-supremum', 'set-infimum', 'set-maximum', 'set-minimum'))
OPERATIONS = BOUNDS | {'set', 'interval', 'open-endpoint', 'union', 'intersection', 'set-minus', 'element'}


@dataclass(frozen=True)
class OpenEndpoint:
    value: object


def element_equal(left, right):
    """True, False, or None (undecided) for two set elements. An ordered tuple
    (a cartesian-product element) is compared componentwise and never equals a
    scalar or a tuple of another length, matching the element equality that
    counts a set's elements (cas_cardinality.py, MC-12)."""
    if isinstance(left, s.Tuple) or isinstance(right, s.Tuple):
        if not (isinstance(left, s.Tuple) and isinstance(right, s.Tuple)) or len(left) != len(right):
            return False
        undecided = False
        for a, b in zip(left.args, right.args):
            same = element_equal(a, b)
            if same is False:
                return False
            undecided = undecided or same is None
        return None if undecided else True
    difference = left - right
    zero = difference.is_zero
    if zero is not None:
        return zero
    if difference.free_symbols:
        return None
    try:
        return difference.equals(0)
    except (NotImplementedError, ValueError, TypeError, AttributeError):
        return None


def finite_set_minus(left, right, error):
    """left - right for two listed (FiniteSet) operands, without trusting
    SymPy's own Complement construction: it drops a left element whenever the
    element is not STRUCTURALLY among right's listed elements, even when an
    unlisted equality with an unknown element is neither proved nor disproved.
    {1, k} - {k} silently becomes {1} that way, discarding the k=1 case where
    the true difference is empty (MC-23b; the same unsound simplification also
    reached the explicit-universe complement in cas_set_relations.py). Keep an
    element only when it is proved absent from right; leave the whole
    operation unevaluated when some pair is neither proved equal nor proved
    different, matching the established/unproved cases of every other set
    relation in this codebase."""
    kept = []
    for element in left.args:
        excluded = undecided = False
        for other in right.args:
            same = element_equal(element, other)
            if same is True:
                excluded = True
                break
            if same is None:
                undecided = True
        if excluded:
            continue
        if undecided:
            raise error('unevaluated', 'Set-minus membership is not established for an unknown element')
        kept.append(element)
    return s.FiniteSet(*kept) if kept else s.S.EmptySet


def set_operation(decoder, operation, args, error):
    count = len(args)
    if operation == 'open-endpoint':
        if count != 1:
            raise error('syntax', 'An open endpoint needs one value')
        return OpenEndpoint(args[0])
    if operation == 'interval':
        if count != 2:
            raise error('syntax', 'An interval needs two endpoints')
        ends = [value.value if isinstance(value, OpenEndpoint) else value for value in args]
        if any(not isinstance(value, s.Expr) or value.is_extended_real is False for value in ends):
            raise error('domain', 'Interval endpoints must be real or infinite')
        if any(value.is_extended_real is not True for value in ends):
            raise error('unevaluated', 'Endpoint order requires established real values')
        return s.Interval(*ends, left_open=isinstance(args[0], OpenEndpoint),
                          right_open=isinstance(args[1], OpenEndpoint))
    if operation == 'set':
        if any(not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase) for value in args):
            raise error('domain', 'Finite sets currently require scalar elements')
        return s.FiniteSet(*args)
    if operation == 'element':
        if count != 2 or not isinstance(args[1], s.Set) or not isinstance(args[0], s.Expr):
            raise error('domain', 'Membership requires a scalar element and a set')
        result = args[1].contains(args[0])
        if result is not s.true and result is not s.false:
            raise error('unevaluated', 'Membership is not established')
        return result
    if operation in ('union', 'intersection', 'set-minus'):
        if (count != 2 if operation == 'set-minus' else not 2 <= count <= 256):
            raise error('syntax', 'Invalid set operand count')
        if any(not isinstance(value, s.Set) for value in args):
            raise error('domain', 'Set operations require sets')
        if operation == 'set-minus' and isinstance(args[0], s.FiniteSet) and isinstance(args[1], s.FiniteSet):
            return finite_set_minus(args[0], args[1], error)
        return {'union': s.Union, 'intersection': s.Intersection, 'set-minus': s.Complement}[operation](*args)
    if operation not in BOUNDS or count != 1 or not isinstance(args[0], s.Set):
        raise error('domain', 'An ordered bound requires one set')
    values = args[0]
    if values.is_empty is True:
        # Explicit product convention: do not silently adopt extended-lattice
        # identities sup(empty)=-oo and inf(empty)=oo as useful CAD values.
        raise error('empty-set', 'An empty set has no bound under the selected convention')
    if values.is_empty is not False:
        raise error('unevaluated', 'The set may be empty')
    real = values.is_subset(s.S.Reals)
    if real is False:
        raise error('domain', 'Complex or non-real sets have no real ordering')
    if real is not True:
        raise error('unevaluated', 'A real ordering is not established')
    try:
        result = values.sup if operation in ('set-supremum', 'set-maximum') else values.inf
    except NotImplementedError:
        raise error('unevaluated', 'The set bound is not established') from None
    if result.is_extended_real is not True or result.free_symbols:
        raise error('unevaluated', 'The bound remains conditional')
    if operation in ('set-maximum', 'set-minimum'):
        attained = values.contains(result)
        if attained is s.false:
            raise error('no-extremum', 'The bound is not an element of the set')
        if attained is not s.true:
            raise error('unevaluated', 'Attainment of the bound is not established')
    if result in (s.oo, -s.oo):
        decoder.infinite_bound = True
    return result
