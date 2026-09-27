"""Real Riemann zeta and derivative expressions; no rounded literals in transport."""
import sympy as s
from sympy.core.function import ArgumentIndexError
from cas_elliptic_functions import real_finite as known_real_finite, analytic_at as known_analytic_at
from cas_airy_functions import FAMILIES as AIRY


class RealZeta(s.Function):
    nargs = 1

    @classmethod
    def eval(cls, argument):
        if isinstance(argument, s.Integer) and argument != 1:
            return s.zeta(argument)

    def fdiff(self, argindex=1):
        if argindex != 1:
            raise ArgumentIndexError(self, argindex)
        return RealZetaDerivative(s.S.One, self.args[0])

class RealZetaDerivative(s.Function):
    nargs = 2

    @classmethod
    def eval(cls, order, argument):
        if order == 0:
            return RealZeta(argument)

    def fdiff(self, argindex=2):
        if argindex != 2:
            raise ArgumentIndexError(self, argindex)
        return RealZetaDerivative(self.args[0]+1, self.args[1])

# Domain facts belong to real_finite/analytic_at below. Do not ask assumptions
# about this same function from an assumption hook: before substituting the
# derivative point its pole is unresolved and those queries can recurse.
FAMILIES = (RealZeta, RealZetaDerivative)


def signature(value):
    if value.func is RealZeta or value.func is s.zeta and len(value.args) == 1:
        return s.S.Zero, value.args[0]
    if value.func is RealZetaDerivative:
        return value.args
    return None


def zeta_point(order, argument, problem):
    if not isinstance(order, s.Integer) or not 0 <= order <= 17:
        raise problem('budget', 'Zeta derivative order must be from 0 to 17')
    if not isinstance(argument, s.Expr) or argument.has(s.oo, -s.oo, s.zoo, s.nan):
        raise problem('domain', 'Zeta needs a finite scalar argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex zeta inputs are not enabled')
    if not real_finite(argument):
        raise problem('unevaluated', 'A finite real zeta argument has not been established')
    if (argument-1).is_zero is True:
        raise problem('domain', 'Zeta diverges at one')
    if (argument-1).is_zero is not False:
        raise problem('unevaluated', 'The zeta pole has not been excluded')
    if argument.is_Rational and max(abs(int(argument.p)).bit_length(),int(argument.q).bit_length()) > 8192:
        raise problem('budget', 'The original zeta argument exceeds its exact work bound')
    if (argument < -32) is s.true or (argument > 128) is s.true:
        raise problem('budget', 'The zeta argument exceeds its numerical work bound')
    if (argument >= -32) is not s.true or (argument <= 128) is not s.true:
        raise problem('unevaluated', 'The zeta numerical work bound has not been established')


def zeta_operation(decoder, operation, arguments, problem):
    expected = 1 if operation == 'zeta' else 2
    if len(arguments) != expected:
        raise problem('syntax', 'Invalid zeta argument count')
    order = s.S.Zero if operation == 'zeta' else arguments[0]
    argument = arguments[-1]
    if not isinstance(order,s.Integer) or not 0 <= order <= 17:
        raise problem('budget', 'Zeta derivative order must be from 0 to 17')
    if not isinstance(argument,s.Expr) or argument.is_finite is False or argument.has(s.zoo,s.nan):
        raise problem('domain', 'Zeta needs a finite scalar argument')
    if argument.is_real is False:
        raise problem('unsupported', 'Complex zeta inputs are not enabled')
    if not argument.free_symbols:
        zeta_point(order,argument,problem)
    decoder.zeta_domains.append((order,argument))
    decoder.domain_conditions.append(s.Ne(argument,1))
    return RealZeta(argument) if order == 0 else RealZetaDerivative(order,argument)


def real_finite(value):
    if known_real_finite(value):
        return True
    if not isinstance(value,s.Expr) or value.free_symbols or value.has(s.oo,-s.oo,s.zoo,s.nan):
        return False
    zeta = signature(value)
    if zeta is not None:
        order,argument=zeta
        return (isinstance(order,s.Integer) and 0 <= order <= 17 and real_finite(argument)
                and (argument-1).is_zero is False)
    if value.is_Add or value.is_Mul:
        return all(real_finite(x) for x in value.args)
    if value.is_Pow and value.exp.is_Integer:
        return real_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    return False


def analytic_at(value,variable,target):
    if known_analytic_at(value,variable,target):
        return True
    if not value.has(variable):
        return real_finite(value)
    zeta=signature(value)
    if zeta is not None:
        order,argument=zeta
        at=argument.subs(variable,target)
        return (isinstance(order,s.Integer) and 0 <= order <= 17
                and analytic_at(argument,variable,target) and real_finite(at) and (at-1).is_zero is False)
    if value.is_Add or value.is_Mul:
        return all(analytic_at(x,variable,target) for x in value.args)
    if value.is_Pow and value.exp.is_Integer:
        return analytic_at(value.base,variable,target) and (value.exp >= 0 or value.base.subs(variable,target).is_zero is False)
    if value.func in (*AIRY,s.exp,s.sin,s.cos,s.sinh,s.cosh,s.erf,s.erfc):
        return analytic_at(value.args[0],variable,target)
    return False
