"""Exact univariate solution sets and explicit finite choices, preserving source holes.

No sampled or floating root is certified here. An unresolved set is never empty.
Polynomial roots keep multiplicities separately from the set of distinct roots.
"""
from functools import cmp_to_key
import sympy as s
from sympy.calculus.singularities import singularities
from sympy.core.relational import Relational
from cas_input import CasInputProblem, fields, reference_key
from cas_sequences import sequence_budget, check_size


def unresolved(detail):
    raise CasInputProblem('unevaluated', detail)


def resolved_set(value):
    if not isinstance(value, s.Set) or value.has(s.ConditionSet) or value.free_symbols:
        unresolved('The complete solution set has not been established')
    check_size(value, CasInputProblem)
    return value


def equation_domain(decoder, node, scope, depth):
    if type(node) is dict and node.get('kind') == 'constant':
        value = decoder.node(node, scope, depth+1)
        if value in (s.S.Reals, s.S.Complexes):
            return value
    if type(node) is dict and node.get('kind') == 'operation' and node.get('operation') == 'interval':
        fields(node, ('kind', 'operation', 'operands'))
        if type(node['operands']) is not list or len(node['operands']) != 2:
            raise CasInputProblem('syntax', 'An interval needs two endpoints')
        endpoints, opened = [], []
        for item in node['operands']:
            is_open = type(item) is dict and item.get('kind') == 'operation' and item.get('operation') == 'open-endpoint'
            if is_open:
                fields(item, ('kind', 'operation', 'operands'))
                if type(item['operands']) is not list or len(item['operands']) != 1:
                    raise CasInputProblem('syntax', 'An open endpoint needs one value')
                item = item['operands'][0]
            value = decoder.node(item, scope, depth+1)
            if not isinstance(value, s.Expr) or value.free_symbols or value.is_extended_real is not True:
                raise CasInputProblem('domain', 'Interval endpoints must be resolved extended real values')
            endpoints.append(value)
            opened.append(is_open)
        if s.simplify(endpoints[1]-endpoints[0]).is_nonnegative is not True:
            raise CasInputProblem('domain', 'The interval endpoints must be ordered')
        return s.Interval(*endpoints, left_open=opened[0], right_open=opened[1])
    raise CasInputProblem('domain', 'Choose the real numbers, complex numbers or an explicit real interval')


def truth_set(predicate, variable, domain):
    if predicate is s.true:
        return domain
    if predicate is s.false:
        return s.S.EmptySet
    if predicate.func is s.And:
        return s.Intersection(domain, *(truth_set(item, variable, domain) for item in predicate.args))
    if predicate.func is s.Or:
        return s.Union(*(truth_set(item, variable, domain) for item in predicate.args))
    if predicate.func is s.Not:
        return domain - truth_set(predicate.args[0], variable, domain)
    if predicate.func in (s.Implies, s.Equivalent):
        return truth_set(s.to_nnf(predicate, simplify=True), variable, domain)
    if isinstance(predicate, (s.Equality, s.Unequality)):
        roots = resolved_set(s.solveset(predicate.lhs-predicate.rhs, variable, domain=domain))
        return domain-roots if isinstance(predicate, s.Unequality) else roots
    if isinstance(predicate, Relational):
        if domain.is_subset(s.S.Reals) is not True:
            raise CasInputProblem('domain', 'An ordered inequality requires a real domain')
        # SymPy's trigonometric inequality helper may return only one period.
        # It must never be advertised as the full unbounded solution set.
        if (predicate.lhs-predicate.rhs).has(s.sin, s.cos, s.tan, s.cot, s.sec, s.csc):
            unresolved('A periodic inequality needs a complete interval enumeration')
        return s.solve_univariate_inequality(predicate, variable, relational=False, domain=domain)
    raise CasInputProblem('domain', 'Solve requires an equality, inequality or a combination of conditions')


def exact_truth(value):
    result = s.simplify(value)
    if result is s.true:
        return True
    if result is s.false:
        return False
    unresolved('A candidate could not be checked against its original condition')


def ordered(values):
    def compare(a, b):
        # Complex choices use real part, then imaginary part, each increasing.
        for difference in (s.re(a-b), s.im(a-b)):
            difference = s.simplify(difference)
            if difference.is_zero is True:
                continue
            if difference.is_positive is True:
                return 1
            if difference.is_negative is True:
                return -1
            unresolved('The exact ordering of finite solutions is unknown')
        return 0
    return sorted(values, key=cmp_to_key(compare))


