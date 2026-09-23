"""Analytic line length, oriented work, reparametrization and original-domain checks."""
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


def function(body, names):
    return {'kind': 'binder', 'operation': 'lambda', 'body': body, 'bindings': [
        {'variable': sym(name)['reference'], 'domain': {'kind': 'unrestricted'}} for name in names]}


def line(body, path, lower=0, upper=1, operation='line-integral', names=('x', 'y')):
    return op(operation, function(body, names), function(op('list', *path), ('t',)),
              num(lower) if isinstance(lower, int) else lower, num(upper) if isinstance(upper, int) else upper)


class LineIntegrals(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_length_density_and_reversed_arc_limits(self):
        path = [op('multiply', num(3), sym('t')), op('multiply', num(4), sym('t'))]
        self.assertEqual(self.value(line(num(1), path)), 5)
        self.assertEqual(self.value(line(num(1), path, 1, 0)), 5)
        self.assertEqual(self.value(line(sym('x'), path)), s.Rational(15, 2))

    def test_closed_circle_measure_and_orientation_in_both_angle_units(self):
        path = [op('cos', sym('t')), op('sin', sym('t'))]
        field = op('list', op('negate', sym('y')), sym('x'))
        for unit, end in [('radian', op('multiply', num(2), {'kind':'constant','name':'pi'})), ('degree', 360)]:
            self.assertEqual(self.value(line(num(1), path, 0, end), unit), 2*s.pi)
            self.assertEqual(self.value(line(field, path, 0, end, 'circulation'), unit), 2*s.pi)
            self.assertEqual(self.value(line(field, path, end, 0, 'circulation'), unit), -2*s.pi)

    def test_conservative_field_work_and_reparametrization(self):
        field = op('list', op('multiply', num(2), sym('x')), op('multiply', num(2), sym('y')))
        path = [sym('t'), op('square', sym('t'))]
        slower = [op('square', sym('t')), op('power', sym('t'), num(4))]
        self.assertEqual(self.value(line(field, path, operation='circulation')), 2)
        self.assertEqual(self.value(line(field, slower, operation='circulation')), 2)

    def test_real_three_dimensional_helix(self):
        path = [op('cos', sym('t')), op('sin', sym('t')), sym('t')]
        end = op('multiply', num(2), {'kind':'constant','name':'pi'})
        self.assertEqual(self.value(line(num(1), path, 0, end, names=('x','y','z'))), 2*s.pi*s.sqrt(2))

    def test_integrable_field_endpoint_and_infinite_path(self):
        reciprocal_root = op('divide', num(1), op('sqrt', sym('x')))
        self.assertEqual(self.value(line(reciprocal_root, [sym('t')], names=('x',))), 2)
        self.assertEqual(self.value(line(op('exponential', op('negate', sym('x'))), [sym('t')],
                                         upper={'kind':'constant','name':'infinity'}, names=('x',))), 1)

    def test_path_gaps_complex_values_and_unselected_invalid_field(self):
        paths = [[op('divide', sym('t'), sym('t')), num(0)], [op('sqrt', sym('t')), num(0)],
                 [{'kind':'constant','name':'imaginary-unit'}, sym('t')]]
        for path in paths:
            self.assertEqual(self.result(line(num(1), path, -1, 1))['reason'], 'domain')
        hidden = op('list', num(1), op('divide', sym('y'), sym('y')))
        self.assertEqual(self.result(line(hidden, [sym('t'), num(0)], operation='circulation'))['reason'], 'domain')

    def test_opposite_improper_sides_and_zero_do_not_hide_divergence(self):
        singular = line(op('divide', num(1), sym('x')), [sym('t')], -1, 1, names=('x',))
        for expression in (singular, op('multiply', num(0), singular), op('subtract', singular, singular)):
            self.assertEqual(self.result(expression)['reason'], 'divergent')

    def test_coordinate_order_and_zero_speed(self):
        self.assertEqual(self.value(line(sym('x'), [num(2), sym('t')], names=('y','x'))), s.Rational(1, 2))
        self.assertEqual(self.value(line(num(7), [num(2), num(3)])), 0)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if not isinstance(items, list) or len(items) > 80:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
