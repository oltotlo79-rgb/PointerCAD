"""MC-18: exact matrix constructors and their dimension boundary."""
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
from cas_input import Decoder


def number(value):
    return {'kind': 'number', 'decimal': str(value)}


def operation(name, *operands):
    return {'kind': 'operation', 'operation': name, 'operands': list(operands)}


def reply(expression):
    return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))


class MatrixConstructorChecks(unittest.TestCase):
    def matrix(self, expression):
        result = reply(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'matrix', result)
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['domainConditions'], [])
        value = Decoder('radian').node(result['expression'])
        self.assertIsInstance(value, s.MatrixBase)
        self.assertFalse(value.has(s.Float))
        return value

    def rejected(self, expression, status, reason):
        self.assertEqual(reply(expression), {
            'status': status, 'reason': reason, 'coordinateAuthorized': False,
        })

    def test_identity_of_order_one(self):
        self.assertEqual(self.matrix(operation('identity-matrix', number(1))), s.eye(1))

    def test_identity_of_order_three_has_only_diagonal_ones(self):
        value = self.matrix(operation('identity-matrix', number(3)))
        self.assertEqual(value.shape, (3, 3))
        for row in range(3):
            for column in range(3):
                self.assertEqual(value[row, column], 1 if row == column else 0)

    def test_identity_at_upper_limit(self):
        self.assertEqual(self.matrix(operation('identity-matrix', number(16))), s.eye(16))

    def test_zero_matrix_one_argument_is_square(self):
        self.assertEqual(self.matrix(operation('zero-matrix', number(3))), s.zeros(3, 3))

    def test_zero_matrix_two_arguments_is_rectangular(self):
        self.assertEqual(self.matrix(operation('zero-matrix', number(2), number(3))), s.zeros(2, 3))

    def test_zero_matrix_accepts_each_dimension_at_upper_limit(self):
        self.assertEqual(self.matrix(operation('zero-matrix', number(16), number(1))), s.zeros(16, 1))
        self.assertEqual(self.matrix(operation('zero-matrix', number(1), number(16))), s.zeros(1, 16))
        self.assertEqual(self.matrix(operation('zero-matrix', number(16), number(16))), s.zeros(16, 16))

    def test_identity_left_product_matches_independent_matrix(self):
        original = s.ImmutableMatrix([[s.Rational(1, 3), -7, s.sqrt(2)],
                                      [0, 5, s.I], [11, s.Rational(2, 5), 0]])
        identity = self.matrix(operation('identity-matrix', number(3)))
        self.assertEqual(identity * original, original)

    def test_identity_right_product_matches_independent_matrix(self):
        original = s.ImmutableMatrix([[2, 3], [s.Rational(-1, 4), s.sqrt(3)]])
        identity = self.matrix(operation('identity-matrix', number(2)))
        self.assertEqual(original * identity, original)

    def test_both_dimensions_above_limit_report_budget(self):
        for expression in (operation('identity-matrix', number(17)),
                           operation('zero-matrix', number(17)),
                           operation('zero-matrix', number(2), number(17))):
            with self.subTest(expression=expression):
                self.rejected(expression, 'stopped', 'budget')

    def test_zero_and_negative_dimensions_report_domain(self):
        for expression in (operation('identity-matrix', number(0)),
                           operation('identity-matrix', number(-1)),
                           operation('zero-matrix', number(0)),
                           operation('zero-matrix', number(3), number(0)),
                           operation('zero-matrix', number(-2), number(3))):
            with self.subTest(expression=expression):
                self.rejected(expression, 'invalid', 'domain')

    def test_fractional_dimensions_report_domain(self):
        half = operation('divide', number(1), number(2))
        for expression in (operation('identity-matrix', half),
                           operation('zero-matrix', number(2), half),
                           operation('zero-matrix', number('2.5'))):
            with self.subTest(expression=expression):
                self.rejected(expression, 'invalid', 'domain')

    def test_non_scalar_dimensions_report_domain(self):
        vector = operation('list', number(1), number(2))
        for expression in (operation('identity-matrix', vector),
                           operation('zero-matrix', vector, number(2))):
            with self.subTest(expression=expression):
                self.rejected(expression, 'invalid', 'domain')

    def test_wrong_operand_counts_report_syntax(self):
        for expression in (operation('identity-matrix'),
                           operation('identity-matrix', number(2), number(3)),
                           operation('zero-matrix'),
                           operation('zero-matrix', number(2), number(3), number(4))):
            with self.subTest(expression=expression):
                self.rejected(expression, 'invalid', 'syntax')

    def test_constructor_result_works_in_existing_matrix_operation(self):
        result = reply(operation('trace', operation('identity-matrix', number(3))))
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(Decoder('radian').node(result['expression']), s.Integer(3))


if __name__ == '__main__':
    unittest.main(verbosity=2)