def solve_source(decoder, operation, operands, scope, depth):
    if len(operands) != 2:
        raise CasInputProblem('syntax', 'A solution needs its function and domain')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or len(function['bindings']) != 1):
        raise CasInputProblem('syntax', 'Bind one unknown')
    binding = function['bindings'][0]
    fields(binding, ('variable', 'domain'))
    fields(binding['domain'], ('kind',))
    key = reference_key(binding['variable'])
    if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
        raise CasInputProblem('syntax', 'The unknown must be locally bound')
    domain = equation_domain(decoder, operands[1], scope, depth)
    variable = s.Dummy('pcad_equation', real=True) if domain.is_subset(s.S.Reals) is True else s.Dummy('pcad_equation')
    nested = dict(scope)
    nested[key] = variable
    decoder.references[variable] = dict(binding['variable'])
    start = len(decoder.domain_conditions)
    observed, previous_observer = [], decoder.domain_observer
    decoder.domain_observer = observed.append
    try:
        body = decoder.node(function['body'], nested, depth+1)
    finally:
        decoder.domain_observer = previous_observer
    if not isinstance(body, s.Basic) or body.free_symbols - {variable}:
        unresolved('Resolve the parameters before solving')
    conditions = list(decoder.domain_conditions[start:])
    multiplicities = None
    if operation == 'polynomial-roots':
        if not isinstance(body, s.Expr):
            raise CasInputProblem('domain', 'PolynomialRoots requires a polynomial expression equal to zero')
        try:
            polynomial = s.Poly(body, variable)
        except s.PolynomialError as error:
            raise CasInputProblem('domain', 'The expression is not a polynomial') from error
        if polynomial.is_zero:
            unresolved('An identically zero polynomial has no finite root multiplicities')
        if polynomial.degree() > 16:
            raise CasInputProblem('budget', 'The polynomial degree exceeds 16')
        multiplicities = s.roots(polynomial)
        if sum(multiplicities.values()) != polynomial.degree():
            unresolved('Not all polynomial roots are represented exactly')
        solutions = s.FiniteSet(*multiplicities)
        body = s.Eq(body, 0)
    else:
        solutions = resolved_set(truth_set(body, variable, domain))
    if isinstance(solutions, s.FiniteSet):
        valid = []
        for candidate in solutions:
            if candidate.is_finite is not True:
                unresolved('A finite root could not be established')
            if not exact_truth(domain.contains(candidate)):
                continue
            if not all(exact_truth(condition.subs(variable, candidate)) for condition in conditions):
                continue
            defined = True
            for item in set(observed):
                value = item.subs(variable, candidate)
                if value.has(s.nan, s.zoo, s.oo, -s.oo) or value.is_finite is False:
                    defined = False
                    break
                if value.is_finite is not True:
                    unresolved('The original operands are not proved finite at a candidate')
            if defined and exact_truth(body.subs(variable, candidate)):
                valid.append(candidate)
        solutions = s.FiniteSet(*valid)
    elif solutions is not s.S.EmptySet:
        for condition in conditions:
            solutions = resolved_set(solutions.intersect(truth_set(condition, variable, domain)))
        for item in set(observed):
            if item.has(s.zoo, s.nan, s.oo, -s.oo):
                raise CasInputProblem('domain', 'The original equation contains a nonfinite operand')
            holes = resolved_set(singularities(item, variable, domain=domain))
            solutions = resolved_set(solutions-holes)
    del decoder.domain_conditions[start:]
    if multiplicities is not None:
        rows = [[root, s.Integer(multiplicities[root])] for root in ordered(solutions)]
        return s.ImmutableMatrix(rows) if rows else ()
    return solutions


def equation_operation(decoder, operation, operands, scope, depth):
    if decoder.smooth_point is not None or decoder.domain_observer is not None:
        unresolved('A nested solution needs its own regularity proof')
    try:
        with sequence_budget(decoder):
            if operation != 'solution-value':
                return solve_source(decoder, operation, operands, scope, depth)
            if len(operands) != 2:
                raise CasInputProblem('syntax', 'Select a solution set and a one-based index')
            source = operands[0]
            fields(source, ('kind', 'operation', 'operands'))
            if source['kind'] != 'operation' or source['operation'] != 'solve-equation':
                raise CasInputProblem('domain', 'Select a finite Solve result explicitly')
            solutions = solve_source(decoder, 'solve-equation', source['operands'], scope, depth+1)
            index = decoder.node(operands[1], scope, depth+1)
            if not isinstance(solutions, s.FiniteSet):
                raise CasInputProblem('domain', 'A solution index requires a finite nonempty set')
            if not isinstance(index, s.Integer) or index < 1 or index > len(solutions):
                raise CasInputProblem('domain', 'The solution index is outside the finite set')
            return ordered(solutions)[int(index)-1]
    except NotImplementedError as error:
        raise CasInputProblem('unevaluated', 'The complete solution set could not be established') from error
