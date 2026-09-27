"""Verified ODE branches with explicit constants and original-domain checks.

No claim of exhaustive solutions is made by dsolve. An undecided branch or
condition is unresolved, never replaced by zero or an empty solution set.
"""
import sympy as s
from cas_input import CasInputProblem
from cas_result import Encoder
from cas_ode_input import problem_source
from cas_equations import unresolved, exact_truth
from cas_sequences import check_size


def replace_functions(value, mapping):
    return value.subs(mapping, simultaneous=True).doit()


def solve_branches(source, decoder, scope=None, depth=0):
    if decoder.smooth_point is not None or decoder.domain_observer is not None:
        unresolved('Nested ODE calculations need a separate regularity proof')
    function, local, equations, initials, observed = problem_source(source, decoder, scope, depth)
    variable, functions = local.independent, local.functions
    try:
        solved = (s.dsolve(equations[0], functions[0]) if len(functions) == 1
                  else s.dsolve(equations, functions))
    except (NotImplementedError, ValueError):
        unresolved('The differential equations have no verified explicit solution')
    if isinstance(solved, s.Equality):
        candidates = [[solved]]
    elif type(solved) is list and solved and all(isinstance(item, s.Equality) for item in solved):
        candidates = [[item] for item in solved] if len(functions) == 1 else [solved]
    elif type(solved) is list and all(type(item) is list for item in solved):
        candidates = solved
    else:
        unresolved('The solver did not return explicit solution branches')
    if not candidates or len(candidates) > 32:
        unresolved('The solution branches are empty or exceed their representation limit')
    branches = []
    for candidate in candidates:
        mapping = {}
        for equation in candidate:
            if (not isinstance(equation, s.Equality) or equation.lhs not in functions
                    or equation.lhs in mapping or equation.rhs.has(*functions, s.Integral, s.Derivative)):
                unresolved('An implicit or incomplete solution branch cannot be used')
            mapping[equation.lhs] = equation.rhs
        if set(mapping) != set(functions):
            unresolved('A dependent function is missing from the solution')
        constants = sorted(set().union(*(value.free_symbols for value in mapping.values())) - {variable},
                           key=s.default_sort_key)
        if len(constants) > 16:
            raise CasInputProblem('budget', 'Too many integration constants')
        initial_equations = [
            s.simplify(replace_functions(target, mapping).subs(variable, point)-value)
            for target, point, value in initials
        ]
        if any(value.has(s.nan, s.zoo, s.oo, -s.oo) for value in initial_equations):
            raise CasInputProblem('domain', 'A condition is placed at a singular point')
        if not initial_equations or all(value == 0 for value in initial_equations):
            substitutions = [{}]
        elif not constants:
            continue
        else:
            try:
                substitutions = s.solve(initial_equations, constants, dict=True)
            except (NotImplementedError, ValueError):
                unresolved('The initial or boundary conditions remain unresolved')
            if type(substitutions) is not list:
                unresolved('The integration constants remain unresolved')
        for values in substitutions:
            if type(values) is not dict or set(values) - set(constants):
                unresolved('The conditions introduced unbound constants')
            row = tuple(s.simplify(mapping[item].subs(values, simultaneous=True)) for item in functions)
            current = dict(zip(functions, row))
            free = sorted(set().union(*(item.free_symbols for item in row)) - {variable}, key=s.default_sort_key)
            if set(free) - set(constants):
                unresolved('The conditions introduced an undeclared parameter')
            if any(s.simplify(replace_functions(equation.lhs-equation.rhs, current)) != 0 for equation in equations):
                unresolved('The candidate has not satisfied every original differential equation')
            if any(s.simplify(replace_functions(target, current).subs(variable, point)-value) != 0
                   for target, point, value in initials):
                unresolved('The candidate has not satisfied every original initial or boundary condition')
            original = tuple(replace_functions(item, current) for item in observed)
            conditions = [replace_functions(item, current) for item in local.domain_conditions]
            conditions.extend(s.Ne(item.as_numer_denom()[1], 0) for item in row + original)
            conditions.extend(s.Eq(s.im(item), 0) for item in row if item.is_real is not True)
            condition = s.simplify(s.And(*conditions))
            if condition is s.false:
                continue
            if any(item.has(s.nan, s.zoo, s.oo, -s.oo) for item in row + original):
                continue
            for point in {point for _, point, _ in initials}:
                if not exact_truth(condition.subs(variable, point)):
                    # Free constants may still determine admissibility; do not
                    # reject a family merely because a symbolic condition remains.
                    if not free:
                        raise CasInputProblem('domain', 'An initial condition violates an original domain')
                if not free and any(item.subs(variable, point).is_finite is not True for item in original):
                    raise CasInputProblem('domain', 'An original operand is not finite at a condition')
            for item in row + (condition,):
                check_size(item, CasInputProblem)
            branch = (row, tuple(free), condition, original)
            if branch not in branches:
                branches.append(branch)
    if not branches:
        unresolved('No explicit branch satisfying all original conditions has been verified')
    return function, variable, functions, equations, initials, branches


