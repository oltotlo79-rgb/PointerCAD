"""Finite logic against independent rational distances and enumerated truth tables."""
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
from cas_sequences import MAX_WORK


def num(value):
    return {'kind': 'number', 'decimal': str(value)}


def constant(name):
    return {'kind': 'constant', 'name': name}


def op(operation, *operands):
    return {'kind': 'operation', 'operation': operation, 'operands': list(operands)}


def sym(name, role='bound', label=None):
    return {'kind': 'symbol', 'reference': {'role': role, 'id': name, 'label': label or name}}


def finite(*values):
    return op('set', *(num(value) for value in values))


def binding(name, domain):
    return {'variable': sym(name)['reference'], 'domain': {'kind': 'set', 'value': domain}}


def quantify(operation, domain, body, name='x'):
    return {'kind': 'binder', 'operation': operation, 'bindings': [binding(name, domain)], 'body': body}


def approx(a, b, tolerance):
    return op('approximately-equal', num(a), num(b), num(tolerance))


class ExactExtendedLogic(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def boolean(self, expression, expected):
        self.assertEqual(self.result(expression), {
            'status': 'value', 'kind': 'boolean',
            'expression': constant('true' if expected else 'false'),
            'domainConditions': [], 'coordinateAuthorized': False,
        })

    def rejected(self, expression, reason, status='invalid'):
        self.assertEqual(self.result(expression), {'status': status, 'reason': reason, 'coordinateAuthorized': False})

    def test_missing_tolerance_explains_why_even_for_identical_values(self):
        source = op('approximately-equal', num(1), num(1))
        with self.assertRaisesRegex(CasInputProblem, 'explicit absolute tolerance') as caught:
            Decoder('radian').node(source)
        self.assertEqual(caught.exception.code, 'domain')
        self.rejected(source, 'domain')

    def test_exact_decimal_boundary_is_inclusive(self):
        self.boolean(approx('0.3', '0.2', '0.1'), True)

    def test_difference_just_outside_boundary_is_false(self):
        self.boolean(approx('0.3000000000000000000000000000000000000001', '0.2', '0.1'), False)

    def test_zero_tolerance_does_not_round_nearby_values(self):
        self.boolean(approx(1, 1, 0), True)
        self.boolean(approx('1.0000000000000000000000000000000000000001', 1, 0), False)

    def test_negative_values_use_absolute_distance(self):
        self.boolean(approx(-3, -2, 1), True)
        self.boolean(approx(-3, -2, '0.99'), False)

    def test_tolerance_is_absolute_not_relative_to_magnitude(self):
        self.boolean(approx('1000000000000000000000000000000', '1000000000000000000000000000001', '0.5'), False)

    def test_tiny_nonzero_difference_does_not_underflow(self):
        self.boolean(approx('1e-400', 0, '9e-401'), False)
        self.boolean(approx('1e-400', 0, '1e-400'), True)

    def test_algebraic_operands_are_not_rounded(self):
        source = op('approximately-equal', op('sqrt', num(2)), num(1), op('subtract', op('sqrt', num(2)), num(1)))
        self.boolean(source, True)

    def test_complex_distance_uses_the_modulus(self):
        source = op('approximately-equal', op('complex', num(3), num(4)), num(0), num(5))
        self.boolean(source, True)
        source['operands'][2] = num('4.99')
        self.boolean(source, False)

    def test_negative_complex_and_infinite_tolerances_are_invalid(self):
        for tolerance in (num(-1), constant('imaginary-unit'), constant('infinity')):
            self.rejected(op('approximately-equal', num(1), num(1), tolerance), 'domain')

    def test_nonfinite_operands_cannot_compare_equal(self):
        self.rejected(op('approximately-equal', constant('infinity'), constant('infinity'), num(0)), 'domain')

    def test_unknown_operand_does_not_hide_an_invalid_tolerance_or_operand(self):
        unknown = sym('a', 'declared')
        self.rejected(op('approximately-equal', unknown, num(1), num(-1)), 'domain')
        self.rejected(op('approximately-equal', unknown, constant('infinity'), num(1)), 'domain')

    def test_boolean_vector_and_set_operands_are_not_scalars(self):
        for invalid in (constant('true'), op('list', num(1)), finite(1)):
            for position in range(3):
                operands = [num(1), num(1), num(0)]
                operands[position] = invalid
                self.rejected(op('approximately-equal', *operands), 'domain')

    def test_symbolic_operand_and_tolerance_remain_unknown(self):
        for operands in ((sym('a', 'declared'), num(1), num(0)), (num(1), num(1), sym('t', 'declared'))):
            self.rejected(op('approximately-equal', *operands), 'unevaluated', 'unresolved')

    def test_comparison_preserves_original_denominator_conditions(self):
        a = sym('a', 'declared')
        self.rejected(op('approximately-equal', op('divide', a, a), num(1), num(0)), 'unevaluated', 'unresolved')
        self.rejected(op('approximately-equal', op('divide', num(0), num(0)), num(0), num(1)), 'domain')

    def test_comparison_arity_is_checked_by_dispatch(self):
        for count in (0, 1, 4):
            self.rejected(op('approximately-equal', *[num(1)]*count), 'syntax')

    def test_forall_true_and_false_from_finite_enumeration(self):
        body = op('greater', sym('x'), num(0))
        self.boolean(quantify('for-all', finite(1, 2, 3), body), True)
        self.boolean(quantify('for-all', finite(-1, 2, 3), body), False)

    def test_exists_true_and_false_from_finite_enumeration(self):
        body = op('equal', op('square', sym('x')), num(4))
        self.boolean(quantify('exists', finite(1, 2, 3), body), True)
        self.boolean(quantify('exists', finite(0, 1, 3), body), False)

    def test_empty_set_has_vacuous_universal_and_no_witness(self):
        for domain in (finite(), constant('empty-set')):
            self.boolean(quantify('for-all', domain, constant('false')), True)
            self.boolean(quantify('exists', domain, constant('true')), False)

    def test_finite_set_operations_and_duplicates(self):
        domain = op('intersection', op('union', finite(1, 1, 2), finite(2, 3)), finite(2))
        self.boolean(quantify('for-all', domain, op('equal', sym('x'), num(2))), True)

    def test_singleton_closed_interval_is_a_finite_set(self):
        self.boolean(quantify('for-all', op('interval', num(2), num(2)), op('equal', sym('x'), num(2))), True)

    def test_finite_integer_interval_is_enumerated(self):
        domain = op('intersection', constant('integers'), op('interval', num(1), num(3)))
        self.boolean(quantify('for-all', domain, op('greater', sym('x'), num(0))), True)
        self.boolean(quantify('exists', domain, op('equal', sym('x'), num(2))), True)

    def test_infinite_sets_are_unknown_even_for_constant_predicates(self):
        domains = [constant(name) for name in ('real-numbers', 'integers', 'naturals', 'rationals', 'complex-numbers')]
        domains.append(op('interval', num(0), num(1)))
        for operation in ('for-all', 'exists'):
            for domain in domains:
                self.rejected(quantify(operation, domain, constant('true')), 'unevaluated', 'unresolved')

    def test_finite_undecided_predicate_is_not_false(self):
        for operation in ('for-all', 'exists'):
            self.rejected(quantify(operation, finite(1), op('equal', sym('x'), sym('a', 'declared'))),
                          'unevaluated', 'unresolved')

    def test_decisive_finite_witness_and_counterexample_with_unknown(self):
        domain = op('set', num(0), sym('a', 'declared'))
        self.boolean(quantify('exists', domain, op('equal', sym('x'), num(0))), True)
        self.boolean(quantify('for-all', domain, op('not-equal', sym('x'), num(0))), False)

    def test_nested_quantifiers_respect_the_outer_scope(self):
        inner = quantify('exists', finite(1, 2), op('equal', sym('x'), sym('y')), 'y')
        self.boolean(quantify('for-all', finite(1, 2), inner), True)
        self.boolean(quantify('for-all', finite(1, 3), inner), False)

    def test_later_domains_see_earlier_bindings(self):
        source = quantify('for-all', finite(1, 2), op('equal', sym('x'), sym('y')))
        source['bindings'].append(binding('y', op('set', sym('x'))))
        self.boolean(source, True)

    def test_own_domain_is_read_before_shadowing_and_scope_is_restored(self):
        inner = quantify('exists', op('set', sym('x')), op('equal', sym('x'), num(2)))
        outer = quantify('exists', finite(1, 2), inner)
        self.boolean(outer, True)
        scope = {('bound', 'x'): s.Integer(9)}
        self.assertIs(Decoder('radian').node(outer, scope), s.true)
        self.assertEqual(scope, {('bound', 'x'): s.Integer(9)})

    def test_same_label_does_not_merge_distinct_identities(self):
        inner = quantify('exists', finite(2), op('less', sym('outer', label='x'), sym('inner', label='x')), 'inner')
        inner['bindings'][0]['variable']['label'] = 'x'
        source = quantify('for-all', finite(1), inner, 'outer')
        source['bindings'][0]['variable']['label'] = 'x'
        self.boolean(source, True)

    def test_invalid_later_predicate_is_not_hidden_by_a_decisive_result(self):
        for operation, comparison in (('exists', 'equal'), ('for-all', 'not-equal')):
            body = op(comparison, op('divide', num(1), op('subtract', sym('x'), num(1))), num(-1))
            self.rejected(quantify(operation, finite(0, 1), body), 'domain')

    def test_unknown_original_condition_is_not_hidden_by_a_true_witness(self):
        a = sym('a', 'declared')
        body = op('equal', op('divide', sym('x'), sym('x')), num(1))
        self.rejected(quantify('exists', op('set', num(1), a), body), 'unevaluated', 'unresolved')

    def test_missing_tolerance_inside_predicate_stays_invalid(self):
        body = op('approximately-equal', sym('x'), num(1))
        self.rejected(quantify('exists', finite(1), body), 'domain')

    def test_approximation_predicate_and_logical_composition(self):
        body = op('approximately-equal', sym('x'), num(1), num('0.1'))
        universal = quantify('for-all', finite('0.9', 1, '1.1'), body)
        self.boolean(op('and', universal, op('not', approx(1, 2, '0.1'))), True)
        self.boolean(op('implies', universal, constant('false')), False)

    def test_approximation_selects_only_the_true_piecewise_branch(self):
        expression = op('which', approx('0.3', '0.2', '0.1'), num(7),
                        constant('true'), op('divide', num(1), num(0)))
        result = self.result(expression)
        self.assertEqual(result['status'], 'value')
        self.assertEqual(result['kind'], 'real')
        self.assertEqual(result['expression'], num(7))

    def test_scalar_predicate_and_nonset_domain_are_invalid(self):
        for operation in ('for-all', 'exists'):
            self.rejected(quantify(operation, finite(1), num(1)), 'domain')
            self.rejected(quantify(operation, num(1), constant('true')), 'domain')

    def test_invalid_binding_shapes_and_duplicate_identities(self):
        good = quantify('for-all', finite(1), constant('true'))
        for bindings in ([], 'x', [binding('x', finite(1))]*2, [binding('x', finite(1))]*16):
            self.rejected({**good, 'bindings': bindings}, 'syntax')
        for domain in ({'kind': 'unrestricted'}, {'kind': 'set', 'value': finite(1), 'extra': 1}):
            self.rejected({**good, 'bindings': [{'variable': sym('x')['reference'], 'domain': domain}]}, 'syntax')
        self.rejected({**good, 'bindings': [{'variable': sym('x', 'declared')['reference'],
                                           'domain': {'kind': 'set', 'value': finite(1)}}]}, 'syntax')

    def test_finite_enumeration_budget_rejects_before_returning_a_witness(self):
        groups = [finite(*range(start, min(start+250, 1001))) for start in range(0, 1001, 250)]
        source = quantify('exists', op('union', *groups), constant('true'))
        self.rejected(source, 'budget', 'stopped')

    def test_nested_bindings_share_a_sample_budget(self):
        source = quantify('exists', finite(*range(33)), constant('true'))
        source['bindings'].append(binding('y', finite(*range(33))))
        self.rejected(source, 'budget', 'stopped')

    def test_shared_work_budget_and_scope_are_preserved_on_failure(self):
        decoder = Decoder('radian')
        decoder.sequence_work = MAX_WORK-1
        scope = {('bound', 'x'): s.Integer(9)}
        with self.assertRaises(CasInputProblem) as caught:
            decoder.node(quantify('for-all', finite(1), constant('true')), scope)
        self.assertEqual(caught.exception.code, 'budget')
        self.assertEqual(decoder.sequence_depth, 0)
        self.assertEqual(scope, {('bound', 'x'): s.Integer(9)})

    def test_explosive_integer_power_is_rejected_before_construction(self):
        body = op('equal', op('power', num(2), num(1000000)), num(0))
        self.rejected(quantify('exists', finite(1), body), 'budget', 'stopped')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        inputs = json.load(sys.stdin)
        if type(inputs) is not list or len(inputs) > 100:
            raise ValueError('A bounded batch is required')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in inputs]))
    else:
        unittest.main()
