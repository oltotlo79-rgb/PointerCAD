"""Gamma has poles; derivative values and Taylor coefficients stay exact."""
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
from cas_line_integrals_test import function
from cas_taylor_test import expansion
from cas_derivatives import derivative_at
from cas_gamma_functions import gamma_argument_radius


class GammaFunctionTests(unittest.TestCase):
    def test_exact_values_and_constants_return_as_reusable_functions(self):
        decoder = Decoder('radian')
        self.assertEqual(decoder.node(op('gamma', num(5))), 24)
        self.assertEqual(decoder.node(op('gamma', op('divide', num(1), num(2)))), s.sqrt(s.pi))
        for value in [s.EulerGamma, s.Catalan, s.zeta(3), s.zeta(5, s.Rational(1, 3)),
                      s.polygamma(0, s.Rational(1, 4)), s.gamma(s.Rational(-1, 3))]:
            encoded = Encoder(decoder).node(value)
            decoded = decoder.node(encoded)
            if value is s.Catalan:
                # Use the defining convergent sums, not simplify() knowing this
                # special value: A=sum(4k+1)^-2, B=sum(4k+3)^-2; G=A-B,
                # pi^2=8(A+B), and psi'(1/4)=16A (DLMF 5.15.1).
                a, b = s.symbols('A B')
                residual = (decoded-value).xreplace({s.Catalan: a-b,
                    s.pi**2: 8*(a+b), s.polygamma(1,s.Rational(1,4)): 16*a})
                self.assertEqual(s.expand(residual), 0)
            else:
                self.assertEqual(s.simplify((decoded-value).rewrite(s.zeta)), 0)
            self.assertNotIn('Float', json.dumps(encoded))

    def test_original_poles_and_orders_survive_simplification(self):
        for source in [op('gamma', num(0)), op('gamma', num(-2)),
                       op('polygamma', num(1), num(-1)), op('polygamma', num('0.5'), num(1)),
                       op('polygamma', num(18), num(1)), op('gamma', op('divide',num(1),num(0))),
                       op('gamma', {'kind':'constant','name':'infinity'}),
                       op('gamma', {'kind':'constant','name':'true'}),
                       op('gamma', {'kind':'constant','name':'imaginary-unit'})]:
            for wrapped in [source, op('multiply',num(0),source), op('component',op('list',num(7),source),num(1))]:
                with self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)

    def test_point_derivatives_and_cartesian_derivatives(self):
        x = s.Symbol('x', real=True)
        for order, expected in [(1,-s.EulerGamma),(2,s.EulerGamma**2+s.pi**2/6)]:
            value = derivative_at(s.gamma(x), x, s.S.One, s.Integer(order), [], CasInputProblem)
            self.assertEqual(s.simplify(value-expected), 0)
        source = op('gradient-at', function(op('gamma',sym('x')),('x',)), op('list',num(1)))
        self.assertEqual(Decoder('degree').node(source), (-s.EulerGamma,))
        for target in (s.S.Zero, s.Integer(-1)):
            with self.assertRaises(CasInputProblem):
                derivative_at(s.gamma(x), x, target, s.S.One, [], CasInputProblem)

    def test_taylor_coefficients_and_nearest_pole_disk(self):
        source = expansion(op('gamma',sym('x')),1,3)
        result = json.loads(calculate_exact_json(json.dumps({'expression':source,'angleUnit':'radian'})))
        self.assertEqual(result['status'],'value',result)
        values = [Decoder('radian').node(item) for item in result['expansion']['coefficients']]
        expected = [1,-s.EulerGamma,(s.EulerGamma**2+s.pi**2/6)/2,
                    -(s.EulerGamma**3+s.EulerGamma*s.pi**2/2+2*s.zeta(3))/6]
        for actual, target in zip(values, expected):
            self.assertEqual(s.simplify(actual-target),0)
        self.assertEqual(result['expansion']['convergence']['kind'],'disk')
        self.assertEqual(Decoder('radian').node(result['expansion']['convergence']['radius']),1)
        x = s.Symbol('x', real=True)
        self.assertEqual(gamma_argument_radius(2*x+1,x,s.S.Zero),s.Rational(1,2))
        self.assertEqual(gamma_argument_radius(x,x,s.Rational(-3,2)),s.Rational(1,2))
        self.assertIsNone(gamma_argument_radius(s.exp(x),x,s.S.Zero))

    def test_original_holes_and_gamma_poles_are_not_entire(self):
        for body in [op('gamma',sym('x')), op('gamma',op('divide',num(1),sym('x'))),
                     op('polygamma',num(1),sym('x'))]:
            for wrapped in (body, op('multiply',num(0),body)):
                result = json.loads(calculate_exact_json(json.dumps({
                    'expression':expansion(wrapped,0,3),'angleUnit':'radian'})))
                self.assertNotEqual(result['status'],'value',result)
        # A cancelled Gamma operand retains its original finite disk, too.
        source = expansion(op('multiply',num(0),op('gamma',sym('x'))),1,2)
        result = json.loads(calculate_exact_json(json.dumps({'expression':source,'angleUnit':'radian'})))
        self.assertEqual(result['status'],'value',result)
        self.assertEqual(result['expansion']['convergence']['kind'],'disk')
        self.assertEqual(Decoder('radian').node(result['expansion']['convergence']['radius']),1)

    def test_large_arguments_do_not_expand_huge_exact_integers(self):
        decoder = Decoder('radian')
        for source in [op('gamma',num(20000)),op('polygamma',num(0),num(20000))]:
            value = decoder.node(source)
            self.assertEqual(Encoder(decoder).node(value),source)


if __name__ == '__main__':
    unittest.main()
