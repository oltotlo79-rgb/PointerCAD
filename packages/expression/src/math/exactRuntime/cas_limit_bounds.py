"""Exact upper/lower limits, preserving approach domains and correlated oscillations."""
import sympy as s
from cas_limits import limit_value
from sympy.calculus.util import continuous_domain, function_range, periodicity
from sympy.series.limitseq import limit_seq
from sympy.core.function import PoleError


def scalar_limit(value):
    return (isinstance(value, s.Expr) and value.is_extended_real is True
            and not value.free_symbols and not value.has(s.AccumBounds, s.Limit, s.zoo, s.nan))


def fail(problem, message):
    raise problem('unevaluated', message)


def eventually_real(body, variable, problem):
    """Establish a whole continuous real tail before any simplification result."""
    if s.simplify(s.im(body)).is_zero is not True:
        fail(problem, 'The function is not established to be real along this approach')
    tail = s.Interval.open(0, s.oo)
    try:
        domain = continuous_domain(body, variable, tail)
        missing = tail - domain
        if missing is s.S.EmptySet:
            return
        if missing.is_empty is False and missing.sup.is_finite is True:
            return
    except (NotImplementedError, ValueError, TypeError):
        pass
    fail(problem, 'A real punctured neighbourhood has not been established')


def eventual_conditions(conditions, variable, discrete, problem):
    """A cancelled denominator must not hide infinitely many forbidden points."""
    tail = s.S.Naturals if discrete else s.Interval.open(0, s.oo)
    for condition in conditions:
        if not isinstance(condition, s.Unequality):
            fail(problem, 'The original neighbourhood condition is not established')
        expression = condition.lhs - condition.rhs
        try:
            zeros = s.solveset(expression, variable, domain=tail)
            if zeros is s.S.EmptySet:
                continue
            if zeros.is_empty is False and zeros.sup.is_finite is True:
                continue
        except (NotImplementedError, ValueError, TypeError):
            pass
        fail(problem, 'The original expression may have arbitrarily late forbidden points')


def continuous_tail(body, variable, upper, problem):
    eventually_real(body, variable, problem)
    ordinary = s.limit(body, variable, s.oo)
    if scalar_limit(ordinary):
        return ordinary
    # Reduce only additive terms whose exact limit is independently zero.
    terms = s.Add.make_args(s.expand(body))
    periodic_terms = []
    for term in terms:
        value = s.limit(term, variable, s.oo)
        if value != 0:
            periodic_terms.append(term)
    expression = s.Add(*periodic_terms)
    period = periodicity(expression, variable, check=True)
    if (period is None or period.is_positive is not True or period.is_finite is not True
            or period.free_symbols):
        fail(problem, 'No exact periodic remainder was established')
    # The original correlated expression is evaluated as a whole. In particular
    # sin(t)+cos(t) has extrema +/-sqrt(2), NOT the hull endpoints +/-2.
    values = function_range(expression, variable, s.Interval(0, period))
    answer = values.sup if upper else values.inf
    if not scalar_limit(answer):
        fail(problem, 'The full-period range is not established')
    return answer


def discrete_tail(body, variable, upper, problem):
    # Every residue class is included. If all exact subsequence limits exist,
    # their largest/smallest value is the limsup/liminf even without periodicity.
    k = s.Dummy('pcad_sequence_tail', positive=True, integer=True)
    for period in range(1, 17):
        limits = []
        for residue in range(period):
            branch = s.simplify(body.subs(variable, period*k + residue))
            if branch.is_extended_real is not True:
                break
            answer = limit_seq(branch, k, trials=3)
            if not scalar_limit(answer):
                break
            limits.append(answer)
        if len(limits) == period:
            return (s.Max if upper else s.Min)(*limits)
    fail(problem, 'The exact subsequence limits were not established within the finite search')


