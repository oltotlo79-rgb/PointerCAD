"""Ordered set bounds against independent endpoint and finite-set identities."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder
from cas_step_ranges_test import num, sym, op


def constant(name):
    return {'kind': 'constant', 'name': name}


class ExactSetBounds(unittest.TestCase):
    def result(self, source):
        return json.loads(calculate_exact_json(json.dumps({'expression': source, 'angleUnit': 'radian'})))

    def value(self, source):
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_open_and_closed_endpoints_have_the_same_bounds_but_different_extrema(self):
        for left_open in (False, True):
            for right_open in (False, True):
                ends = [op('open-endpoint', num(0)) if left_open else num(0),
                        op('open-endpoint', num(1)) if right_open else num(1)]
                values = op('interval', *ends)
                self.assertEqual(self.value(op('set-supremum', values)), 1)
                self.assertEqual(self.value(op('set-infimum', values)), 0)
                for operation, opened, answer in [('set-maximum', right_open, 1), ('set-minimum', left_open, 0)]:
                    source = op(operation, values)
                    if opened:
                        self.assertEqual(self.result(source)['reason'], 'no-extremum')
                    else:
                        self.assertEqual(self.value(source), answer)

    def test_finite_algebraic_values_keep_exact_ordering_and_duplicates(self):
        values = op('set', num(2), op('sqrt', num(2)), op('divide', num(1), num(3)), num(2))
        self.assertEqual(self.value(op('set-maximum', values)), 2)
        self.assertEqual(self.value(op('set-minimum', values)), s.Rational(1, 3))

    def test_union_intersection_and_complement_preserve_endpoint_membership(self):
        a, b = op('interval', num(0), num(2)), op('interval', num(1), num(3))
        self.assertEqual(self.value(op('set-supremum', op('union', a, b))), 3)
        self.assertEqual(self.value(op('set-infimum', op('intersection', a, b))), 1)
        removed = op('set-minus', a, op('set', num(2)))
        self.assertEqual(self.value(op('set-supremum', removed)), 2)
        self.assertEqual(self.result(op('set-maximum', removed))['reason'], 'no-extremum')

    def test_infinite_bounds_are_display_only_and_cannot_cancel_to_coordinates(self):
        for name, operation, answer in [('naturals','set-supremum',s.oo),
                                        ('integers','set-infimum',-s.oo)]:
            source = op(operation, constant(name))
            self.assertEqual(self.result(source)['kind'], 'infinite-bound')
            self.assertEqual(self.value(source), answer)
            for outer in [op('multiply',num(0),source),op('divide',num(1),source),op('list',source,num(3))]:
                self.assertEqual(self.result(outer)['reason'], 'non-finite')
        self.assertEqual(self.value(op('set-minimum', constant('naturals'))), 0)
        self.assertEqual(self.result(op('set-maximum', constant('integers')))['reason'], 'no-extremum')

    def test_empty_complex_undefined_and_unknown_are_not_finite_answers(self):
        for operation in ('set-supremum','set-infimum','set-maximum','set-minimum'):
            self.assertEqual(self.result(op(operation,constant('empty-set')))['reason'], 'empty-set')
            self.assertEqual(self.result(op(operation,op('set',constant('imaginary-unit'))))['reason'], 'domain')
        invalid = op('set-maximum',op('interval',num(0),op('open-endpoint',num(1))))
        self.assertEqual(self.result(op('multiply',num(0),invalid))['reason'],'no-extremum')
        self.assertEqual(self.result(op('set-supremum',op('set',op('divide',num(1),num(0)))))['reason'],'domain')
        declared = {'kind':'symbol','reference':{'role':'declared','id':'unknown','label':'x'}}
        unknown = self.result(op('set-supremum',op('set',declared)))
        self.assertEqual(unknown['status'],'unresolved',unknown)
        self.assertEqual(self.result(op('set-supremum',op('set',sym('x'))))['reason'],'syntax')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 64:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
