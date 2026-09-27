"""Exact real-basis Fourier coefficients on a finite interval, with explicit partial sums.

Basis functions always use radians and period b-a. The source function retains
its saved angle convention. A truncation is never presented as a certified
approximation of the original function. a0/2 is stored separately from a1..aN.
"""
import sympy as s
from sympy.calculus.util import continuous_domain
from cas_input import CasInputProblem, fields, reference_key
from cas_result import Encoder
from cas_integrals import integral_value
from cas_sequences import check_size, sequence_budget


def absolute_integrability(body, variable, lower, upper, conditions):
    try:
        return integral_value(s.Abs(body), variable, lower, upper, conditions, CasInputProblem)
    except CasInputProblem as error:
        if error.code != 'unevaluated':
            raise
        # Abs(log(x)) can remain unevaluated even though -log(x) integrates
        # exactly on (0,1). Remove Abs only after proving the sign everywhere
        # in the open interval, never by sampling or cancelling divergent sides.
        interior = s.Interval.open(lower, upper)
        for direction in (1, -1):
            try:
                domain = s.solve_univariate_inequality(direction*body >= 0, variable, relational=False)
                if interior-domain is s.S.EmptySet:
                    return integral_value(direction*body, variable, lower, upper, conditions, CasInputProblem)
            except (NotImplementedError, TypeError, ValueError):
                continue
        raise error


def smooth_pieces(body, variable, lower, upper):
    """A sufficient Dirichlet proof: finitely many C1 pieces with finite one-sided derivatives."""
    try:
        real = s.simplify(s.im(body))
        if real != 0:
            return None
        pieces = s.piecewise_fold(body.rewrite(s.Piecewise))
        interval = s.Interval.open(lower, upper)
        parts = pieces.as_expr_set_pairs(domain=interval) if isinstance(pieces, s.Piecewise) else [(pieces, interval)]
        if len(parts) > 32:
            return None
        covered = s.S.EmptySet
        for expression, domain in parts:
            if isinstance(domain, s.FiniteSet):
                continue
            segments = domain.args if isinstance(domain, s.Union) else [domain]
            for segment in segments:
                if not isinstance(segment, s.Interval):
                    return None
                derivative = s.diff(expression, variable)
                interior = s.Interval.open(segment.start, segment.end)
                for item in (expression, derivative):
                    if interior - continuous_domain(item, variable, interior) is not s.S.EmptySet:
                        return None
                    for point, direction in ((segment.start, '+'), (segment.end, '-')):
                        if s.limit(item, variable, point, dir=direction).is_finite is not True:
                            return None
                covered = covered.union(segment)
        missing = interval-covered
        if missing is not s.S.EmptySet and not isinstance(missing, s.FiniteSet):
            return None
        left, right = s.limit(body, variable, lower, dir='+'), s.limit(body, variable, upper, dir='-')
        if left.is_finite is not True or right.is_finite is not True:
            return None
        return s.simplify((left+right)/2)
    except (NotImplementedError, ValueError, TypeError):
        return None