def limit_bound_value(body, variable, target, direction, discrete, upper, conditions, problem):
    if target.free_symbols or target.is_extended_real is not True:
        fail(problem, 'The real approach point is not established')
    if direction not in (s.S.NegativeOne, s.S.Zero, s.S.One):
        raise problem('domain', 'Approach direction must be -1, 0 or 1')
    if discrete and (target not in (s.oo, -s.oo) or direction != 0):
        raise problem('domain', 'An integer sequence requires an infinite approach point without a side')
    if target in (s.oo, -s.oo) and direction != 0:
        raise problem('domain', 'An infinite point has its own approach direction')
    sides = (0,) if target in (s.oo, -s.oo) else ((-1, 1) if direction == 0 else (int(direction),))
    tail = s.Dummy('pcad_bound_tail', positive=True, integer=True) if discrete else s.Dummy('pcad_bound_tail', positive=True)
    answers = []
    try:
        for side in sides:
            location = tail if target is s.oo else -tail if target is -s.oo else target + side/tail
            shifted = body.subs(variable, location)
            obligations = [condition.subs(variable, location) for condition in conditions]
            # Keep Unequality without automatic True/False collapse; true needs
            # no further check, false invalidates the entire original input.
            if s.false in obligations:
                raise problem('domain', 'An original denominator is zero throughout the approach')
            eventual_conditions([value for value in obligations if value is not s.true], tail, discrete, problem)
            answers.append(discrete_tail(shifted, tail, upper, problem) if discrete
                           else continuous_tail(shifted, tail, upper, problem))
    except (NotImplementedError, ValueError, TypeError, PoleError):
        fail(problem, 'The exact upper or lower limit could not be established')
    answer = (s.Max if upper else s.Min)(*answers)
    if not scalar_limit(answer):
        fail(problem, 'The ordering of the side limits remains unresolved')
    return answer


def decode_limit(decoder, operands, outer_scope, depth, operation, fields, reference_key, problem):
    bound = operation != 'limit'
    if len(operands) not in ((2, 3, 4) if bound else (2, 3)):
        raise problem('syntax', 'A limit requires a function, point and optional direction')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or len(function['bindings']) != 1):
        raise problem('syntax', 'A limit binds exactly one local variable')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    if binding['domain']['kind'] != 'unrestricted':
        raise problem('syntax', 'A limit function cannot carry an unrelated range')
    key = reference_key(binding['variable'])
    if key[0] != 'bound':
        raise problem('syntax', 'A local limit variable is required')
    target = decoder.node(operands[1], outer_scope, depth+1)
    direction = decoder.node(operands[2], outer_scope, depth+1) if len(operands) >= 3 else s.S.Zero
    if any(not isinstance(item, s.Expr) or isinstance(item, s.MatrixBase) for item in (target, direction)):
        raise problem('domain', 'Scalar limit point and direction are required')
    domain = decoder.node(operands[3], outer_scope, depth+1) if len(operands) == 4 else s.S.Reals
    if domain not in (s.S.Reals, s.S.Integers, s.S.Naturals0):
        raise problem('domain', 'The approach domain must be real numbers, integers or natural numbers')
    discrete = domain in (s.S.Integers, s.S.Naturals0)
    if domain is s.S.Naturals0 and target is not s.oo:
        raise problem('domain', 'Natural indices approach positive infinity')
    variable = s.Dummy('pcad_limit_' + str(len(decoder.references)),
                       **({'integer': True} if discrete else {'real': True}))
    decoder.references[variable] = dict(binding['variable'])
    scope = dict(outer_scope)
    scope[key] = variable
    condition_start = len(decoder.domain_conditions)
    body = decoder.node(function['body'], scope, depth+1)
    if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
        raise problem('domain', 'A scalar function is required')
    conditions = decoder.domain_conditions[condition_start:]
    local = [condition for condition in conditions if variable in condition.free_symbols]
    decoder.domain_conditions[condition_start:] = [condition for condition in conditions if variable not in condition.free_symbols]
    if not bound:
        return limit_value(body, variable, target, direction, local, problem)
    result = limit_bound_value(body, variable, target, direction, discrete,
                               operation == 'limit-supremum', local, problem)
    if result in (s.oo, -s.oo):
        if depth > 0:
            raise problem('non-finite', 'An infinite bound is display-only, not a scalar operand')
        decoder.infinite_bound = True
    return result

