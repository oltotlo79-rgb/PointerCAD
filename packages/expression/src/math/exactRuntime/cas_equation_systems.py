"""Exact rational-polynomial systems, with explicit free parameters and source holes.

No root sampler is used. Unsupported sets remain unresolved, never empty.
The formal result cannot authorize a coordinate: choose a branch and supply every
free parameter before selecting a component of its finite vector.
"""
from functools import cmp_to_key
import sympy as s
from sympy.solvers.solveset import NonlinearError
from cas_input import CasInputProblem, fields, reference_key
from cas_result import Encoder
from cas_sequences import sequence_budget, check_size
from cas_equations import unresolved, exact_truth, ordered


def system_source(source, decoder, scope=None, depth=0):
    fields(source, ('kind', 'operation', 'operands'))
    if (source['kind'] != 'operation' or source['operation'] != 'solve-system'
            or type(source['operands']) is not list or len(source['operands']) != 2):
        raise CasInputProblem('syntax', 'Declare equations, unknowns and a real or complex domain')
    function, domain_node = source['operands']
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or not 1 <= len(function['bindings']) <= 8):
        raise CasInputProblem('syntax', 'Declare one to eight distinct unknowns')
    fields(domain_node, ('kind', 'name'))
    if domain_node['kind'] != 'constant' or domain_node['name'] not in ('real-numbers', 'complex-numbers'):
        raise CasInputProblem('domain', 'The system domain must be real or complex')
    real = domain_node['name'] == 'real-numbers'
    nested, variables, labels, keys = dict(scope or {}), [], set(), set()
    for index, binding in enumerate(function['bindings']):
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        label = binding['variable']['label']
        if (key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted'
                or key in keys or label in labels):
            raise CasInputProblem('syntax', 'Unknowns must be distinct local scalar variables')
        variable = s.Dummy('pcad_system_'+str(index), real=True) if real else s.Dummy('pcad_system_'+str(index), complex=True)
        keys.add(key)
        labels.add(label)
        variables.append(variable)
        nested[key] = variable
        decoder.references[variable] = dict(binding['variable'])
    body = function['body']
    fields(body, ('kind', 'operation', 'operands'))
    if (body['kind'] != 'operation' or body['operation'] != 'list'
            or type(body['operands']) is not list or not 1 <= len(body['operands']) <= 16):
        raise CasInputProblem('syntax', 'Supply a nonempty list of at most sixteen equalities')
    observed, start = [], len(decoder.domain_conditions)
    previous = decoder.domain_observer
    decoder.domain_observer = observed.append
    try:
        equations = [decoder.node(item, nested, depth+1) for item in body['operands']]
    finally:
        decoder.domain_observer = previous
    conditions = list(decoder.domain_conditions[start:])
    del decoder.domain_conditions[start:]
    allowed = set(variables)
    if any(not isinstance(item, s.Basic) or item.free_symbols - allowed for item in equations+conditions+observed):
        unresolved('Resolve external parameters before solving the system')
    if any(item not in (s.true, s.false) and not isinstance(item, s.Equality) for item in equations):
        raise CasInputProblem('domain', 'Every system entry must be an equality')
    polynomials = []
    for item in set(observed):
        if item.has(s.nan, s.zoo, s.oo, -s.oo):
            raise CasInputProblem('domain', 'An original operand is not finite')
        if item.is_rational_function(*variables) is not True:
            unresolved('The complete system currently requires rational-polynomial operands')
        numerator, denominator = item.as_numer_denom()
        for part in (numerator, denominator):
            polynomial = s.Poly(part, *variables)
            if polynomial.total_degree() > 16:
                raise CasInputProblem('budget', 'The polynomial system degree exceeds sixteen')
            if any(coefficient.is_algebraic is not True for coefficient in polynomial.coeffs()):
                unresolved('The complete polynomial system requires exact algebraic coefficients')
        conditions.append(s.Ne(denominator, 0))
    for equation in equations:
        if isinstance(equation, s.Equality):
            polynomials.append(s.together(equation.lhs-equation.rhs).as_numer_denom()[0])
    if s.false in equations:
        solutions = s.S.EmptySet
    elif not polynomials:
        solutions = s.FiniteSet(s.Tuple(*variables))
    else:
        try:
            matrix, right = s.linear_eq_to_matrix(polynomials, variables)
        except NonlinearError:
            solutions = s.nonlinsolve(polynomials, variables)
        else:
            solutions = s.linsolve((matrix, right), variables)
    if solutions is s.S.EmptySet:
        return function, variables, real, [], equations, observed, conditions
    if not isinstance(solutions, s.FiniteSet) or len(solutions) > 256:
        unresolved('The complete system is not representable as finitely many branches')
    branches = []
    for row in solutions:
        if (not isinstance(row, s.Tuple) or len(row) != len(variables)
                or any(not isinstance(value, s.Expr) or value.free_symbols - allowed for value in row)):
            unresolved('A system branch contains an unresolved set or an undeclared parameter')
        generated_conditions = [s.Ne(value.as_numer_denom()[1], 0) for value in row]
        # nonlinsolve can return the same radical in factored and expanded form.
        # Normalize exact formulas before numbering, preserving all denominators.
        row = tuple(s.simplify(value) for value in row)
        replacements = dict(zip(variables, row))
        condition = s.And(*(item.subs(replacements, simultaneous=True) for item in conditions),
                          *generated_conditions)
        condition = s.simplify(condition)
        if real:
            # Keep the exact reality condition; eager complex expansion can turn
            # a simple radical into atan2/sign branches outside the wire grammar.
            reality = [s.false if value.is_real is False else s.Eq(s.im(value, evaluate=False), 0, evaluate=False)
                       for value in row if value.is_real is not True and s.im(value).is_zero is not True]
            condition = s.And(condition, *reality)
        if condition is s.false:
            continue
        if any(s.simplify(equation.subs(replacements, simultaneous=True)) is not s.true for equation in equations):
            unresolved('A branch has not established every original equality')
        free = set().union(*(value.free_symbols for value in row), condition.free_symbols)
        parameters = [variable for variable in variables if variable in free]
        # A free variable is a coordinate itself, not an implicit new parameter.
        if any(row[variables.index(variable)] != variable for variable in parameters):
            unresolved('A cyclic or transformed free parameter needs a separate representation')
        for value in row:
            if value.has(s.nan, s.zoo, s.oo, -s.oo):
                unresolved('A branch is not finite')
            if not free and value.is_finite is not True:
                unresolved('A finite branch was not proved finite')
            check_size(value, CasInputProblem)
        check_size(condition, CasInputProblem)
        if not parameters and not exact_truth(condition):
            continue
        branch = (row, tuple(parameters), condition)
        if branch not in branches:
            branches.append(branch)
    if all(not parameters for _, parameters, _ in branches):
        def compare(left, right):
            for a, b in zip(left[0], right[0]):
                if s.simplify(a-b) == 0:
                    continue
                return -1 if ordered((a, b))[0] == a else 1
            return 0
        branches.sort(key=cmp_to_key(compare))
    else:
        branches.sort(key=lambda branch: s.default_sort_key(s.Tuple(*branch[0])))
    return function, variables, real, branches, equations, observed, conditions


