"""Check original terms separately from convergence of an infinite tail."""
import sympy as s
from cas_input import CasInputProblem


def is_infinite_discrete(value):
    return isinstance(value, (s.Sum, s.Product)) and any(
        bound in (s.oo, -s.oo) for limit in value.limits for bound in limit[1:])


def zero_set(value, variable, bounds):
    lower, upper = bounds
    if lower.free_symbols or upper.free_symbols:
        return None
    domain = s.Intersection(s.S.Integers, s.Interval(lower, upper))
    try:
        zeros = s.solveset(value, variable, domain=domain)
    except (NotImplementedError, ValueError, TypeError):
        return None
    return zeros.is_empty


def validate_discrete(decoder):
    conditions = []
    for condition in decoder.domain_conditions:
        variables = condition.free_symbols.intersection(decoder.bound_domains)
        # A proof over a concrete discrete range can discharge a local condition.
        # Symbolic or multivariable ranges retain their original obligation.
        if isinstance(condition, s.Unequality) and len(variables) == 1:
            variable = next(iter(variables))
            domain = decoder.bound_domains[variable]
            if domain['operation'] in ('sum', 'product'):
                empty = zero_set(condition.lhs-condition.rhs, variable, domain['bounds'])
                if empty is False:
                    raise CasInputProblem('domain', 'An original term has a zero denominator')
                if empty is True:
                    continue
        conditions.append(condition)
    decoder.domain_conditions = conditions
    for series in decoder.infinite_discrete:
        if any(condition.free_symbols.intersection(series.variables) for condition in conditions):
            raise CasInputProblem('unevaluated', 'The original terms need established domain conditions')
        if isinstance(series, s.Product):
            if len(series.limits) != 1:
                raise CasInputProblem('unevaluated', 'Nested infinite product terms need domain conditions')
            variable, lower, upper = series.limits[0]
            numerator, _ = s.fraction(series.function)
            empty = zero_set(numerator, variable, (lower, upper))
            if empty is False:
                raise CasInputProblem('domain', 'An infinite product contains a zero factor')
            if empty is not True:
                raise CasInputProblem('unevaluated', 'Infinite product factors need established nonzero conditions')
        try:
            convergent = series.is_convergent()
        except (NotImplementedError, ValueError, TypeError):
            raise CasInputProblem('unevaluated', 'Convergence could not be established') from None
        if convergent is s.false or convergent is False:
            raise CasInputProblem('divergent', 'The infinite sum or product does not converge')
        if convergent is not s.true and convergent is not True:
            raise CasInputProblem('unevaluated', 'Convergence requires additional conditions')


def balanced_gamma_limit(partial, cutoff):
    """The exact limit of C*prod(gamma(cutoff+b)**e) whose gamma powers balance, else None.

    For a fixed rational b, gamma(n+b)/(gamma(n)*n**b) -> 1 as the integer n -> oo
    (Wendel's limit). With sum(e) == 0 and sum(e*b) == 0 the gamma powers therefore
    tend to 1, and the limit is exactly the constant C. The general symbolic limit
    took seconds for such partial products (Wallis: 3.6 s in CPython, beyond the 45 s
    calculation limit in Firefox on a busy Windows CI runner, 2026-09-29). Any other
    factor, exponent, shift or constant is left to the general limit.
    """
    constant, weight, moment = s.S.One, s.S.Zero, s.S.Zero
    for factor in s.Mul.make_args(partial.rewrite(s.gamma)):
        if cutoff not in factor.free_symbols:
            constant *= factor
            continue
        base, exponent = factor.as_base_exp()
        if not isinstance(base, s.gamma) or not exponent.is_Integer:
            return None
        shift = s.expand(base.args[0]-cutoff)
        if not shift.is_Rational:
            return None
        weight += exponent
        moment += exponent*shift
    if weight != 0 or moment != 0 or constant.is_finite is not True or constant.is_zero is not False:
        return None
    return constant


def evaluate_infinite_discrete(value):
    result = value.doit(deep=True)
    if not isinstance(result, s.Product) or len(result.limits) != 1:
        return result
    variable, lower, upper = result.limits[0]
    if upper is s.oo and lower.is_finite is True:
        # Evaluate the limit of exact partial products, never a numerical cutoff.
        cutoff = s.Dummy('pcad_product_limit', integer=True, positive=True)
        partial = s.Product(result.function, (variable, lower, cutoff)).doit()
        if not partial.has(s.Product):
            balanced = balanced_gamma_limit(partial, cutoff)
            return balanced if balanced is not None else s.limit(partial, cutoff, s.oo)
    return result


def prepare_infinite_values(value):
    if isinstance(value, s.MatrixBase):
        return value.applyfunc(prepare_infinite_values)
    if type(value) is tuple:
        return tuple(prepare_infinite_values(item) for item in value)
    if isinstance(value, s.Basic):
        return value.replace(is_infinite_discrete, evaluate_infinite_discrete)
    return value
