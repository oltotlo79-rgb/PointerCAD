"""Positive Beta values, original conditions, and exact differential results."""
from pathlib import Path
import sys
import unittest
import json

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_input import Decoder, CasInputProblem
from cas_result import Encoder
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, sym, op
from cas_derivatives_test import derivative
from cas_vector_calculus_test import field
from cas_taylor_test import expansion
from cas_gamma_functions import beta_argument_radius


class BetaFunctionTests(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_values_and_large_held_results_retain_both_arguments(self):
        decoder = Decoder('radian')
        for a,b,expected in [(1,4,s.Rational(1,4)),(2,3,s.Rational(1,12)),('0.5','0.5',s.pi)]:
            value = decoder.node(op('beta',num(a),num(b)))
            self.assertEqual(s.simplify(value.rewrite(s.gamma)-expected), 0)
            self.assertEqual(s.simplify((decoder.node(Encoder(decoder).node(value))-value).rewrite(s.gamma)), 0)
        source = op('beta',num(10000),num(10000))
        self.assertEqual(Encoder(decoder).node(decoder.node(source)),source)

    def test_original_input_conditions_survive_zero_and_component_selection(self):
        for source in [op('beta',num(0),num(1)),op('beta',num(1),num(-1)),
                       op('beta',num(1),op('divide',num(1),num(0))),
                       op('beta',num(1),{'kind':'constant','name':'infinity'}),
                       op('beta',num(1),{'kind':'constant','name':'imaginary-unit'}),
                       op('beta',num(1),{'kind':'constant','name':'true'}),
                       op('beta',num(20000),num('1e-100'))]:
            for wrapped in [source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))]:
                with self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)

    def test_point_and_cartesian_derivatives_match_rational_and_integral_values(self):
        body = op('beta',sym('t'),num(1))
        for order,expected in [(1,-1),(2,2),(3,-6)]:
            self.assertEqual(s.simplify(self.value(derivative(body,num(1),order))-expected),0)
        body = op('beta',sym('x'),sym('y'))
        self.assertEqual(self.value(field('gradient',body,points=(1,1))),(-1,-1))
        expected = s.ImmutableMatrix([[2,2-s.pi**2/6],[2-s.pi**2/6,2]])
        self.assertEqual(s.simplify(self.value(field('hessian',body,points=(1,1)))-expected),s.zeros(2))

    def test_point_and_field_calculations_cannot_erase_negative_or_zero_arguments(self):
        for point in (0,-1):
            for body in [op('beta',sym('t'),num(1)),op('multiply',num(0),op('beta',sym('t'),num(1)))]:
                self.assertNotEqual(self.result(derivative(body,num(point)))['status'],'value')
            for body in [op('beta',sym('x'),sym('y')),op('multiply',num(0),op('beta',sym('x'),sym('y')))]:
                self.assertNotEqual(self.result(field('gradient',body,points=(1,point)))['status'],'value')

    def test_taylor_keeps_original_positive_disk_after_algebraic_simplification(self):
        body = op('beta',sym('x'),num(1))
        result = self.result(expansion(body,1,3))
        self.assertEqual(result['status'],'value',result)
        self.assertEqual([Decoder('radian').node(item) for item in result['expansion']['coefficients']],[1,-1,1,-1])
        for expression in [body,op('multiply',num(0),body)]:
            result = self.result(expansion(expression,1,2))
            self.assertEqual(result['status'],'value',result)
            self.assertEqual(result['expansion']['convergence']['kind'],'disk')
            self.assertEqual(Decoder('radian').node(result['expansion']['convergence']['radius']),1)
            for center in (0,-1):
                self.assertNotEqual(self.result(expansion(expression,center,2))['status'],'value')
        x = s.Symbol('x', real=True)
        self.assertEqual(beta_argument_radius(2*x+1,x,s.S.Zero),s.Rational(1,2))
        self.assertEqual(beta_argument_radius(3-x,x,s.S.One),2)
        self.assertIsNone(beta_argument_radius(s.exp(x),x,s.S.Zero))
        self.assertIsNone(beta_argument_radius(x,x,s.S.Zero))


if __name__ == '__main__':
    unittest.main()
