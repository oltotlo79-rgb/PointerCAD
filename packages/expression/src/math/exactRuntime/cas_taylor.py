"""Exact local Taylor coefficients, with truncation distinct from numerical error.

A finite Taylor polynomial does not establish convergence of its infinite series.
Only holomorphic composition and fully enumerated polynomial poles certify an
open disk below. Boundary points, branch functions, and other cases stay unknown.
"""
import sympy as s
from cas_input import CasInputProblem, fields, reference_key
from cas_result import Encoder
from cas_derivatives import derivative_at, point_domain
from cas_sequences import check_size, sequence_budget
from cas_gamma_functions import gamma_argument_radius, beta_argument_radius
from cas_bessel_functions import FAMILIES, POSITIVE_ARGUMENT, real_finite


def polynomial_degree_bound(expression, variable):
    """An upper degree bound without expanding a potentially enormous power."""
    if not expression.has(variable):
        return 0
    if expression == variable:
        return 1
    if expression.is_Add or expression.is_Mul:
        degrees = [polynomial_degree_bound(child, variable) for child in expression.args]
        if any(degree is None for degree in degrees):
            return None
        return max(degrees) if expression.is_Add else sum(degrees)
    if expression.is_Pow and isinstance(expression.exp, s.Integer) and expression.exp >= 0:
        degree = polynomial_degree_bound(expression.base, variable)
        return None if degree is None else degree * int(expression.exp)
    return None


def analytic_radius(expression, variable, center):
    """Prove a sufficient complex disk; None means no proof, not radius zero."""
    if not expression.has(variable):
        return s.oo if expression.is_finite is True or real_finite(expression) else None
    if expression == variable:
        return s.oo
    if expression.func in FAMILIES:
        argument = expression.args[1]
        if expression.func in POSITIVE_ARGUMENT:
            return beta_argument_radius(argument, variable, center)
        return analytic_radius(argument, variable, center)
    if expression.func in (s.gamma, s.polygamma):
        return gamma_argument_radius(expression.args[-1], variable, center)
    if expression.func is s.beta:
        radii = [beta_argument_radius(argument, variable, center) for argument in expression.args]
        return None if any(radius is None for radius in radii) else s.Min(*radii)
    if expression.is_Add or expression.is_Mul or expression.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        radii = [analytic_radius(child, variable, center) for child in expression.args]
        return None if any(radius is None for radius in radii) else s.Min(*radii)
    if expression.is_Pow and isinstance(expression.exp, s.Integer):
        base, exponent = expression.args
        radius = analytic_radius(base, variable, center)
        if radius is None or exponent >= 0:
            return radius
        degree = polynomial_degree_bound(base, variable)
        if degree is None or degree > 12:
            return None
        polynomial = s.Poly(base, variable)
        try:
            roots = s.roots(polynomial, variable)
        except (NotImplementedError, s.PolynomialError):
            return None
        if sum(roots.values()) != polynomial.degree():
            return None
        distances = [s.simplify(s.Abs(root-center)) for root in roots]
        if any(distance.is_positive is not True for distance in distances):
            return None
        return s.Min(radius, *distances)
    return None


def taylor_result(source, decoder, scope=None, depth=0):
    # Share the existing exact-digit guard, including center/order expressions
    # and original operands that simplification could otherwise erase.
    with sequence_budget(decoder):
        return bounded_taylor_result(source, decoder, scope, depth)


