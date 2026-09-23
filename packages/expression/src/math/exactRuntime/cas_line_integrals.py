"""Cartesian scalar arc-length integrals and oriented work along an explicit path."""
import sympy as s
from sympy.calculus.util import continuous_domain
from cas_integrals import finite_holes, integral_value
from cas_vector_calculus import finite_real

OPERATIONS = {'line-integral', 'circulation'}


class LineDomain:
    """Check original operands before a product or component selection can erase them."""
    def __init__(self, variable, region, allow_holes, problem):
        self.variable, self.region = variable, region
        self.allow_holes, self.problem = allow_holes, problem
        self.checked = set()

    def available(self, domain):
        missing = self.region - domain
        if missing is s.S.EmptySet:
            return
        if not self.allow_holes:
            raise self.problem('domain', 'The original path is not defined throughout its parameter range')
        finite_holes(self.region, domain, self.problem)

    def __call__(self, value):
        if value in self.checked:
            return
        if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
            raise self.problem('domain', 'A real scalar field or path component is required')
        if value.free_symbols - {self.variable}:
            raise self.problem('unevaluated', 'The line integral has unresolved parameters')
        if not value.free_symbols:
            finite_real(value, self.problem)
        else:
            if value.has(s.I) or value.is_real is False:
                raise self.problem('domain', 'A Cartesian path and field must be real')
            try:
                domain = continuous_domain(value, self.variable, self.region)
                # SymPy's real-domain helper accepts odd-denominator powers on
                # negative bases although Pow itself uses the complex principal
                # branch. Never use that mismatch to authorize real geometry.
                for power in value.atoms(s.Pow):
                    if power.exp.is_integer is not True and power.base.is_positive is not True:
                        relation = (s.Ge(power.base, 0) if power.exp.is_positive is True
                                    else s.Gt(power.base, 0))
                        domain = domain.intersect(s.solve_univariate_inequality(
                            relation, self.variable, relational=False))
                self.available(domain)
            except NotImplementedError:
                raise self.problem('unevaluated', 'The real path domain could not be established') from None
        self.checked.add(value)

    def conditions(self, conditions):
        for condition in conditions:
            if not isinstance(condition, s.Unequality):
                raise self.problem('unevaluated', 'An original line-integral condition is unresolved')
            zeros = s.solveset(condition.lhs-condition.rhs, self.variable, domain=self.region)
            self.available(self.region - zeros)


def function_bindings(function, fields, reference_key, problem):
    fields(function, ('kind', 'operation', 'body', 'bindings'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or not 1 <= len(function['bindings']) <= 3):
        raise problem('syntax', 'An explicit function of one to three variables is required')
    keys = []
    for binding in function['bindings']:
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys or binding['domain']['kind'] != 'unrestricted':
            raise problem('syntax', 'Distinct local variables are required')
        keys.append(key)
    return keys


def line_integral(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != 4:
        raise problem('syntax', 'A field, path and two parameter endpoints are required')
    field, path, lower_node, upper_node = operands
    field_keys = function_bindings(field, fields, reference_key, problem)
    path_keys = function_bindings(path, fields, reference_key, problem)
    if len(path_keys) != 1:
        raise problem('domain', 'A curve has exactly one parameter')
    lower, upper = (decoder.node(value, scope, depth+1) for value in (lower_node, upper_node))
    for value in (lower, upper):
        if value not in (s.oo, -s.oo):
            finite_real(value, problem)
        if value.free_symbols:
            raise problem('unevaluated', 'Resolve the parameter endpoints before line integration')
    reverse = s.StrictGreaterThan(lower, upper)
    if reverse not in (s.true, s.false):
        raise problem('unevaluated', 'The parameter endpoint order is unknown')
    left, right = (upper, lower) if reverse is s.true else (lower, upper)
    if left == right and left in (s.oo, -s.oo):
        raise problem('domain', 'Coincident infinite endpoints do not define a curve')
    variable = s.Dummy('pcad_path_' + str(len(decoder.references)), real=True)
    decoder.references[variable] = dict(path['bindings'][0]['variable'])
    region = s.Interval(left, right)
    path_domain = LineDomain(variable, region, False, problem)
    field_domain = LineDomain(variable, region, True, problem)
    previous, start = decoder.domain_observer, len(decoder.domain_conditions)
    try:
        decoder.domain_observer = path_domain
        curve = decoder.node(path['body'], {**scope, path_keys[0]: variable}, depth+1)
        if type(curve) is not tuple or len(curve) != len(field_keys):
            raise problem('domain', 'Path coordinates must match the field dimension')
        for value in curve:
            path_domain(value)
        path_domain.conditions(decoder.domain_conditions[start:])
        tangent = [s.diff(value, variable) for value in curve]
        # A derivative may be unbounded at an endpoint; the final integral must
        # still prove each improper side converges. Interior gaps remain explicit.
        derivative_domain = LineDomain(variable, s.Interval.open(left, right), False, problem)
        for value in tangent:
            derivative_domain(value)
        decoder.domain_observer = field_domain
        field_start = len(decoder.domain_conditions)
        body = decoder.node(field['body'], {**scope, **dict(zip(field_keys, curve))}, depth+1)
        conditions = decoder.domain_conditions[field_start:]
        field_domain.conditions(conditions)
        if operation == 'circulation':
            if type(body) is not tuple or len(body) != len(curve):
                raise problem('domain', 'Work requires one field component per coordinate')
            for value in body:
                field_domain(value)
            integrand = sum((value*direction for value, direction in zip(body, tangent)), s.S.Zero)
            a, b = lower, upper
        else:
            field_domain(body)
            speed = s.sqrt(s.trigsimp(sum((value**2 for value in tangent), s.S.Zero)))
            integrand, a, b = body*speed, left, right
        result = integral_value(s.trigsimp(integrand), variable, a, b, conditions, problem)
        return finite_real(result, problem)
    finally:
        decoder.domain_observer = previous
        del decoder.domain_conditions[start:]
