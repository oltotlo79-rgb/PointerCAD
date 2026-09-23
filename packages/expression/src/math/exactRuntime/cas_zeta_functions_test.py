"""Original domains and exact zeta derivative transport through the real decoder."""
from pathlib import Path
import sys,json,unittest
ROOT=Path(__file__).resolve().parents[5]
sys.dont_write_bytecode=True
sys.path[:0]=[str(Path(__file__).resolve().parent),
    str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
    str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_input import Decoder,CasInputProblem
from cas_result import Encoder
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num,sym,op
from cas_derivatives_test import derivative
from cas_zeta_functions import RealZeta,RealZetaDerivative,real_finite,analytic_at

class ZetaTests(unittest.TestCase):
    def test_symbolic_derivative_and_assumptions_terminate_before_substitution(self):
        variable=s.Symbol('t',real=True)
        for order in (1,2,3,15):
            original=RealZeta(variable)
            value=s.diff(original,variable,order)
            self.assertEqual(value,RealZetaDerivative(order,variable))
            self.assertIsNone(value.is_real)
            self.assertIsNone(value.is_finite)
            self.assertEqual(value.subs(variable,2),RealZetaDerivative(order,2))
            self.assertTrue(real_finite(value.subs(variable,2)))
        self.assertEqual(Decoder('radian').node(derivative(op('zeta',sym('t')),num(2))),RealZetaDerivative(1,2))

    def result(self,expression):
        return json.loads(calculate_exact_json(json.dumps({'expression':expression,'angleUnit':'radian'})))

    def value(self,expression):
        result=self.result(expression)
        self.assertEqual(result['status'],'value',result)
        self.assertEqual(result['domainConditions'],[],result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_regular_value_and_derivative_round_trip_without_inexact_numbers(self):
        for order in range(18):
            source=op('zeta',num('0.5')) if order==0 else op('zetaderivative',num(order),num('0.5'))
            decoder=Decoder('radian');value=decoder.node(source)
            expected=RealZeta(s.Rational(1,2)) if order==0 else RealZetaDerivative(order,s.Rational(1,2))
            self.assertEqual(value,expected);self.assertTrue(real_finite(value))
            self.assertEqual(Decoder('radian').node(Encoder(decoder).node(value)),value)
            self.assertEqual(self.value(source),value)

    def test_exact_integer_identities(self):
        for argument,expected in [(0,-s.Rational(1,2)),(-1,-s.Rational(1,12)),(-2,0),(2,s.pi**2/6),(4,s.pi**4/90)]:
            self.assertEqual(self.value(op('zeta',num(argument))),expected)

    def test_first_to_fifteenth_derivative_preserves_order_and_point(self):
        for target in map(s.sympify,(-2,0,s.Rational(1,2),2,4)):
            target_node=num(target) if target.is_Integer else op('divide',num(target.p),num(target.q))
            for order in (1,2,3,15):
                with self.subTest(target=target,order=order):
                    self.assertEqual(self.value(derivative(op('zeta',sym('t')),target_node,order)),
                                     RealZetaDerivative(order,target))

    def test_original_pole_work_bound_and_nonscalar_arguments_survive_simplification(self):
        for argument in [num(1),num(-33),num(129),{'kind':'constant','name':'imaginary-unit'},
                         op('divide',num(1),num(0)),op('list',num(2))]:
            source=op('zeta',argument)
            for wrapped in [source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))]:
                with self.subTest(source=wrapped):self.assertNotEqual(self.result(wrapped)['status'],'value')
        for order in (-1,18,s.Rational(1,2)):
            order_node=op('divide',num(1),num(2)) if order==s.Rational(1,2) else num(order)
            with self.assertRaises(CasInputProblem):Decoder('radian').node(op('zetaderivative',order_node,num(2)))

    def test_chain_rule_and_original_derivative_neighbourhood(self):
        actual=self.value(derivative(op('zeta',op('square',sym('t'))),num(2),2))
        self.assertEqual(s.expand(actual-(2*RealZetaDerivative(1,4)+16*RealZetaDerivative(2,4))),0)
        for point in (1,129,-33):
            call=op('zeta',sym('t'))
            for body in [call,op('multiply',num(0),call),op('component',op('list',num(7),call),num(1))]:
                self.assertNotEqual(self.result(derivative(body,num(point)))['status'],'value')
        for body in [op('zeta',op('absolute',sym('t'))),op('zeta',op('divide',num(1),sym('t')))]:
            self.assertNotEqual(self.result(derivative(body,num(0)))['status'],'value')
        variable=s.Symbol('t',real=True)
        self.assertTrue(analytic_at(RealZeta(variable**2),variable,s.Integer(2)))
        self.assertFalse(analytic_at(RealZeta(s.Abs(variable)),variable,s.S.Zero))

if __name__=='__main__':unittest.main()
