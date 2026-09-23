"""Independent values and refusal of unproved/undefined Cartesian fields."""
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


def field(operation, body, names=('x', 'y'), points=(2, 3)):
    function = {'kind': 'binder', 'operation': 'lambda', 'body': body, 'bindings': [
        {'variable': sym(name)['reference'], 'domain': {'kind': 'unrestricted'}} for name in names]}
    return op(operation+'-at', function, op('list', *(num(value) for value in points)))


class VectorCalculus(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_scalar_field_gradient_laplacian_and_hessian(self):
        body = op('multiply', op('power', sym('x'), num(2)), sym('y'))
        self.assertEqual(self.value(field('gradient', body)), (12, 4))
        self.assertEqual(self.value(field('laplacian', body)), 6)
        self.assertEqual(self.value(field('hessian', body)), s.ImmutableMatrix([[6, 4], [4, 0]]))

    def test_vector_field_jacobian_divergence_and_right_handed_curl(self):
        body = op('list', op('multiply', sym('x'), sym('y')), op('power', sym('x'), num(2)))
        self.assertEqual(self.value(field('jacobian', body)), s.ImmutableMatrix([[3, 2], [4, 0]]))
        self.assertEqual(self.value(field('divergence', body)), 3)
        rotational = op('list', op('negate', sym('y')), sym('x'), num(0))
        self.assertEqual(self.value(field('curl', rotational, ('x', 'y', 'z'), (2, 3, 4))), (0, 0, 2))

    def test_coordinate_order_is_explicit(self):
        body = op('multiply', op('power', sym('x'), num(2)), sym('y'))
        self.assertEqual(self.value(field('gradient', body, ('y', 'x'), (3, 2))), (4, 12))

    def test_transcendental_chain_factors_and_regular_absolute_value(self):
        self.assertEqual(self.value(field('gradient', op('sin', sym('x')), ('x',), (0,)), 'degree'), (s.pi/180,))
        self.assertEqual(self.value(field('gradient', op('natural-log', sym('x')), ('x',), (2,))), (s.Rational(1, 2),))
        self.assertEqual(self.value(field('gradient', op('absolute', sym('x')), ('x',), (-2,))), (-1,))

    def test_removable_holes_and_joint_singularities_are_not_filled(self):
        for body in (op('divide', sym('x'), sym('x')),
                     op('divide', op('multiply', sym('x'), sym('y')),
                        op('add', op('square', sym('x')), op('square', sym('y'))))):
            self.assertEqual(self.result(field('gradient', body, points=(0, 0)))['reason'], 'domain')

    def test_component_and_zero_cannot_erase_original_field_checks(self):
        bad = field('jacobian', op('list', sym('x'), op('divide', sym('y'), sym('y'))), points=(2, 0))
        for expression in (op('component', bad, num(1), num(1)), op('multiply', num(0), op('component', bad, num(1), num(1)))):
            self.assertEqual(self.result(expression)['reason'], 'domain')
        hidden = field('gradient', op('component', op('list', sym('x'), op('divide', sym('y'), sym('y'))), num(1)), points=(2, 0))
        self.assertEqual(self.result(hidden)['reason'], 'domain')

    def test_unproved_smooth_boundaries_remain_unresolved(self):
        for body in (op('absolute', sym('x')), op('sqrt', sym('x'))):
            result = self.result(field('gradient', body, ('x',), (0,)))
            self.assertEqual(result['status'], 'unresolved', result)
            self.assertFalse(result['coordinateAuthorized'])

    def test_complex_values_and_duplicate_bindings_are_rejected(self):
        body = op('multiply', {'kind': 'constant', 'name': 'imaginary-unit'}, sym('x'))
        self.assertEqual(self.result(field('gradient', body))['reason'], 'domain')
        self.assertEqual(self.result(field('gradient', sym('x'), ('x', 'x')))['reason'], 'syntax')
        self.assertEqual(self.result(field('curl', op('list', sym('x'), sym('y'))))['reason'], 'domain')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if not isinstance(items, list) or len(items) > 80:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in items]))
    else:
        unittest.main()
