"""Independent values and exclusions for complete exact system branches."""
from pathlib import Path
import json
import sys
import unittest
ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_input import Decoder
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, op
X, Y = [{'kind': 'symbol', 'reference': {'role': 'bound', 'id': name, 'label': name}} for name in ('x', 'y')]
REAL = {'kind': 'constant', 'name': 'real-numbers'}
COMPLEX = {'kind': 'constant', 'name': 'complex-numbers'}


def system(equations, variables=(X, Y), domain=REAL):
    return op('solve-system', {'kind': 'binder', 'operation': 'lambda', 'body': op('list', *equations),
                              'bindings': [{'variable': value['reference'], 'domain': {'kind': 'unrestricted'}} for value in variables]}, domain)


def select(source, index=1, values=()):
    return op('system-solution', source, num(index), op('list', *(num(value) for value in values)))


def equal(left, right):
    return op('equal', left, right)


class SystemTests(unittest.TestCase):
    def result(self, node):
        return json.loads(calculate_exact_json(json.dumps({'expression': node, 'angleUnit': 'radian'})))

    def value(self, node):
        result = self.result(node)
        self.assertEqual(result['status'], 'value', result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def formal(self, source):
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'equation-system')
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['request'], source)
        return result['solutions']['branches']

    def test_unique_linear_and_explicit_unknown_order(self):
        equations = [equal(op('add', X, Y), num(3)), equal(op('subtract', X, Y), num(1))]
        self.assertEqual(self.value(select(system(equations))), (2, 1))
        self.assertEqual(self.value(select(system(equations, (Y, X)))), (1, 2))
        self.assertEqual(self.formal(system(equations))[0]['parameters'], [])

    def test_free_parameter_is_never_silently_zero(self):
        source = system([equal(op('add', X, Y), num(2))])
        self.assertEqual(self.formal(source)[0]['parameters'], ['y'])
        self.assertEqual(self.value(select(source, values=(3,))), (-1, 3))
        self.assertEqual(self.result(select(source))['reason'], 'dimension')
        self.assertEqual(self.result(select(source, values=(3, 4)))['reason'], 'dimension')

    def test_no_solution_and_all_values_differ(self):
        none = system([equal(op('add', X, Y), num(2)), equal(op('add', X, Y), num(3))])
        self.assertEqual(self.formal(none), [])
        self.assertEqual(self.result(select(none))['reason'], 'domain')
        all_values = system([equal(X, X)])
        self.assertEqual(self.formal(all_values)[0]['parameters'], ['x', 'y'])
        self.assertEqual(self.value(select(all_values, values=(2, 3))), (2, 3))

    def test_nonlinear_finite_branches_and_domain(self):
        source = system([equal(op('power', X, num(2)), num(1)), equal(Y, X)])
        self.assertEqual(len(self.formal(source)), 2)
        self.assertEqual(self.value(select(source, 1)), (-1, -1))
        self.assertEqual(self.value(select(source, 2)), (1, 1))
        imaginary = [equal(op('power', X, num(2)), num(-1)), equal(Y, X)]
        self.assertEqual(self.formal(system(imaginary)), [])
        self.assertEqual(self.value(select(system(imaginary, domain=COMPLEX))), (-s.I, -s.I))

    def test_cancellation_and_zero_multiplier_preserve_holes(self):
        for lhs, rhs in [(op('divide', X, X), num(1)),
                         (op('multiply', num(0), op('divide', num(1), X)), num(0))]:
            source = system([equal(lhs, rhs), equal(Y, X)])
            self.assertEqual(self.value(select(source, values=(2,))), (2, 2))
            self.assertEqual(self.result(select(source, values=(0,)))['reason'], 'domain')

    def test_derived_denominator_and_invalid_outer_zero(self):
        source = system([equal(op('multiply', X, Y), num(1))])
        self.assertEqual(self.value(select(source, values=(2,))), (s.Rational(1, 2), 2))
        self.assertEqual(self.result(select(source, values=(0,)))['reason'], 'domain')
        self.assertEqual(self.result(op('multiply', num(0), op('component', select(source, values=(0,)), num(1))))['reason'], 'domain')

    def test_excluded_finite_candidate_is_not_accepted(self):
        source = system([equal(op('divide', op('subtract', op('power', X, num(2)), num(1)), op('subtract', X, num(1))), num(2)), equal(Y, num(0))])
        self.assertEqual(self.formal(source), [])

    def test_transcendental_system_is_unresolved_not_empty(self):
        source = system([equal(op('cos', X), X), equal(Y, X)])
        self.assertEqual(self.result(source)['status'], 'unresolved')

    def test_real_radical_family_keeps_its_reality_condition(self):
        source = system([equal(op('add', op('power', X, num(2)), op('power', Y, num(2))), num(1))])
        branches = self.formal(source)
        self.assertEqual(len(branches), 2)
        self.assertEqual({self.value(select(source, index, values=(0,))) for index in (1, 2)}, {(-1, 0), (1, 0)})
        for index in (1, 2):
            self.assertEqual(self.result(select(source, index, values=(2,)))['reason'], 'domain')

    def test_malformed_unknowns_and_inequalities_are_rejected(self):
        source = system([equal(X, num(1))], (X, X))
        self.assertEqual(self.result(source)['reason'], 'syntax')
        self.assertEqual(self.result(system([]))['reason'], 'syntax')
        self.assertEqual(self.result(system([op('less', X, num(1))]))['reason'], 'domain')


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in json.load(sys.stdin)]))
    else:
        unittest.main()
