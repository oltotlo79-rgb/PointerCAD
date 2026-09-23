"""Independent coefficients and analytic domains, using the shipped fixed engine."""
from fractions import Fraction
import math
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder
from cas_line_integrals_test import function
from cas_step_ranges_test import num, sym, op


def expansion(body, center=0, degree=3):
    return op('taylor', function(body, ('x',)), num(center), num(degree))


class TaylorTests(unittest.TestCase):
    def result(self, source, angle='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': source, 'angleUnit': angle})))

    def value(self, source, angle='radian'):
        result = self.result(source, angle)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'series')
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['domainConditions'], [])
        value = result['expansion']
        return value, [Decoder(angle).node(node) for node in value['coefficients']]

    def test_exponential_coefficients_against_integer_factorials(self):
        report, values = self.value(expansion(op('exponential', sym('x')), degree=8))
        for index, value in enumerate(values):
            reference = Fraction(1, math.factorial(index))
            self.assertEqual(value, s.Rational(reference.numerator, reference.denominator))
        self.assertEqual(report['convergence'], {'kind': 'entire', 'radius': None})
        self.assertFalse(report['exact'])
        self.assertEqual(report['remainderOrder'], '9')

    def test_geometric_power_series_and_nonzero_center(self):
        report, values = self.value(expansion(op('divide', num(1), op('subtract', num(1), sym('x'))), degree=4))
        self.assertEqual(values, [1]*5)
        self.assertEqual(report['convergence']['kind'], 'disk')
        self.assertEqual(Decoder('radian').node(report['convergence']['radius']), 1)
        self.assertEqual(sum(c*s.Rational(1, 2)**i for i, c in enumerate(values)), s.Rational(31, 16))
        report, values = self.value(expansion(op('divide', num(1), sym('x')), 1, 3))
        self.assertEqual(values, [1, -1, 1, -1])
        self.assertEqual(sum(c*s.Rational(1, 2)**i for i, c in enumerate(values)), s.Rational(5, 8))

    def test_exact_polynomial_and_degree_zero(self):
        report, values = self.value(expansion(op('power', sym('x'), num(3)), 2, 4))
        self.assertEqual(values, [8, 12, 6, 1, 0])
        self.assertTrue(report['exact'])
        report, values = self.value(expansion(num(7), 9, 0))
        self.assertEqual(values, [7])
        self.assertTrue(report['exact'])

    def test_trigonometric_angle_conventions_and_complex_coefficients(self):
        body = op('sin', sym('x'))
        _, values = self.value(expansion(body))
        self.assertEqual(values, [0, 1, 0, -s.Rational(1, 6)])
        _, degrees = self.value(expansion(body), 'degree')
        self.assertEqual(degrees, [0, s.pi/180, 0, -(s.pi/180)**3/6])
        _, values = self.value(expansion(op('multiply', {'kind': 'constant', 'name': 'imaginary-unit'}, sym('x'))))
        self.assertEqual(values, [0, s.I, 0, 0])

    def test_nonanalytic_centers_and_original_canceled_holes_are_not_filled(self):
        hole = op('subtract', sym('x'), num(1))
        for body, center in [(op('divide', hole, hole), 1), (op('absolute', sym('x')), 0),
                             (op('divide', num(1), sym('x')), 0), (op('natural-log', sym('x')), 0),
                             (op('multiply', num(0), op('natural-log', sym('x'))), 0)]:
            self.assertNotEqual(self.result(expansion(body, center))['status'], 'value')

    def test_canceled_original_pole_still_limits_certified_disk(self):
        body = op('divide', sym('x'), sym('x'))
        report, values = self.value(expansion(body, 1))
        self.assertEqual(values, [1, 0, 0, 0])
        self.assertFalse(report['exact'])
        # The original reciprocal was evaluated before cancellation.
        self.assertNotEqual(report['convergence']['kind'], 'entire')

    def test_branch_functions_do_not_claim_entire_convergence(self):
        report, values = self.value(expansion(op('natural-log', sym('x')), 1, 3))
        self.assertEqual(values, [0, 1, -s.Rational(1, 2), s.Rational(1, 3)])
        self.assertEqual(report['convergence']['kind'], 'unknown')

    def test_complex_poles_bound_the_disk_even_without_real_poles(self):
        report, _ = self.value(expansion(op('divide', num(1), op('add', num(1), op('square', sym('x')))), degree=4))
        self.assertEqual(report['convergence']['kind'], 'disk')
        self.assertEqual(Decoder('radian').node(report['convergence']['radius']), 1)

    def test_invalid_order_budget_and_nested_scalar_use_are_rejected(self):
        for degree in [-1, '0.5', 13, 1000000]:
            self.assertNotEqual(self.result(expansion(sym('x'), degree=degree))['status'], 'value')
        for source in [op('multiply', num(0), expansion(sym('x'))),
                       op('component', op('list', num(1), expansion(sym('x'))), num(1))]:
            self.assertNotEqual(self.result(source)['status'], 'value')

    def test_large_power_keeps_only_requested_coefficients_without_full_expansion(self):
        degree = 1_000_000
        report, values = self.value(expansion(op('power', op('add', num(1), sym('x')), num(degree))))
        self.assertEqual(values, [1, degree, math.comb(degree, 2), math.comb(degree, 3)])
        self.assertFalse(report['exact'])
        self.assertEqual(report['remainderOrder'], '4')
        self.assertEqual(report['convergence'], {'kind': 'entire', 'radius': None})

    def test_original_large_powers_are_rejected_before_allocation_or_cancellation(self):
        from cas_taylor import taylor_result
        from cas_input import CasInputProblem

        class GuardedDecoder(Decoder):
            def operation(self, operation, arguments):
                if operation == 'power' and arguments == [s.Integer(2), s.Integer(20000)]:
                    raise AssertionError('The over-budget power reached exact allocation')
                return super().operation(operation, arguments)

        huge = op('power', num(2), num(20000))
        for source in [op('taylor', function(sym('x'), ('x',)), huge, num(3)),
                       op('taylor', function(sym('x'), ('x',)), num(0), huge),
                       expansion(op('add', sym('x'), op('multiply', num(0), huge)))]:
            decoder = GuardedDecoder('radian')
            with self.assertRaises(CasInputProblem) as raised:
                taylor_result(source, decoder)
            self.assertEqual(raised.exception.code, 'budget')
            self.assertEqual(decoder.sequence_depth, 0)
            self.assertIsNone(decoder.domain_observer)
            result = self.result(source)
            self.assertEqual((result['status'], result['reason']), ('stopped', 'budget'))
            self.assertFalse(result['coordinateAuthorized'])

    def test_selected_coefficient_is_exact_and_retains_outer_arithmetic(self):
        coefficient = op('series-coefficient', expansion(op('power', sym('x'), num(3)), 2, 4), num(1))
        for source, expected in [(coefficient, 12), (op('add', op('multiply', num(2), coefficient), num(1)), 25)]:
            result = self.result(source)
            self.assertEqual(result['status'], 'value', result)
            self.assertEqual(Decoder('radian').node(result['expression']), expected)
            self.assertFalse(result['coordinateAuthorized'])
        hole = op('subtract', sym('x'), num(1))
        local = op('series-coefficient', expansion(op('divide', hole, hole), 2, 3), num(0))
        result = self.result(local)
        self.assertEqual(Decoder('radian').node(result['expression']), 1)
        self.assertEqual(result['domainConditions'], [])

    def test_selection_checks_the_whole_source_before_zero_and_component(self):
        bad = op('series-coefficient', expansion(op('absolute', sym('x'))), num(0))
        for source in [bad, op('multiply', num(0), bad), op('component', op('list', num(7), bad), num(1)),
                       op('add', op('divide', num(1), num(0)),
                          op('series-coefficient', expansion(sym('x')), num(1)))]:
            self.assertNotEqual(self.result(source)['status'], 'value')
        for order in [-1, '0.5', 4]:
            self.assertNotEqual(self.result(op('series-coefficient', expansion(sym('x')), num(order)))['status'], 'value')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if type(items) is not list or len(items) > 100:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
