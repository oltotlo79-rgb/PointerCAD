"""Typed scalar maps with explicit domain/codomain; no reciprocal-as-inverse.

An unknown totality, range or bijection proof stays unresolved. Finite samples
are never used to prove a property over an infinite domain.
"""
from dataclasses import dataclass
import sympy as s
from sympy.calculus.util import continuous_domain, function_range
from cas_input import CasInputProblem, fields, reference_key
from cas_equations import resolved_set, truth_set

MAPS = frozenset(('mapping', 'mapping-compose', 'mapping-inverse'))
OPERATIONS = MAPS | {'mapping-value', 'mapping-image', 'mapping-preimage'}


def unknown(message):
    raise CasInputProblem('unevaluated', message)


def require(value, message):
    if value is False or value is s.false:
        raise CasInputProblem('domain', message)
    if value is not True and value is not s.true:
        unknown(message)


def subset(left, right):
    included = left.is_subset(right)
    if included is None:
        # A decidable difference also proves inclusion or supplies an actual
        # omitted point; SymPy may leave Reals.is_subset(Reals-{0}) unknown.
        included = resolved_set(left-right).is_empty
    require(included, 'The declared mapping sets do not fit')


def checked_set(value):
    value = resolved_set(value)
    subset(value, s.S.Complexes)
    if isinstance(value, s.FiniteSet) and len(value) > 256:
        raise CasInputProblem('budget', 'A mapping set exceeds 256 elements')
    return value


def finite(value):
    if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
        raise CasInputProblem('domain', 'A scalar mapping value is required')
    if value.free_symbols:
        unknown('Resolve the mapping parameters first')
    require(value.is_finite, 'The original mapping value must be finite')
    return value


def interval(value):
    return isinstance(value, s.Interval) or value == s.S.Reals


def prove_real(mapping, values):
    # function_range works over the reals. Continuity alone is not a proof
    # of a real output under principal complex powers (e.g. x**(1/3)).
    if mapping.body.is_real is True:
        return
    for sign, region in (('positive', s.Interval.open(0, s.oo)),
                         ('negative', s.Interval.open(-s.oo, 0)),
                         ('nonnegative', s.Interval(0, s.oo)),
                         ('nonpositive', s.Interval(-s.oo, 0))):
        if values.is_subset(region) is True:
            local = s.Dummy('pcad_mapping_real', **{sign: True})
            if mapping.body.subs(mapping.variable, local).is_real is True:
                return
    unknown('A real image over this entire domain has not been established')


@dataclass(frozen=True)
class Mapping:
    kind: str
    domain: object
    codomain: object
    variable: object = None
    body: object = None
    outer: object = None
    inner: object = None


def image(mapping, values):
    values = checked_set(values)
    subset(values, mapping.domain)
    if values is s.S.EmptySet:
        return values
    if isinstance(values, s.FiniteSet):
        return s.FiniteSet(*(apply(mapping, item) for item in values))
    if mapping.kind == 'compose':
        return image(mapping.outer, image(mapping.inner, values))
    if mapping.kind == 'inverse':
        return preimage(mapping.inner, values)
    if isinstance(values, s.Union):
        return resolved_set(s.Union(*(image(mapping, part) for part in values.args)))
    if not interval(values):
        unknown('The complete image of this set has not been established')
    prove_real(mapping, values)
    result = resolved_set(function_range(mapping.body, mapping.variable, values))
    # Do not lose an attained finite endpoint when its value also equals an
    # excluded infinite-end limit (e.g. x*exp(-x) on [0,infinity)).
    ends = []
    if values != s.S.Reals:
        for endpoint, opened in ((values.start, values.left_open), (values.end, values.right_open)):
            if not opened and endpoint.is_finite is True:
                ends.append(apply(mapping, endpoint))
    return resolved_set(result.union(s.FiniteSet(*ends)))