class OdeEncoder(Encoder):
    def __init__(self, decoder, variable, source_bindings, constants):
        super().__init__(decoder)
        variable_binding = source_bindings[0]
        self.bindings = [variable_binding]
        names = {binding['variable']['label'] for binding in source_bindings}
        for index in range(len(constants)):
            label = 'C' + str(index+1)
            while label in names:
                label += '_'
            names.add(label)
            self.bindings.append({
                'variable': {'role': 'bound', 'id': variable_binding['variable']['id'] + '/ode-constant/' + str(index+1),
                             'label': label}, 'domain': {'kind': 'unrestricted'}})
        self.references = dict(zip([variable] + list(constants), [item['variable'] for item in self.bindings]))

    def node(self, value, depth=0):
        if isinstance(value, s.Symbol) and value in self.references:
            return self.made({'kind': 'symbol', 'reference': dict(self.references[value])}, depth)
        return super().node(value, depth)

    def bound(self, value):
        return {'kind': 'binder', 'operation': 'lambda', 'bindings': self.bindings, 'body': self.node(value)}


def ode_result(source, decoder):
    function, variable, _, _, initials, branches = solve_branches(source, decoder)
    rows = []
    for row, constants, condition, observed in branches:
        # Callers supply real constants. Keep their identities/order while
        # discharging only the realness that follows from that input contract.
        real_constants = tuple(s.Dummy('pcad_ode_constant_' + str(index), real=True)
                               for index in range(len(constants)))
        replacements = dict(zip(constants, real_constants))
        row = tuple(item.xreplace(replacements) for item in row)
        condition = condition.xreplace(replacements)
        observed = tuple(item.xreplace(replacements) for item in observed)
        positions = {point for _, point, _ in initials}
        condition = s.simplify(s.And(condition, *(condition.subs(variable, point) for point in positions)))
        originals = []
        # A simplified solution alone loses poles hidden by zero, cancellation
        # or the initial conditions. Transfer the original finite operands at
        # the sampling position AND at every initial/boundary position.
        for item in observed + tuple(item.subs(variable, point) for point in positions for item in observed):
            # Symbolic finiteness is not a proof at every substitution (log(x)
            # still has a hole at x=0). Omit only proved finite constants.
            if not item.free_symbols and item.is_finite is True:
                continue
            if item.has(s.nan, s.zoo, s.oo, -s.oo):
                raise CasInputProblem('domain', 'An original operand is not finite at a condition')
            if item not in originals:
                originals.append(item)
            if len(originals) > 256:
                raise CasInputProblem('budget', 'Too many original differential-equation operands')
        encoder = OdeEncoder(decoder, variable, function['bindings'], real_constants)
        rows.append({'formula': encoder.bound(row), 'condition': encoder.bound(condition),
                     'originals': encoder.bound(tuple(originals))})
    return {'status': 'value', 'kind': 'ode-solutions', 'request': source,
            'solutions': {'coverage': 'verified-branches', 'branches': rows},
            'domainConditions': [], 'coordinateAuthorized': False}


def ode_value(decoder, operands, scope, depth):
    if len(operands) != 4:
        raise CasInputProblem('syntax', 'Supply an ODE, branch number, constants and evaluation position')
    _, variable, _, _, initials, branches = solve_branches(operands[0], decoder, scope, depth+1)
    index = decoder.node(operands[1], scope, depth+1)
    supplied = decoder.node(operands[2], scope, depth+1)
    point = decoder.node(operands[3], scope, depth+1)
    if not isinstance(index, s.Integer) or not 1 <= index <= len(branches):
        raise CasInputProblem('domain', 'Choose an existing solution branch')
    row, constants, condition, observed = branches[int(index)-1]
    if type(supplied) is not tuple or len(supplied) != len(constants):
        raise CasInputProblem('dimension', 'Supply every displayed integration constant')
    if any(not isinstance(item, s.Expr) or item.free_symbols or item.is_real is not True
           or item.is_finite is not True for item in supplied + (point,)):
        raise CasInputProblem('domain', 'Constants and position must be finite real values')
    replacements = dict(zip(constants, supplied))
    for target in {point} | {position for _, position, _ in initials}:
        at = {**replacements, variable: target}
        if not exact_truth(condition.subs(at, simultaneous=True)):
            raise CasInputProblem('domain', 'The chosen constants or position violate the solution conditions')
        if any(item.subs(at, simultaneous=True).is_finite is not True for item in observed):
            raise CasInputProblem('domain', 'An original operand is not finite at the chosen position')
    values = tuple(s.simplify(item.subs({**replacements, variable: point}, simultaneous=True)) for item in row)
    if any(item.is_real is not True or item.is_finite is not True for item in values):
        unresolved('The selected solution has no proved finite real value')
    return values
