"""Closed forms and independent exact enumeration check the finite sequence contract."""
from fractions import Fraction
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder, CasInputProblem
from cas_sequences import MAX_WORK
from cas_line_integrals_test import function
from cas_step_ranges_test import num, sym, op


def recurrence(body, seeds, target, first=0, names=('n', 'a')):
    return op('recurrence-value', function(body, names), num(first), op('list', *(num(n) for n in seeds)), num(target))


class SequenceTests(unittest.TestCase):
    def result(self, expression, angle='degree'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': angle})))

    def value(self, expression, angle='degree'):
        result = self.result(expression, angle)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(angle).node(result['expression'])

    def test_fibonacci_against_independent_integer_enumeration(self):
        left, right = 0, 1
        for index in range(40):
            self.assertEqual(self.value(recurrence(op('add', sym('a'), sym('b')), [0, 1], index, names=('n', 'a', 'b'))), left)
            left, right = right, left+right

    def test_indexed_closed_formula_and_negative_initial_index(self):
        self.assertEqual(self.value(op('sequence-value', function(op('square', sym('n')), ('n',)), num(-3))), 9)
        self.assertEqual(self.value(recurrence(op('add', sym('a'), sym('n')), [10], 1, first=-2)), 7)

    def test_difference_is_not_a_derivative_and_keeps_step(self):
        fn = function(op('power', sym('n'), num(3)), ('n',))
        for order, expected in [(0, 27), (1, 98), (2, 120), (3, 48), (4, 0)]:
            self.assertEqual(self.value(op('difference-at', fn, num(3), num(order), num(2))), expected)

    def test_nonlinear_recurrence_against_fraction_enumeration(self):
        # a_(n+1)=a_n^2+1/2, a_0=1/2, evaluated without floating rounding.
        body = op('add', op('square', sym('a')), op('divide', num(1), num(2)))
        expression = recurrence(body, ['0.5'], 5)
        expected = Fraction(1, 2)
        for _ in range(5):
            expected = expected**2 + Fraction(1, 2)
        self.assertEqual(self.value(expression), s.Rational(expected.numerator, expected.denominator))

    def test_state_order_and_initial_values_are_not_reversed(self):
        self.assertEqual(self.value(recurrence(op('subtract', sym('b'), sym('a')), [2, 5], 2, names=('n', 'a', 'b'))), 3)
        for index, expected in [(0, 2), (1, 5)]:
            self.assertEqual(self.value(recurrence(op('subtract', sym('b'), sym('a')), [2, 5], index, names=('n', 'a', 'b'))), expected)

    def test_angles_and_complex_terms_keep_their_meaning(self):
        fn = function(op('sin', sym('n')), ('n',))
        self.assertEqual(self.value(op('sequence-value', fn, num(30))), s.Rational(1, 2))
        body = op('multiply', sym('a'), {'kind': 'constant', 'name': 'imaginary-unit'})
        self.assertEqual(self.value(recurrence(body, [1], 3)), -s.I)

    def test_every_used_domain_is_checked_before_simplification(self):
        hole = op('divide', num(1), op('subtract', sym('n'), num(1)))
        for body in [hole, op('multiply', num(0), hole), op('component', op('list', num(1), hole), num(1))]:
            expression = recurrence(body, [0], 3)
            for wrapped in [expression, op('multiply', num(0), expression)]:
                self.assertNotEqual(self.result(wrapped)['status'], 'value')

    def test_invalid_index_order_step_and_seed_shape_have_no_value(self):
        fn = function(sym('n'), ('n',))
        bad = [op('sequence-value', fn, num('0.5')),
               op('difference-at', fn, num(1), num(-1), num(1)),
               op('difference-at', fn, num(1), num(1), num(0)),
               recurrence(sym('a'), [1], -1),
               recurrence(sym('a'), [1, 2], 5),
               recurrence(sym('a'), [1], 2, names=('n', 'n'))]
        for expression in bad:
            self.assertNotEqual(self.result(expression)['status'], 'value')

    def test_budget_stops_before_explosive_power_and_without_partial_result(self):
        for expression in [recurrence(op('power', sym('a'), sym('a')), [2], 10),
                           recurrence(op('add', sym('a'), num(1)), [0], 4097),
                           op('difference-at', function(sym('n'), ('n',)), num(0), num(65), num(1))]:
            self.assertEqual(self.result(expression), {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})

    def test_cumulative_work_is_shared_and_scope_is_restored_on_failure(self):
        decoder = Decoder('degree')
        decoder.sequence_work = MAX_WORK-1
        with self.assertRaises(CasInputProblem) as caught:
            decoder.node(recurrence(op('add', sym('a'), num(1)), [0], 2))
        self.assertEqual(caught.exception.code, 'budget')
        self.assertEqual(decoder.sequence_depth, 0)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if type(items) is not list or len(items) > 100:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
