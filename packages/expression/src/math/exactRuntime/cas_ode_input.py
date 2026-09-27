"""A differential equation binds dependent functions, never scalar constants."""
import sympy as s
from cas_input import Decoder, CasInputProblem, fields, reference_key


def entries(node, minimum=0, maximum=16):
    fields(node, ('kind', 'operation', 'operands'))
    if (node['kind'] != 'operation' or node['operation'] != 'list'
            or type(node['operands']) is not list
            or not minimum <= len(node['operands']) <= maximum):
        raise CasInputProblem('syntax', 'An explicit bounded list is required')
    return node['operands']


class OdeDecoder(Decoder):
    def __init__(self, angle_unit):
        super().__init__(angle_unit)
        self.independent = None
        self.functions = []

    def _node(self, value, scope=None, depth=0):
        if type(value) is dict and value.get('operation') == 'differentiate':
            fields(value, ('kind', 'operation', 'operands'))
            operands = value['operands']
            if value['kind'] != 'operation' or type(operands) is not list or not 2 <= len(operands) <= 9:
                raise CasInputProblem('syntax', 'Supply the dependent expression and differentiation variables')
            self.nodes += 1
            if self.nodes > 4096 or depth > 64:
                raise CasInputProblem('budget', 'The differential equation is too large')
            body = self.node(operands[0], scope, depth+1)
            variables = [self.node(item, scope, depth+1) for item in operands[1:]]
            if any(variable != self.independent for variable in variables):
                raise CasInputProblem('domain', 'An ODE differentiates only its declared independent variable')
            if not isinstance(body, s.Expr):
                raise CasInputProblem('domain', 'A scalar differential expression is required')
            return s.Derivative(body, *variables, evaluate=False)
        return super()._node(value, scope, depth)


def problem_source(source, parent, scope=None, depth=0):
    fields(source, ('kind', 'operation', 'operands'))
    if (source['kind'] != 'operation' or source['operation'] != 'solve-ode'
            or type(source['operands']) is not list or len(source['operands']) != 2):
        raise CasInputProblem('syntax', 'Declare equations, independent/dependent variables and conditions')
    function, independent_count = source['operands']
    fields(independent_count, ('kind', 'decimal'))
    if independent_count != {'kind': 'number', 'decimal': '1'}:
        raise CasInputProblem('syntax', 'An ODE has one independent variable')
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or not 2 <= len(function['bindings']) <= 5):
        raise CasInputProblem('syntax', 'Declare one independent variable and one to four dependent functions')
    local, nested, seen, labels = OdeDecoder(parent.angle_unit), dict(scope or {}), set(), set()
    variable = s.Dummy('pcad_ode_independent', real=True)
    local.independent = variable
    for index, binding in enumerate(function['bindings']):
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        label = binding['variable']['label']
        if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted' or key in seen or label in labels:
            raise CasInputProblem('syntax', 'Every local variable must have a distinct identity and name')
        seen.add(key)
        labels.add(label)
        if index == 0:
            nested[key] = variable
        else:
            dependent = s.Function('pcad_ode_dependent_' + str(index), real=True)(variable)
            local.functions.append(dependent)
            nested[key] = dependent
    body = entries(function['body'], 2, 2)
    equations_raw, initial_raw = entries(body[0], 1, 4), entries(body[1], 0, 16)
    if len(equations_raw) != len(local.functions):
        raise CasInputProblem('dimension', 'Supply one equation per dependent function')
    observed = []
    local.domain_observer = observed.append
    equations = [local.node(item, nested, depth+1) for item in equations_raw]
    if any(not isinstance(equation, s.Equality) for equation in equations):
        raise CasInputProblem('domain', 'Each ODE entry must be an equality containing a derivative')
    initials = []
    for raw in initial_raw:
        target_node, point_node, value_node = entries(raw, 3, 3)
        target = local.node(target_node, nested, depth+1)
        point, value = local.node(point_node, nested, depth+1), local.node(value_node, nested, depth+1)
        valid_target = target in local.functions or (
            isinstance(target, s.Derivative) and target.expr in local.functions
            and all(item == variable for item in target.variables))
        if not valid_target:
            raise CasInputProblem('domain', 'A condition specifies a dependent function or its derivative')
        if any(not isinstance(item, s.Expr) or item.free_symbols or item.is_real is not True
               or item.is_finite is not True for item in (point, value)):
            raise CasInputProblem('domain', 'Condition positions and values must be finite real constants')
        if any(old_target == target and old_point == point and s.simplify(old_value-value) != 0
               for old_target, old_point, old_value in initials):
            raise CasInputProblem('domain', 'Two conditions assign different values at the same position')
        initials.append((target, point, value))
    local.domain_observer = None
    if any(item.free_symbols - {variable} for item in equations + observed + local.domain_conditions):
        raise CasInputProblem('unevaluated', 'Resolve external coefficients before solving the ODE')
    if any(not equation.has(s.Derivative) for equation in equations):
        raise CasInputProblem('domain', 'Each declared differential equation must contain a derivative')
    parent.nodes += local.nodes
    if parent.nodes > 4096:
        raise CasInputProblem('budget', 'Combined differential-equation input exceeds the node budget')
    return function, local, equations, initials, observed
