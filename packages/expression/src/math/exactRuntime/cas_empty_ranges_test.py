"""Independent range enumeration must agree with the exact JSON adapter."""
from pathlib import Path
import json
import math
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
from cas_evaluate import calculate_exact_json
from cas_input import Decoder


def number(value):
    return {'kind': 'number', 'decimal': str(value)}


def reference(label):
    return {'role': 'bound', 'id': label, 'label': label}


def symbol(label):
    return {'kind': 'symbol', 'reference': reference(label)}


def binding(label, lower, upper):
    return {'variable': reference(label), 'domain': {'kind': 'range',
        'lower': lower, 'upper': upper, 'step': None}}


def expression(operation, bindings, body):
    return {'kind': 'binder', 'operation': operation, 'bindings': bindings, 'body': body}


class EmptyRangeChecks(unittest.TestCase):
    def value(self, value):
        result = json.loads(calculate_exact_json(json.dumps({'expression': value, 'angleUnit': 'degree'})))
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'real', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('degree').node(result['expression'])

    def test_discrete_ranges_match_enumeration_including_nonadjacent_empty_ranges(self):
        for lower, upper in ((5, 1), (2, 1), (4, 4), (-3, 2), (1, 5)):
            for operation, combine in (('sum', sum), ('product', math.prod)):
                with self.subTest(operation=operation, lower=lower, upper=upper):
                    actual = self.value(expression(operation,
                        [binding('k', number(lower), number(upper))], symbol('k')))
                    self.assertEqual(actual, combine(range(lower, upper+1)))

    def test_inner_ranges_depending_on_outer_indices_keep_empty_iterations(self):
        bindings = [binding('i', number(1), number(3)), binding('j', number(3), symbol('i'))]
        for operation, combine in (('sum', sum), ('product', math.prod)):
            with self.subTest(operation=operation):
                expected = combine(combine(range(3, outer+1)) for outer in range(1, 4))
                self.assertEqual(self.value(expression(operation, bindings, symbol('j'))), expected)

    def test_reversed_integrals_keep_their_signed_orientation(self):
        self.assertEqual(self.value(expression('integrate',
            [binding('k', number(3), number(1))], symbol('k'))), -4)

    def test_empty_infinite_endpoints_do_not_create_an_infinite_term(self):
        positive = {'kind': 'constant', 'name': 'infinity'}
        negative = {'kind': 'operation', 'operation': 'negate', 'operands': [positive]}
        for lower, upper in ((positive, number(3)), (number(3), negative), (negative, negative), (positive, positive)):
            for operation, expected in (('sum', 0), ('product', 1)):
                with self.subTest(operation=operation, lower=lower, upper=upper):
                    self.assertEqual(self.value(expression(operation, [binding('k', lower, upper)], symbol('k'))), expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