def compute_series(source, decoder, scope=None, depth=0):
    fields(source, ('kind', 'operation', 'operands'))
    operands = source['operands']
    if source['kind'] != 'operation' or source['operation'] != 'fourier-series' or type(operands) is not list or len(operands) != 4:
        raise CasInputProblem('syntax', 'A Fourier series needs a function, finite interval and highest harmonic')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if function['kind'] != 'binder' or function['operation'] != 'lambda' or type(function['bindings']) is not list or len(function['bindings']) != 1:
        raise CasInputProblem('syntax', 'Bind one Fourier variable')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    key = reference_key(binding['variable'])
    if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
        raise CasInputProblem('syntax', 'The Fourier variable must be locally bound')
    lower, upper, degree = [decoder.node(value, scope, depth+1) for value in operands[1:]]
    if any(not isinstance(value, s.Expr) or value.free_symbols or value.is_real is not True or value.is_finite is not True for value in (lower, upper)):
        raise CasInputProblem('domain', 'The period endpoints must be finite resolved real values')
    if s.simplify(upper-lower).is_positive is not True:
        raise CasInputProblem('domain', 'The period endpoints must be strictly increasing')
    if not isinstance(degree, s.Integer) or degree < 0:
        raise CasInputProblem('domain', 'The highest harmonic must be a nonnegative integer')
    if degree > 12:
        raise CasInputProblem('budget', 'The highest harmonic exceeds 12')
    decoder.fourier_series_work = getattr(decoder, 'fourier_series_work', 0) + 2*int(degree)+1
    if decoder.fourier_series_work > 100:
        raise CasInputProblem('budget', 'Too many Fourier coefficients in one request')
    variable = s.Dummy('pcad_fourier_series', real=True)
    decoder.references[variable] = dict(binding['variable'])
    nested = dict(scope or {})
    nested[key] = variable
    condition_start = len(decoder.domain_conditions)
    observed, previous_observer = [], decoder.domain_observer
    decoder.domain_observer = observed.append
    try:
        body = decoder.node(function['body'], nested, depth+1)
    finally:
        decoder.domain_observer = previous_observer
    if not isinstance(body, s.Expr) or body.free_symbols - {variable}:
        raise CasInputProblem('unevaluated', 'Resolve all Fourier function parameters')
    conditions = decoder.domain_conditions[condition_start:]
    # Establish the original integrability before simplification or a selected
    # coefficient can hide a nonintegrable operand (including multiplication by 0).
    for item in set(observed + [body]):
        absolute_integrability(item, variable, lower, upper, conditions)
    period = upper-lower
    def coefficient(weight):
        value = s.simplify(integral_value(body*weight, variable, lower, upper, conditions, CasInputProblem)/period)
        check_size(value, CasInputProblem)
        if value.free_symbols or value.is_finite is not True:
            raise CasInputProblem('unevaluated', 'A finite exact Fourier coefficient could not be established')
        return value
    constant = coefficient(s.S.One)
    cosine, sine = [], []
    for harmonic in range(1, int(degree)+1):
        phase = 2*s.pi*harmonic*variable/period
        cosine.append(coefficient(2*s.cos(phase)))
        sine.append(coefficient(2*s.sin(phase)))
    endpoint_mean = smooth_pieces(body, variable, lower, upper)
    del decoder.domain_conditions[condition_start:]
    return lower, upper, int(degree), constant, cosine, sine, endpoint_mean


def fourier_series_result(source, decoder):
    with sequence_budget(decoder):
        lower, upper, degree, constant, cosine, sine, endpoint = compute_series(source, decoder)
        encoder = Encoder(decoder)
        return {'status': 'value', 'kind': 'fourier-series', 'request': source,
                'series': {'lower': encoder.node(lower), 'upper': encoder.node(upper), 'degree': str(degree),
                           'constant': encoder.node(constant), 'cosine': [encoder.node(value) for value in cosine],
                           'sine': [encoder.node(value) for value in sine], 'convention': 'real-harmonics-radian',
                           'convergence': 'unknown' if endpoint is None else 'piecewise-smooth',
                           'endpointMean': None if endpoint is None else encoder.node(endpoint)},
                'domainConditions': [], 'coordinateAuthorized': False}


def fourier_series_select(decoder, operation, operands, scope, depth):
    if len(operands) != 2:
        raise CasInputProblem('syntax', 'Select a Fourier series and a coefficient or partial-sum argument')
    with sequence_budget(decoder):
        lower, upper, degree, constant, cosine, sine, _ = compute_series(operands[0], decoder, scope, depth+1)
        selected = decoder.node(operands[1], scope, depth+1)
        if operation != 'fourier-value':
            if not isinstance(selected, s.Integer) or selected < 0 or selected > degree:
                raise CasInputProblem('domain', 'The selected harmonic is outside the retained series')
            if selected == 0:
                return 2*constant if operation == 'fourier-cosine' else s.S.Zero
            return (cosine if operation == 'fourier-cosine' else sine)[int(selected)-1]
        if not isinstance(selected, s.Expr) or selected.free_symbols or selected.is_real is not True or selected.is_finite is not True:
            raise CasInputProblem('domain', 'The partial-sum argument must be a resolved finite real value')
        value = constant
        for harmonic, (a, b) in enumerate(zip(cosine, sine), 1):
            phase = 2*s.pi*harmonic*selected/(upper-lower)
            value += a*s.cos(phase) + b*s.sin(phase)
        value = s.simplify(value)
        check_size(value, CasInputProblem)
        if value.is_finite is not True:
            raise CasInputProblem('unevaluated', 'A finite partial-sum value could not be established')
        return value
