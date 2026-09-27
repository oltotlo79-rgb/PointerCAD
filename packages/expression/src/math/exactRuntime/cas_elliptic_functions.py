"""Real ordinary Legendre integrals, preserving the whole original path."""
import sympy as s
from sympy.core.function import ArgumentIndexError
from cas_airy_functions import real_finite as known_real_finite, analytic_at as known_analytic_at

class RealIncompletePi(s.elliptic_pi):
    """Keep the ordinary integral's periods when m=0 or n=m.

    The dependency's automatic atan(tan(phi)) rewrite at m=0 selects a
    principal branch. Retain the integral until our real-path check/numerical
    implementation handles it; do not discard complete half-turns.
    """
    @classmethod
    def eval(cls, n, phi, m):
        if phi.is_zero:
            return s.S.Zero
        if n.is_zero:
            return s.elliptic_f(phi, m)
        turns = 2*phi/s.pi
        if turns.is_integer:
            return turns*s.elliptic_pi(n, m)
        if phi.could_extract_minus_sign():
            return -cls(n, -phi, m)

    def fdiff(self, argindex=1):
        n, phi, m = self.args
        root = s.sqrt(1-m*s.sin(phi)**2)
        denominator = 1-n*s.sin(phi)**2
        if argindex == 1:
            return (s.elliptic_e(phi, m)+(m-n)*s.elliptic_f(phi, m)/n
                    +(n**2-m)*self/n-n*root*s.sin(2*phi)/(2*denominator))/(2*(m-n)*(n-1))
        if argindex == 2:
            return 1/(root*denominator)
        if argindex == 3:
            return (s.elliptic_e(phi, m)/(m-1)+self-m*s.sin(2*phi)/(2*(m-1)*root))/(2*(n-m))
        raise ArgumentIndexError(self, argindex)

    def _eval_evalf(self, precision):
        return s.elliptic_pi(*self.args, evaluate=False)._eval_evalf(precision)


ARITY = {'elliptick': 1, 'elliptice': 1, 'ellipticf': 2,
         'ellipticeinc': 2, 'ellipticpi': 2, 'ellipticpiinc': 3}
FAMILIES = (s.elliptic_k, s.elliptic_e, s.elliptic_f, s.elliptic_pi, RealIncompletePi)


def signature(value):
    if value.func is s.elliptic_k:
        return 'elliptick', value.args
    if value.func is s.elliptic_e:
        return ('elliptice' if len(value.args) == 1 else 'ellipticeinc'), value.args
    if value.func is s.elliptic_f:
        return 'ellipticf', value.args
    if value.func in (s.elliptic_pi, RealIncompletePi):
        return ('ellipticpi' if len(value.args) == 2 else 'ellipticpiinc'), value.args
    return None


def amplitude_index(operation):
    return 0 if operation in ('ellipticf', 'ellipticeinc') else 1 if operation == 'ellipticpiinc' else None


def path_condition(operation, arguments, varying=None):
    """Sufficient real domain; varying marks parameters needing an open neighbourhood."""
    m = arguments[-1]
    third = operation in ('ellipticpi', 'ellipticpiinc')
    n = arguments[0] if third else s.S.Zero
    index = amplitude_index(operation)
    second = operation in ('elliptice', 'ellipticeinc')
    m_varies = varying is not None and varying[-1]
    global_m = m <= 1 if second and not m_varies else m < 1
    global_condition = s.And(global_m, n < 1) if third else global_m
    if index is None:
        return global_condition
    phi = arguments[index]
    if phi.is_zero is True:
        return s.true
    # E(phi,1) integrates |cos(phi)|. It is analytic in phi between, but
    # not at, its zeros; allowing its finite value does not prove smoothness.
    if second and varying is not None and varying[index]:
        global_condition = s.And(global_condition, s.Or(s.Ne(m, 1), s.Ne(s.cos(phi), 0)))
    square = s.sin(phi)**2
    local = s.And(s.Abs(phi) < s.pi/2, 1-m*square > 0)
    if third:
        local = s.And(local, 1-n*square > 0)
    return s.Or(global_condition, local)


def real_finite(value):
    if not isinstance(value, s.Expr) or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return False
    elliptic = signature(value)
    if elliptic is not None:
        operation, arguments = elliptic
        return all(real_finite(arg) for arg in arguments) and path_condition(operation, arguments) is s.true
    if known_real_finite(value):
        return True
    if value.free_symbols:
        return False
    if value.is_Add or value.is_Mul:
        return all(real_finite(arg) for arg in value.args)
    if value.is_Pow and value.exp.is_Integer:
        return real_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    return False


def elliptic_point(operation, arguments, problem, varying=None):
    if not all(real_finite(argument) for argument in arguments):
        raise problem('unevaluated', 'Finite real elliptic arguments have not been established')
    condition = path_condition(operation, arguments, varying)
    if condition is s.false:
        raise problem('domain', 'The original elliptic path leaves its real domain or crosses a pole')
    if condition is not s.true:
        raise problem('unevaluated', 'The original elliptic path condition has not been established')


