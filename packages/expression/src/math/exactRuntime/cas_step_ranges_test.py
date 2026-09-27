"""Positive-step ranges preserve exact enumeration, scope, and original domains."""
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
from cas_evaluate import calculate_exact_json
from cas_input import Decoder


def num(value):
    return {'kind': 'number', 'decimal': str(value)}


def ref(identity, label=None):
    return {'role': 'bound', 'id': identity, 'label': label or identity}


def sym(identity, label=None):
    return {'kind': 'symbol', 'reference': ref(identity, label)}


def op(name, *args):
    return {'kind': 'operation', 'operation': name, 'operands': list(args)}


def binding(identity, lower, upper, step, label=None):
    return {'variable': ref(identity, label), 'domain': {'kind': 'range',
        'lower': lower, 'upper': upper, 'step': step}}


def binder(operation, bindings, body):
    return {'kind': 'binder', 'operation': operation, 'bindings': bindings, 'body': body}


class StepRanges(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'degree'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'real', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('degree').node(result['expression'])

    def test_finite_ranges_match_independent_enumeration(self):
        for lower, upper, stride in [(1, 10, 2), (-5, 5, 3), (4, 4, 7), (5, 1, 3),
                                     (0, 0, 2), (-9, -1, 2), (2, 3, 5), (1, 7, 1)]:
            for operation, combine in [('sum', sum), ('product', math.prod)]:
                with self.subTest(lower=lower, upper=upper, stride=stride, operation=operation):
                    self.assertEqual(self.value(binder(operation,
                        [binding('k', num(lower), num(upper), num(stride))], sym('k'))),
                        combine(range(lower, upper+1, stride)))

    def test_later_limits_use_the_outer_index_value(self):
        bindings = [binding('i', num(2), num(8), num(3)),
                    binding('j', sym('i'), op('add', sym('i'), num(5)), num(2))]
        body = op('add', sym('i'), sym('j'))
        for operation, combine in [('sum', sum), ('product', math.prod)]:
            expected = combine(combine(i+j for j in range(i, i+6, 2)) for i in range(2, 9, 3))
            self.assertEqual(self.value(binder(operation, bindings, body)), expected)

    def test_nested_same_labels_keep_different_identities(self):
        inner = binder('sum', [binding('inner', num(1), sym('outer', 'k'), num(2), 'k')],
                       op('add', sym('outer', 'k'), sym('inner', 'k')))
        outer = binder('sum', [binding('outer', num(2), num(8), num(3), 'k')], inner)
        expected = sum(sum(i+j for j in range(1, i+1, 2)) for i in range(2, 9, 3))
        self.assertEqual(self.value(outer), expected)

    def test_outer_dependent_empty_ranges_remain_empty(self):
        bindings = [binding('i', num(1), num(7), num(3)),
                    binding('j', num(5), sym('i'), num(2))]
        for operation, combine in [('sum', sum), ('product', math.prod)]:
            expected = combine(combine(range(5, i+1, 2)) for i in range(1, 8, 3))
            self.assertEqual(self.value(binder(operation, bindings, sym('j'))), expected)

    def test_invalid_steps_do_not_return_a_partial_value(self):
        for step in [num(0), num(-1), num('0.5'), {'kind': 'constant', 'name': 'infinity'},
                     op('complex', num(1), num(1)), op('list', num(2))]:
            with self.subTest(step=step):
                result = self.result(binder('sum', [binding('k', num(1), num(9), step)], sym('k')))
                self.assertEqual(result['status'], 'invalid', result)
                self.assertFalse(result['coordinateAuthorized'])

    def test_an_integral_never_accepts_a_discrete_step(self):
        for step in [num(1), num(2)]:
            result = self.result(binder('integrate', [binding('k', num(1), num(9), step)], sym('k')))
            self.assertEqual(result['status'], 'invalid', result)

    def test_negative_infinite_start_does_not_choose_an_arbitrary_progression(self):
        negative_infinity = op('negate', {'kind': 'constant', 'name': 'infinity'})
        result = self.result(binder('sum', [binding('k', negative_infinity, num(9), num(2))], sym('k')))
        self.assertEqual(result['status'], 'invalid', result)
        self.assertEqual(result['reason'], 'unsupported', result)

    def test_input_domain_errors_are_not_erased_by_simplifying(self):
        body = op('divide', sym('k'), sym('k'))
        result = self.result(binder('sum', [binding('k', num(-2), num(2), num(2))], body))
        self.assertNotEqual(result['status'], 'value', result)
        self.assertFalse(result['coordinateAuthorized'])


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 32:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
