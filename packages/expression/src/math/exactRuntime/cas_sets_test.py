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
from cas_input import CasInputProblem, Decoder
from cas_sets import element_equal, finite_set_minus
from cas_step_ranges_test import num, sym, op


def constant(name):
    return {'kind': 'constant', 'name': name}


def declared(name):
    return {'kind': 'symbol', 'reference': {'role': 'declared', 'id': name, 'label': name}}


def bound(name):
    return {'kind': 'symbol', 'reference': {'role': 'bound', 'id': name, 'label': name}}


def finite(*values):
    return op('set', *(value if type(value) is dict else num(value) for value in values))


def summation(body, variable, lower, upper):
    return {'kind': 'binder', 'operation': 'sum', 'body': body, 'bindings': [
        {'variable': {'role': 'bound', 'id': variable, 'label': variable},
         'domain': {'kind': 'range', 'lower': num(lower), 'upper': num(upper), 'step': None}}]}


UNKNOWN = declared('x')


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


class ExactSetMinusSymbols(unittest.TestCase):
    """MC-23b: SymPy's own Complement of two FiniteSets removes a left element
    whenever the element is not structurally found in the right set, even
    when an unknown element of the right set might coincide with it. {1, x}
    minus {x} silently became {1}, which is wrong when x = 1 (the true
    difference is then empty). w14b's probe (probe_setminus.py, reached
    through cardinality) found the same defect; this covers the set-minus
    operation itself and the sum-of-truth-values shape that first exposed
    the wrong value 3 instead of 2."""

    def result(self, source):
        return json.loads(calculate_exact_json(json.dumps({'expression': source, 'angleUnit': 'radian'})))

    def value(self, source):
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def unresolved(self, source):
        self.assertEqual(self.result(source), {'status': 'unresolved', 'reason': 'unevaluated',
                                               'coordinateAuthorized': False}, source)

    def test_numeric_set_minus_is_unaffected(self):
        self.assertEqual(self.value(op('set-minus', finite(1, 2, 3), finite(2))), s.FiniteSet(1, 3))
        self.assertEqual(self.value(op('set-minus', finite(1), finite(2))), s.FiniteSet(1))

    def test_identical_symbol_is_still_removed_exactly(self):
        self.assertEqual(self.value(op('set-minus', op('set', UNKNOWN), op('set', UNKNOWN))), s.S.EmptySet)
        # Every left element is matched exactly (by the same symbol, or the same
        # number), so no element's exclusion is left to guess: the full removal
        # is still decided, unlike the ambiguous {x, 2} - {x} case below.
        self.assertEqual(self.value(op('set-minus', op('set', UNKNOWN, num(5)), op('set', UNKNOWN, num(5)))), s.S.EmptySet)
        self.assertEqual(self.value(op('set-minus', op('set', UNKNOWN), op('set', UNKNOWN, num(100)))), s.S.EmptySet)

    def test_algebraically_equal_but_differently_written_elements_are_still_removed(self):
        square = op('power', op('add', num(1), op('sqrt', num(2))), num(2))
        expanded = op('add', num(3), op('multiply', num(2), op('sqrt', num(2))))
        self.assertEqual(self.value(op('set-minus', op('set', square), finite(expanded))), s.S.EmptySet)

    def test_unknown_element_that_could_coincide_stays_unevaluated(self):
        # SymPy alone simplifies {1, x} minus {x} to {1}, discarding x = 1 (probe_setminus.py).
        self.unresolved(op('set-minus', op('set', num(1), UNKNOWN), op('set', UNKNOWN)))
        self.unresolved(op('set-minus', op('set', UNKNOWN, num(2)), op('set', UNKNOWN)))
        self.unresolved(op('set-minus', op('set', num(1), UNKNOWN), op('set', UNKNOWN, num(5))))
        self.unresolved(op('set-minus', op('set', UNKNOWN, num(1)), finite(2)))

    def test_element_of_a_finite_set_minus_matches_the_proved_removal(self):
        removed = op('set-minus', finite(1, 2, 3), finite(2))
        self.assertEqual(self.value(op('element', num(1), removed)), s.true)
        self.assertEqual(self.value(op('element', num(2), removed)), s.false)

    def test_sum_of_membership_over_a_set_minus_with_the_index_symbol(self):
        # probe_setminus.py: this summed to 3 before the fix (always "1 in {1}");
        # the true total is 2 (k=1 makes the set-minus empty, so 1 is absent that term).
        member = op('which', op('element', num(1),
                               op('set-minus', op('set', num(1), bound('k')), op('set', bound('k')))),
                   num(1), constant('true'), num(0))
        self.unresolved(summation(member, 'k', 1, 3))

    def test_union_and_intersection_with_an_unknown_element_are_unaffected(self):
        # Union/intersection stay soundly symbolic already; only set-minus needed the fix.
        self.assertEqual(self.value(op('element', num(1), op('union', op('set', num(1), UNKNOWN), finite(2)))), s.true)
        self.unresolved(op('element', num(2), op('intersection', op('set', num(1), UNKNOWN), finite(2))))

    def test_declared_sign_assumptions_prove_inequality_directly(self):
        # White-box: the JSON 'declared' role carries no sign assumptions, so this
        # exercises cas_sets.element_equal/finite_set_minus with SymPy assumptions
        # directly, matching the "known from a declaration" provable case.
        positive, negative = s.Symbol('p', positive=True), s.Symbol('n', negative=True)
        self.assertIs(element_equal(positive, negative), False)
        self.assertEqual(finite_set_minus(s.FiniteSet(positive, s.Integer(1)), s.FiniteSet(negative), CasInputProblem),
                         s.FiniteSet(positive, s.Integer(1)))
        self.assertRaises(CasInputProblem, finite_set_minus,
                         s.FiniteSet(positive, s.Integer(1)), s.FiniteSet(s.Symbol('u')), CasInputProblem)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 64:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
