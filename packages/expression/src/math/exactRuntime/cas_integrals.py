"""Definite real-axis integrals keep original holes and independently convergent sides."""
import sympy as s
from sympy.calculus.util import continuous_domain


def finite_holes(domain, available, problem):
    missing = domain - available
    if missing is s.S.EmptySet:
        return []
    if isinstance(missing, s.FiniteSet):
        if len(missing) > 64:
            raise problem('budget', 'Too many integral discontinuities')
        return list(missing)
    if isinstance(missing, s.Interval) and missing.measure.is_positive is True:
        raise problem('domain', 'The integrand is not defined on a whole interval')
    raise problem('unevaluated', 'The integral domain has not been established')


def continuous_real_axis(body, variable):
    """Use the same real-axis domain convention for concrete and parameter-dependent inputs."""
    return (continuous_domain(s.re(body), variable, s.S.Reals).intersect(
        continuous_domain(s.im(body), variable, s.S.Reals)) if body.has(s.I)
        else continuous_domain(body, variable, s.S.Reals))


def parameter_integral(body, variable, lower, upper, conditions, problem):
    """Prove finite parameter-dependent ranges, or separate an established finite factor."""
    if body.has(s.Integral):
        raise problem('unevaluated', 'An inner integral needs established convergence')
    if lower.is_finite is True and upper.is_finite is True:
        # Continuity on the whole real axis proves existence on every finite
        # interval, including an interval whose endpoints depend on outer variables.
        if continuous_real_axis(body, variable) != s.S.Reals:
            raise problem('unevaluated', 'The parameter-dependent integral domain remains unresolved')
        for condition in conditions:
            if (not isinstance(condition, s.Unequality)
                    or s.solveset(condition.lhs-condition.rhs, variable, domain=s.S.Reals) is not s.S.EmptySet):
                raise problem('unevaluated', 'An original parameter-dependent condition remains')
        value = s.Integral(body, (variable, lower, upper)).doit()
        if value.has(s.Integral, s.AccumBounds, s.oo, -s.oo, s.zoo, s.nan):
            raise problem('unevaluated', 'The finite integral could not be evaluated exactly')
        return value
    if not lower.free_symbols and not upper.free_symbols:
        factor, dependent = body.as_independent(variable, as_Add=False)
        if (factor != 1 and factor.is_finite is True
                and not dependent.free_symbols - {variable}
                and not any(condition.free_symbols - {variable} for condition in conditions)):
            try:
                return factor * integral_value(dependent, variable, lower, upper, conditions, problem)
            except problem as error:
                if error.code == 'divergent' and factor.is_zero is None:
                    raise problem('unevaluated', 'Convergence depends on an outer factor being zero') from None
                raise
    # Do not pass an unchecked Integral to ordinary simplification: 0*Integral
    # could erase it before a containing integral checks the original input.
    raise problem('unevaluated', 'Parameter-dependent convergence has not been established')


def integral_value(body, variable, lower, upper, conditions, problem):
    """Resolve each definite binder before an outer operation can erase its obligation."""
    if (lower.free_symbols or upper.free_symbols or body.free_symbols - {variable}
            or any(condition.free_symbols - {variable} for condition in conditions)):
        try:
            return parameter_integral(body, variable, lower, upper, conditions, problem)
        except NotImplementedError:
            raise problem('unevaluated', 'The parameter-dependent integral domain could not be established') from None
    if body.has(s.Integral):
        raise problem('unevaluated', 'An inner integral needs established convergence')
    if lower == upper:
        # A coincident infinite endpoint is not an empty finite interval.
        if lower.is_finite is not True:
            raise problem('domain', 'Coincident infinite bounds do not define an integral')
        return s.S.Zero
    reverse = s.StrictGreaterThan(lower, upper)
    if reverse not in (s.true, s.false):
        raise problem('unevaluated', 'The order of the integral bounds is unknown')
    left, right = (upper, lower) if reverse is s.true else (lower, upper)
    interior = s.Interval.open(left, right)
    try:
        # Roots/logarithms use their real interval domain. Explicit complex
        # integrands require continuous real and imaginary components.
        available = (continuous_domain(s.re(body), variable, interior).intersect(
            continuous_domain(s.im(body), variable, interior)) if body.has(s.I)
            else continuous_domain(body, variable, interior))
        points = finite_holes(interior, available, problem)
        for condition in conditions:
            if not isinstance(condition, s.Unequality):
                raise problem('unevaluated', 'An original integral condition remains')
            zeros = s.solveset(condition.lhs-condition.rhs, variable, domain=interior)
            if zeros is s.S.EmptySet:
                continue
            if not isinstance(zeros, s.FiniteSet):
                raise problem('unevaluated', 'Original denominator zeros are not isolated')
            points.extend(zeros)
        points = list(set(points))
        if len(points) > 64:
            raise problem('budget', 'Too many integral discontinuities')
        # Exact comparisons only; numerical sorting must not merge nearby poles.
        from functools import cmp_to_key

        def compare(a, b):
            difference = s.simplify(a-b)
            if difference.is_zero is True:
                return 0
            if difference.is_negative is True:
                return -1
            if difference.is_positive is True:
                return 1
            raise problem('unevaluated', 'The order of integral singularities is unknown')

        boundaries = [left, *sorted(points, key=cmp_to_key(compare)), right]
        total = s.S.Zero
        for a, b in zip(boundaries, boundaries[1:]):
            # Each half has only one possibly improper endpoint. Never cancel
            # opposite divergences or implicitly request a Cauchy principal value.
            middle = (s.S.Zero if a is -s.oo and b is s.oo else b-1 if a is -s.oo
                      else a+1 if b is s.oo else (a+b)/2)
            for start, end in ((a, middle), (middle, b)):
                value = s.Integral(body, (variable, start, end)).doit()
                if value.has(s.AccumBounds, s.oo, -s.oo, s.zoo, s.nan) or value.is_finite is False:
                    raise problem('divergent', 'One side of the improper integral does not converge')
                if value.has(s.Integral) or value.is_finite is not True:
                    raise problem('unevaluated', 'Convergence of the integral has not been established')
                total += value
        return -total if reverse is s.true else total
    except NotImplementedError:
        raise problem('unevaluated', 'The exact integral domain could not be established') from None
