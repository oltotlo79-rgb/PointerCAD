"""Compare composed indexed calculations with independent integers and fractions."""
from fractions import Fraction
import json
import math
import unittest
import cas_sequences_test as base
recurrence = base.recurrence
import sympy as s
from cas_input import Decoder, CasInputProblem
from cas_sequences import MAX_WORK
from cas_step_ranges_test import num, sym, op, binding, binder
from cas_line_integrals_test import function


def indexed(body, target):
    return op('sequence-value', function(body, ('n',)), target)


def ranged(operation, body, lower=1, upper=4, step=None):
    return binder(operation, [binding('k', num(lower), num(upper), None if step is None else num(step))], body)


class CompositionTests(unittest.TestCase):
    result = base.SequenceTests.result
    value = base.SequenceTests.value

    def test_fibonacci_sum_and_indexed_product_have_independent_answers(self):
        fib = recurrence(op('add', sym('a'), sym('b')), [0, 1], 0, names=('n', 'a', 'b'))
        fib['operands'][-1] = sym('k')
        a, b, total = 0, 1, 0
        for _ in range(11):
            total += a
            a, b = b, a+b
        self.assertEqual(self.value(ranged('sum', fib, 0, 10)), total)
        self.assertEqual(self.value(ranged('product', indexed(op('add', sym('n'), num(1)), sym('k')))), math.prod(range(2, 6)))

    def test_steps_negative_indices_and_empty_ranges_match_enumeration(self):
        for lower, upper, step in [(-5, 5, 3), (7, 2, 1), (2, 2, 7), (1, 8, 3)]:
            body = indexed(op('add', op('square', sym('n')), num(1)), sym('k'))
            for operation, combine in [('sum', sum), ('product', math.prod)]:
                self.assertEqual(self.value(ranged(operation, body, lower, upper, step)),
                                 combine(k*k+1 for k in range(lower, upper+1, step)))

    def test_outer_dependent_ranges_and_same_labels_keep_distinct_identities(self):
        body = indexed(op('add', sym('n'), sym('outer', 'n')), sym('inner', 'n'))
        expression = binder('sum', [binding('outer', num(1), num(5), num(2), 'n'),
            binding('inner', num(3), sym('outer', 'n'), num(2), 'n')], body)
        expected = sum(sum(i+j for j in range(3, i+1, 2)) for i in range(1, 6, 2))
        self.assertEqual(self.value(expression), expected)

    def test_range_bound_can_use_a_sequence_and_sees_the_outer_scope(self):
        inner = binder('sum', [binding('k', sym('k'), indexed(op('add', sym('n'), num(1)), sym('k')), None)], sym('k'))
        self.assertEqual(self.value(ranged('sum', inner, 1, 3)), sum(sum(range(k, k+2)) for k in range(1, 4)))

    def test_zero_product_and_unused_component_cannot_erase_a_later_hole(self):
        hole = indexed(op('divide', sym('n'), op('subtract', sym('n'), num(2))), sym('k'))
        for body in [hole, op('component', op('list', num(1), hole), num(1))]:
            expression = ranged('product', body, 0, 3)
            for wrapped in [expression, op('multiply', num(0), expression)]:
                self.assertEqual(self.result(wrapped)['status'], 'invalid')

    def test_infinite_composition_is_unresolved_instead_of_a_finite_cutoff(self):
        expression = ranged('sum', indexed(op('power', num(2), op('negate', sym('n'))), sym('k')))
        expression['bindings'][0]['domain']['upper'] = {'kind': 'constant', 'name': 'infinity'}
        self.assertEqual(self.result(expression)['status'], 'unresolved')

    def test_invalid_steps_and_iteration_budgets_return_no_partial_value(self):
        body = indexed(sym('n'), sym('k'))
        for step in (0, -1, '0.5'):
            self.assertEqual(self.result(ranged('sum', body, 1, 4, step))['status'], 'invalid')
        self.assertEqual(self.result(ranged('sum', body, 0, 4096))['status'], 'stopped')
        decoder = Decoder('degree')
        decoder.sequence_work = MAX_WORK-5
        with self.assertRaises(CasInputProblem) as caught:
            decoder.node(ranged('sum', body))
        self.assertEqual(caught.exception.code, 'budget')
        self.assertEqual(decoder.sequence_depth, 0)

    def test_combinatorics_in_terms_match_integer_library(self):
        for n in range(13):
            self.assertEqual(self.value(indexed(op('factorial', sym('n')), num(n))), math.factorial(n))
            self.assertEqual(self.value(indexed(op('double-factorial', sym('n')), num(n))), math.prod(range(n, 1, -2)))
            for k in range(n+1):
                for operation, calculate in [('binomial', math.comb), ('permutations', math.perm)]:
                    self.assertEqual(self.value(indexed(op(operation, sym('n'), num(k)), num(n))), calculate(n, k))
        self.assertEqual(self.value(indexed(op('double-factorial', sym('n')), num(-1))), 1)

    def test_fractional_rounding_is_half_even_on_both_sides_of_zero(self):
        for decimal in ['2.5', '3.5', '-2.5', '-3.5', '1.245', '-1.255', '150', '250']:
            for digits in [-1, 0, 2]:
                expected = round(Fraction(decimal), digits)
                actual = self.value(indexed(op('round', num(decimal), num(digits)), num(1)))
                self.assertEqual(actual, s.Rational(expected.numerator, expected.denominator))
        self.assertEqual(self.value(op('difference-at', function(op('floor', op('divide', sym('n'), num(2))), ('n',)), num(3), num(1), num(1))), 1)

    def test_signed_quotient_remainder_gcd_and_lcm_follow_original_conventions(self):
        for a in range(-7, 8):
            for b in (-3, -2, 2, 3):
                q = self.value(indexed(op('integer-quotient', sym('n'), num(b)), num(a)))
                r = self.value(indexed(op('integer-remainder', sym('n'), num(b)), num(a)))
                self.assertEqual(q*b+r, a)
                self.assertTrue(0 <= r < abs(b))
                self.assertEqual(self.value(indexed(op('modulo', sym('n'), num(b)), num(a))), a % b)
                for operation, calculate in [('gcd', math.gcd), ('lcm', math.lcm)]:
                    self.assertEqual(self.value(indexed(op(operation, sym('n'), num(b)), num(a))), calculate(a, b))

    def test_primes_factors_and_totients_match_exhaustive_small_integers(self):
        def prime(n):
            return n >= 2 and all(n % divisor for divisor in range(2, math.isqrt(n)+1))
        decoder = Decoder('degree')
        for n in range(1, 121):
            self.assertEqual(decoder.operation('is-prime', [s.Integer(n)]), s.sympify(prime(n)))
            next_value = n+1
            while not prime(next_value):
                next_value += 1
            self.assertEqual(self.value(indexed(op('next-prime', sym('n')), num(n))), next_value)
            factors = decoder.operation('prime-factors', [s.Integer(n)])
            self.assertEqual(math.prod(int(p)**int(k) for p, k in factors), n)
            self.assertTrue(all(prime(int(p)) for p, _ in factors))
            self.assertEqual(decoder.operation('divisors', [s.Integer(n)]), tuple(d for d in range(1, n+1) if n % d == 0))
            self.assertEqual(self.value(indexed(op('euler-totient', sym('n')), num(n))), sum(math.gcd(n, k) == 1 for k in range(1, n+1)))

    def test_invalid_integer_operands_are_not_hidden_by_zero_or_component(self):
        invalid = [op('factorial', num(-1)), op('binomial', num(3), num(4)),
            op('factorial', num('1.5')), op('integer-remainder', num(1), num(0)),
            op('divisors', num(0)), op('euler-totient', num(-1))]
        for expression in invalid:
            for body in [expression, op('multiply', num(0), expression), op('component', op('list', num(1), expression), num(1))]:
                self.assertEqual(self.result(indexed(body, num(2)))['status'], 'invalid')
        for expression in [op('factorial', num(1001)), op('round', num(1), num(2049)),
            op('is-prime', op('subtract', op('power', num(2), num(127)), num(1)))]:
            self.assertEqual(self.result(indexed(expression, num(1)))['status'], 'stopped')


if __name__ == '__main__':
    unittest.main()
