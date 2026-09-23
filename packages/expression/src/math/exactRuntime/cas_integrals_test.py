"""The shipped exact engine must establish ordinary improper integrals, never implicit principal values."""
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

INF = {'kind': 'constant', 'name': 'infinity'}


def integral(body, lower, upper, variable='t'):
    return {'kind': 'binder', 'operation': 'integrate', 'body': body, 'bindings': [
        {'variable': sym(variable)['reference'], 'domain': {
            'kind': 'range', 'lower': lower, 'upper': upper, 'step': None}}]}


class ExactIntegrals(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_integrable_endpoint_root_and_log(self):
        self.assertEqual(self.value(integral(op('divide', num(1), op('sqrt', sym('t'))), num(0), num(1))), 2)
        self.assertEqual(self.value(integral(op('natural-log', sym('t')), num(0), num(1))), -1)

    def test_removable_original_hole_and_reverse_direction(self):
        body = op('divide', op('subtract', op('power', sym('t'), num(2)), num(1)),
                  op('subtract', sym('t'), num(1)))
        self.assertEqual(self.value(integral(body, num(0), num(2))), 4)
        self.assertEqual(self.value(integral(body, num(2), num(0))), -4)
        self.assertEqual(self.value(integral(op('divide', sym('t'), sym('t')), num(-1), num(1))), 2)

    def test_independent_sides_of_interior_poles_are_not_principal_values(self):
        for power in (1, 2):
            body = op('divide', num(1), op('power', sym('t'), num(power)))
            for bounds in ((num(-1), num(1)), (num(0), num(1))):
                with self.subTest(power=power, bounds=bounds):
                    self.assertEqual(self.result(integral(body, *bounds))['reason'], 'divergent')

    def test_improper_half_lines_and_two_sided_integrals(self):
        cauchy = op('divide', num(1), op('add', num(1), op('power', sym('t'), num(2))))
        self.assertEqual(self.value(integral(cauchy, op('negate', INF), INF)), s.pi)
        self.assertEqual(self.value(integral(op('exponential', op('negate', sym('t'))), num(0), INF)), 1)
        self.assertEqual(self.value(integral(op('divide', num(1), op('power', sym('t'), num(2))), num(1), INF)), 1)
        self.assertEqual(self.result(integral(op('divide', num(1), sym('t')), num(1), INF))['reason'], 'divergent')

    def test_outer_zero_and_subtraction_do_not_hide_divergence(self):
        invalid = integral(op('divide', num(1), sym('t')), num(-1), num(1))
        for expression in (op('multiply', num(0), invalid), op('subtract', invalid, invalid)):
            self.assertEqual(self.result(expression)['reason'], 'divergent')

    def test_degree_radian_and_ordinary_nested_ranges(self):
        body = op('sin', sym('t'))
        self.assertEqual(self.value(integral(body, num(0), num(180)), 'degree'), 360/s.pi)
        self.assertEqual(self.value(integral(body, num(0), {'kind': 'constant', 'name': 'pi'})), 2)
        nested = integral(integral(op('multiply', sym('t'), sym('u')), num(0), sym('t'), 'u'), num(0), num(1))
        self.assertEqual(self.value(nested), s.Rational(1, 8))

    def test_undefined_real_interval_is_not_assumed_valid(self):
        result = self.result(integral(op('divide', num(1), op('sqrt', sym('t'))), num(-1), num(1)))
        self.assertNotEqual(result['status'], 'value', result)

    def test_parameter_dependent_divergence_cannot_disappear_under_outer_zero(self):
        inner = integral(op('multiply', sym('t'), op('exponential', sym('u'))), num(0), INF, 'u')
        expression = integral(op('multiply', num(0), inner), num(1), num(2))
        result = self.result(expression)
        self.assertNotEqual(result['status'], 'value', result)

    def test_finite_and_separable_nested_ranges_keep_exact_answers(self):
        finite = integral(integral(op('multiply', sym('t'), sym('u')), num(0), sym('t'), 'u'), num(0), num(1))
        self.assertEqual(self.value(finite), s.Rational(1, 8))
        decay = integral(op('multiply', sym('t'), op('exponential', op('negate', sym('u')))), num(0), INF, 'u')
        self.assertEqual(self.value(integral(decay, num(1), num(2))), s.Rational(3, 2))
        self.assertEqual(self.value(integral(decay, num(2), num(1))), -s.Rational(3, 2))

    def test_multiple_bindings_keep_outer_inner_order_and_discharge_each_domain(self):
        expression = integral(op('multiply', sym('t'), sym('u')), num(0), num(1))
        expression['bindings'].append({'variable': sym('u')['reference'], 'domain': {
            'kind': 'range', 'lower': num(0), 'upper': sym('t'), 'step': None}})
        self.assertEqual(self.value(expression), s.Rational(1, 8))


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if not isinstance(items, list) or len(items) > 32:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
