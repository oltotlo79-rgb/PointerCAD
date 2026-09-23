"""Classical real-axis derivatives with original domains and analytic or limit proofs."""
import sympy as s
from sympy.calculus.util import continuous_domain
from cas_limits import limit_value
from cas_gamma_functions import gamma_point, beta_point
from cas_bessel_functions import FAMILIES, bessel_point
from cas_lambert_functions import lambert_point, derivative as lambert_derivative
from cas_airy_functions import FAMILIES as AIRY, airy_point
from cas_elliptic_functions import FAMILIES as ELLIPTIC, elliptic_point, signature as elliptic_signature
from cas_elliptic_functions import regularize_characteristic_zero
from cas_zeta_functions import FAMILIES as ZETA, real_finite, analytic_at, zeta_point, signature as zeta_signature
from cas_error_functions import complex_finite, error_point, error_analytic_at


def point_domain(body, variable, target, conditions, problem):
    """Require an open real neighbourhood; simplification cannot fill an original hole."""
    for condition in conditions:
        at = condition.subs(variable, target)
        if at is s.false:
            raise problem('domain', 'The original expression is undefined at the evaluation point')
        if at is not s.true:
            raise problem('unevaluated', 'The original point condition has not been established')
    zeta = zeta_signature(body)
    if zeta is not None:
        order, argument = zeta
        point_domain(argument, variable, target, conditions, problem)
        zeta_point(order, argument.subs(variable, target), problem)
        return
    elliptic = elliptic_signature(body)
    if elliptic is not None:
        operation, arguments = elliptic
        for argument in arguments:
            point_domain(argument, variable, target, conditions, problem)
        elliptic_point(operation, tuple(argument.subs(variable, target) for argument in arguments),
                       problem, tuple(argument.has(variable) for argument in arguments))
        return
    if body.func in AIRY:
        argument = body.args[0]
        point_domain(argument, variable, target, conditions, problem)
        airy_point(argument.subs(variable, target), problem)
        return
    if body.func is s.LambertW:
        argument = body.args[0]
        branch = body.args[1] if len(body.args) == 2 else s.S.Zero
        point_domain(argument, variable, target, conditions, problem)
        lambert_point(branch, argument.subs(variable, target), problem, strict=True)
        return
    if body.func in FAMILIES:
        argument = body.args[1]
        point_domain(argument, variable, target, conditions, problem)
        bessel_point(body.func, argument.subs(variable, target), problem)
        return
    if body.func in (s.gamma, s.polygamma):
        argument = body.args[-1]
        point_domain(argument, variable, target, conditions, problem)
        gamma_point(argument.subs(variable, target), problem)
        return
    if body.func is s.beta:
        for argument in body.args:
            point_domain(argument, variable, target, conditions, problem)
        beta_point([argument.subs(variable, target) for argument in body.args], problem)
        return
    if body.has(s.gamma, s.polygamma, s.beta, s.LambertW, *FAMILIES, *AIRY, *ELLIPTIC, *ZETA) and body.is_Pow and body.exp.is_Integer:
        point_domain(body.base, variable, target, conditions, problem)
        if body.exp >= 0:
            return
        at = body.base.subs(variable, target)
        if at.is_zero is True:
            raise problem('domain', 'The original reciprocal vanishes at the evaluation point')
        if at.is_zero is False:
            return
        raise problem('unevaluated', 'The original reciprocal has no proved nonzero neighbourhood')
    if body.has(s.erf, s.erfc, s.gamma, s.polygamma, s.beta, s.LambertW, *FAMILIES, *AIRY, *ELLIPTIC, *ZETA) and (body.func in (s.erf, s.erfc, s.exp, s.sin, s.cos, s.sinh, s.cosh) or body.is_Add or body.is_Mul):
        # erf/erfc are entire. Their composition is continuous wherever the
        # original argument is continuous; never erase a pole in that argument.
        # SymPy continuous_domain does not currently establish these functions.
        for argument in body.args:
            point_domain(argument, variable, target, conditions, problem)
        return
    try:
        domain = (continuous_domain(s.re(body), variable, s.S.Reals).intersect(
            continuous_domain(s.im(body), variable, s.S.Reals)) if body.has(s.I)
            else continuous_domain(body, variable, s.S.Reals))
        inside = (domain - domain.boundary).contains(target)
    except NotImplementedError:
        raise problem('unevaluated', 'An open derivative neighbourhood has not been established') from None
    if inside is s.false:
        raise problem('domain', 'The derivative requires a two-sided real neighbourhood')
    if inside is not s.true:
        raise problem('unevaluated', 'The derivative neighbourhood depends on unresolved conditions')