def elliptic_operation(decoder, operation, arguments, problem):
    if len(arguments) != ARITY[operation]:
        raise problem('syntax', 'Elliptic argument count does not match')
    for argument in arguments:
        if not isinstance(argument, s.Expr) or argument.is_finite is False or argument.has(s.zoo, s.nan):
            raise problem('domain', 'Elliptic arguments must be finite scalars')
        if argument.is_real is False:
            raise problem('unsupported', 'Complex elliptic arguments are not enabled')
        if argument.is_Rational and max(abs(int(argument.p)).bit_length(), int(argument.q).bit_length()) > 8192:
            raise problem('budget', 'The original elliptic argument exceeds the exact input bound')
    arguments = list(arguments)
    index = amplitude_index(operation)
    if index is not None and decoder.angle_unit == 'degree':
        arguments[index] *= s.pi/180
    arguments = tuple(arguments)
    if not any(argument.free_symbols for argument in arguments):
        elliptic_point(operation, arguments, problem)
    condition = path_condition(operation, arguments)
    if condition is s.false:
        raise problem('domain', 'The original elliptic path is outside the supported real domain')
    if condition is not s.true:
        decoder.domain_conditions.append(condition)
    decoder.elliptic_domains.append((operation, arguments))
    function = {'elliptick': s.elliptic_k, 'elliptice': s.elliptic_e,
                'ellipticf': s.elliptic_f, 'ellipticeinc': s.elliptic_e,
                'ellipticpi': s.elliptic_pi, 'ellipticpiinc': RealIncompletePi}[operation]
    return function(*arguments)


def analytic_at(expression, variable, target):
    if not expression.has(variable):
        return real_finite(expression)
    if expression == variable:
        return True
    elliptic = signature(expression)
    if elliptic is not None:
        operation, arguments = elliptic
        at = tuple(argument.subs(variable, target) for argument in arguments)
        varying = tuple(argument.has(variable) for argument in arguments)
        return (all(analytic_at(argument, variable, target) for argument in arguments)
                and all(real_finite(argument) for argument in at)
                and path_condition(operation, at, varying) is s.true)
    if expression.is_Add or expression.is_Mul:
        return all(analytic_at(argument, variable, target) for argument in expression.args)
    if expression.is_Pow and expression.exp.is_Integer:
        return (analytic_at(expression.base, variable, target)
                and (expression.exp >= 0 or expression.base.subs(variable, target).is_zero is False))
    if expression.func in (s.exp, s.sin, s.cos, s.sinh, s.cosh, s.erf, s.erfc):
        return analytic_at(expression.args[0], variable, target)
    return known_analytic_at(expression, variable, target)


def sine_moments(phi, order):
    """Exact integrals of sin(theta)^(2*k), valid across whole periods too."""
    values = [phi]
    for k in range(1, order+1):
        values.append((s.Integer(2*k-1)*values[-1] - s.sin(phi)**(2*k-1)*s.cos(phi))/(2*k))
    return values


def regularize_characteristic_zero(body, variable, target, order):
    """The analytic n=0 Pi jet, derived from 1/(1-n*sin²), before differentiation.

    Do not ask the general limit engine to resolve the 1/n in Pi's derivative:
    that path fails to return a value at n=0. The geometric series gives the
    exact Taylor coefficients. Original-path analyticity is checked by caller.
    """
    replacements = {}
    for atom in body.atoms(s.elliptic_pi):
        n, *rest = atom.args
        if not n.has(variable) or n.subs(variable, target).is_zero is not True:
            continue
        phi, m = (s.pi/2, rest[0]) if len(rest) == 1 else rest
        if m.subs(variable, target).is_zero is True:
            # Both n and m vanish: expand both denominator factors. Retain all
            # total degrees through order, also when phi depends on variable.
            moments = sine_moments(phi, order)
            value = s.S.Zero
            for i in range(order+1):
                for j in range(order-i+1):
                    value += n**i*m**j*s.binomial(2*j, j)/4**j*moments[i+j]
        else:
            first = s.elliptic_k(m) if len(rest) == 1 else s.elliptic_f(phi, m)
            second = s.elliptic_e(m) if len(rest) == 1 else s.elliptic_e(phi, m)
            moments = [first, (first-second)/m]
            # Integrate d[sin^(2*k-1)(theta)*cos(theta)*sqrt(1-m*sin²(theta))].
            for k in range(1, order):
                boundary = s.S.Zero if len(rest) == 1 else s.sin(phi)**(2*k-1)*s.cos(phi)*s.sqrt(1-m*s.sin(phi)**2)
                moments.append((boundary+2*k*(1+m)*moments[k]-(2*k-1)*moments[k-1])/((2*k+1)*m))
            value = sum(n**k*moments[k] for k in range(order+1))
        replacements[atom] = value
    return body.xreplace(replacements)
