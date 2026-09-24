"""Set relations against independent membership, endpoint and product identities."""
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
from cas_result import encode_result
from cas_set_relations import subset_truth


def num(value):
    return {'kind': 'number', 'decimal': str(value)}


def constant(name):
    return {'kind': 'constant', 'name': name}


def op(operation, *operands):
    return {'kind': 'operation', 'operation': operation, 'operands': list(operands)}


def finite(*values):
    return op('set', *(num(value) for value in values))


def interval(left, right, left_open=False, right_open=False):
    return op('interval', op('open-endpoint', num(left)) if left_open else num(left),
              op('open-endpoint', num(right)) if right_open else num(right))


EMPTY = constant('empty-set')
REAL = constant('real-numbers')
INTEGER = constant('integers')
NATURAL = constant('naturals')
UNKNOWN = {'kind': 'symbol', 'reference': {'role': 'declared', 'id': 'unknown', 'label': 'x'}}


class ExactSetRelations(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def expression(self, source, kind='set'):
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], kind, result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertIs(result['coordinateAuthorized'], False)
        return result['expression']

    def truth(self, operation, left, right, expected):
        self.assertEqual(self.expression(op(operation, left, right), 'boolean'),
                         constant('true' if expected else 'false'))

    def unresolved(self, source):
        self.assertEqual(self.result(source), {'status': 'unresolved', 'reason': 'unevaluated',
                                               'coordinateAuthorized': False})

    def test_nonmembership_present_and_absent(self):
        self.truth('not-element', num(2), finite(1, 2, 2), False)
        self.truth('not-element', num(3), finite(1, 2), True)

    def test_nonmembership_open_and_closed_endpoints(self):
        self.truth('not-element', num(0), interval(0, 1, True), True)
        self.truth('not-element', num(0), interval(0, 1), False)

    def test_nonmembership_number_sets_and_empty(self):
        self.truth('not-element', num(-1), NATURAL, True)
        self.truth('not-element', num(0), NATURAL, False)
        self.truth('not-element', op('divide', num(1), num(2)), INTEGER, True)
        self.truth('not-element', num(1), EMPTY, True)

    def test_nonmembership_unknown_is_not_true(self):
        self.unresolved(op('not-element', UNKNOWN, INTEGER))

    def test_finite_subset_ignores_duplicates_and_order(self):
        self.truth('subset-equal', finite(2, 1, 2), finite(1, 2), True)
        self.truth('subset-equal', finite(1, 4), finite(1, 2, 3), False)

    def test_proper_subset_is_false_for_equal_sets(self):
        self.truth('subset', finite(2, 1, 2), finite(1, 2), False)
        self.truth('subset', finite(1, 2), finite(1, 2, 3), True)

    def test_superset_reverses_operands(self):
        self.truth('superset', finite(1, 2, 3), finite(1, 2), True)
        self.truth('superset', finite(1), finite(1, 2), False)

    def test_superset_equal_accepts_equality(self):
        self.truth('superset-equal', finite(2, 1), finite(1, 2), True)
        self.truth('superset', finite(2, 1), finite(1, 2), False)

    def test_empty_subset_and_properness(self):
        self.truth('subset-equal', EMPTY, EMPTY, True)
        self.truth('subset', EMPTY, EMPTY, False)
        self.truth('subset', EMPTY, REAL, True)
        self.truth('subset-equal', finite(0), EMPTY, False)

    def test_interval_endpoint_inclusion(self):
        for left_open in (False, True):
            for right_open in (False, True):
                inner = interval(0, 1, left_open, right_open)
                self.truth('subset-equal', inner, interval(0, 1), True)
                self.truth('subset', inner, interval(0, 1), left_open or right_open)
                self.truth('subset-equal', interval(0, 1), inner, not (left_open or right_open))

    def test_disjoint_and_partially_overlapping_intervals(self):
        self.truth('subset-equal', interval(0, 1), interval(2, 3), False)
        self.truth('subset', interval(0, 2), interval(1, 3), False)

    def test_number_set_hierarchy_in_both_directions(self):
        names = ['naturals', 'integers', 'rationals', 'real-numbers', 'complex-numbers']
        for i, left in enumerate(names):
            for j, right in enumerate(names):
                self.truth('subset-equal', constant(left), constant(right), i <= j)
                self.truth('subset', constant(left), constant(right), i < j)

    def test_finite_set_and_interval_in_number_sets(self):
        self.truth('subset', finite(-1, 0, 1), INTEGER, True)
        self.truth('subset', interval(0, 1), REAL, True)
        self.truth('subset-equal', interval(0, 1), INTEGER, False)

    def test_algebraic_and_complex_members_are_exact(self):
        self.truth('subset-equal', op('set', op('sqrt', num(2))), constant('rationals'), False)
        self.truth('subset', op('set', constant('imaginary-unit')), constant('complex-numbers'), True)
        self.truth('subset-equal', op('set', constant('imaginary-unit')), REAL, False)

    def test_union_and_intersection_inclusion(self):
        union = op('union', interval(0, 1), interval(1, 2))
        self.truth('subset-equal', union, interval(0, 2), True)
        self.truth('subset', union, interval(0, 2), False)
        self.truth('subset', op('intersection', interval(0, 2), interval(1, 3)), interval(0, 3), True)

    def test_symbolic_properness_is_not_structural_inequality(self):
        self.unresolved(op('subset', finite(0), op('set', num(0), UNKNOWN)))
        self.unresolved(op('superset', op('set', num(0), UNKNOWN), finite(0)))

    def test_unknown_membership_in_infinite_set_stays_unresolved(self):
        self.unresolved(op('subset-equal', op('set', UNKNOWN), INTEGER))
        self.unresolved(op('subset', op('set', UNKNOWN), NATURAL))

    def test_two_infinite_sets_with_unknown_holes_stay_unresolved(self):
        left = op('set-minus', REAL, op('set', UNKNOWN))
        right = op('set-minus', REAL, finite(0))
        self.unresolved(op('subset-equal', left, right))
        self.unresolved(op('superset-equal', right, left))

    def test_unimplemented_infinite_inclusion_is_unknown(self):
        x = s.Symbol('x', real=True)
        values = s.ConditionSet(x, s.Eq(s.sin(x), x/2), s.S.Reals)
        self.assertIsNone(subset_truth(values, s.S.Integers))

    def test_complement_uses_set_then_explicit_universe(self):
        self.assertEqual(self.expression(op('complement', finite(2), finite(1, 2, 3))), finite(1, 3))

    def test_complement_empty_and_whole_universe(self):
        self.assertEqual(self.expression(op('complement', EMPTY, finite(1, 2))), finite(1, 2))
        self.assertEqual(self.expression(op('complement', REAL, REAL)), EMPTY)

    def test_interval_complement_preserves_open_endpoints(self):
        result = self.expression(op('complement', interval(1, 2), interval(0, 3)))
        self.assertEqual(Decoder('radian').node(result), s.Union(s.Interval.Ropen(0, 1), s.Interval.Lopen(2, 3)))

    def test_number_set_complement(self):
        result = self.expression(op('complement', INTEGER, REAL))
        self.assertEqual(Decoder('radian').node(result), s.Complement(s.S.Reals, s.S.Integers))

    def test_complement_rejects_noncontained_set(self):
        self.assertEqual(self.result(op('complement', finite(4), finite(1, 2)))['reason'], 'domain')

    def test_complement_requires_universe(self):
        self.assertEqual(self.result(op('complement', finite(1)))['reason'], 'syntax')

    def test_unknown_complement_containment_is_unresolved(self):
        self.unresolved(op('complement', op('set', UNKNOWN), INTEGER))

    def test_complement_of_finite_universe_needs_proved_membership(self):
        # SymPy alone simplifies {1, x} minus {x} to {1}: complement(x-set, {1,x}-universe)
        # reaches the identical Complement construction and must stay unevaluated too,
        # not silently keep {1} (MC-23b, found through probe_setminus.py).
        self.unresolved(op('complement', op('set', UNKNOWN), op('set', num(1), UNKNOWN)))

    def test_complement_of_finite_universe_still_proves_full_cancellation(self):
        self.assertEqual(self.expression(op('complement', op('set', UNKNOWN, num(5)), op('set', UNKNOWN, num(5)))), EMPTY)

    def test_binary_product_returns_ordered_tuples_without_duplicates(self):
        self.assertEqual(self.expression(op('cartesian-product', finite(2, 1, 1), finite(3, 4))),
                         op('set', op('list', num(1), num(3)), op('list', num(1), num(4)),
                            op('list', num(2), num(3)), op('list', num(2), num(4))))

    def test_three_factor_product_preserves_factor_order(self):
        self.assertEqual(self.expression(op('cartesian-product', finite(3), finite(1), finite(2))),
                         op('set', op('list', num(3), num(1), num(2))))

    def test_product_of_sixteen_factors(self):
        factors = [finite(value) for value in range(16)]
        self.assertEqual(self.expression(op('cartesian-product', *factors)),
                         op('set', op('list', *(num(value) for value in range(16)))))

    def test_product_rejects_one_and_seventeen_factors(self):
        for count in (1, 17):
            self.assertEqual(self.result(op('cartesian-product', *([finite(1)] * count)))['reason'], 'syntax')

    def test_empty_product_factor(self):
        self.assertEqual(self.expression(op('cartesian-product', REAL, EMPTY)), EMPTY)

    def test_infinite_product_is_a_set_not_a_vector(self):
        source = op('cartesian-product', REAL, INTEGER)
        self.assertEqual(self.expression(source), source)

    def test_nested_products_do_not_flatten_tuples(self):
        source = op('cartesian-product', op('cartesian-product', finite(1), finite(2)), finite(3))
        self.assertEqual(self.expression(source), op('set', op('list', op('list', num(1), num(2)), num(3))))

    def test_product_nonmembership_respects_tuple_order(self):
        values = op('cartesian-product', finite(1), finite(2))
        self.truth('not-element', op('list', num(1), num(2)), values, False)
        self.truth('not-element', op('list', num(2), num(1)), values, True)

    def test_product_result_element_budget(self):
        source = op('cartesian-product', finite(*range(17)), finite(*range(17)))
        self.assertEqual(self.result(source), {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False})

    def test_product_result_node_budget(self):
        factors = [finite(0, 1)] * 8 + [finite(0)] * 8
        self.assertEqual(self.result(op('cartesian-product', *factors))['reason'], 'budget')

    def test_invalid_operands_are_not_hidden_by_empty_factors(self):
        source = op('cartesian-product', EMPTY, op('set', op('divide', num(1), num(0))))
        self.assertEqual(self.result(source)['reason'], 'domain')

    def test_all_operations_reject_nonsets(self):
        for operation in ('subset', 'subset-equal', 'superset', 'superset-equal', 'complement', 'cartesian-product'):
            self.assertEqual(self.result(op(operation, num(1), finite(1)))['reason'], 'domain')
        self.assertEqual(self.result(op('not-element', num(1), num(2)))['reason'], 'domain')
        for element in (constant('true'), op('list', constant('true'), num(1)), op('list', REAL, num(1))):
            self.assertEqual(self.result(op('not-element', element, op('cartesian-product', REAL, REAL)))['reason'], 'domain')

    def test_original_domain_conditions_survive_set_cancellation(self):
        source = op('complement', op('set', op('divide', UNKNOWN, UNKNOWN)), finite(1))
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['expression'], EMPTY)
        self.assertEqual(len(result['domainConditions']), 1)

    def test_product_encoder_preserves_interval_factors(self):
        result = encode_result(s.ProductSet(s.Interval.open(0, 1), s.S.Reals), Decoder('radian'))
        self.assertEqual(result['kind'], 'set')
        self.assertEqual(result['expression'], op('cartesian-product', interval(0, 1, True, True), REAL))


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 128:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