def bounded_taylor_result(source, decoder, scope, depth):
    fields(source, ('kind', 'operation', 'operands'))
    operands = source['operands']
    if source['kind'] != 'operation' or type(operands) is not list or len(operands) != (3 if source['operation'] == 'taylor' else 2):
        raise CasInputProblem('syntax', 'An expansion needs a function, center and degree')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if function['kind'] != 'binder' or function['operation'] != 'lambda' or type(function['bindings']) is not list or len(function['bindings']) != 1:
        raise CasInputProblem('syntax', 'An expansion binds one local variable')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    key = reference_key(binding['variable'])
    if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
        raise CasInputProblem('syntax', 'Invalid expansion variable')
    center = decoder.node(operands[1], scope, depth+1) if source['operation'] == 'taylor' else s.S.Zero
    degree = decoder.node(operands[-1], scope, depth+1)
    if not isinstance(center, s.Expr) or center.is_real is not True or center.is_finite is not True or center.free_symbols:
        raise CasInputProblem('domain', 'An expansion center must be a resolved finite real value')
    if not isinstance(degree, s.Integer) or degree < 0:
        raise CasInputProblem('domain', 'An expansion degree must be a nonnegative integer')
    if degree > 12:
        raise CasInputProblem('budget', 'Taylor degree exceeds the finite calculation budget')
    variable = s.Dummy('pcad_taylor_variable', real=True)
    decoder.references[variable] = dict(binding['variable'])
    observed = []
    nested_scope = dict(scope or {})
    nested_scope[key] = variable
    decoder.domain_observer = observed.append
    try:
        body = decoder.node(function['body'], nested_scope, depth+1)
    finally:
        decoder.domain_observer = None
    if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase) or body.free_symbols - {variable}:
        raise CasInputProblem('unevaluated', 'Resolve the scalar function parameters before expansion')
    # Every original operand must be defined, even after algebraic cancellation.
    for item in observed:
        point_domain(item, variable, center, decoder.domain_conditions, CasInputProblem)
    point_domain(body, variable, center, decoder.domain_conditions, CasInputProblem)
    radii = [analytic_radius(item, variable, center) for item in observed]
    for condition in decoder.domain_conditions:
        if isinstance(condition, s.Unequality):
            radii.append(analytic_radius(s.Pow(condition.lhs-condition.rhs, -1, evaluate=False), variable, center))
        elif condition is not s.true:
            # Only the condition recorded by the original Gamma operand may use
            # this pole-distance proof. Other unresolved propositions stay unknown.
            arguments = [argument for argument, recorded in decoder.gamma_domains if recorded == condition]
            radii.extend(gamma_argument_radius(argument, variable, center) for argument in arguments)
            beta_arguments = [argument for argument, recorded in decoder.beta_domains if recorded == condition]
            radii.extend(beta_argument_radius(argument, variable, center) for argument in beta_arguments)
            bessel_arguments = [argument for argument, recorded in decoder.bessel_domains if recorded == condition]
            radii.extend(beta_argument_radius(argument, variable, center) for argument in bessel_arguments)
            if not arguments and not beta_arguments and not bessel_arguments:
                radii.append(None)
    radius = None if any(value is None for value in radii) else s.Min(*radii)
    if radius is not None and radius is not s.oo and radius.is_positive is not True:
        radius = None
    coefficients = [body.subs(variable, center)]
    current = body
    for order in range(1, int(degree)+2):
        # Analyticity of every original operand proves the local derivatives.
        # Otherwise retain the classical two-sided difference-quotient check.
        derivative = s.diff(current, variable)
        check_size(derivative, CasInputProblem)
        value = (derivative.subs(variable, center) if radius is not None else
                 derivative_at(current, variable, center, s.S.One, decoder.domain_conditions, CasInputProblem))
        check_size(value, CasInputProblem)
        if order <= degree:
            coefficients.append(s.cancel(value/s.factorial(order)))
        current = derivative
    if any(value.free_symbols or (value.is_finite is not True and not real_finite(value)) for value in coefficients):
        raise CasInputProblem('unevaluated', 'The expansion coefficients must be exact finite values')
    # A polynomial of degree <= n equals its Taylor polynomial. Establish that
    # degree structurally; never expand a million-degree body to decide this flag.
    degree_bound = polynomial_degree_bound(body, variable)
    exact = bool(degree_bound is not None and degree_bound <= degree and not decoder.domain_conditions)
    encoder = Encoder(decoder)
    expansion = {'center': encoder.node(center), 'degree': str(degree),
                 'coefficients': [encoder.node(value) for value in coefficients],
                 'exact': exact, 'remainderOrder': str(degree+1),
                 'convergence': {'kind': 'unknown' if radius is None else 'entire' if radius is s.oo else 'disk',
                                 'radius': None if radius is None or radius is s.oo else encoder.node(radius)}}
    return {'status': 'value', 'kind': 'series', 'expansion': expansion,
            'domainConditions': [], 'coordinateAuthorized': False}


def series_coefficient(decoder, operands, scope, depth):
    """Select an exact coefficient; never evaluate the truncated polynomial as f(x)."""
    if (len(operands) != 2 or type(operands[0]) is not dict
            or operands[0].get('kind') != 'operation'
            or operands[0].get('operation') not in ('taylor', 'maclaurin')):
        raise CasInputProblem('syntax', 'Select a coefficient from an explicit Taylor expansion')
    condition_start = len(decoder.domain_conditions)
    with sequence_budget(decoder):
        order = decoder.node(operands[1], scope, depth+1)
        if not isinstance(order, s.Integer) or order < 0 or order > 12:
            raise CasInputProblem('domain', 'The selected coefficient degree must be an integer from 0 to 12')
        result = taylor_result(operands[0], decoder, scope, depth+1)['expansion']
        if order > int(result['degree']):
            raise CasInputProblem('domain', 'The selected degree is outside the retained expansion')
        # These local conditions were proved at the expansion center, not at an
        # arbitrary coordinate. Keep every pre-existing outer domain obligation.
        del decoder.domain_conditions[condition_start:]
        return decoder.node(result['coefficients'][int(order)], scope, depth+1)
