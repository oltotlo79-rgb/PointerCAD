"""Finite indexed sequences and recurrences; evaluate original operands at every used index."""
from contextlib import contextmanager
import sympy as s

OPERATIONS = {'sequence-value': 2, 'difference-at': 4, 'recurrence-value': 4}
MAX_STEPS = 4096
MAX_WORK = 262144
MAX_BITS = 16384


def check_size(value, problem):
    if not isinstance(value, s.Basic):
        return
    count = 0
    for item in s.preorder_traversal(value):
        count += 1
        if count > 4096:
            raise problem('budget', 'Sequence expression exceeds the size budget')
        if isinstance(item, s.Rational) and max(int(item.p).bit_length(), int(item.q).bit_length()) > MAX_BITS:
            raise problem('budget', 'Sequence exact digits exceed the size budget')


def before_operation(operation, args, problem):
    # Reject explosive integer powers BEFORE SymPy allocates their exact digits.
    if operation in ('power', 'square') and len(args) == (2 if operation == 'power' else 1):
        base, exponent = args[0], args[1] if operation == 'power' else s.Integer(2)
        if isinstance(base, s.Rational) and base not in (0, 1, -1) and isinstance(exponent, s.Rational):
            bits = max(int(base.p).bit_length(), int(base.q).bit_length())
            if abs(exponent) * bits > MAX_BITS:
                raise problem('budget', 'Sequence power exceeds the exact digit budget')


@contextmanager
def sequence_budget(decoder):
    decoder.sequence_depth += 1
    try:
        yield
    finally:
        decoder.sequence_depth -= 1


def integer(value, label, problem):
    if not isinstance(value, s.Integer):
        raise problem('domain', label + ' must be a finite exact integer')
    return int(value)


def scalar(value, problem):
    if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
        raise problem('domain', 'A scalar sequence value is required')
    if value.is_finite is False or value.has(s.nan, s.zoo, s.oo, -s.oo):
        raise problem('domain', 'A sequence term is not finite')
    if value.is_finite is not True:
        raise problem('unevaluated', 'The sequence term needs established finite values')
    check_size(value, problem)
    return value


def sequence_operation(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != OPERATIONS[operation]:
        raise problem('syntax', 'Invalid sequence argument count')
    function = operands[0]
    fields(function, ('kind', 'operation', 'body', 'bindings'))
    recurrence = operation == 'recurrence-value'
    bindings = function['bindings']
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(bindings) is not list or not (2 if recurrence else 1) <= len(bindings) <= (17 if recurrence else 1)):
        raise problem('syntax', 'Invalid sequence local variables')
    keys = []
    for binding in bindings:
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys or binding['domain']['kind'] != 'unrestricted':
            raise problem('syntax', 'Sequence local variables must be distinct and unrestricted')
        keys.append(key)

    def sample(values):
        nested = dict(scope)
        nested.update(zip(keys, values))
        # The original body has a structural budget per evaluation. A separate
        # cumulative counter also bounds repeated and nested recurrence work.
        original_nodes = decoder.nodes
        start = len(decoder.domain_conditions)
        try:
            result = scalar(decoder.node(function['body'], nested, depth+1), problem)
            if decoder.domain_conditions[start:]:
                raise problem('unevaluated', 'A sequence term has unresolved original domain conditions')
            return result
        finally:
            decoder.nodes = original_nodes

    with sequence_budget(decoder):
        args = [decoder.node(item, scope, depth+1) for item in operands[1:]]
        first = integer(args[0], 'Index', problem)
        if operation == 'sequence-value':
            return sample([s.Integer(first)])
        if operation == 'difference-at':
            order = integer(args[1], 'Difference order', problem)
            step = integer(args[2], 'Difference step', problem)
            if order < 0 or step <= 0:
                raise problem('domain', 'Difference order must be nonnegative and step positive')
            if order > 64:
                raise problem('budget', 'Difference order exceeds 64')
            # Exact forward differences Δ_h^m f(n), without dividing by h.
            values = [sample([s.Integer(first+i*step)]) for i in range(order+1)]
            for _ in range(order):
                values = [scalar(b-a, problem) for a, b in zip(values, values[1:])]
            return values[0]
        seeds, target = args[1], integer(args[2], 'Target index', problem)
        if type(seeds) is not tuple or len(seeds) != len(keys)-1:
            raise problem('domain', 'Initial values must match the recurrence state variables')
        state = [scalar(value, problem) for value in seeds]
        if target < first:
            raise problem('domain', 'The target precedes the initial index; no backward recurrence is implied')
        iterations = max(0, target-first-len(state)+1)
        if iterations > MAX_STEPS:
            raise problem('budget', 'Recurrence needs more than 4096 steps')
        if iterations == 0:
            return state[target-first]
        for offset in range(iterations):
            following = sample([s.Integer(first+offset), *state])
            state = [*state[1:], following]
        return state[-1]
