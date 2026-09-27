"""Real Lambert W branches with original domains, no approximate transport."""
import sympy as s
from cas_bessel_functions import real_finite as bessel_real_finite, analytic_at as bessel_analytic_at


def branch_of(value, problem):
    if not isinstance(value, s.Integer) or value not in (0, -1):
        raise problem('unsupported', 'The real Lambert W branch must be 0 or -1')
    return value


def conditions(branch, argument, strict=False):
    lower = argument > -1/s.E if strict else argument >= -1/s.E
    return [lower] if branch == 0 else [lower, argument < 0]


def real_finite(value):
    if not isinstance(value, s.Expr) or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return False
    if bessel_real_finite(value):
        return True
    if value.free_symbols:
        return False
    if value.func is s.LambertW:
        argument = value.args[0]
        branch = value.args[1] if len(value.args) == 2 else s.S.Zero
        return branch in (0, -1) and real_finite(argument) and all(c is s.true for c in conditions(branch, argument))
    if value.is_Add or value.is_Mul:
        return all(real_finite(argument) for argument in value.args)
    if value.is_Pow and isinstance(value.exp, s.Integer):
        return real_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    if value.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return real_finite(value.args[0])
    return False


def lambert_point(branch, argument, problem, strict=False):
    branch_of(branch, problem)
    if not real_finite(argument):
        raise problem('unevaluated', 'A finite real Lambert W argument has not been established')
    for condition in conditions(branch, argument, strict):
        if condition is s.false:
            raise problem('domain', 'The original Lambert W argument is outside the selected real branch')
        if condition is not s.true:
            raise problem('unevaluated', 'The original Lambert W branch domain has not been established')


def lambert_operation(decoder, arguments, problem):
    if len(arguments) != 2:
        raise problem('syntax', 'Lambert W needs a branch and an argument')
    branch, argument = arguments
    branch_of(branch, problem)
    if not isinstance(argument, s.Expr) or argument.is_finite is False or argument.has(s.zoo, s.nan):
        raise problem('domain', 'Lambert W needs one finite scalar argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex Lambert W branches are not enabled')
    if argument.is_Rational and max(abs(int(argument.p)).bit_length(), int(argument.q).bit_length()) > 8192:
        raise problem('budget', 'The original Lambert W argument exceeds the exact input budget')
    if not argument.free_symbols:
        lambert_point(branch, argument, problem)
    for condition in conditions(branch, argument):
        if condition is s.false:
            raise problem('domain', 'The original Lambert W argument is outside the selected real branch')
        if condition is not s.true:
            decoder.domain_conditions.append(condition)
    decoder.lambert_domains.append((branch, argument))
    return s.LambertW(argument, branch)


def analytic_at(expression, variable, target):
    """Sufficient open-neighbourhood proof; branch points and corners stay excluded."""
    if bessel_analytic_at(expression, variable, target):
        return True
    if not expression.has(variable):
        return real_finite(expression)
    if expression == variable:
        return True
    if expression.is_Add or expression.is_Mul:
        return all(analytic_at(arg, variable, target) for arg in expression.args)
    if expression.is_Pow and isinstance(expression.exp, s.Integer):
        return (analytic_at(expression.base, variable, target)
                and (expression.exp >= 0 or expression.base.subs(variable, target).is_zero is False))
    if expression.func is s.LambertW:
        argument = expression.args[0]
        branch = expression.args[1] if len(expression.args) == 2 else s.S.Zero
        at = argument.subs(variable, target)
        return (branch in (0, -1) and real_finite(at) and analytic_at(argument, variable, target)
                and all(c is s.true for c in conditions(branch, at, strict=True)))
    if expression.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return analytic_at(expression.args[0], variable, target)
    return False


def derivative(expression, variable):
    """Use W'=exp(-W)/(1+W), including W_0'(0), before substitution.

    The caller proves an analytic neighbourhood first. The chain rule treats
    each W call as a temporary symbol, so no removable division by x appears.
    """
    calls = expression.atoms(s.LambertW)
    if not calls:
        return s.diff(expression, variable)
    replacements = {call: s.Dummy('lambert_value') for call in calls}
    outer = expression.xreplace(replacements)
    restore = {symbol: call for call, symbol in replacements.items()}
    answer = s.diff(outer, variable).xreplace(restore)
    for call, symbol in replacements.items():
        partial = s.diff(outer, symbol)
        if partial != 0:
            answer += (partial.xreplace(restore) * s.exp(-call) / (1+call)
                       * derivative(call.args[0], variable))
    return answer
