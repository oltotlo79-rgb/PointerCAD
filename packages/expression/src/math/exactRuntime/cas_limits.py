"""Exact real-axis limits with explicit sides and punctured original domains."""
import sympy as s
from sympy.core.function import PoleError


def nonzero_near(value, variable, target, side):
    distance = s.Dummy('pcad_limit_distance', positive=True)
    location = (1/distance if target is s.oo else -1/distance if target is -s.oo
                else target + side*distance)
    shifted = value.subs(variable, location)
    try:
        leading = shifted.as_leading_term(distance, cdir=1)
        coefficient, power = leading.as_coeff_exponent(distance)
        if (distance not in coefficient.free_symbols and coefficient.is_zero is False
                and coefficient.is_finite is True and power.is_real is True
                and power.is_finite is True):
            return True
        # A limit bounded away from zero also proves an eventual nonzero value.
        result = s.limit(shifted, distance, 0, dir='+')
        return result.is_zero is False and not result.has(s.Limit, s.zoo, s.nan)
    except (NotImplementedError, ValueError, TypeError, PoleError):
        return False


def limit_value(body, variable, target, direction, conditions, problem):
    if target.free_symbols or target.is_extended_real is not True:
        raise problem('unevaluated', 'A real limit point must be established')
    if direction not in (s.S.NegativeOne, s.S.Zero, s.S.One):
        raise problem('domain', 'Limit direction must be -1, 0 or 1')
    if target in (s.oo, -s.oo):
        if direction != 0:
            raise problem('domain', 'An infinite point has its own approach direction')
        sides = (-1,) if target is s.oo else (1,)
    else:
        sides = (-1, 1) if direction == 0 else (int(direction),)
    values = []
    for side in sides:
        for condition in conditions:
            if not isinstance(condition, s.Unequality) or not nonzero_near(
                    condition.lhs-condition.rhs, variable, target, side):
                raise problem('unevaluated', 'The original expression needs a punctured domain')
        try:
            value = s.limit(body, variable, target, dir='+' if side > 0 else '-')
        except (NotImplementedError, ValueError, TypeError, PoleError):
            raise problem('unevaluated', 'The exact limit could not be established') from None
        if value.has(s.AccumBounds, s.zoo, s.nan):
            raise problem('no-limit', 'The expression has no unique limit')
        if value.has(s.Limit):
            raise problem('unevaluated', 'An unevaluated limit remains')
        values.append(value)
    if len(values) == 2 and values[0] != values[1]:
        difference = s.simplify(values[0]-values[1])
        if difference.is_zero is not True:
            if difference.is_zero is False or difference.has(s.zoo, s.nan):
                raise problem('no-limit', 'The left and right limits differ')
            raise problem('unevaluated', 'Equality of the left and right limits is unknown')
    return values[0]
