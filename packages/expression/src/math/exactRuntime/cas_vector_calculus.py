"""Cartesian derivatives at a point, with a local smoothness proof before simplification."""
import sympy as s
from cas_gamma_functions import gamma_point, beta_point
from cas_bessel_functions import BESSEL, bessel_point, real_finite

OPERATIONS = {'gradient-at', 'divergence-at', 'curl-at', 'laplacian-at', 'jacobian-at', 'hessian-at'}


def finite_real(value, problem):
    if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
        raise problem('domain', 'A finite real scalar is required')
    if value.is_real is False or value.is_finite is False or value.has(s.zoo, s.nan):
        raise problem('domain', 'The Cartesian value must be finite and real')
    if (value.is_real is not True or value.is_finite is not True) and not real_finite(value):
        raise problem('unevaluated', 'The finite real value has not been established')
    return value


def point_value(value, targets, problem):
    if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
        raise problem('domain', 'A scalar field component is required')
    return finite_real(value.subs(targets, simultaneous=True), problem)


def smooth_operation(operation, arguments, targets, angle_unit, problem):
    """Induct on original operands, not a simplified expression or just axis slices.

    Strict inequalities and nonzero continuous denominators establish an open
    neighbourhood. Nonsmooth boundaries remain unresolved, never guessed smooth.
    """
    if operation in ('list', 'matrix', 'component'):
        return
    points = [point_value(value, targets, problem) for value in arguments]
    if all(not value.free_symbols.intersection(targets) for value in arguments):
        return
    if operation in ('gamma', 'polygamma'):
        gamma_point(points[-1], problem)
        return
    if operation == 'beta':
        beta_point(points, problem)
        return
    if operation in BESSEL:
        bessel_point(BESSEL[operation], points[1], problem)
        return
    if operation in ('add', 'subtract', 'negate', 'multiply', 'square', 'exponential', 'legendre', 'erf', 'erfc',
                     'sin', 'cos', 'sinh', 'cosh', 'tanh', 'arsinh', 'arctan',
                     'real-part', 'imaginary-part', 'conjugate'):
        return
    if operation == 'divide':
        if points[1].is_zero is True:
            raise problem('domain', 'The original denominator vanishes at the evaluation point')
        if points[1].is_zero is False:
            return
    elif operation == 'power':
        base, exponent = points
        if not arguments[1].free_symbols.intersection(targets) and exponent.is_integer is True:
            if exponent.is_nonnegative is True or base.is_zero is False:
                return
        if base.is_positive is True:
            return
    elif operation in ('natural-log', 'sqrt') and points[0].is_positive is True:
        return
    elif operation == 'absolute' and points[0].is_zero is False:
        return
    elif operation in ('arcsin', 'arccos', 'artanh') and (1-points[0]**2).is_positive is True:
        return
    elif operation == 'arcosh' and (points[0]-1).is_positive is True:
        return
    elif operation in ('tan', 'cot', 'sec', 'csc'):
        scale = s.pi/180 if angle_unit == 'degree' else s.S.One
        denominator = (s.cos if operation in ('tan', 'sec') else s.sin)(points[0]*scale)
        if denominator.is_zero is True:
            raise problem('domain', 'The original trigonometric function has a pole')
        if denominator.is_zero is False:
            return
    raise problem('unevaluated', 'A smooth real neighbourhood of the whole field has not been established')


def vector_at(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != 2:
        raise problem('syntax', 'A Cartesian function and an explicit point are required')
    function, point = operands
    fields(function, ('kind', 'operation', 'body', 'bindings'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or not 1 <= len(function['bindings']) <= 3):
        raise problem('syntax', 'One to three ordered Cartesian variables are required')
    targets = decoder.node(point, scope, depth+1)
    if type(targets) is not tuple or len(targets) != len(function['bindings']):
        raise problem('domain', 'The point must have one scalar coordinate per variable')
    for target in targets:
        finite_real(target, problem)
    variables, nested, keys = [], dict(scope), set()
    for binding in function['bindings']:
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys or binding['domain']['kind'] != 'unrestricted':
            raise problem('syntax', 'Distinct local Cartesian variables are required')
        variable = s.Dummy('pcad_cartesian_' + str(len(decoder.references)), real=True)
        decoder.references[variable] = dict(binding['variable'])
        variables.append(variable)
        nested[key] = variable
        keys.add(key)
    point_map = dict(zip(variables, targets))
    previous, start = decoder.smooth_point, len(decoder.domain_conditions)
    decoder.smooth_point = point_map
    try:
        body = decoder.node(function['body'], nested, depth+1)
    finally:
        decoder.smooth_point = previous
    for condition in decoder.domain_conditions[start:]:
        truth = condition.subs(point_map, simultaneous=True)
        if truth is s.false:
            raise problem('domain', 'An original field condition fails at the evaluation point')
        if truth is not s.true:
            raise problem('unevaluated', 'An original field condition remains unresolved')
    del decoder.domain_conditions[start:]
    width = len(variables)
    vector = operation in ('divergence-at', 'curl-at', 'jacobian-at')
    if vector:
        if type(body) is not tuple or not 1 <= len(body) <= 16:
            raise problem('domain', 'An explicit vector of one to sixteen scalar components is required')
        for component in body:
            point_value(component, point_map, problem)
        if operation != 'jacobian-at' and (len(body) != width or operation == 'curl-at' and width != 3):
            raise problem('domain', 'Field dimensions and Cartesian variables do not match')
    else:
        point_value(body, point_map, problem)

    def partial(component, *indices):
        # Differentiate before simultaneous substitution; no coordinate is
        # silently assumed to be zero and no mixed-variable order is reordered.
        result = s.diff(component, *(variables[index] for index in indices))
        return point_value(result, point_map, problem)

    if operation == 'gradient-at':
        return tuple(partial(body, i) for i in range(width))
    if operation == 'hessian-at':
        return s.ImmutableMatrix([[partial(body, i, j) for j in range(width)] for i in range(width)])
    if operation == 'laplacian-at':
        return sum((partial(body, i, i) for i in range(width)), s.S.Zero)
    if operation == 'jacobian-at':
        return s.ImmutableMatrix([[partial(component, i) for i in range(width)] for component in body])
    if operation == 'divergence-at':
        return sum((partial(component, i) for i, component in enumerate(body)), s.S.Zero)
    return tuple(partial(body[(i+2) % 3], (i+1) % 3)-partial(body[(i+1) % 3], (i+2) % 3)
                 for i in range(3))
