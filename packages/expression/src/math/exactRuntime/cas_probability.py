"""Exact events and moments over explicit laws; never infer a joint law or sample."""
import sympy as s
import sympy.stats as st
from sympy.core.relational import Relational
from sympy.logic.boolalg import BooleanFunction
from sympy.stats.rv import random_symbols
from cas_probability_laws import declared_law
from cas_probability_domain import ProbabilityDomain


OPERATIONS = {'event-probability': 1, 'given-probability': 2, 'random-expectation': 1,
              'random-variance': 1, 'random-covariance': 2, 'random-correlation': 2,
              'independent-events': 2, 'independent-variables': 2}
EVENTS = {'event-probability', 'given-probability', 'independent-events'}


def scalar(value, problem):
    if (not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase)
            or value.has(s.zoo, s.nan, s.oo, -s.oo)):
        raise problem('domain', 'A finite real random quantity is required')
    return value


def finished(value, problem):
    # Positive closed Beta constants are normalization factors, not unfinished
    # expectations. Expand only these exact identities before proving finiteness.
    replacements = {beta: s.gamma(beta.args[0])*s.gamma(beta.args[1])/s.gamma(sum(beta.args))
                    for beta in value.atoms(s.beta)
                    if all(not arg.free_symbols and arg.is_positive is True for arg in beta.args)}
    value = value.xreplace(replacements)
    value = s.simplify(value)
    scalar(value, problem)
    if value.free_symbols or value.is_real is not True or value.is_finite is not True:
        raise problem('unevaluated', 'The exact probability calculation did not establish a finite real value')
    return value


def truth(value, problem):
    value = s.simplify(value)
    if value not in (s.true, s.false):
        raise problem('unevaluated', 'The event cannot be decided exactly')
    return value is s.true


def positive(value, problem):
    if value.is_positive is not True:
        raise problem('domain' if value.is_positive is False else 'unevaluated',
                      'The conditioning probability or variance must be proved positive')


def finite_result(operation, records, problem):
    if operation in EVENTS:
        events = [(tuple(truth(value, problem) for value in values), weight) for values, weight in records]
        pa = sum((weight for (a, *rest), weight in events if a), s.S.Zero)
        if operation == 'event-probability':
            return pa
        pb = sum((weight for (_, b), weight in events if b), s.S.Zero)
        joint = sum((weight for (a, b), weight in events if a and b), s.S.Zero)
        if operation == 'independent-events':
            return s.true if truth(s.Eq(joint, pa*pb), problem) else s.false
        positive(pb, problem)
        return joint/pb
    if operation == 'independent-variables':
        first, second, joint = {}, {}, {}
        def category(value, known):
            for previous in known:
                equal = s.simplify(value-previous).is_zero
                if equal is True:
                    return previous
                if equal is not False:
                    raise problem('unevaluated', 'Equality of finite outcomes is not established')
            return value
        for (a, b), weight in records:
            a, b = s.simplify(a), s.simplify(b)
            a, b = category(a, first), category(b, second)
            first[a] = first.get(a, 0)+weight
            second[b] = second.get(b, 0)+weight
            joint[a, b] = joint.get((a, b), 0)+weight
        return s.true if all(truth(s.Eq(joint.get((a, b), 0), p*q), problem)
                             for a, p in first.items() for b, q in second.items()) else s.false
    mean = sum((values[0]*weight for values, weight in records), s.S.Zero)
    if operation == 'random-expectation':
        return mean
    variance = sum(((values[0]-mean)**2*weight for values, weight in records), s.S.Zero)
    if operation == 'random-variance':
        return variance
    second_mean = sum((values[1]*weight for values, weight in records), s.S.Zero)
    covariance = sum(((a-mean)*(b-second_mean)*weight for (a, b), weight in records), s.S.Zero)
    if operation == 'random-covariance':
        return covariance
    second_variance = sum(((values[1]-second_mean)**2*weight for values, weight in records), s.S.Zero)
    positive(variance, problem)
    positive(second_variance, problem)
    return covariance/s.sqrt(variance*second_variance)


