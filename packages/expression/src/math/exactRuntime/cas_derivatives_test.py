"""Check classical derivatives against independent exact values and original domains."""
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
from cas_input import Decoder
from cas_step_ranges_test import num, sym, op


def derivative(body, point, order=1, variable='t'):
    function = {'kind': 'binder', 'operation': 'lambda', 'body': body, 'bindings': [
        {'variable': sym(variable)['reference'], 'domain': {'kind': 'unrestricted'}}]}
    return op('differentiate-at', function, point, num(order))


class ExactDerivatives(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_polynomial_orders_are_taken_before_substitution(self):
        cube = op('power', sym('t'), num(3))
        for order, expected in ((1, 12), (2, 12), (3, 6), (4, 0), (15, 0)):
            with self.subTest(order=order):
                self.assertEqual(self.value(derivative(cube, num(2), order)), expected)

    def test_degree_and_radian_keep_chain_factors_at_each_order(self):
        self.assertEqual(self.value(derivative(op('sin', sym('t')), num(0))), 1)
        self.assertEqual(self.value(derivative(op('sin', sym('t')), num(0)), 'degree'), s.pi/180)
        self.assertEqual(self.value(derivative(op('cos', sym('t')), num(0), 2)), -1)
        self.assertEqual(self.value(derivative(op('cos', sym('t')), num(0), 2), 'degree'), -s.pi**2/32400)

    def test_log_exp_and_rational_answers(self):
        self.assertEqual(self.value(derivative(op('natural-log', sym('t')), num(2))), s.Rational(1, 2))
        self.assertEqual(self.value(derivative(op('exponential', sym('t')), num(0), 3)), 1)
        self.assertEqual(self.value(derivative(op('divide', num(1), sym('t')), num(2), 2)), s.Rational(1, 4))

    def test_corner_is_invalid_but_regular_absolute_values_are_accepted(self):
        body = op('absolute', sym('t'))
        self.assertEqual(self.result(derivative(body, num(0)))['reason'], 'domain')
        self.assertEqual(self.value(derivative(body, num(2))), 1)
        self.assertEqual(self.value(derivative(body, num(-2))), -1)

    def test_boundary_and_original_removable_hole_are_not_derivative_points(self):
        cases = [derivative(op('sqrt', sym('t')), num(0)),
                 derivative(op('divide', sym('t'), sym('t')), num(0)),
                 derivative(op('divide', op('subtract', op('power', sym('t'), num(2)), num(1)),
                               op('subtract', sym('t'), num(1))), num(1))]
        for expression in cases:
            with self.subTest(expression=expression):
                self.assertEqual(self.result(expression)['reason'], 'domain')

    def test_outer_arithmetic_cannot_hide_invalid_derivatives(self):
        invalid = derivative(op('absolute', sym('t')), num(0))
        for expression in (op('multiply', num(0), invalid), op('subtract', invalid, invalid)):
            self.assertEqual(self.result(expression)['reason'], 'domain')

    def test_nested_different_variables_keep_scope(self):
        body = op('multiply', op('power', sym('x'), num(2)), sym('y'))
        expression = derivative(derivative(body, num(2), variable='x'), num(3), variable='y')
        self.assertEqual(self.value(expression), 4)

    def test_invalid_order_and_infinite_point_are_rejected(self):
        for order in (0, -1, '1.5', 16):
            self.assertEqual(self.result(derivative(sym('t'), num(2), order))['reason'], 'domain')
        self.assertEqual(self.result(derivative(sym('t'), {'kind': 'constant', 'name': 'infinity'}))['reason'], 'domain')

    def test_non_list_binding_cannot_be_used_as_a_local_scope(self):
        expression = derivative(sym('t'), num(2))
        expression['operands'][0]['bindings'] = {'0': expression['operands'][0]['bindings'][0]}
        self.assertEqual(self.result(expression)['reason'], 'syntax')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if not isinstance(items, list) or len(items) > 48:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