class SystemEncoder(Encoder):
    def __init__(self, decoder, variables, bindings):
        super().__init__(decoder)
        self.bound = dict(zip(variables, bindings))

    def node(self, value, depth=0):
        if isinstance(value, s.Symbol) and value in self.bound:
            return self.made({'kind': 'symbol', 'reference': dict(self.bound[value]['variable'])}, depth)
        return super().node(value, depth)


def guarded_system(source, decoder, scope=None, depth=0):
    if decoder.smooth_point is not None or decoder.domain_observer is not None:
        unresolved('A nested system requires its own regularity proof')
    try:
        with sequence_budget(decoder):
            return system_source(source, decoder, scope, depth)
    except NotImplementedError:
        unresolved('The complete system remains unresolved')


def encode_system_result(source, decoder):
    function, variables, real, branches, _, _, _ = guarded_system(source, decoder)
    encoder = SystemEncoder(decoder, variables, function['bindings'])
    def bound(value):
        return {'kind': 'binder', 'operation': 'lambda', 'bindings': function['bindings'], 'body': encoder.node(value)}
    rows = [{'parameters': [function['bindings'][variables.index(variable)]['variable']['id'] for variable in parameters],
             'formula': bound(row), 'condition': bound(condition)} for row, parameters, condition in branches]
    return {'status': 'value', 'kind': 'equation-system', 'request': source,
            'solutions': {'domain': 'real' if real else 'complex', 'branches': rows},
            'domainConditions': [], 'coordinateAuthorized': False}


def system_result(source, decoder):
    try:
        return encode_system_result(source, decoder)
    except CasInputProblem as error:
        if error.code == 'unsupported':
            unresolved('An exact system branch has no supported representation')
        raise


def system_solution(decoder, operands, scope, depth):
    if len(operands) != 3:
        raise CasInputProblem('syntax', 'Select the system, branch number and free parameter values')
    _, variables, real, branches, equations, observed, conditions = guarded_system(operands[0], decoder, scope, depth+1)
    index = decoder.node(operands[1], scope, depth+1)
    supplied = decoder.node(operands[2], scope, depth+1)
    if not isinstance(index, s.Integer) or index < 1 or index > len(branches):
        raise CasInputProblem('domain', 'The branch number is outside the displayed list')
    row, parameters, condition = branches[int(index)-1]
    if type(supplied) is not tuple or len(supplied) != len(parameters):
        raise CasInputProblem('dimension', 'Supply every free parameter, in its displayed order')
    if any(not isinstance(value, s.Expr) or value.free_symbols or value.is_finite is not True
           or (real and value.is_real is not True) for value in supplied):
        raise CasInputProblem('domain', 'Free parameters must be finite values in the selected domain')
    replacements = dict(zip(parameters, supplied))
    if not exact_truth(condition.subs(replacements, simultaneous=True)):
        raise CasInputProblem('domain', 'The free parameters do not meet the original domain conditions')
    values = tuple(s.simplify(value.subs(replacements, simultaneous=True)) for value in row)
    replacements = dict(zip(variables, values))
    if any(value.free_symbols or value.is_finite is not True or (real and value.is_real is not True) for value in values):
        unresolved('The selected branch has not produced a finite vector')
    if not all(exact_truth(item.subs(replacements, simultaneous=True)) for item in equations+conditions):
        raise CasInputProblem('domain', 'The selected values do not satisfy the original equations')
    for item in observed:
        if item.subs(replacements, simultaneous=True).is_finite is not True:
            raise CasInputProblem('domain', 'An original operand is not finite at the selected values')
    return values
