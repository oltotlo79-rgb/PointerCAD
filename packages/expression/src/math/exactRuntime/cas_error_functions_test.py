"""Error functions stay exact structured operations, including the small complementary tail."""
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
from cas_derivatives_test import derivative
from cas_error_functions import complex_finite, error_analytic_at


class ErrorFunctionTests(unittest.TestCase):
    def test_exact_values_and_transfer(self):
        decoder = Decoder('radian')
        self.assertEqual(decoder.node(op('erf', num(0))), 0)
        self.assertEqual(decoder.node(op('erfc', num(0))), 1)
        for name in ('erf', 'erfc'):
            source = op(name, num(10))
            self.assertEqual(Encoder(decoder).node(decoder.node(source)), source)
        self.assertEqual(decoder.node(op('erf', num(-1))), -s.erf(1))

    def test_original_domain(self):
        for source in [op('erf', op('divide', num(1), num(0))),
                       op('erfc', {'kind':'constant','name':'infinity'}),
                       op('erf', {'kind':'constant','name':'true'})]:
            for wrapped in [source, op('multiply',num(0),source), op('component',op('list',num(7),source),num(1))]:
                with self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)

    def test_complex_transfer_and_original_bounds(self):
        imaginary = {'kind':'constant','name':'imaginary-unit'}
        for name in ('erf', 'erfc'):
            for argument in [imaginary, op('complex',num(1),num(2)), op('complex',num(8),num(-8))]:
                decoder = Decoder('radian')
                source = op(name, argument)
                value = decoder.node(source)
                transferred = Encoder(decoder).node(value)
                self.assertEqual(decoder.node(transferred), value)
                self.assertNotIn('erfi', json.dumps(transferred))
            for argument in [op('complex',num(9),num(1)), op('complex',num(0),num(-9))]:
                source = op(name,argument)
                for wrapped in [source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))]:
                    with self.assertRaises(CasInputProblem) as caught:
                        Decoder('radian').node(wrapped)
                    self.assertEqual(caught.exception.code, 'budget')

    def test_complex_derivative_keeps_the_entire_function(self):
        decoder = Decoder('radian')
        z = s.Symbol('z')
        for name, sign in [('erf',1),('erfc',-1)]:
            value = decoder.node(op(name,op('complex',num(1),num(2))))
            function_value = (s.erf if name == 'erf' else s.erfc)(z,evaluate=False)
            derivative = s.diff(function_value,z).subs(z,1+2*s.I)
            expected = sign*2*s.exp(-(1+2*s.I)**2)/s.sqrt(s.pi)
            self.assertEqual(s.simplify(derivative-expected),0)
            self.assertEqual(value.func, s.erf if name == 'erf' else s.erfc)
            self.assertEqual(decoder.node(Encoder(decoder).node(derivative)),derivative)

    def test_complex_composition_through_the_public_exact_request(self):
        imaginary = {'kind':'constant','name':'imaginary-unit'}
        for name, sign in [('erf',1),('erfc',-1)]:
            body = op(name,op('add',sym('t'),imaginary))
            source = derivative(body,num(0))
            Decoder('radian').node(source)  # Preserve the concrete failure before public error conversion.
            result = json.loads(calculate_exact_json(json.dumps({'expression':source,'angleUnit':'radian'})))
            self.assertEqual(result['status'],'value',result)
            self.assertEqual(result['domainConditions'],[],result)
            value = Decoder('radian').node(result['expression'])
            self.assertEqual(s.simplify(value-sign*2*s.E/s.sqrt(s.pi)),0)
        hole = op('erf',op('divide',imaginary,sym('t')))
        for body in [hole,op('multiply',num(0),hole)]:
            result = json.loads(calculate_exact_json(json.dumps({'expression':derivative(body,num(0)),'angleUnit':'radian'})))
            self.assertNotEqual(result['status'],'value',result)

    def test_entire_finiteness_does_not_replace_original_domain_or_differentiability(self):
        variable = s.Symbol('t',real=True)
        self.assertTrue(complex_finite(s.erf(s.I,evaluate=False)))
        self.assertTrue(complex_finite(s.I*s.erfi(1)))
        self.assertFalse(complex_finite(s.zoo))
        self.assertTrue(error_analytic_at(s.erf(variable+s.I,evaluate=False),variable,0))
        self.assertFalse(error_analytic_at(s.erf(s.Abs(variable)+s.I,evaluate=False),variable,0))
        self.assertFalse(error_analytic_at(s.erf(1/variable+s.I,evaluate=False),variable,0))
        imaginary = {'kind':'constant','name':'imaginary-unit'}
        for argument in [op('add',sym('t'),op('multiply',num(9),imaginary)),op('absolute',sym('t'))]:
            body=op('erf',argument)
            result=json.loads(calculate_exact_json(json.dumps({'expression':derivative(body,num(0)),'angleUnit':'radian'})))
            self.assertNotEqual(result['status'],'value',result)
        hidden=op('multiply',num(0),op('erf',op('add',sym('t'),op('multiply',num(9),imaginary))))
        result=json.loads(calculate_exact_json(json.dumps({'expression':derivative(hidden,num(0)),'angleUnit':'radian'})))
        self.assertEqual(result['status'],'stopped',result)

    def test_point_derivative_and_taylor(self):
        source = op('gradient-at', function(op('erf',sym('x')),('x',)), op('list',num(1)))
        self.assertEqual(Decoder('degree').node(source), (2*s.exp(-1)/s.sqrt(s.pi),))
        source = expansion(op('erf',sym('x')),0,3)
        result = json.loads(calculate_exact_json(json.dumps({'expression':source,'angleUnit':'radian'})))
        self.assertEqual(result['status'],'value',result)
        values = [Decoder('radian').node(item) for item in result['expansion']['coefficients']]
        self.assertEqual(values,[0,2/s.sqrt(s.pi),0,-2/(3*s.sqrt(s.pi))])
        self.assertEqual(result['expansion']['convergence']['kind'], 'entire')

    def test_original_argument_holes_and_finite_radius_survive(self):
        for name in ('erf', 'erfc'):
            body = op(name, op('divide', num(1), sym('x')))
            for wrapped in (body, op('multiply', num(0), body)):
                result = json.loads(calculate_exact_json(json.dumps({
                    'expression': expansion(wrapped, 0, 3), 'angleUnit': 'radian'})))
                self.assertNotEqual(result['status'], 'value', result)
            body = op(name, op('divide', num(1), op('subtract', num(1), sym('x'))))
            result = json.loads(calculate_exact_json(json.dumps({
                'expression': expansion(body, 0, 3), 'angleUnit': 'radian'})))
            self.assertEqual(result['status'], 'value', result)
            self.assertEqual(result['expansion']['convergence']['kind'], 'disk')
            self.assertEqual(Decoder('radian').node(result['expansion']['convergence']['radius']), 1)

    def test_gaussian_integral_result_keeps_error_function(self):
        decoder = Decoder('radian')
        gaussian_integral = s.integrate(s.exp(-s.Symbol('t')**2),(s.Symbol('t'),0,1))
        encoded = Encoder(decoder).node(gaussian_integral)
        self.assertIn('erf',json.dumps(encoded))
        self.assertNotIn('normal-cdf',json.dumps(encoded))
        self.assertEqual(decoder.node(encoded),gaussian_integral)


if __name__ == '__main__':
    unittest.main()