def continuous_result(operation, bodies, variables, laws, problem):
    replacements = dict(zip(variables, (law.rv for law in laws)))
    random = [body.xreplace(replacements) for body in bodies]

    def probability(event):
        if event in (s.true, s.false):
            return s.S.One if event is s.true else s.S.Zero
        if isinstance(event, s.Not):
            return 1-probability(event.args[0])
        if isinstance(event, (s.And, s.Or)) and len(random_symbols(event)) > 1:
            # Independent variables do not make overlapping events independent.
            # The fixed engine's product space multiplies And and adds Or without
            # checking this distinction. Combine only proved disjoint variable sets.
            used = [set(random_symbols(child)) for child in event.args]
            if any(left & right for index, left in enumerate(used) for right in used[index+1:]):
                raise problem('unevaluated', 'The joint event involves overlapping random variables')
            values = [probability(child) for child in event.args]
            return s.prod(values) if isinstance(event, s.And) else 1-s.prod(1-value for value in values)
        value = finished(st.P(event), problem)
        if value.is_negative is True or (1-value).is_negative is True:
            raise problem('domain', 'The result is outside the probability interval')
        return value

    def mean(value):
        try:
            result = st.E(value)
        except NotImplementedError:
            # Student-t has finite low-order moments but no moment-generating
            # function. Use the same declared density's integral in that case.
            result = st.E(value, evaluate=False).rewrite(s.Integral).doit()
        return finished(result, problem)

    if operation in EVENTS:
        pa = probability(random[0])
        if operation == 'event-probability':
            return pa
        pb = probability(random[1])
        joint = probability(s.And(*random))
        if operation == 'independent-events':
            return s.true if truth(s.Eq(joint, pa*pb), problem) else s.false
        positive(pb, problem)
        return joint/pb
    # Finite second moments prove integrability; otherwise prove absolute first
    # moment explicitly. Never accept a Cauchy principal value as an expectation.
    if operation == 'random-expectation':
        try:
            mean(random[0]**2)
        except problem:
            mean(s.Abs(random[0]))
        return mean(random[0])
    if operation == 'independent-variables':
        used = [body.free_symbols & set(variables) for body in bodies]
        if not used[0] or not used[1] or used[0].isdisjoint(used[1]):
            return s.true  # Independence was explicitly declared in this law.
    second_moments = [mean(value**2) for value in random]
    means = [mean(value) for value in random]
    variances = [s.simplify(second-first**2) for second, first in zip(second_moments, means)]
    if operation == 'random-variance':
        return variances[0]
    covariance = mean(random[0]*random[1])-means[0]*means[1]
    if operation == 'random-covariance':
        return covariance
    if operation == 'independent-variables':
        if s.simplify(covariance).is_zero is False:
            return s.false
        if all(law.gaussian for law in laws):
            try:
                affine = all(s.Poly(body, *variables).total_degree() <= 1 for body in bodies)
            except s.PolynomialError:
                affine = False
            if affine and s.simplify(covariance).is_zero is True:
                return s.true  # Jointly Gaussian affine forms: zero covariance suffices.
        raise problem('unevaluated', 'Zero covariance alone does not establish independence')
    for variance in variances:
        positive(variance, problem)
    return covariance/s.sqrt(variances[0]*variances[1])


def probability_operation(decoder, operation, operands, scope, depth, fields, reference_key, problem):
    if len(operands) != 2:
        raise problem('syntax', 'A probability operation needs a local function and a distribution')
    function, declaration = operands
    fields(function, ('kind', 'operation', 'body', 'bindings'))
    bindings = function['bindings']
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(bindings) is not list or not 1 <= len(bindings) <= 8):
        raise problem('syntax', 'One to eight local random variables are required')
    keys = []
    for binding in bindings:
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or key in keys or binding['domain']['kind'] != 'unrestricted':
            raise problem('syntax', 'Invalid or duplicate random variable')
        keys.append(key)
    body = function['body']
    fields(body, ('kind', 'operation', 'operands'))
    if (body['kind'] != 'operation' or body['operation'] != 'list'
            or type(body['operands']) is not list or len(body['operands']) != OPERATIONS[operation]):
        raise problem('dimension', 'The number of probability expressions is incorrect')
    laws, rows = declared_law(decoder, declaration, len(bindings), scope, depth, fields, problem)

    def decode_values(values, observer=None):
        nested = dict(scope)
        nested.update(zip(keys, values))
        start = len(decoder.domain_conditions)
        previous = decoder.domain_observer
        decoder.domain_observer = observer
        try:
            result = [decoder.node(child, nested, depth+1) for child in body['operands']]
        finally:
            decoder.domain_observer = previous
        conditions = decoder.domain_conditions[start:]
        if observer is not None:
            observer.conditions(conditions)
        elif not all(truth(condition, problem) for condition in conditions):
            raise problem('domain', 'The original expression is undefined at a declared outcome')
        del decoder.domain_conditions[start:]
        for value in result:
            if operation in EVENTS:
                if value not in (s.true, s.false) and not isinstance(value, (Relational, BooleanFunction)):
                    raise problem('domain', 'A probability event must be a proposition')
            else:
                scalar(value, problem)
                if observer is None:
                    finished(value, problem)
        return result

    if rows is not None:
        records = [(decode_values(values), weight) for values, weight in rows]
        result = finite_result(operation, records, problem)
    else:
        variables = [s.Dummy('pcad_probability_' + str(index), real=True) for index in range(len(keys))]
        supports = dict(zip(variables, (law.support for law in laws)))
        values = decode_values(variables, ProbabilityDomain(supports, problem))
        try:
            result = continuous_result(operation, values, variables, laws, problem)
        except NotImplementedError as error:
            raise problem('unevaluated', 'The declared probability problem has no established exact result') from error
    return result if result in (s.true, s.false) else finished(result, problem)
