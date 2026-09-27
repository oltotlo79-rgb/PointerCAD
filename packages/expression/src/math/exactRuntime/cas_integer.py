"""Exact integer operations for bound terms; no rounded or probable-prime answers."""
import math
import sympy as s
from cas_sequences import MAX_WORK

ARITY = {
    'factorial': (1, 1), 'double-factorial': (1, 1), 'binomial': (2, 2),
    'permutations': (2, 2), 'gcd': (2, 256), 'lcm': (2, 256),
    'integer-quotient': (2, 2), 'integer-remainder': (2, 2), 'divides': (2, 2),
    'congruent-modulo': (3, 3), 'is-prime': (1, 1), 'next-prime': (1, 1),
    'prime-factors': (1, 1), 'divisors': (1, 1), 'euler-totient': (1, 1),
    'floor': (1, 1), 'ceiling': (1, 1), 'round': (1, 2),
    'minimum': (1, 256), 'maximum': (1, 256), 'sign': (1, 1), 'modulo': (2, 2),
}


def integer_operation(decoder, operation, args, problem):
    minimum, maximum = ARITY[operation]
    if not minimum <= len(args) <= maximum:
        raise problem('syntax', 'Invalid integer operation argument count')

    def integer(value):
        if not isinstance(value, s.Integer):
            raise problem('domain', 'An exact integer is required; no rounding is implied')
        if int(value).bit_length() > 4096:
            raise problem('budget', 'Integer input exceeds 4096 bits')
        return int(value)

    remaining = 200000

    def tick():
        nonlocal remaining
        remaining -= 1
        decoder.sequence_work += 1
        if remaining < 0 or decoder.sequence_work > MAX_WORK:
            raise problem('budget', 'Integer work exhausted; no partial or probable result')

    if operation in ('floor', 'ceiling', 'round', 'minimum', 'maximum', 'sign', 'modulo'):
        if any(not isinstance(a, s.Expr) or a.is_real is not True or a.is_finite is not True for a in args):
            raise problem('domain', 'Finite established real values are required')
        if operation == 'floor':
            return s.floor(args[0])
        if operation == 'ceiling':
            return s.ceiling(args[0])
        if operation == 'sign':
            return s.sign(args[0])
        if operation in ('minimum', 'maximum'):
            return (s.Min if operation == 'minimum' else s.Max)(*args)
        if operation == 'modulo':
            decoder.nonzero(args[1])
            # Ordinary mod has the divisor's sign. IntegerRemainder is Euclidean.
            return args[0]-s.floor(args[0]/args[1])*args[1]
        digits = integer(args[1]) if len(args) == 2 else 0
        if abs(digits) > 2048:
            raise problem('budget', 'Rounding precision exceeds 2048 digits')
        scale = s.Integer(10)**digits
        scaled = args[0]*scale
        lower = s.floor(scaled)
        if not isinstance(lower, s.Integer):
            raise problem('unevaluated', 'Rounding needs an established integer enclosure')
        half = s.simplify(scaled-lower-s.Rational(1, 2))
        if half.is_zero is True:
            rounded = lower if lower % 2 == 0 else lower+1
        elif half.is_negative is True:
            rounded = lower
        elif half.is_positive is True:
            rounded = lower+1
        else:
            raise problem('unevaluated', 'Rounding direction is not established')
        return rounded/scale

    values = [integer(a) for a in args]
    a = values[0]
    if operation in ('factorial', 'double-factorial', 'binomial', 'permutations'):
        if operation == 'double-factorial' and a == -1:
            return s.S.One
        if any(n < 0 for n in values) or len(values) == 2 and values[1] > a:
            raise problem('domain', 'Combinatorial arguments require 0 <= k <= n')
        if a > 1000:
            raise problem('budget', 'Combinatorial input exceeds 1000')
        if operation == 'binomial':
            return s.Integer(math.comb(a, values[1]))
        if operation == 'permutations':
            return s.Integer(math.perm(a, values[1]))
        return s.Integer(math.prod(range(a, 1, -2 if operation == 'double-factorial' else -1)))
    if operation in ('gcd', 'lcm'):
        return s.Integer((math.gcd if operation == 'gcd' else math.lcm)(*values))

    def remainder(left, modulus):
        if modulus == 0:
            raise problem('domain', 'A modulus must be nonzero')
        return left % abs(modulus)

    if operation == 'integer-remainder':
        return s.Integer(remainder(a, values[1]))
    if operation == 'integer-quotient':
        return s.Integer((a-remainder(a, values[1]))//values[1])
    if operation == 'divides':
        return s.sympify(values[1] == 0 if a == 0 else values[1] % a == 0)
    if operation == 'congruent-modulo':
        return s.sympify(remainder(a, values[2]) == remainder(values[1], values[2]))

    def prime(n):
        if n < 2:
            return False
        if n in (2, 3):
            return True
        tick()
        if n % 2 == 0 or n % 3 == 0:
            return False
        divisor = 5
        while divisor <= n//divisor:
            tick()
            if n % divisor == 0 or n % (divisor+2) == 0:
                return False
            divisor += 6
        return True

    if operation == 'is-prime':
        return s.sympify(prime(a))
    if operation == 'next-prime':
        candidate = max(2, a+1)
        if candidate > 2 and candidate % 2 == 0:
            candidate += 1
        while True:
            tick()
            if prime(candidate):
                return s.Integer(candidate)
            candidate += 2
    if a <= 0:
        raise problem('domain', 'Factorization requires a positive integer')
    rest, factors = a, []

    def extract(p):
        nonlocal rest
        exponent = 0
        while True:
            tick()
            if rest % p:
                break
            rest //= p
            exponent += 1
        if exponent:
            factors.append((p, exponent))

    extract(2)
    extract(3)
    divisor = 5
    while divisor <= rest//divisor:
        extract(divisor)
        extract(divisor+2)
        divisor += 6
    if rest > 1:
        factors.append((rest, 1))
    if operation == 'prime-factors':
        if len(factors) > 256:
            raise problem('budget', 'Too many prime factors')
        return tuple(tuple(s.Integer(n) for n in pair) for pair in factors)
    if operation == 'euler-totient':
        result = a
        for p, _ in factors:
            result = result//p*(p-1)
        return s.Integer(result)
    divisors = [1]
    for p, exponent in factors:
        if len(divisors)*(exponent+1) > 256:
            raise problem('budget', 'Too many divisors; no partial list')
        prior = divisors[:]
        power = 1
        for _ in range(exponent):
            power *= p
            for n in prior:
                tick()
                divisors.append(n*power)
    return tuple(s.Integer(n) for n in sorted(divisors))
