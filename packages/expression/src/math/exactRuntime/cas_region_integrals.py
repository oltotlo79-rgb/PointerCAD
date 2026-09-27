"""Area measure, oriented flux and volume measure on explicit finite boxes.

Every original field/mapping operand is checked before symbolic cancellation.
The mapping may cover a region more than once: multiplicity is retained.
"""
import sympy as s
from cas_box_domain import BoxDomain
from cas_line_integrals import function_bindings
from cas_vector_calculus import finite_real

OPERATIONS = {'surface-integral', 'flux-integral', 'volume-integral'}


def finite_box(decoder, lower_node, upper_node, dimension, scope, depth, problem):
    lower = decoder.node(lower_node, scope, depth+1)
    upper = decoder.node(upper_node, scope, depth+1)
    if type(lower) is not tuple or type(upper) is not tuple or len(lower) != dimension or len(upper) != dimension:
        raise problem('domain', 'One lower and upper endpoint per parameter is required')
    bounds, orientation = [], s.S.One
    for a, b in zip(lower, upper):
        finite_real(a, problem)
        finite_real(b, problem)
        if a.free_symbols or b.free_symbols:
            raise problem('unevaluated', 'Finite resolved parameter endpoints are required')
        reverse = s.StrictGreaterThan(a, b)
        if reverse not in (s.true, s.false):
            raise problem('unevaluated', 'The parameter endpoint order is unresolved')
        if reverse is s.true:
            a, b, orientation = b, a, -orientation
        bounds.append((a, b))
    return bounds, orientation


def region_integral(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != 4:
        raise problem('syntax', 'A field, mapping and two endpoint lists are required')
    field, mapping, lower, upper = operands
    field_keys = function_bindings(field, fields, reference_key, problem)
    mapping_keys = function_bindings(mapping, fields, reference_key, problem)
    dimension = 3 if operation == 'volume-integral' else 2
    if len(field_keys) != 3 or len(mapping_keys) != dimension:
        raise problem('domain', 'Three field coordinates and two or three parameters are required')
    bounds, orientation = finite_box(decoder, lower, upper, dimension, scope, depth, problem)
    variables = []
    for binding in mapping['bindings']:
        variable = s.Dummy('pcad_region_' + str(len(decoder.references)), real=True)
        decoder.references[variable] = dict(binding['variable'])
        variables.append(variable)
    box = dict(zip(variables, bounds))
    mapping_domain = BoxDomain(box, problem, smooth=True)
    field_domain = BoxDomain(box, problem)
    previous, start = decoder.domain_observer, len(decoder.domain_conditions)
    try:
        decoder.domain_observer = mapping_domain
        coordinates = decoder.node(mapping['body'], {**scope, **dict(zip(mapping_keys, variables))}, depth+1)
        if type(coordinates) is not tuple or len(coordinates) != 3:
            raise problem('domain', 'The mapping must have three real scalar coordinates')
        mapping_domain.conditions(decoder.domain_conditions[start:])
        derivatives = s.Matrix(coordinates).jacobian(variables)
        # Check the derived values too. Zero Jacobians and sphere poles have
        # finite derivatives; they must not be mistaken for undefined formulas.
        for value in derivatives:
            field_domain(value)
        decoder.domain_observer = field_domain
        field_start = len(decoder.domain_conditions)
        body = decoder.node(field['body'], {**scope, **dict(zip(field_keys, coordinates))}, depth+1)
        field_domain.conditions(decoder.domain_conditions[field_start:])
        if operation == 'volume-integral':
            field_domain(body)
            weight = s.Abs(s.trigsimp(derivatives.det()))
            integrand = body * weight
        else:
            normal = derivatives[:, 0].cross(derivatives[:, 1])
            if operation == 'flux-integral':
                if type(body) is not tuple or len(body) != 3:
                    raise problem('domain', 'Flux requires three real field components')
                for value in body:
                    field_domain(value)
                integrand = orientation * sum((value * direction for value, direction in zip(body, normal)), s.S.Zero)
            else:
                field_domain(body)
                weight = s.sqrt(s.trigsimp(normal.dot(normal)))
                integrand = body * weight
        # A continuous bounded integrand on this compact box is absolutely
        # integrable. Do not extend this proof to arbitrary or improper domains.
        integrand = s.trigsimp(integrand)
        limits = [(variable, *box[variable]) for variable in reversed(variables)]
        if decoder.angle_unit == 'degree' and integrand.has(s.sin, s.cos, s.tan, s.cot, s.sec, s.csc):
            # Positive linear changes of all integration variables preserve the
            # domain and orientation. Integrate trigonometry in radians instead
            # of asking the symbolic solver to partition Abs(sin(pi*u/180)).
            scale = s.pi/180
            replacements, limits = {}, []
            for variable in reversed(variables):
                normalized = s.Dummy('pcad_region_radian', real=True)
                replacements[variable] = normalized/scale
                limits.append((normalized, box[variable][0]*scale, box[variable][1]*scale))
            integrand = s.simplify(integrand.subs(replacements, simultaneous=True)/scale**dimension)
        result = s.integrate(integrand, *limits)
        if result.has(s.Integral) or result.free_symbols:
            raise problem('unevaluated', 'The exact region integral remains unresolved')
        return finite_real(result, problem)
    finally:
        decoder.domain_observer = previous
        del decoder.domain_conditions[start:]
