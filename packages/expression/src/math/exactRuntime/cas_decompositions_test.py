"""Independent exact identities for the shipped algebraic decomposition adapter."""
from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
# The browser/Electron flow separately exercises the bundled WebAssembly runtime.
# This suite checks independent exact identities through the same JSON decoder
# and closed result encoder, using the two approved wheels without installation.
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder


def op(name, *operands):
    return {'kind': 'operation', 'operation': name, 'operands': list(operands)}


def node(value):
    if isinstance(value, (tuple, list)):
        return op('list', *(node(item) for item in value))
    return value if isinstance(value, dict) else {'kind': 'number', 'decimal': str(value)}


S2, S3 = op('sqrt', node(2)), op('sqrt', node(3))
I = {'kind': 'constant', 'name': 'imaginary-unit'}
PI = {'kind': 'constant', 'name': 'pi'}


def result(expression):
    return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'degree'})))


class DecompositionChecks(unittest.TestCase):
    def value(self, expression, kind='matrix'):
        response = result(expression)
        self.assertEqual(response['status'], 'value', response)
        self.assertEqual(response['kind'], kind, response)
        self.assertFalse(response['coordinateAuthorized'])
        self.assertEqual(response['domainConditions'], [])
        return Decoder('degree').node(response['expression'])

    def equal(self, actual, expected):
        self.assertEqual(actual.shape, expected.shape)
        self.assertTrue(all(s.simplify(entry) == 0 for entry in actual-expected), actual-expected)
        self.assertFalse(actual.has(s.Float))

    def matrix(self, data):
        return Decoder('degree').node(op('matrix', node(data)))

    def qr(self, data):
        original = self.matrix(data)
        q = self.value(op('qr-q', node(data)))
        r = self.value(op('qr-r', node(data)))
        self.equal(q.H*q, s.eye(original.rows))
        self.equal(q*r, original)
        self.assertTrue(all(s.simplify(r[row, col]) == 0
                            for row in range(r.rows) for col in range(min(row, r.cols))))
        return q, r

    def lu(self, data):
        original = self.matrix(data)
        p, lower, upper = (self.value(op(operation, node(data))) for operation in ('lu-p', 'lu-l', 'lu-u'))
        self.equal(p*original, lower*upper)
        self.equal(p.T*p, s.eye(original.rows))
        self.assertTrue(all(lower[row, row] == 1 for row in range(lower.rows)))
        self.assertTrue(all(lower[row, col] == 0 for row in range(lower.rows)
                            for col in range(row+1, lower.cols)))
        self.assertTrue(all(upper[row, col] == 0 for row in range(upper.rows)
                            for col in range(min(row, upper.cols))))
        return p, lower, upper

    def test_qr_two_algebraic_extensions(self):
        self.qr([[S2, S3], [S3, -1]])

    def test_qr_uses_complex_conjugation(self):
        self.qr([[I, 1], [1, I]])

    def test_qr_full_basis_for_rectangular_and_deficient_inputs(self):
        for data in ([[S2, 1], [2, S2], [0, 0]], [[0, S2, 1], [0, 2, S2]], [[0, 0], [0, 0]]):
            with self.subTest(data=data):
                self.qr(data)

    def test_qr_retains_tiny_independent_direction(self):
        q, r = self.qr([[S2, S2], [0, '1e-40']])
        self.assertEqual(r[1, 1], s.Rational(1, 10**40))

    def test_lu_row_exchange_after_a_previous_pivot(self):
        p, _, _ = self.lu([[S2, 1, 0], [2, S2, 1], [1, 0, 1]])
        self.assertEqual(list(p), [1, 0, 0, 0, 0, 1, 0, 1, 0])

    def test_lu_singular_rectangular_and_skipped_columns(self):
        for data in ([[0, S2, 1], [0, 2, S2], [0, 0, 0]], [[0, S2], [1, 1], [I, 2]], [[0, 0], [0, 0]]):
            with self.subTest(data=data):
                self.lu(data)

    def test_lu_retains_complex_and_tiny_pivots(self):
        self.lu([[I, 1], ['1e-40', S3]])

    def test_characteristic_coefficients_have_independent_trace_and_determinant(self):
        coefficients = self.value(op('characteristic-coefficients', node([[S2, 1], [1, S3]])), 'vector')
        self.assertEqual(coefficients[0], 1)
        self.assertEqual(s.simplify(coefficients[1]+s.sqrt(2)+s.sqrt(3)), 0)
        self.assertEqual(s.simplify(coefficients[2]-(s.sqrt(6)-1)), 0)

    def test_characteristic_polynomial_annihilates_the_matrix(self):
        data = [[S2, 1, 0], [0, S3, 1], [I, 0, S2]]
        original = self.matrix(data)
        coefficients = self.value(op('characteristic-coefficients', node(data)), 'vector')
        value = s.zeros(3)
        for coefficient in coefficients:
            value = value*original+coefficient*s.eye(3)
        self.equal(value, s.zeros(3))

    def test_eigenspace_repeated_defective_and_empty(self):
        data = [[S2, 1, 0], [0, S2, 0], [0, 0, S3]]
        basis = self.value(op('eigenspace', node(data), S2))
        self.equal(basis, s.Matrix([[1, 0, 0]]))
        self.equal((self.matrix(data)-s.sqrt(2)*s.eye(3))*basis.T, s.zeros(3, 1))
        self.assertEqual(self.value(op('eigenspace', node(data), node(0)), 'vector'), ())

    def test_eigenspace_complex_algebraic_eigenvalue(self):
        data = [[0, op('negate', S2)], [S2, 0]]
        eigenvalue = op('multiply', I, S2)
        basis = self.value(op('eigenspace', node(data), eigenvalue))
        self.equal((self.matrix(data)-s.I*s.sqrt(2)*s.eye(2))*basis.T, s.zeros(2, 1))

    def test_component_and_nested_component_keep_actual_shape(self):
        q = op('qr-q', node([[S2], [0]]))
        self.assertEqual(self.value(op('component', q, node(2), node(2)), 'real'), 1)
        self.assertEqual(self.value(op('component', op('component', q, node(1)), node(1)), 'real'), 1)
        self.assertEqual(result(op('component', q, node(3), node(1)))['reason'], 'domain')

    def test_invalid_dimensions_eigenvalue_and_entries(self):
        cases = [op('qr-q', node([[S2, 1], [0]])),
                 op('lu-l', node([[S2, {'kind': 'constant', 'name': 'true'}]])),
                 op('characteristic-coefficients', node([[S2, 1]])),
                 op('eigenspace', node([[S2, 1]]), S2),
                 op('eigenspace', node([[S2]]), node([1])),
                 op('qr-q', node([[op('divide', node(1), node(0))]]))]
        for expression in cases:
            with self.subTest(expression=expression):
                self.assertEqual(result(expression), {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False})

    def test_no_assumption_about_transcendental_zero_and_no_hidden_bad_input(self):
        for operation in ('qr-q', 'lu-u', 'characteristic-coefficients'):
            self.assertEqual(result(op(operation, node([[PI]])))['reason'], 'unsupported')
        self.assertEqual(result(op('multiply', node(0), op('qr-q', node([[1, 0], [0]]))))['status'], 'invalid')

    def test_dimension_budget_before_decomposition(self):
        for operation in ('qr-q', 'lu-l'):
            self.assertEqual(result(op(operation, node([[S2] for _ in range(17)]))),
                             {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})


    def svd(self, data):
        original = self.matrix(data)
        left, diagonal, right = [self.value(op(operation, node(data)))
            for operation in ('svd-u', 'svd-s', 'svd-v')]
        self.equal(left.H*left, s.eye(original.rows))
        self.equal(right.H*right, s.eye(original.cols))
        self.equal(left*diagonal*right.H, original)
        self.assertEqual(diagonal.shape, original.shape)
        values = self.value(op('singular-values', node(data)), 'vector')
        self.assertEqual(len(values), min(original.shape))
        self.assertEqual(tuple(diagonal[index, index] for index in range(min(original.shape))), values)
        self.assertTrue(all(value.is_nonnegative is True for value in values))
        self.assertTrue(all(s.simplify(a-b).is_nonnegative is True for a, b in zip(values, values[1:])))
        self.assertEqual(s.simplify(sum(value**2 for value in values)-(original.H*original).trace()), 0)
        return values

    def test_svd_general_three_dimensional_values_and_full_factors(self):
        values = self.svd([[2, 1, 0], [1, 2, 1], [0, 1, 2]])
        self.assertTrue(all(s.simplify(a-b) == 0 for a, b in zip(values, [2+s.sqrt(2), 2, 2-s.sqrt(2)])))

    def test_svd_rectangular_algebraic_and_dependent_inputs(self):
        self.svd([[S2, 0], [0, S3], [0, 0]])
        self.svd([[S2, 0, 0], [0, S3, 0]])
        self.svd([[S2, 1], [2, S2]])

    def test_svd_repeated_complex_values_and_paired_phase(self):
        self.svd([[I, 0], [0, op('negate', I)]])
        self.svd([[I, 1], [1, I]])
        data = [[I, 0], [0, S2]]
        self.svd(data)
        # These two independently known components also fix the ordinary editor sample.
        self.assertEqual(self.value(op('imaginary-part', op('component', op('svd-u', node(data)), node(1), node(2))), 'real'), 1)
        self.assertEqual(self.value(op('component', op('svd-v', node(data)), node(2), node(1)), 'real'), 1)

    def test_svd_zero_matrix_retains_full_bases_and_all_zeros(self):
        self.assertEqual(self.svd([[0, 0, 0], [0, 0, 0]]), (0, 0))

    def test_svd_tiny_nonzero_is_not_truncated(self):
        self.assertEqual(self.svd([[S2, 0], [0, '1e-40']]), (s.sqrt(2), s.Rational(1, 10**40)))

    def test_eigenvalues_algebraic_complex_and_defective_keep_multiplicity(self):
        for data in ([[2, 1, 0], [1, 2, 1], [0, 1, 2]], [[S2, 1], [0, S2]],
                     [[0, op('negate', S2)], [S2, 0]]):
            matrix = self.matrix(data)
            values = self.value(op('eigenvalues', node(data)), 'vector')
            self.assertEqual(len(values), matrix.rows)
            self.assertEqual(s.simplify(sum(values)-matrix.trace()), 0)
            self.assertEqual(s.simplify(s.prod(values)-matrix.det()), 0)
            for value in values:
                self.assertEqual(s.simplify((matrix-value*s.eye(matrix.rows)).det()), 0)
        self.assertEqual(self.value(op('eigenvalues', node([[S2, 1], [0, S2]])), 'vector'), (s.sqrt(2), s.sqrt(2)))
        self.assertEqual(self.value(op('component', op('eigenvalues', node([[S2, 1], [0, S3]])), node(1)), 'real'), s.sqrt(2))
        # The component API promises diagonal order, not numerical sorting.
        for triangular in ([[S3, 1], [0, S2]], [[S3, 0], [1, S2]], [[I, 1], [0, op('negate', I)]]):
            matrix = self.matrix(triangular)
            self.assertEqual(self.value(op('eigenvalues', node(triangular)), 'vector'),
                tuple(matrix[index, index] for index in range(matrix.rows)))
        complex_values = self.value(op('eigenvalues', node([[0, op('negate', S2)], [S2, 0]])), 'vector')
        self.assertEqual(complex_values, (s.sqrt(2)*s.I, -s.sqrt(2)*s.I))

    def test_unrepresentable_quintic_spectrum_does_not_emit_approximations_or_partial_values(self):
        companion = [[0, 0, 0, 0, -1], [1, 0, 0, 0, 1], [0, 1, 0, 0, 0],
                     [0, 0, 1, 0, 0], [0, 0, 0, 1, 0]]
        self.assertEqual(result(op('eigenvalues', node(companion))),
            {'status': 'unresolved', 'reason': 'unevaluated', 'coordinateAuthorized': False})

    def test_spectral_invalid_shapes_scalars_and_bounds_are_rejected(self):
        for expression in (op('eigenvalues', node([[S2, 1]])),
                           op('svd-u', node([[S2, 1], [0]])),
                           op('svd-s', node([[S2, {'kind': 'constant', 'name': 'true'}]])),
                           op('component', op('singular-values', node([[S2, 1]])), node(2)),
                           op('component', op('svd-v', node([[S2], [1]])), node(2), node(1))):
            self.assertEqual(result(expression), {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False})
        self.assertEqual(result(op('svd-u', node([[S2] for _ in range(17)]))),
            {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})



if __name__ == '__main__':
    unittest.main(verbosity=2)
