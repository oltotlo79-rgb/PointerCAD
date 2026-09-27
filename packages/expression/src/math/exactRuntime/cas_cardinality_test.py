"""Number of elements against independent counts, spellings of one value and unproved sets."""
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
import cas_extended_dispatch
from cas_cardinality import IMPLEMENTATIONS, MAX_SIMPLIFIED_COMPARISONS, cardinality, separated, unknown_set_operation
from cas_evaluate import calculate_exact_json
from cas_input import CasInputProblem


def num(value):
    return {'kind': 'number', 'decimal': str(value)}


def constant(name):
    return {'kind': 'constant', 'name': name}


def op(operation, *operands):
    return {'kind': 'operation', 'operation': operation, 'operands': list(operands)}


def finite(*values):
    return op('set', *(value if type(value) is dict else num(value) for value in values))


def interval(left, right, left_open=False, right_open=False):
    return op('interval', op('open-endpoint', left) if left_open else left, op('open-endpoint', right) if right_open else right)


def count(operand):
    return op('cardinality', operand)


def declared(name):
    return {'kind': 'symbol', 'reference': {'role': 'declared', 'id': name, 'label': name}}


def bound(name):
    return {'kind': 'symbol', 'reference': {'role': 'bound', 'id': name, 'label': name}}


def summation(body, variable, lower, upper):
    return {'kind': 'binder', 'operation': 'sum', 'body': body, 'bindings': [
        {'variable': {'role': 'bound', 'id': variable, 'label': variable},
         'domain': {'kind': 'range', 'lower': num(lower), 'upper': num(upper), 'step': None}}]}


SQRT2, SQRT3 = op('sqrt', num(2)), op('sqrt', num(3))
I = constant('imaginary-unit')
UNKNOWN = declared('x')