def preimage(mapping, values):
    values = checked_set(values)
    subset(values, mapping.codomain)
    if values is s.S.EmptySet:
        return values
    if mapping.domain is s.S.EmptySet:
        return s.S.EmptySet
    if isinstance(mapping.domain, s.FiniteSet):
        selected = []
        for candidate in mapping.domain:
            member = values.contains(apply(mapping, candidate))
            if member is not s.true and member is not s.false:
                unknown('Membership of an image is not established')
            if member is s.true:
                selected.append(candidate)
        return s.FiniteSet(*selected)
    if mapping.kind == 'compose':
        return preimage(mapping.inner, preimage(mapping.outer, values).intersect(mapping.inner.codomain))
    if mapping.kind == 'inverse':
        return image(mapping.inner, values)
    if isinstance(values, s.Union):
        return resolved_set(s.Union(*(preimage(mapping, part) for part in values.args)))
    if isinstance(values, s.FiniteSet):
        return resolved_set(s.Union(*(s.solveset(mapping.body - item, mapping.variable,
                                               domain=mapping.domain) for item in values)))
    if values == mapping.codomain:
        return mapping.domain
    if interval(values):
        condition = s.And(mapping.body > values.start if values.left_open else mapping.body >= values.start,
                          mapping.body < values.end if values.right_open else mapping.body <= values.end)
        return resolved_set(truth_set(condition, mapping.variable, mapping.domain))
    unknown('The complete preimage has not been established')


def apply(mapping, value):
    value = finite(value)
    require(mapping.domain.contains(value), 'The value is outside the mapping domain')
    if mapping.kind == 'compose':
        result = apply(mapping.outer, apply(mapping.inner, value))
    elif mapping.kind == 'inverse':
        candidates = preimage(mapping.inner, s.FiniteSet(value))
        if not isinstance(candidates, s.FiniteSet) or len(candidates) != 1:
            unknown('The unique inverse value has not been established')
        result = next(iter(candidates))
    else:
        result = finite(s.simplify(mapping.body.subs(mapping.variable, value)))
    require(mapping.codomain.contains(result), 'The result is outside the mapping codomain')
    return result


def validate_total(mapping, observed, conditions):
    variable, domain = mapping.variable, mapping.domain
    if domain is s.S.EmptySet:
        return
    if isinstance(domain, s.FiniteSet):
        for candidate in domain:
            for expression in observed:
                finite(expression.subs(variable, candidate))
            for condition in conditions:
                require(s.simplify(condition.subs(variable, candidate)), 'A mapping operand is undefined')
        return
    if domain.is_subset(s.S.Reals) is not True:
        unknown('Totality on this non-finite complex domain has not been established')
    for expression in observed:
        if expression.free_symbols - {variable}:
            unknown('Resolve every mapping parameter before declaring its domain')
        continuous = continuous_domain(expression, variable, s.S.Reals)
        if domain.is_subset(continuous) is not True:
            gaps = resolved_set(domain-continuous)
            if gaps is not s.S.EmptySet and not isinstance(gaps, s.FiniteSet):
                unknown('Finiteness outside the established continuous domain is unknown')
            # A discontinuity is not necessarily an undefined value. Confirm
            # isolated excluded points exactly rather than rejecting them just
            # because a stronger continuity proof failed.
            for candidate in gaps:
                finite(expression.subs(variable, candidate))
    for condition in conditions:
        subset(domain, resolved_set(truth_set(condition, variable, domain)))


def declare(decoder, operands, scope, depth):
    if len(operands) != 3:
        raise CasInputProblem('syntax', 'A mapping needs its function, domain and codomain')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or len(function['bindings']) != 1):
        raise CasInputProblem('syntax', 'A mapping binds exactly one scalar variable')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    key = reference_key(binding['variable'])
    if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
        raise CasInputProblem('syntax', 'The mapping variable must be locally bound')
    domain, codomain = [checked_set(decoder.node(item, scope, depth + 1)) for item in operands[1:]]
    variable = s.Dummy('pcad_mapping', real=True) if domain.is_subset(s.S.Reals) is True else s.Dummy('pcad_mapping')
    nested = dict(scope)
    nested[key] = variable
    start = len(decoder.domain_conditions)
    observed, previous = [], decoder.domain_observer
    decoder.domain_observer = observed.append
    try:
        body = decoder.node(function['body'], nested, depth + 1)
    finally:
        decoder.domain_observer = previous
    if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
        raise CasInputProblem('domain', 'A scalar mapping expression is required')
    if body.free_symbols - {variable}:
        unknown('Resolve the mapping parameters before defining its range')
    mapping = Mapping('forward', domain, codomain, variable=variable, body=body)
    validate_total(mapping, set(observed), decoder.domain_conditions[start:])
    subset(image(mapping, domain), codomain)
    # The local obligations have now been proved over the entire domain. They
    # must not escape as free variables in a scalar result or disappear earlier.
    del decoder.domain_conditions[start:]
    return mapping