def derivative_at(body, variable, target, order, conditions, problem):
    if not isinstance(order, s.Integer) or not 1 <= order <= 15:
        raise problem('domain', 'Derivative order must be an integer from 1 to 15')
    if target.is_real is not True or target.is_finite is not True:
        raise problem('domain', 'A derivative evaluation point must be finite and real')
    if body.has(s.Integral, s.Derivative, s.Limit, s.Sum, s.Product):
        raise problem('unevaluated', 'An inner calculation remains unresolved')
    if body.has(*ZETA):
        point_domain(body, variable, target, conditions, problem)
        if not analytic_at(body, variable, target):
            raise problem('unevaluated', 'An analytic zeta neighbourhood has not been established')
        value = s.diff(body, variable, int(order)).subs(variable, target)
        if not real_finite(value):
            raise problem('unevaluated', 'Finiteness of the zeta derivative is unresolved')
        return value
    if body.has(*ELLIPTIC):
        point_domain(body, variable, target, conditions, problem)
        if not analytic_at(body, variable, target):
            raise problem('unevaluated', 'An analytic elliptic neighbourhood has not been established')
        # Prove the original function analytic first. Differentiated formulas
        # can have removable m=0/n=0 denominators; do not invent original holes.
        local_body = regularize_characteristic_zero(body, variable, target, int(order))
        differentiated = s.diff(local_body, variable, int(order))
        value = differentiated.subs(variable, target)
        if value.has(s.oo, -s.oo, s.zoo, s.nan) or not real_finite(value):
            value = limit_value(differentiated, variable, target, s.S.Zero, [], problem)
        if value.is_finite is False or value.has(s.oo, -s.oo, s.zoo, s.nan):
            raise problem('domain', 'The elliptic derivative is not finite')
        if not real_finite(value):
            raise problem('unevaluated', 'Finiteness of the elliptic derivative is unresolved')
        return value
    current = body
    for _ in range(int(order)):
        point_domain(current, variable, target, conditions, problem)
        at = current.subs(variable, target)
        if not complex_finite(at) and not real_finite(at):
            raise problem('domain', 'The function must have a finite value at the derivative point')
        lambert_next = None
        if current.has(s.LambertW):
            if not analytic_at(current, variable, target):
                raise problem('unevaluated', 'An analytic Lambert W neighbourhood has not been established')
            lambert_next = lambert_derivative(current, variable)
            value = lambert_next.subs(variable, target)
        elif current.has(*AIRY):
            if not analytic_at(current, variable, target):
                raise problem('unevaluated', 'An analytic Airy neighbourhood has not been established')
            value = s.diff(current, variable).subs(variable, target)
        elif current.has(*FAMILIES):
            # The pinned limit engine misclassifies the integer J/I origin and
            # leaves I difference quotients unresolved. A proved analytic
            # neighbourhood permits the exact chain/adjacent-order rules.
            # Continuity alone (for example J_1(Abs(x))) is not sufficient.
            if not analytic_at(current, variable, target):
                raise problem('unevaluated', 'An analytic Bessel neighbourhood has not been established')
            value = s.diff(current, variable).subs(variable, target)
        elif current.has(s.erf, s.erfc) and error_analytic_at(current, variable, target):
            # Entire composition with a proved analytic argument permits the
            # exact chain rule. Continuity alone is not a differentiability proof.
            value = s.diff(current, variable).subs(variable, target)
        else:
            distance = s.Dummy('pcad_derivative_distance', real=True)
            quotient = (current.subs(variable, target+distance)-at)/distance
            try:
                value = limit_value(quotient, distance, s.S.Zero, s.S.Zero, [], problem)
            except problem as error:
                if error.code == 'no-limit':
                    raise problem('domain', 'The two difference-quotient limits do not agree') from None
                raise
        if value.is_finite is False or value.has(s.oo, -s.oo, s.zoo, s.nan):
            raise problem('domain', 'The derivative is not finite')
        if not complex_finite(value) and not real_finite(value):
            raise problem('unevaluated', 'Finiteness of the derivative is unresolved')
        # Do not substitute the target into the body before differentiating for
        # the next order. Nonclassical distributions are never used as coordinates.
        current = lambert_next if lambert_next is not None else s.diff(current, variable)
        if current.has(s.DiracDelta, s.Derivative) and _ + 1 < int(order):
            raise problem('unevaluated', 'The next classical derivative needs a separate domain proof')
    return value


