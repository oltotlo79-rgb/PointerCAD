"""Conservative exact real enclosures on a finite Cartesian parameter box."""
import sympy as s
from sympy.calculus.util import continuous_domain, function_range
from cas_vector_calculus import finite_real


class BoxDomain:
    def __init__(self, bounds, problem, smooth=False):
        self.bounds, self.problem, self.smooth = bounds, problem, smooth
        self.cache = {}

    def unknown(self):
        raise self.problem('unevaluated', 'The original field or mapping is not proved regular on its entire parameter box')

    def positive(self, value):
        return value.is_positive is True

    def nonzero(self, value):
        lower, upper = self.enclosure(value)
        if lower.is_positive is not True and upper.is_negative is not True:
            self.unknown()

    def conditions(self, conditions):
        for condition in conditions:
            if not isinstance(condition, s.Unequality):
                self.unknown()
            self.nonzero(condition.lhs-condition.rhs)

    def __call__(self, value):
        self.enclosure(value)

    def operation(self, operation, arguments):
        if not self.smooth or operation in ('list', 'matrix', 'component'):
            return
        if all(isinstance(value, s.Expr) and not value.free_symbols for value in arguments):
            return
        if operation in ('add', 'subtract', 'negate', 'multiply', 'square', 'exponential',
                         'sin', 'cos', 'sinh', 'cosh', 'tanh', 'arsinh', 'arctan',
                         'real-part', 'imaginary-part', 'conjugate'):
            return
        if operation in ('absolute', 'divide'):
            self.nonzero(arguments[0] if operation == 'absolute' else arguments[1])
            return
        if operation == 'power' and not arguments[1].free_symbols and arguments[1].is_integer is True:
            if arguments[1].is_positive is not True:
                self.nonzero(arguments[0])
            return
        if operation in ('sqrt', 'natural-log', 'power'):
            if self.positive(self.enclosure(arguments[0])[0]):
                return
        if operation in ('arcsin', 'arccos', 'artanh'):
            lower, upper = self.enclosure(arguments[0])
            if self.positive(lower+1) and self.positive(1-upper):
                return
        if operation == 'arcosh' and self.positive(self.enclosure(arguments[0])[0]-1):
            return
        # Pole-free trigonometric functions are analytic wherever the original
        # result and its recorded denominator are proved finite on the box.
        if operation in ('tan', 'cot', 'sec', 'csc'):
            return
        self.unknown()

    def enclosure(self, value, depth=0):
        if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase):
            raise self.problem('domain', 'A real scalar component is required')
        if value in self.cache:
            return self.cache[value]
        if depth > 64 or len(self.cache) > 8192:
            raise self.problem('budget', 'Parameter-box domain proof exceeds its budget')
        if value.free_symbols - self.bounds.keys():
            self.unknown()
        if not value.free_symbols:
            finite_real(value, self.problem)
            result = value, value
        elif value in self.bounds:
            result = self.bounds[value]
        else:
            parts = [self.enclosure(child, depth+1) for child in value.args]
            if value.func is s.Add:
                result = sum((item[0] for item in parts), s.S.Zero), sum((item[1] for item in parts), s.S.Zero)
            elif value.func is s.Mul:
                result = s.S.One, s.S.One
                for lower, upper in parts:
                    candidates = [result[0]*lower, result[0]*upper, result[1]*lower, result[1]*upper]
                    result = s.Min(*candidates), s.Max(*candidates)
            elif value.func is s.Pow:
                result = self.power(value, parts[0])
            elif len(parts) == 1:
                result = self.unary(value.func, parts[0])
            else:
                self.unknown()
        for endpoint in result:
            finite_real(endpoint, self.problem)
        self.cache[value] = result
        return result

    def power(self, value, base):
        exponent = value.exp
        lower, upper = base
        if exponent.free_symbols or exponent.is_real is not True:
            self.unknown()
        if exponent.is_integer is True:
            if abs(exponent) > 4096:
                raise self.problem('budget', 'A parameter-box power exceeds its budget')
            if exponent <= 0 and lower.is_positive is not True and upper.is_negative is not True:
                self.unknown()
            candidates = [lower**exponent, upper**exponent]
            if exponent.is_positive and exponent.is_even and not (lower.is_positive is True or upper.is_negative is True):
                candidates.append(s.S.Zero)
            return s.Min(*candidates), s.Max(*candidates)
        # Pow uses the complex principal branch, even for odd-denominator roots.
        if lower.is_positive is not True and not (lower.is_nonnegative is True and exponent.is_positive is True):
            self.unknown()
        return s.Min(lower**exponent, upper**exponent), s.Max(lower**exponent, upper**exponent)

    def unary(self, function, bounds):
        lower, upper = bounds
        if function in (s.sin, s.cos):
            return -s.S.One, s.S.One
        if function is s.Abs:
            low = s.S.Zero if not (lower.is_positive is True or upper.is_negative is True) else s.Min(abs(lower), abs(upper))
            return low, s.Max(abs(lower), abs(upper))
        if function in (s.exp, s.sinh, s.tanh, s.asinh, s.atan):
            return function(lower), function(upper)
        if function is s.cosh:
            low = s.S.One if not (lower.is_positive is True or upper.is_negative is True) else s.Min(s.cosh(lower), s.cosh(upper))
            return low, s.Max(s.cosh(lower), s.cosh(upper))
        if function is s.log and lower.is_positive is True:
            return s.log(lower), s.log(upper)
        if function in (s.asin, s.acos) and (lower+1).is_nonnegative is True and (1-upper).is_nonnegative is True:
            return (s.asin(lower), s.asin(upper)) if function is s.asin else (s.acos(upper), s.acos(lower))
        if function is s.acosh and (lower-1).is_nonnegative is True:
            return s.acosh(lower), s.acosh(upper)
        if function is s.atanh and (lower+1).is_positive is True and (1-upper).is_positive is True:
            return s.atanh(lower), s.atanh(upper)
        if function in (s.tan, s.cot, s.sec, s.csc):
            variable = s.Dummy('pcad_box_argument', real=True)
            region = s.Interval(lower, upper)
            try:
                body = function(variable)
                if continuous_domain(body, variable, region) != region:
                    self.unknown()
                available = function_range(body, variable, region)
                if isinstance(available, s.Interval):
                    return available.start, available.end
                if isinstance(available, s.FiniteSet) and len(available) == 1:
                    point = next(iter(available))
                    return point, point
            except NotImplementedError:
                self.unknown()
        self.unknown()
