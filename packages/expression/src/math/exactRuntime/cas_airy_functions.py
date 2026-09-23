"""Entire real Airy functions, exact transport and analytic neighbourhood proofs."""
import sympy as s
from cas_bessel_functions import FAMILIES as BESSEL, POSITIVE_ARGUMENT
from cas_lambert_functions import real_finite as known_real_finite, analytic_at as known_analytic_at, conditions

AIRY = {'airyai': s.airyai, 'airybi': s.airybi,
        'airyaiprime': s.airyaiprime, 'airybiprime': s.airybiprime}
FAMILIES = tuple(AIRY.values())


def real_finite(value):
    if not isinstance(value, s.Expr) or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return False
    if known_real_finite(value):
        return True
    if value.free_symbols:
        return False
    if value.func in FAMILIES:
        return real_finite(value.args[0])
    if value.is_Add or value.is_Mul:
        return all(real_finite(argument) for argument in value.args)
    if value.is_Pow and isinstance(value.exp, s.Integer):
        return real_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    if value.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return real_finite(value.args[0])
    return False


def airy_point(argument, problem):
    if not real_finite(argument):
        raise problem('unevaluated', 'A finite real Airy argument has not been established')
    # This is a numerical work bound, not a singularity of the entire function.
    if (s.Abs(argument) > 32) is s.true:
        raise problem('budget', 'The Airy argument exceeds the numerical work bound')
    if (s.Abs(argument) <= 32) is not s.true:
        raise problem('unevaluated', 'The Airy numerical work bound has not been established')


def airy_operation(decoder, operation, arguments, problem):
    if len(arguments) != 1:
        raise problem('syntax', 'Airy needs one argument')
    argument = arguments[0]
    if not isinstance(argument, s.Expr) or argument.is_finite is False or argument.has(s.zoo, s.nan):
        raise problem('domain', 'Airy needs one finite scalar argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex Airy inputs are not enabled')
    if argument.is_Rational and max(abs(int(argument.p)).bit_length(), int(argument.q).bit_length()) > 8192:
        raise problem('budget', 'The original Airy argument exceeds the exact input budget')
    if not argument.free_symbols:
        airy_point(argument, problem)
    decoder.airy_arguments.append(argument)
    return AIRY[operation](argument)


def analytic_at(expression, variable, target):
    if known_analytic_at(expression, variable, target):
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
    if expression.func in FAMILIES or expression.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        argument = expression.args[0]
        return analytic_at(argument, variable, target) and real_finite(argument.subs(variable, target))
    if expression.func is s.LambertW:
        argument = expression.args[0]
        branch = expression.args[1] if len(expression.args) == 2 else s.S.Zero
        at = argument.subs(variable, target)
        return (branch in (0, -1) and real_finite(at) and analytic_at(argument, variable, target)
                and all(c is s.true for c in conditions(branch, at, strict=True)))
    if expression.func in BESSEL:
        order, argument = expression.args
        at = argument.subs(variable, target)
        return (isinstance(order, s.Integer) and real_finite(at) and analytic_at(argument, variable, target)
                and (expression.func not in POSITIVE_ARGUMENT or at.is_positive is True))
    return False
