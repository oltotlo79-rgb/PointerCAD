"""Independent exact identities for transpose, adjoint, inverse, trace, and determinant."""
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


def declared(identity, label=None):
    # A 'declared' reference is a named math symbol the input has not resolved to
    # a number. rank/inverse-matrix must refuse it because free_symbols is nonempty,
    # while determinant/trace/transpose keep working symbolically.
    return {'kind': 'symbol', 'reference': {'role': 'declared', 'id': identity, 'label': label or identity}}


S2, S3 = op('sqrt', node(2)), op('sqrt', node(3))
I = {'kind': 'constant', 'name': 'imaginary-unit'}

# cas_input.py L312-333 dispatches exactly these six operations through one
# shared block of square/singular/budget/free-symbol checks.
MATRIX_OPERATIONS = ('determinant', 'transpose', 'conjugate-transpose', 'trace', 'rank', 'inverse-matrix')


def result(expression):
    return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'degree'})))


class MatrixBasicsChecks(unittest.TestCase):
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

    def scalar_equal(self, actual, expected):
        self.assertEqual(s.simplify(actual-expected), 0, (actual, expected))
        self.assertFalse(actual.has(s.Float))

    def matrix(self, data):
        return Decoder('degree').node(op('matrix', node(data)))

    # --- transpose -----------------------------------------------------------

    def test_transpose_rectangular_matches_independent_identity(self):
        data = [[1, 2, 3], [4, 5, 6]]
        original = self.matrix(data)
        self.equal(self.value(op('transpose', node(data))), original.T)

    def test_transpose_is_involutive_for_algebraic_entries(self):
        data = [[S2, 1], [1, S3]]
        original = self.matrix(data)
        twice = self.value(op('transpose', op('transpose', node(data))))
        self.equal(twice, original)

    # --- conjugate-transpose (adjoint) ----------------------------------------

    def test_conjugate_transpose_matches_independent_identity(self):
        data = [[I, 1], [1, 2]]
        original = self.matrix(data)
        self.equal(self.value(op('conjugate-transpose', node(data))), original.H)

    def test_conjugate_transpose_differs_from_plain_transpose_by_conjugation(self):
        # This matrix is symmetric in position (entry[0][1] == entry[1][0] == 1), so
        # any difference between the two results must come from conjugating the
        # imaginary entry, not from swapping rows and columns.
        data = [[I, 1], [1, 2]]
        transposed = self.value(op('transpose', node(data)))
        adjoint = self.value(op('conjugate-transpose', node(data)))
        self.assertEqual(transposed[0, 0], s.I)
        self.assertEqual(adjoint[0, 0], -s.I)
        self.assertTrue(all(transposed[row, col] == adjoint[row, col]
                            for row in range(2) for col in range(2) if (row, col) != (0, 0)))

    # --- trace and determinant -------------------------------------------------

    def test_determinant_matches_independent_value_for_2x2_and_3x3(self):
        for data in ([[S2, 1], [1, S3]], [[2, 1, 0], [1, 2, 1], [0, 1, 2]]):
            with self.subTest(data=data):
                original = self.matrix(data)
                self.scalar_equal(self.value(op('determinant', node(data)), 'real'), original.det())

    def test_trace_matches_independent_sum_of_diagonal(self):
        for data in ([[S2, 1], [1, S3]], [[2, 1, 0], [1, 2, 1], [0, 1, 2]]):
            with self.subTest(data=data):
                original = self.matrix(data)
                self.scalar_equal(self.value(op('trace', node(data)), 'real'), original.trace())

    def test_determinant_and_trace_report_complex_kind_for_non_real_results(self):
        data = [[I, 1], [1, 2]]
        original = self.matrix(data)
        self.scalar_equal(self.value(op('determinant', node(data)), 'complex'), original.det())
        self.scalar_equal(self.value(op('trace', node(data)), 'complex'), original.trace())

    # --- inverse ---------------------------------------------------------------

    def test_inverse_matrix_satisfies_left_and_right_identity(self):
        for data in ([[S2, 1], [1, S3]], [[2, 1, 0], [1, 2, 1], [0, 1, 2]], [[I, 1], [1, 2]]):
            with self.subTest(data=data):
                original = self.matrix(data)
                inverse = self.value(op('inverse-matrix', node(data)))
                self.equal(original*inverse, s.eye(original.rows))
                self.equal(inverse*original, s.eye(original.rows))

    def test_inverse_matrix_matches_independent_value(self):
        data = [[2, 1, 0], [1, 2, 1], [0, 1, 2]]
        original = self.matrix(data)
        self.equal(self.value(op('inverse-matrix', node(data))), original.inv())

    # --- input forms and operand counts -----------------------------------------

    def test_matrix_wrapper_and_nested_list_operand_forms_agree(self):
        # Text input stores explicit rows as nested lists; structured input may
        # carry the explicit 'matrix' wrapper instead (cas_input.py L315-317).
        # Both operand shapes must reach the same dispatched result.
        data = [[S2, 1], [1, S3]]
        nested = self.value(op('transpose', node(data)))
        wrapped = self.value(op('transpose', op('matrix', node(data))))
        self.equal(nested, wrapped)

    def test_operand_count_must_be_exactly_one(self):
        expected = {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False}
        for operation in MATRIX_OPERATIONS:
            with self.subTest(operation=operation, count=0):
                self.assertEqual(result(op(operation)), expected)
            with self.subTest(operation=operation, count=2):
                self.assertEqual(result(op(operation, node([[1]]), node([[1]]))), expected)

    def test_all_matrix_operations_reject_non_matrix_operand(self):
        expected = {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False}
        for operation in MATRIX_OPERATIONS:
            with self.subTest(operation=operation):
                self.assertEqual(result(op(operation, node(5))), expected)

    # --- square, singular, and dimension rejections -----------------------------

    def test_determinant_trace_inverse_reject_non_square_matrix(self):
        data = [[1, 2, 3], [4, 5, 6]]
        expected = {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False}
        for operation in ('determinant', 'trace', 'inverse-matrix'):
            with self.subTest(operation=operation):
                self.assertEqual(result(op(operation, node(data))), expected)

    def test_transpose_conjugate_transpose_and_rank_accept_non_square_matrix(self):
        data = [[1, 2, 3], [4, 5, 6]]
        original = self.matrix(data)
        self.equal(self.value(op('transpose', node(data))), original.T)
        self.equal(self.value(op('conjugate-transpose', node(data))), original.H)
        self.assertEqual(self.value(op('rank', node(data)), 'real'), original.rank())

    def test_inverse_matrix_rejects_singular_matrix(self):
        expected = {'status': 'invalid', 'reason': 'domain', 'coordinateAuthorized': False}
        for data in ([[1, 2], [2, 4]], [[1, 2, 3], [4, 5, 6], [7, 8, 9]]):
            with self.subTest(data=data):
                self.assertEqual(self.matrix(data).det(), 0)
                self.assertEqual(result(op('inverse-matrix', node(data))), expected)

    def test_matrix_dimension_budget_rejects_oversized_square_matrix(self):
        data = [[1]*17 for _ in range(17)]
        expected = {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False}
        for operation in MATRIX_OPERATIONS:
            with self.subTest(operation=operation):
                self.assertEqual(result(op(operation, node(data))), expected)

    # --- symbolic entries --------------------------------------------------------

    def test_inverse_matrix_and_rank_reject_unresolved_symbolic_entries(self):
        data = [[declared('a'), 1], [1, declared('a')]]
        expected = {'status': 'invalid', 'reason': 'unsupported', 'coordinateAuthorized': False}
        for operation in ('rank', 'inverse-matrix'):
            with self.subTest(operation=operation):
                self.assertEqual(result(op(operation, node(data))), expected)

    def test_determinant_trace_transpose_tolerate_unresolved_symbolic_entries(self):
        data = [[declared('a'), 1], [1, declared('a')]]
        self.value(op('determinant', node(data)), 'symbolic')
        self.value(op('trace', node(data)), 'symbolic')
        self.value(op('transpose', node(data)), 'matrix')

    # --- downstream coordinate use through component selection -------------------

    def test_component_selection_from_transpose_and_inverse_results_matches_independent_value(self):
        data = [[1, 2, 3], [4, 5, 6]]
        original = self.matrix(data)
        self.assertEqual(
            self.value(op('component', op('transpose', node(data)), node(2), node(1)), 'real'),
            original.T[1, 0])
        square = [[2, 1, 0], [1, 2, 1], [0, 1, 2]]
        expected_inverse = self.matrix(square).inv()
        self.assertEqual(
            self.value(op('component', op('inverse-matrix', node(square)), node(1), node(1)), 'real'),
            expected_inverse[0, 0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
