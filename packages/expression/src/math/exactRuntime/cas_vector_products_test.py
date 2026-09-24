"""Independent exact vector identities and the JSON boundary, using bundled wheels."""
from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder, CasInputProblem


def op(name, *operands):
    return {'kind': 'operation', 'operation': name, 'operands': list(operands)}


def node(value):
    if isinstance(value, (tuple, list)):
        return op('list', *(node(item) for item in value))
    return value if isinstance(value, dict) else {'kind': 'number', 'decimal': str(value)}


def result(expression):
    return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'degree'})))


X = {'kind': 'symbol', 'reference': {'role': 'axis', 'name': 'X'}}
A = {'kind': 'symbol', 'reference': {'role': 'declared', 'id': 'a', 'label': 'a'}}
I = {'kind': 'constant', 'name': 'imaginary-unit'}
INF = {'kind': 'constant', 'name': 'infinity'}
S2 = op('sqrt', node(2))


class VectorProductChecks(unittest.TestCase):
    def value(self, expression, kind='real'):
        response = result(expression)
        self.assertEqual(response['status'], 'value', response)
        self.assertEqual(response['kind'], kind, response)
        self.assertFalse(response['coordinateAuthorized'])
        self.assertEqual(response['domainConditions'], [])
        value = Decoder('degree').node(response['expression'])
        for item in value if type(value) is tuple else (value,):
            self.assertFalse(item.has(s.Float))
        return value

    def rejected(self, expression, reason):
        self.assertEqual(result(expression), {'status': 'invalid', 'reason': reason, 'coordinateAuthorized': False})

    def test_dot_integer(self):
        self.assertEqual(self.value(op('dot', node([1, 2, 3]), node([4, 5, 6]))), 32)

    def test_dot_exact_fraction_and_radical(self):
        self.assertEqual(self.value(op('dot', node([op('divide', node(1), node(3)), S2]), node([3, S2]))), 3)

    def test_dot_dimension_reason(self):
        expression = op('dot', node([1, 2]), node([3]))
        self.rejected(expression, 'dimension')
        with self.assertRaisesRegex(CasInputProblem, 'equal dimensions'):
            Decoder('degree').node(expression)

    def test_dot_complex_rejected_even_if_result_would_be_real(self):
        self.rejected(op('dot', node([I]), node([I])), 'domain')

    def test_dot_symbolic_real_components(self):
        value = self.value(op('dot', node([X, 2]), node([X, 3])), 'symbolic')
        x = next(iter(value.free_symbols))
        self.assertEqual(s.expand(value), x*x+6)

    def test_dot_unknown_real_condition_survives_cancellation(self):
        response = result(op('dot', node([A]), node([0])))
        self.assertEqual(response['status'], 'value', response)
        self.assertEqual(len(response['domainConditions']), 1)
        self.assertEqual(response['domainConditions'][0]['operation'], 'equal')
        self.assertFalse(response['coordinateAuthorized'])

    def test_cross_orientation(self):
        self.assertEqual(self.value(op('cross', node([1, 0, 0]), node([0, 1, 0])), 'vector'), (0, 0, 1))

    def test_cross_exact_radicals(self):
        self.assertEqual(self.value(op('cross', node([S2, 1, 0]), node([0, S2, 1])), 'vector'), (1, -s.sqrt(2), 2))

    def test_cross_antisymmetry_and_orthogonality(self):
        u, v = node([1, 2, 3]), node([-2, 4, 1])
        forward = op('cross', u, v)
        self.assertEqual(self.value(forward, 'vector'), (-10, -7, 8))
        self.assertEqual(self.value(op('cross', v, u), 'vector'), (10, 7, -8))
        self.assertEqual(self.value(op('dot', forward, u)), 0)
        self.assertEqual(self.value(op('dot', forward, v)), 0)

    def test_cross_complex_is_bilinear(self):
        self.assertEqual(self.value(op('cross', node([I, 0, 0]), node([0, 1, 0])), 'vector'), (0, 0, s.I))

    def test_cross_symbolic(self):
        value = self.value(op('cross', node([X, 0, 0]), node([0, 1, 0])), 'vector')
        self.assertEqual(value[:2], (0, 0))
        self.assertEqual(len(value[2].free_symbols), 1)

    def test_cross_rejects_non_three_dimensions(self):
        for size in (1, 2, 4):
            self.rejected(op('cross', node([1]*size), node([2]*size)), 'dimension')

    def test_norm_default_two(self):
        self.assertEqual(self.value(op('norm', node([3, 4]))), 5)

    def test_norm_exact_square_root(self):
        self.assertEqual(self.value(op('norm', node([1, 1]))), s.sqrt(2))

    def test_norm_fraction(self):
        self.assertEqual(self.value(op('norm', node(['0.3', '0.4']))), s.Rational(1, 2))

    def test_norm_one_and_infinity(self):
        self.assertEqual(self.value(op('norm', node([-3, 4]), node(1))), 7)
        self.assertEqual(self.value(op('norm', node([-3, 4]), INF)), 4)

    def test_norm_fractional_order(self):
        order = op('divide', node(3), node(2))
        self.assertEqual(self.value(op('norm', node([4, 4]), order)), 4*2**s.Rational(2, 3))

    def test_norm_complex_uses_absolute_magnitudes(self):
        self.assertEqual(self.value(op('norm', node([op('complex', node(3), node(4)), 12]))), 13)

    def test_norm_symbolic_absolute_value(self):
        value = self.value(op('norm', node([X, 0])), 'symbolic')
        x = next(iter(value.free_symbols))
        self.assertEqual(value, s.Abs(x))

    def test_norm_symbolic_infinity_is_encodable(self):
        value = self.value(op('norm', node([X, 3]), INF), 'symbolic')
        x = next(iter(value.free_symbols))
        self.assertEqual(value.subs(x, -5), 5)
        self.assertEqual(value.subs(x, 2), 3)

    def test_norm_zero_vector(self):
        for order in (node(1), node(2), INF):
            self.assertEqual(self.value(op('norm', node([0, 0]), order)), 0)

    def test_norm_rejects_invalid_orders(self):
        for order in (node(0), node(-1), node('0.5'), I, op('negate', INF), A, node([2])):
            self.rejected(op('norm', node([3, 4]), order), 'domain')

    def test_norm_rejects_explosive_power_before_allocation(self):
        self.assertEqual(result(op('norm', node([2, 3]), node(1000000000))),
                         {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})
        self.assertEqual(result(op('norm', node([S2, 3]), node(1000000000))),
                         {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})

    def test_empty_and_matrix_inputs_are_not_vectors(self):
        for name in ('dot', 'cross', 'norm'):
            for vector in (node([]), node([[1, 2, 3]]), op('matrix', node([[1, 2, 3]]))):
                expression = op(name, vector) if name == 'norm' else op(name, vector, vector)
                self.assertEqual(result(expression)['status'], 'invalid')

    def test_non_numeric_and_nonfinite_components_rejected(self):
        for component in (INF, {'kind': 'constant', 'name': 'true'}, op('set', node(1))):
            for name in ('dot', 'cross', 'norm'):
                vector = node([component, 0, 0])
                expression = op(name, vector) if name == 'norm' else op(name, vector, node([1, 0, 0]))
                self.rejected(expression, 'domain')

    def test_original_hole_survives_zero_and_component_selection(self):
        hole = op('divide', node(1), node(0))
        for expression in (op('dot', node([hole]), node([0])), op('norm', node([hole, 1])),
                           op('component', op('cross', node([hole, 0, 0]), node([0, 1, 0])), node(1)),
                           op('multiply', node(0), op('dot', node([I]), node([0])))):
            self.rejected(expression, 'domain')

    def test_cross_components_are_scalars(self):
        cross = op('cross', node([1, 2, 3]), node([4, 5, 6]))
        for index, expected in enumerate((-3, 6, -3), 1):
            self.assertEqual(self.value(op('component', cross, node(index))), expected)

    def test_argument_count_is_validated(self):
        for name in ('dot', 'cross', 'norm'):
            for args in ([], [node([1]), node([1]), node([1])]):
                self.rejected(op(name, *args), 'syntax')

    def test_tensor_element_selects_from_calculated_vectors_and_matrices(self):
        cross = op('cross', node([1, 2, 3]), node([4, 5, 6]))
        for index, expected in enumerate((-3, 6, -3), 1):
            self.assertEqual(self.value(op('tensor-element', cross, node([index]))), expected)
        self.assertEqual(self.value(op('tensor-element', op('transpose', node([[1, 2], [3, 4]])), node([1, 2]))), 3)
        self.assertEqual(self.value(op('tensor-element', op('matrix', node([[1, 2], [3, 4]])), node([2, 1]))), 3)
        self.assertEqual(self.value(op('tensor-element', op('inverse-matrix', node([[2, 0], [0, 4]])), node([2, 2]))),
                         s.Rational(1, 4))
        self.assertEqual(self.value(op('tensor-element', op('identity-matrix', node(3)), node([2, 2]))), 1)
        self.assertEqual(self.value(op('tensor-element', op('zero-matrix', node(2), node(3)), node([2, 3]))), 0)

    def test_tensor_element_checks_every_original_cell(self):
        hole = op('divide', node(1), op('norm', node([0, 0])))
        self.rejected(op('tensor-element', node([7, hole]), node([1])), 'domain')
        self.rejected(op('tensor-element', node([7, op('dot', node([I]), node([I]))]), node([1])), 'domain')
        self.rejected(op('tensor-element', node([7, op('cross', node([1, 2]), node([3, 4]))]), node([1])), 'dimension')

    def test_tensor_element_rejects_wrong_indices_and_shapes(self):
        cross = op('cross', node([1, 0, 0]), node([0, 1, 0]))
        for indices in ([0], [4], [1, 1], ['1.5']):
            self.rejected(op('tensor-element', cross, node(indices)), 'domain')
        self.rejected(op('tensor-element', cross, node(1)), 'domain')
        self.rejected(op('tensor-element', node([[1, 2], [3]]), node([1, 1])), 'domain')
        self.rejected(op('tensor-element', node([7, cross]), node([1])), 'domain')
        self.rejected(op('tensor-element', node([INF, 1]), node([2])), 'domain')
        self.rejected(op('tensor-element', op('transpose', node([[1, 2], [3, 4]])), node([1])), 'domain')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(request))) for request in json.load(sys.stdin)]))
    else:
        unittest.main()