def inverse(mapping):
    actual = image(mapping, mapping.domain)
    subset(mapping.codomain, actual)
    if mapping.domain is s.S.EmptySet:
        return Mapping('inverse', mapping.codomain, mapping.domain, inner=mapping)
    if isinstance(mapping.domain, s.FiniteSet):
        require(isinstance(actual, s.FiniteSet) and len(actual) == len(mapping.domain),
                'Different domain values have the same image')
    elif mapping.kind == 'inverse':
        return mapping.inner
    elif mapping.kind == 'compose':
        try:
            outer_inverse, inner_inverse = inverse(mapping.outer), inverse(mapping.inner)
        except CasInputProblem as error:
            if error.code in ('domain', 'unevaluated'):
                # A composition may be bijective even when a factor is not
                # bijective over its entire declared codomain. Do not claim
                # that the composition is invalid from that failed proof.
                unknown('The bijection of this composite mapping is not established')
            raise
        return Mapping('compose', mapping.codomain, mapping.domain,
                       outer=inner_inverse, inner=outer_inverse)
    elif interval(mapping.domain):
        interior = s.S.Reals if mapping.domain == s.S.Reals else s.Interval.open(mapping.domain.start, mapping.domain.end)
        derivative = s.diff(mapping.body, mapping.variable)
        if interior.is_subset(continuous_domain(derivative, mapping.variable, s.S.Reals)) is not True:
            unknown('The sufficient monotonicity proof has not been established')
        zeros = resolved_set(s.solveset(derivative, mapping.variable, domain=interior))
        if not isinstance(zeros, s.FiniteSet) and zeros is not s.S.EmptySet:
            unknown('Strict monotonicity is not established')
        positive = resolved_set(truth_set(derivative >= 0, mapping.variable, interior))
        negative = resolved_set(truth_set(derivative <= 0, mapping.variable, interior))
        if interior.is_subset(positive) is not True and interior.is_subset(negative) is not True:
            unknown('The map is not proved one-to-one over its full domain')
    else:
        unknown('The complete bijection proof is not available for this domain')
    return Mapping('inverse', mapping.codomain, mapping.domain, inner=mapping)


def mapping_operation(decoder, operation, operands, scope, depth):
    if decoder.domain_observer is not None or decoder.smooth_point is not None:
        unknown('A nested mapping needs a separate regularity proof')
    try:
        if operation == 'mapping':
            return declare(decoder, operands, scope, depth)
        count = 1 if operation == 'mapping-inverse' else 2
        if len(operands) != count:
            raise CasInputProblem('syntax', 'The mapping operation has an invalid operand count')
        args = [decoder.node(item, scope, depth + 1) for item in operands]
        first = args[0]
        if not isinstance(first, Mapping):
            raise CasInputProblem('domain', 'A declared mapping is required')
        if operation == 'mapping-compose':
            second = args[1]
            if not isinstance(second, Mapping):
                raise CasInputProblem('domain', 'Composition needs two mappings')
            subset(second.codomain, first.domain)
            return Mapping('compose', second.domain, first.codomain, outer=first, inner=second)
        if operation == 'mapping-inverse':
            return inverse(first)
        if operation == 'mapping-value':
            return apply(first, args[1])
        if operation == 'mapping-image':
            return image(first, args[1])
        if operation == 'mapping-preimage':
            return preimage(first, args[1])
        raise CasInputProblem('unsupported', 'Unknown mapping operation')
    except NotImplementedError:
        unknown('The complete mapping proof has not been established')


def mapping_result(source, decoder):
    value = decoder.node(source)
    if not isinstance(value, Mapping):
        raise CasInputProblem('domain', 'The requested result is not a mapping')
    if any(s.simplify(condition) is not s.true for condition in decoder.domain_conditions):
        unknown('The original mapping declaration has unresolved conditions')
    return {'status': 'value', 'kind': 'function', 'request': source,
            'domainConditions': [], 'coordinateAuthorized': False}
