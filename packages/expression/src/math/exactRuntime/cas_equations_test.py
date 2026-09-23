"""Independent analytic roots, original holes, inequalities and multiplicities."""
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

X = {'kind': 'symbol', 'reference': {'role': 'bound', 'id': 'x', 'label': 'x'}}
REAL = {'kind': 'constant', 'name': 'real-numbers'}
COMPLEX = {'kind': 'constant', 'name': 'complex-numbers'}


def solve(body, domain=REAL, operation='solve-equation'):
    return op(operation, {'kind': 'binder', 'operation': 'lambda', 'body': body,
                         'bindings': [{'variable': X['reference'], 'domain': {'kind': 'unrestricted'}}]}, domain)


class EquationTests(unittest.TestCase):
    def result(self, node, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': node, 'angleUnit': unit})))

    def scalar(self, node):
        result = self.result(node)
        self.assertEqual(result['status'], 'value', result)
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['domainConditions'], [])
        return Decoder('radian').node(result['expression'])

    def test_distinct_finite_roots_are_selected_explicitly(self):
        equation = solve(op('equal', op('power', X, num(2)), num(2)))
        self.assertEqual(self.scalar(op('solution-value', equation, num(1))), -s.sqrt(2))
        self.assertEqual(self.scalar(op('solution-value', equation, num(2))), s.sqrt(2))
        for index in (0, 3):
            self.assertEqual(self.result(op('solution-value', equation, num(index)))['reason'], 'domain')

    def test_holes_survive_identity_zero_and_cancellation(self):
        for body in (op('equal', op('divide', X, X), num(1)),
                     op('equal', op('multiply', num(0), op('divide', num(1), X)), num(0)),
                     op('equal', op('subtract', op('divide', num(1), X), op('divide', num(1), X)), num(0))):
            result = self.result(solve(body))
            self.assertEqual(result['status'], 'value', result)
            self.assertEqual(result['kind'], 'set')
            # The two open intervals exclude exactly 0, even after simplification.
            self.assertEqual(result['expression']['operation'], 'union')
            ends = result['expression']['operands']
            self.assertEqual(ends[0]['operands'][1], op('open-endpoint', num(0)))
            self.assertEqual(ends[1]['operands'][0], op('open-endpoint', num(0)))
        rational = op('divide', op('subtract', op('power', X, num(2)), num(1)), op('subtract', X, num(1)))
        equation = solve(op('equal', rational, num(2)))
        self.assertEqual(self.result(equation)['expression'], {'kind': 'constant', 'name': 'empty-set'})

    def test_intervals_inequalities_and_boundary_membership(self):
        result = self.result(solve(op('greater', op('divide', num(1), X), num(0))))
        self.assertEqual(result['kind'], 'interval', result)
        self.assertEqual(result['expression']['operands'][0], op('open-endpoint', num(0)))
        interval = op('interval', op('open-endpoint', num(-1)), num(1))
        equation = solve(op('equal', op('power', X, num(2)), num(1)), interval)
        self.assertEqual(self.scalar(op('solution-value', equation, num(1))), 1)
        self.assertEqual(self.result(op('solution-value', equation, num(2)))['reason'], 'domain')

    def test_empty_all_and_unresolved_are_distinct(self):
        empty = solve(op('equal', op('sqrt', X), num(-1)))
        self.assertEqual(self.result(empty)['expression'], {'kind': 'constant', 'name': 'empty-set'})
        all_values = solve(op('equal', X, X))
        self.assertEqual(self.result(all_values)['kind'], 'set')
        self.assertEqual(self.result(all_values)['expression'], REAL)
        unknown = solve(op('equal', op('cos', X), X))
        self.assertEqual(self.result(unknown)['status'], 'unresolved')
        self.assertEqual(self.result(op('multiply', num(0), op('solution-value', unknown, num(1))))['status'], 'unresolved')
        self.assertEqual(self.result(solve(op('greater', op('sin', X), num(0))))['status'], 'unresolved')

    def test_complex_domain_and_root_multiplicity(self):
        equation = solve(op('equal', op('power', X, num(2)), num(-1)), COMPLEX)
        self.assertEqual(self.scalar(op('solution-value', equation, num(1))), -s.I)
        self.assertEqual(self.scalar(op('solution-value', equation, num(2))), s.I)
        polynomial = op('multiply', op('power', op('subtract', X, num(1)), num(2)), op('add', X, num(2)))
        roots = solve(polynomial, COMPLEX, 'polynomial-roots')
        self.assertEqual(self.scalar(roots), s.ImmutableMatrix([[-2, 1], [1, 2]]))
        self.assertEqual(self.scalar(op('component', roots, num(2), num(2))), 2)

    def test_periodic_equation_respects_saved_angle_and_domain(self):
        interval = op('interval', num(0), num(180))
        equation = solve(op('equal', op('sin', X), num(1)), interval)
        result = self.result(op('solution-value', equation, num(1)), 'degree')
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['expression'], num(90))


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in json.load(sys.stdin)]))
    else:
        unittest.main()