class ExactCardinality(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def value(self, expression, conditions=0):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'real', result)
        self.assertEqual(len(result['domainConditions']), conditions, result)
        self.assertIs(result['coordinateAuthorized'], False)
        self.assertEqual(result['expression']['kind'], 'number', result)
        return int(result['expression']['decimal'])

    def reason(self, expression):
        result = self.result(expression)
        self.assertNotEqual(result['status'], 'value', result)
        self.assertNotIn('expression', result)
        return result['status'], result['reason']

    def test_registered_through_the_dispatch_table(self):
        self.assertEqual(IMPLEMENTATIONS, {'cardinality': cardinality})
        self.assertIs(cas_extended_dispatch.IMPLEMENTATIONS['cardinality'], cardinality)

    def test_finite_set_counts_its_elements(self):
        self.assertEqual(self.value(count(finite(1, 2, 3))), 3)
        self.assertEqual(self.value(count(finite(7))), 1)

    def test_repeated_entries_count_once(self):
        self.assertEqual(self.value(count(finite(1, 1, 2))), 2)
        self.assertEqual(self.value(count(finite(2, 1, 2, 1, 2))), 2)

    def test_decimal_and_fraction_of_one_value_count_once(self):
        self.assertEqual(self.value(count(finite(op('divide', num(1), num(2)), '0.5'))), 1)
        self.assertEqual(self.value(count(finite(2, op('sqrt', num(4))))), 1)

    def test_different_spellings_of_one_algebraic_value_count_once(self):
        square = op('power', op('add', num(1), SQRT2), num(2))
        self.assertEqual(self.value(count(finite(square, op('add', num(3), op('multiply', num(2), SQRT2))))), 1)
        nested = op('sqrt', op('add', num(5), op('multiply', num(2), op('sqrt', num(6)))))
        self.assertEqual(self.value(count(finite(op('add', SQRT2, SQRT3), nested))), 1)

    def test_logarithm_and_complex_identities_need_a_proof_not_a_spelling(self):
        self.assertEqual(self.value(count(finite(op('natural-log', num(8)),
                                                 op('multiply', num(3), op('natural-log', num(2)))))), 1)
        root = op('add', op('divide', num(1), num(2)), op('multiply', op('divide', SQRT3, num(2)), I))
        polar = op('exponential', op('multiply', I, op('divide', constant('pi'), num(3))))
        self.assertEqual(self.value(count(finite(polar, root))), 1)

    def test_close_but_different_numbers_are_different(self):
        self.assertEqual(self.value(count(finite(constant('pi'), op('divide', num(355), num(113))))), 2)
        self.assertEqual(self.value(count(finite(SQRT2, SQRT3, I, op('negate', I)))), 4)

    def test_empty_sets_have_no_elements(self):
        for empty in (constant('empty-set'), op('set'), interval(num(1), num(1), left_open=True),
                      op('intersection', finite(1), finite(2)), op('set-minus', finite(1), finite(1))):
            self.assertEqual(self.value(count(empty)), 0)

    def test_degenerate_closed_interval_is_one_element(self):
        self.assertEqual(self.value(count(interval(num(2), num(2)))), 1)

    def test_infinite_sets_are_outside_the_finite_count(self):
        for infinite in (constant('naturals'), constant('integers'), constant('rationals'), constant('real-numbers'),
                         constant('complex-numbers'), interval(num(0), num(1)), interval(num(0), constant('infinity')),
                         op('union', finite(5), interval(num(0), num(1))),
                         op('cartesian-product', constant('real-numbers'), finite(1))):
            self.assertEqual(self.reason(count(infinite)), ('invalid', 'domain'), infinite)

    def test_integer_points_of_an_interval_are_counted(self):
        self.assertEqual(self.value(count(op('intersection', constant('integers'), interval(num(0), num(3))))), 4)
        self.assertEqual(self.value(count(op('intersection', constant('naturals'),
                                             interval(num(0), num(4), left_open=True, right_open=True)))), 3)

    def test_products_count_ordered_tuples(self):
        self.assertEqual(self.value(count(op('cartesian-product', finite(1, 2), finite(3, 4)))), 4)
        self.assertEqual(self.value(count(op('cartesian-product', finite(1, 1), finite(2)))), 1)
        self.assertEqual(self.value(count(op('cartesian-product', constant('real-numbers'), constant('empty-set')))), 0)
        self.assertEqual(self.value(count(op('cartesian-product', *([finite(0, 1)] * 8)))), 256)

    def test_unknown_elements_are_not_counted_as_different(self):
        self.assertEqual(self.reason(count(finite(1, UNKNOWN))), ('unresolved', 'unevaluated'))
        tuples = op('cartesian-product', finite(1), op('set', num(2), UNKNOWN))
        self.assertEqual(self.reason(count(tuples)), ('unresolved', 'unevaluated'))

    def test_unknown_elements_proved_different_are_counted(self):
        self.assertEqual(self.value(count(op('set', UNKNOWN, op('add', UNKNOWN, num(1))))), 2)

    def test_set_operations_on_unknown_elements_stay_unevaluated(self):
        # SymPy alone would simplify {1, x} minus {x} to {1}, which is wrong for x = 1.
        for source in (op('set-minus', op('set', num(1), UNKNOWN), op('set', UNKNOWN)),
                       op('complement', op('set', UNKNOWN), op('set', num(1), UNKNOWN)),
                       op('union', finite(1), op('set', UNKNOWN))):
            self.assertEqual(self.reason(count(source)), ('unresolved', 'unevaluated'), source)

    def test_local_index_counts_per_term(self):
        self.assertEqual(self.value(summation(count(op('set', bound('k'), op('add', bound('k'), num(1)))), 'k', 1, 3)), 6)
        self.assertEqual(self.reason(summation(count(op('set', num(1), bound('k'))), 'k', 1, 3)), ('unresolved', 'unevaluated'))

    def test_local_sum_inside_the_operand_is_a_finished_value(self):
        inner = summation(bound('j'), 'j', 1, 3)
        self.assertEqual(self.value(count(op('union', op('set', inner), finite(6)))), 1)
        self.assertFalse(unknown_set_operation(op('union', op('set', inner), finite(6)), CasInputProblem))
        self.assertTrue(unknown_set_operation(op('union', op('set', bound('k')), finite(6)), CasInputProblem))

    def test_operand_must_be_a_set(self):
        for operand in (num(3), op('list', num(1), num(2)), constant('true'),
                        op('list', op('list', num(1), num(2)), op('list', num(3), num(4)))):
            self.assertEqual(self.reason(count(operand)), ('invalid', 'domain'), operand)

    def test_invalid_element_is_not_hidden_by_the_count_or_a_zero_factor(self):
        broken = count(finite(1, op('divide', num(1), num(0))))
        self.assertEqual(self.reason(broken), ('invalid', 'domain'))
        self.assertEqual(self.reason(op('multiply', num(0), broken)), ('invalid', 'domain'))

    def test_original_domain_condition_survives_a_cancelled_element(self):
        self.assertEqual(self.value(count(op('set', op('divide', UNKNOWN, UNKNOWN), num(1))), conditions=1), 1)

    def test_count_is_an_exact_scalar_in_arithmetic(self):
        self.assertEqual(self.value(op('multiply', num(2), count(finite(1, 2)))), 4)
        self.assertEqual(self.value(op('add', count(finite(1, 2)), count(finite(3)))), 3)

    def test_operand_count_is_checked_by_the_dispatch(self):
        self.assertEqual(self.reason(op('cardinality')), ('invalid', 'syntax'))
        self.assertEqual(self.reason(op('cardinality', finite(1), finite(2))), ('invalid', 'syntax'))

    def test_many_distinct_irrational_elements_are_separated_numerically(self):
        roots = [op('sqrt', num(value)) for value in range(2, 258)]
        self.assertEqual(self.value(count(op('set', *roots[:255], num(1)))), 256)

    def test_simplified_comparisons_have_a_budget(self):
        pairs = []
        for power in range(2, 3 + MAX_SIMPLIFIED_COMPARISONS):
            pairs += [op('natural-log', op('power', num(2), num(power))), op('multiply', num(power), op('natural-log', num(2)))]
        self.assertEqual(self.reason(count(op('set', *pairs[:256]))), ('stopped', 'budget'))

    def test_numeric_separation_needs_twenty_agreeing_digits(self):
        self.assertTrue(separated((1, 0), (2, 0)))
        self.assertFalse(separated((10**30, 0), (10**30 + 1, 0)))
        self.assertTrue(separated((0, 1), (0, -1)))

    def test_encoded_count_matches_the_sympy_integer(self):
        result = self.result(count(finite(1, 2, 3)))
        self.assertEqual(result['expression'], num(3))
        self.assertIsInstance(s.Integer(result['expression']['decimal']), s.Integer)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 128:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
