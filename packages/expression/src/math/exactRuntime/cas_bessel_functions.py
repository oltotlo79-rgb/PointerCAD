"""Real integer Bessel values and domains; no numerical answer is authorized here."""
import sympy as s

BESSEL = {'besselj': s.besselj, 'bessely': s.bessely, 'besseli': s.besseli, 'besselk': s.besselk}
FAMILIES = tuple(BESSEL.values())
POSITIVE_ARGUMENT = (s.bessely, s.besselk)


def real_finite(value):
    """Sufficient proof for Bessel constants, which lack SymPy finite assumptions.

    Integer J/I are entire and real on R; Y/K are finite and real on x>0.
    Unknown symbols, unknown signs, branch powers and reciprocals remain unknown.
    This never changes the assumptions on a symbolic object.
    """
    if not isinstance(value, s.Expr) or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return False
    if value.is_real is True and value.is_finite is True:
        return True
    if value.free_symbols:
        return False
    if value.func in FAMILIES:
        order, argument = value.args
        return (isinstance(order, s.Integer) and real_finite(argument)
                and (value.func not in POSITIVE_ARGUMENT or argument.is_positive is True))
    if value.is_Add or value.is_Mul:
        return all(real_finite(argument) for argument in value.args)
    if value.is_Pow and isinstance(value.exp, s.Integer):
        return real_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    if value.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return real_finite(value.args[0])
    return False


def bessel_point(family, argument, problem):
    if not real_finite(argument):
        raise problem('unevaluated', 'A finite real Bessel argument has not been established')
    if family in POSITIVE_ARGUMENT:
        if argument.is_positive is False:
            raise problem('domain', 'Bessel Y and K need a positive argument')
        if argument.is_positive is not True:
            raise problem('unevaluated', 'A positive Bessel argument has not been established')


def bessel_operation(decoder, operation, arguments, problem):
    if len(arguments) != 2:
        raise problem('syntax', 'Bessel needs an integer order and an argument')
    order, argument = arguments
    if not isinstance(order, s.Integer):
        raise problem('unsupported', 'The Bessel order must be a resolved integer')
    if abs(order) > 128:
        raise problem('budget', 'The Bessel order exceeds 128')
    if argument.is_finite is False or argument.has(s.zoo, s.nan):
        raise problem('domain', 'Bessel needs a finite argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex Bessel inputs are not enabled')
    if argument.is_Rational and max(abs(int(argument.p)).bit_length(), int(argument.q).bit_length()) > 8192:
        raise problem('budget', 'The original Bessel argument exceeds the exact input budget')
    if not argument.free_symbols:
        bessel_point(BESSEL[operation], argument, problem)
        if (s.Abs(argument) > 128) is s.true:
            raise problem('budget', 'The Bessel argument exceeds 128')
        if (s.Abs(argument) <= 128) is not s.true:
            raise problem('unevaluated', 'The Bessel argument has not been bounded')
    if BESSEL[operation] in POSITIVE_ARGUMENT:
        condition = argument > 0
        if condition is s.false:
            raise problem('domain', 'Bessel Y and K need a positive argument')
        if condition is not s.true:
            decoder.domain_conditions.append(condition)
            decoder.bessel_domains.append((argument, condition))
    return BESSEL[operation](order, argument)


def analytic_at(expression, variable, target):
    """Prove a real analytic neighbourhood, never just continuity at a point.

    Integer J/I are entire; Y/K are analytic off the nonpositive-real cut.
    DLMF 10.2(ii), 10.25(ii), 10.6 and 10.29. Only closed analytic
    compositions below are admitted; Abs, Piecewise and unknown calls are not.
    Original operand domain conditions are checked separately before this proof.
    """
    if not expression.has(variable):
        return real_finite(expression)
    if expression == variable:
        return True
    if expression.is_Add or expression.is_Mul:
        return all(analytic_at(arg, variable, target) for arg in expression.args)
    if expression.is_Pow and isinstance(expression.exp, s.Integer):
        return (analytic_at(expression.base, variable, target)
                and (expression.exp >= 0 or expression.base.subs(variable,target).is_zero is False))
    if expression.func in FAMILIES:
        order, argument = expression.args
        at = argument.subs(variable, target)
        return (isinstance(order, s.Integer) and real_finite(at)
                and analytic_at(argument, variable, target)
                and (expression.func not in POSITIVE_ARGUMENT or at.is_positive is True))
    if expression.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return analytic_at(expression.args[0], variable, target)
    return False
