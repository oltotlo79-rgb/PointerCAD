"""Independent exact identities and rejection cases for vector projection."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
                str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder


def op(name, *operands):
    return {'kind': 'operation', 'operation': name, 'operands': list(operands)}


def node(value):
    if isinstance(value, (tuple, list)):
        return op('list', *(node(item) for item in value))
    return value if isinstance(value, dict) else {'kind': 'number', 'decimal': str(value)}


I = {'kind': 'constant', 'name': 'imaginary-unit'}


def result(expression):
    return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))


class VectorProjectionChecks(unittest.TestCase):
    def value(self, u, v):
        reply = result(op('projection', node(u), node(v)))
        self.assertEqual(reply['status'], 'value', reply)
        self.assertEqual(reply['kind'], 'vector', reply)
        self.assertEqual(reply['domainConditions'], [], reply)
        self.assertFalse(reply['coordinateAuthorized'])
        return Decoder('radian').node(reply['expression'])

    def rejected(self, u, v, reason):
        self.assertEqual(result(op('projection', node(u), node(v))), {
            'status': 'invalid', 'reason': reason, 'coordinateAuthorized': False})

    def test_exact_rational_components(self):
        self.assertEqual(self.value([1, 2], [3, 4]), (s.Rational(33, 25), s.Rational(44, 25)))

    def test_projection_is_parallel_to_target(self):
        target = s.Matrix([2, -3, 4])
        projected = s.Matrix(self.value([7, 5, -2], [2, -3, 4]))
        self.assertEqual(projected.cross(target), s.zeros(3, 1))
        self.assertFalse(projected.has(s.Float))

    def test_residual_is_orthogonal_to_target(self):
        source, target = s.Matrix([7, 5, -2]), s.Matrix([2, -3, 4])
        projected = s.Matrix(self.value(list(source), list(target)))
        self.assertEqual((source - projected).dot(target), 0)

    def test_projection_onto_itself(self):
        self.assertEqual(self.value([-2, 3], [-2, 3]), (-2, 3))

    def test_orthogonal_projection_is_zero_vector(self):
        self.assertEqual(self.value([2, 0], [0, -5]), (0, 0))

    def test_one_dimensional_projection(self):
        self.assertEqual(self.value([3], [-7]), (3,))

    def test_algebraic_components_remain_exact(self):
        root = op('sqrt', node(2))
        self.assertEqual(self.value([root, 0], [root, 0]), (s.sqrt(2), 0))

    def test_component_can_be_selected_for_a_coordinate(self):
        expression = op('component', op('projection', node([1, 2]), node([3, 4])), node(1))
        reply = result(expression)
        self.assertEqual(reply['status'], 'value', reply)
        self.assertEqual(reply['kind'], 'real', reply)
        self.assertEqual(Decoder('radian').node(reply['expression']), s.Rational(33, 25))

    def test_zero_target_is_rejected(self):
        self.rejected([1, 2], [0, 0], 'domain')

    def test_wrong_dimension_is_rejected(self):
        self.rejected([1, 2], [1, 2, 3], 'dimension')

    def test_empty_vector_is_rejected(self):
        self.rejected([], [], 'dimension')

    def test_scalar_and_matrix_are_not_vectors(self):
        self.rejected(2, [1], 'dimension')
        self.rejected([[1, 2]], [[1, 2]], 'dimension')

    def test_complex_source_is_rejected(self):
        self.rejected([I, 2], [1, 2], 'domain')

    def test_complex_target_is_rejected(self):
        self.rejected([1, 2], [1, I], 'domain')

    def test_complex_cancellation_does_not_make_input_real(self):
        self.rejected([I, op('negate', I)], [1, 1], 'domain')


if __name__ == '__main__':
    unittest.main()
