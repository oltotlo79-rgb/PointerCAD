"""Independent enumeration and moment formulas for declared probability laws."""
import json
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder
from cas_line_integrals_test import function
from cas_step_ranges_test import num, sym, op


def calculation(operation, bodies, law, names=('x',)):
    return op(operation, function(op('list', *bodies), names), law)


class ProbabilityTests(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_all_36_dice_pairs_against_counted_conditional_event(self):
        rows = [(i, j) for i in range(1, 7) for j in range(1, 7)]
        law = op('joint-finite-distribution', op('list', *(op('list', num(i), num(j)) for i, j in rows)),
                 op('list', *(op('divide', num(1), num(36)) for _ in rows)))
        event = op('equal', op('add', sym('x'), sym('y')), num(7))
        condition = op('greater', sym('x'), num(3))
        counted = s.Rational(sum(i+j == 7 and i > 3 for i, j in rows), sum(i > 3 for i, j in rows))
        self.assertEqual(self.value(calculation('given-probability', [event, condition], law, ('x', 'y'))), counted)
        self.assertEqual(self.value(calculation('independent-variables', [sym('x'), sym('y')], law, ('x', 'y'))), s.true)

    def test_zero_covariance_does_not_mean_independence(self):
        law = op('finite-distribution', op('list', num(-1), num(0), num(1)),
                 op('list', *(op('divide', num(1), num(3)) for _ in range(3))))
        self.assertEqual(self.value(calculation('random-covariance', [sym('x'), op('square', sym('x'))], law)), 0)
        self.assertEqual(self.value(calculation('independent-variables', [sym('x'), op('square', sym('x'))], law)), s.false)

    def test_repeated_outcomes_keep_their_probability_mass(self):
        law = op('finite-distribution', op('list', num(0), num(2), num(2)),
                 op('list', op('divide', num(1), num(2)), op('divide', num(1), num(4)), op('divide', num(1), num(4))))
        self.assertEqual(self.value(calculation('random-expectation', [sym('x')], law)), 1)
        self.assertEqual(self.value(calculation('random-variance', [sym('x')], law)), 1)

    def test_positive_noninteger_f_degrees_keep_the_same_analytic_mean(self):
        law = op('f-distribution', op('divide', num(1), num(2)), num(6))
        self.assertEqual(self.value(calculation('random-expectation', [sym('x')], law)), s.Rational(3, 2))

    def test_normalization_constants_reduce_to_the_analytic_moments(self):
        self.assertEqual(self.value(calculation('random-variance', [sym('x')], op('t-distribution', num(4)))), 2)
        self.assertNotEqual(self.result(calculation('random-variance', [sym('x')], op('t-distribution', num(2))))['status'], 'value')
        self.assertEqual(self.value(calculation('random-expectation', [sym('x')], op('f-distribution', num(3), num(6)))), s.Rational(3, 2))

    def test_both_normal_tails_transfer_their_exact_error_function_identity(self):
        normal = op('normal-distribution', num(0), num(1))
        for comparison in ['greater', 'less']:
            result = self.result(calculation('event-probability', [op(comparison, sym('x'), num(1))], normal))
            self.assertEqual(result['status'], 'value', result)
            self.assertEqual(result['domainConditions'], [])
            expected = s.erfc(1/s.sqrt(2))/2 if comparison == 'greater' else 1-s.erfc(1/s.sqrt(2))/2
            self.assertEqual(s.simplify(Decoder('radian').node(result['expression'])-expected), 0)
            self.assertIn('erfc', json.dumps(result['expression']))

    def test_independent_variables_do_not_silently_make_joint_events_independent(self):
        law = op('independent-distributions', op('list', *(op('normal-distribution', num(0), num(1)) for _ in range(2))))
        first, second = op('greater', sym('x'), num(0)), op('greater', sym('y'), num(0))
        self.assertEqual(self.value(calculation('event-probability', [op('and', first, second)], law, ('x', 'y'))), s.Rational(1, 4))
        self.assertEqual(self.value(calculation('event-probability', [op('or', first, second)], law, ('x', 'y'))), s.Rational(3, 4))
        overlapping = op('greater', op('add', sym('x'), sym('y')), num(0))
        self.assertNotEqual(self.result(calculation('given-probability', [overlapping, first], law, ('x', 'y')))['status'], 'value')

    def test_undeclared_independence_and_zero_condition_are_rejected(self):
        normal = op('normal-distribution', num(0), num(1))
        expressions = [calculation('random-covariance', [sym('x'), sym('y')], normal, ('x', 'y')),
                       calculation('given-probability', [op('greater', sym('x'), num(0)),
                                                        op('equal', sym('x'), num(0))], normal)]
        for expression in expressions:
            self.assertNotEqual(self.result(expression)['status'], 'value')

    def test_source_division_hole_survives_multiply_zero_and_component_selection(self):
        for law in [op('normal-distribution', num(0), num(1)), op('uniform-distribution', num(-1), num(1))]:
            hole = op('divide', sym('x'), sym('x'))
            for body in [op('multiply', num(0), hole), op('component', op('list', num(1), hole), num(1))]:
                self.assertNotEqual(self.result(calculation('random-expectation', [body], law))['status'], 'value')

    def test_affine_joint_normal_and_unproved_nonlinear_independence(self):
        law = op('independent-distributions', op('list', *(op('normal-distribution', num(0), num(1)) for _ in range(2))))
        self.assertEqual(self.value(calculation('independent-variables', [op('add', sym('x'), sym('y')),
                                                                        op('subtract', sym('x'), sym('y'))], law, ('x', 'y'))), s.true)
        normal = op('normal-distribution', num(0), num(1))
        self.assertNotEqual(self.result(calculation('independent-variables', [sym('x'), op('square', sym('x'))], normal))['status'], 'value')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if type(items) is not list or len(items) > 100:
            raise ValueError('A bounded batch is required')
        replies = []
        for index, item in enumerate(items):
            started = time.monotonic()
            print('Probability case start: ' + str(index), file=sys.stderr, flush=True)
            replies.append(json.loads(calculate_exact_json(json.dumps(item))))
            print('Probability case finish: ' + str(index) + ' / ' + str(round(time.monotonic()-started, 3)), file=sys.stderr, flush=True)
        print(json.dumps(replies))
    else:
        unittest.main()
