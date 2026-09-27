"""Known analytic ODEs and independently checked original-domain exclusions."""
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
from cas_input import CasInputProblem, Decoder, reference_key
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, op
X, Y, Z = [{'kind': 'symbol', 'reference': {'role': 'bound', 'id': name, 'label': name}}
           for name in ('x', 'y', 'z')]


def ode(equations, conditions=(), functions=(Y,)):
    fn = {'kind': 'binder', 'operation': 'lambda',
          'bindings': [{'variable': item['reference'], 'domain': {'kind': 'unrestricted'}}
                       for item in (X,) + functions],
          'body': op('list', op('list', *equations), op('list', *(op('list', *row) for row in conditions)))}
    return op('solve-ode', fn, num(1))


def derivative(target=Y, order=1):
    return op('differentiate', target, *([X]*order))


def equation(left, right):
    return op('equal', left, right)


def at(source, point, constants=(), branch=1):
    return op('ode-value', source, num(branch), op('list', *(num(value) for value in constants)), point)


class OdeTests(unittest.TestCase):
    def result(self, node, angle='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': node, 'angleUnit': angle})))

    def value(self, node, angle='radian'):
        result = self.result(node, angle)
        self.assertEqual(result['status'], 'value', result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(angle).node(result['expression'])

    def curve_allowed(self, branch, point, constants=()):
        bindings = branch['formula']['bindings']
        self.assertEqual(branch['condition']['bindings'], bindings)
        self.assertEqual(branch['originals']['bindings'], bindings)
        self.assertEqual(len(bindings), len(constants) + 1)
        scope = {reference_key(binding['variable']): s.sympify(value)
                 for binding, value in zip(bindings, (point,) + constants)}
        condition = Decoder('radian').node(branch['condition']['body'], scope)
        try:
            originals = Decoder('radian').node(branch['originals']['body'], scope)
        except CasInputProblem:
            return False
        return condition is s.true and all(value.is_finite is True for value in originals)

    def test_first_order_initial_value(self):
        source = ode([equation(derivative(), Y)], [(Y, num(0), num(2))])
        self.assertEqual(self.value(at(source, op('natural-log', num(2)))), (4,))
        result = self.result(source)
        self.assertEqual(result['kind'], 'ode-solutions')
        self.assertEqual(result['solutions']['coverage'], 'verified-branches')
        self.assertEqual(result['request'], source)
        self.assertEqual(len(result['solutions']['branches'][0]['formula']['bindings']), 1)

    def test_second_order_initial_derivative_and_radian_solution_in_degree_input(self):
        source = ode([equation(derivative(order=2), op('negate', Y))],
                     [(Y, num(0), num(0)), (derivative(), num(0), num(1))])
        point = op('divide', {'kind': 'constant', 'name': 'pi'}, num(2))
        for angle in ('degree', 'radian'):
            self.assertEqual(self.value(at(source, point), angle), (1,))

    def test_boundary_values_are_not_replaced_by_initial_values(self):
        source = ode([equation(derivative(order=2), num(0))],
                     [(Y, num(0), num(2)), (Y, num(2), num(6))])
        self.assertEqual(self.value(at(source, num(1))), (4,))

    def test_coupled_system_preserves_dependent_order(self):
        equations = [equation(derivative(Y), Z), equation(derivative(Z), op('negate', Y))]
        initials = [(Y, num(0), num(0)), (Z, num(0), num(1))]
        point = op('divide', {'kind': 'constant', 'name': 'pi'}, num(2))
        self.assertEqual(self.value(at(ode(equations, initials, (Y, Z)), point)), (1, 0))
        self.assertEqual(self.value(at(ode(equations, initials, (Z, Y)), point)), (0, 1))

    def test_free_constants_must_be_supplied_explicitly(self):
        source = ode([equation(derivative(), num(2))])
        self.assertEqual(self.value(at(source, num(3), (5,))), (11,))
        self.assertEqual(self.result(at(source, num(3)))['reason'], 'dimension')
        self.assertEqual(self.result(at(source, num(3), (5, 6)))['reason'], 'dimension')
        self.assertEqual(self.result(at(source, num(3), (5,), 2))['reason'], 'domain')

    def test_original_denominator_is_preserved_under_zero(self):
        left = op('add', derivative(), op('multiply', num(0), op('divide', num(1), X)))
        source = ode([equation(left, num(1))], [(Y, num(1), num(2))])
        self.assertEqual(self.value(at(source, num(2))), (3,))
        self.assertEqual(self.result(at(source, num(0)))['reason'], 'domain')
        bad_initial = ode([equation(left, num(1))], [(Y, num(0), num(2))])
        self.assertEqual(self.result(bad_initial)['reason'], 'domain')
        outer = op('multiply', num(0), op('component', at(source, num(0)), num(1)))
        self.assertEqual(self.result(outer)['reason'], 'domain')

    def test_curve_transfer_keeps_cancelled_poles_and_free_constant_domain(self):
        cancelled = op('multiply', num(0), op('divide', X, X))
        source = ode([equation(op('add', derivative(), cancelled), num(1))])
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        branch = result['solutions']['branches'][0]
        self.assertTrue(self.curve_allowed(branch, 2, (3,)))
        self.assertFalse(self.curve_allowed(branch, 0, (3,)))
        pole = op('multiply', num(0), op('divide', num(1), Y))
        result = self.result(ode([equation(op('add', derivative(), pole), num(0))]))
        self.assertEqual(result['status'], 'value', result)
        branch = result['solutions']['branches'][0]
        self.assertTrue(self.curve_allowed(branch, 1, (2,)))
        self.assertFalse(self.curve_allowed(branch, 1, (0,)))

    def test_curve_transfer_keeps_original_log_at_every_position(self):
        original = op('multiply', num(0), op('natural-log', X))
        source = ode([equation(op('add', derivative(), original), num(1))], [(Y, num(1), num(2))])
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        branch = result['solutions']['branches'][0]
        self.assertTrue(self.curve_allowed(branch, 2))
        # A finite complex intermediate is allowed; only the final value must
        # be real. Assert admissibility, not which equivalent guard stores it.
        self.assertTrue(self.curve_allowed(branch, -2))
        self.assertFalse(self.curve_allowed(branch, 0))
        bad_initial = ode([equation(op('add', derivative(), original), num(1))], [(Y, num(0), num(2))])
        self.assertEqual(self.result(bad_initial)['reason'], 'domain')

    def test_conflicting_conditions_do_not_produce_a_value(self):
        source = ode([equation(derivative(), num(1))], [(Y, num(0), num(0)), (Y, num(0), num(1))])
        self.assertEqual(self.result(source)['reason'], 'domain')

    def test_unsupported_implicit_result_is_never_a_numeric_zero(self):
        source = ode([equation(derivative(), op('add', op('power', Y, num(3)), X))])
        self.assertNotEqual(self.result(source)['status'], 'value')

    def test_two_verified_branches_are_not_silently_merged(self):
        source = ode([equation(op('power', derivative(), num(2)), num(4))], [(Y, num(0), num(0))])
        result = self.result(source)
        self.assertEqual(len(result['solutions']['branches']), 2, result)
        values = {self.value(at(source, num(1), branch=index))[0] for index in (1, 2)}
        self.assertEqual(values, {-2, 2})


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in json.load(sys.stdin)]))
    else:
        unittest.main()