def decode_derivative(decoder, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != 3:
        raise problem('syntax', 'A derivative needs a function, point and order')
    function, point, order_node = operands
    fields(function, ('kind', 'operation', 'body', 'bindings'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or len(function['bindings']) != 1):
        raise problem('syntax', 'A derivative needs exactly one local variable')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    key = reference_key(binding['variable'])
    if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
        raise problem('syntax', 'Invalid derivative variable')
    target, order = decoder.node(point, scope, depth+1), decoder.node(order_node, scope, depth+1)
    if not isinstance(target, s.Expr) or not isinstance(order, s.Expr):
        raise problem('domain', 'Scalar derivative point and order are required')
    variable = s.Dummy('pcad_derivative_' + str(len(decoder.references)), real=True)
    decoder.references[variable] = dict(binding['variable'])
    nested = dict(scope)
    nested[key] = variable
    start = len(decoder.domain_conditions)
    lambert_start = len(decoder.lambert_domains)
    airy_start = len(decoder.airy_arguments)
    elliptic_start = len(decoder.elliptic_domains)
    zeta_start = len(decoder.zeta_domains)
    error_start = len(decoder.error_arguments)
    body = decoder.node(function['body'], nested, depth+1)
    if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
        raise problem('domain', 'A scalar derivative body is required')
    local = decoder.domain_conditions[start:]
    # A zero multiplier or component selection can remove W from `body`.
    # Keep the original branch neighbourhood, while allowing a constant
    # W(-1/e) whose argument does not vary with this derivative variable.
    for branch, argument in decoder.lambert_domains[lambert_start:]:
        if variable in argument.free_symbols:
            lambert_point(branch, argument.subs(variable, target), problem, strict=True)
    for argument in decoder.airy_arguments[airy_start:]:
        airy_point(argument.subs(variable, target), problem)
    for zeta_order, argument in decoder.zeta_domains[zeta_start:]:
        zeta_point(zeta_order, argument.subs(variable, target), problem)
    for argument in decoder.error_arguments[error_start:]:
        error_point(argument.subs(variable, target), problem)
    for operation, arguments in decoder.elliptic_domains[elliptic_start:]:
        elliptic_point(operation, tuple(argument.subs(variable, target) for argument in arguments),
                       problem, tuple(argument.has(variable) for argument in arguments))
    result = derivative_at(body, variable, target, order, local, problem)
    del decoder.domain_conditions[start:]
    del decoder.lambert_domains[lambert_start:]
    del decoder.airy_arguments[airy_start:]
    del decoder.elliptic_domains[elliptic_start:]
    del decoder.zeta_domains[zeta_start:]
    del decoder.error_arguments[error_start:]
    return result

