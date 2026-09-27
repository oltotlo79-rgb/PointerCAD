"""Real Gamma composition, original poles, and sufficient analytic disks."""
import sympy as s


def gamma_condition(argument):
    # On the real line sin(pi*x)=0 exactly at integers. Positive integers remain
    # admissible; using only the sine denominator would invent poles there.
    return s.Or(argument > 0, s.Ne(s.sin(s.pi*argument), 0))


def gamma_operation(decoder, operation, arguments, problem):
    derivative = operation == 'polygamma'
    if len(arguments) != (2 if derivative else 1):
        raise problem('syntax', 'Gamma needs an argument; polygamma needs an order and argument')
    argument = arguments[-1]
    if derivative and (not isinstance(arguments[0], s.Integer) or not 0 <= arguments[0] <= 17):
        raise problem('domain', 'Polygamma order must be an integer from 0 to 17')
    if argument.is_finite is False or argument.has(s.zoo, s.nan):
        raise problem('domain', 'Gamma needs a finite argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex Gamma inputs are not enabled')
    if not argument.free_symbols and argument.is_real is not True:
        raise problem('unevaluated', 'The Gamma argument has not been proved real')
    if argument.is_Rational and (argument < -19999 or argument > 20000):
        raise problem('budget', 'Gamma argument exceeds its bound')
    condition = gamma_condition(argument)
    if condition is s.false:
        raise problem('domain', 'Gamma has a pole at a nonpositive integer')
    if condition is not s.true:
        decoder.domain_conditions.append(condition)
        decoder.gamma_domains.append((argument, condition))
    # Large integer/rational arguments must not expand huge factorials or
    # harmonic sums just to preserve an exact function in the result.
    if argument.is_Rational and (abs(argument) > 128 or argument.q > 128):
        return (s.polygamma if derivative else s.gamma)(*arguments, evaluate=False)
    return (s.polygamma if derivative else s.gamma)(*arguments)


def gamma_point(argument, problem):
    if argument.is_real is not True or argument.is_finite is not True:
        raise problem('unevaluated', 'A finite real Gamma argument has not been established')
    condition = gamma_condition(argument)
    if condition is s.false:
        raise problem('domain', 'Gamma has a pole at the evaluation point')
    if condition is not s.true:
        raise problem('unevaluated', 'Distance from the Gamma poles is unresolved')


def gamma_argument_radius(argument, variable, center):
    """For a real affine argument, all complex preimages of poles are enumerated
    by the nearest nonpositive integer. A general composition stays unproved.
    """
    if not argument.has(variable):
        return s.oo if argument.is_real is True and argument.is_finite is True and gamma_condition(argument) is s.true else None
    try:
        polynomial = s.Poly(argument, variable)
    except s.PolynomialError:
        return None
    if polynomial.degree() != 1:
        return None
    slope = polynomial.nth(1)
    at = s.simplify(argument.subs(variable, center))
    if any(value.is_real is not True or value.is_finite is not True or value.free_symbols for value in (slope, at)):
        return None
    if slope.is_zero is not False:
        return None
    poles = (s.Min(0, s.floor(at)), s.Min(0, s.ceiling(at)))
    radius = s.simplify(s.Min(*(s.Abs(at-pole) for pole in poles))/s.Abs(slope))
    return radius if radius.is_positive is True else None


def beta_operation(decoder, arguments, problem):
    if len(arguments) != 2:
        raise problem('syntax', 'Beta needs two arguments')
    for argument in arguments:
        if argument.is_finite is False or argument.has(s.zoo, s.nan):
            raise problem('domain', 'Beta needs finite arguments')
        if argument.is_real is False:
            raise problem('unsupported', 'Complex Beta inputs are not enabled')
        if not argument.free_symbols and argument.is_real is not True:
            raise problem('unevaluated', 'The Beta argument has not been proved real')
        condition = argument > 0
        if condition is s.false:
            raise problem('domain', 'Beta needs two positive real arguments')
        if condition is not s.true:
            decoder.domain_conditions.append(condition)
            decoder.beta_domains.append((argument, condition))
        if argument.is_Rational and argument > 20000:
            raise problem('budget', 'Beta argument sum exceeds its bound')
    total = sum(arguments)
    if not total.free_symbols:
        if (total > 20000) is s.true:
            raise problem('budget', 'Beta argument sum exceeds its bound')
        if (total <= 20000) is not s.true:
            raise problem('unevaluated', 'The Beta argument sum has not been bounded')
    if any(argument.is_Rational and (argument > 128 or argument.q > 128) for argument in arguments):
        return s.beta(*arguments, evaluate=False)
    return s.beta(*arguments)


def beta_point(arguments, problem):
    for argument in arguments:
        if argument.is_real is not True or argument.is_finite is not True:
            raise problem('unevaluated', 'Finite real Beta arguments have not been established')
        if argument.is_positive is False:
            raise problem('domain', 'Beta needs positive arguments at the evaluation point')
        if argument.is_positive is not True:
            raise problem('unevaluated', 'Positive Beta arguments have not been established')
    if (sum(arguments) > 20000) is s.true:
        raise problem('budget', 'Beta argument sum exceeds its bound')
    if (sum(arguments) <= 20000) is not s.true:
        raise problem('unevaluated', 'The Beta argument sum has not been bounded')


def beta_argument_radius(argument, variable, center):
    """A real affine argument stays in Re(z)>0 inside this sufficient disk.
    General compositions remain unproved; no branch or pole is crossed.
    """
    if not argument.has(variable):
        return s.oo if argument.is_positive is True and argument.is_finite is True else None
    try:
        polynomial = s.Poly(argument, variable)
    except s.PolynomialError:
        return None
    if polynomial.degree() != 1:
        return None
    slope = polynomial.nth(1)
    at = s.simplify(argument.subs(variable, center))
    if any(value.is_real is not True or value.is_finite is not True or value.free_symbols for value in (slope, at)):
        return None
    if slope.is_zero is not False or at.is_positive is not True:
        return None
    return s.simplify(at/s.Abs(slope))
