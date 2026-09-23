"""Original integer Bessel domains and differential results across exact transport."""
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
from cas_bessel_functions import BESSEL, real_finite, analytic_at


class BesselFunctionTests(unittest.TestCase):
    def result(self, expression):
        result = json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))
        if result['status'] != 'value' and expression.get('operation') == 'differentiate-at':
            try:
                Decoder('radian').node(expression)
            except CasInputProblem as error:
                result['diagnosis'] = str(error)
                result['source'] = expression
        return result

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_all_four_functions_keep_exact_order_and_argument(self):
        for name, family in BESSEL.items():
            source = op(name,num(0),num(1))
            decoder = Decoder('radian')
            self.assertEqual(decoder.node(source), family(0,1))
            self.assertEqual(Encoder(decoder).node(decoder.node(source)), source)
            self.assertTrue(real_finite(family(0,1)))
            self.assertEqual(self.result(source)['kind'],'real')
        for name in ('besselj','besseli'):
            self.assertEqual(self.value(op(name,num(0),num(0))),1)
            self.assertEqual(self.value(op(name,num(1),num(0))),0)
        self.assertFalse(real_finite(s.bessely(0,-1)))
        self.assertFalse(real_finite(s.besselk(0,s.Symbol('x'))))
        self.assertFalse(real_finite(s.besselj(s.Symbol('n'),1)))

    def test_original_failures_survive_zero_and_component_selection(self):
        sources = [op('bessely',num(0),num(0)),op('besselk',num(0),num(-1)),
            op('besselj',num('0.5'),num(1)),op('besseli',num(129),num(1)),
            op('besselj',num(0),op('divide',num(1),num(0))),
            op('besselk',num(0),num('1e-3000')),
            op('bessely',num(0),op('add',num(128),num('1e-100'))),
            op('besselj',num(0),{'kind':'constant','name':'imaginary-unit'}),
            op('besseli',num(0),{'kind':'constant','name':'infinity'}),
            op('besseli',num(0),{'kind':'constant','name':'true'})]
        for source in sources:
            for wrapped in (source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))):
                with self.subTest(source=wrapped), self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)

    def test_first_and_second_derivatives_keep_the_adjacent_order_identities(self):
        for name,family in BESSEL.items():
            body = op(name,num(0),sym('t'))
            first = family(1,1) * (1 if name == 'besseli' else -1)
            second = (family(2,1) + family(0,1)*(1 if name in ('besseli','besselk') else -1))/2
            for order, expected in ((1,first),(2,second)):
                with self.subTest(name=name,order=order):
                    self.assertEqual(s.simplify(self.value(derivative(body,num(1),order))-expected),0)
        for name,second in (('besselj',-s.Rational(1,2)),('besseli',s.Rational(1,2))):
            body = op(name,num(0),sym('t'))
            for order, expected in ((1,0),(2,second)):
                with self.subTest(origin=name,order=order):
                    self.assertEqual(self.value(derivative(body,num(0),order)),expected)

    def test_original_y_k_poles_remain_for_derivative_and_cartesian_fields(self):
        for name in ('bessely','besselk'):
            for point in (0,-1):
                for body in (op(name,num(0),sym('t')),op('multiply',num(0),op(name,num(0),sym('t')))):
                    self.assertNotEqual(self.result(derivative(body,num(point)))['status'],'value')
                body=op('multiply',num(0),op(name,num(0),sym('x')))
                self.assertNotEqual(self.result(field('gradient',body,points=(point,1)))['status'],'value')
        body=op('besselj',num(0),op('add',sym('x'),sym('y')))
        self.assertEqual(self.value(field('gradient',body,points=(0,1))),(-s.besselj(1,1),-s.besselj(1,1)))
        body=op('besseli',num(0),sym('x'))
        self.assertEqual(self.value(field('hessian',body,points=(0,1))),s.diag(s.Rational(1,2),0))

    def test_taylor_keeps_entire_series_and_original_positive_disks(self):
        for name,coefficients in (('besselj',[1,0,-s.Rational(1,4),0,s.Rational(1,64)]),
                                  ('besseli',[1,0,s.Rational(1,4),0,s.Rational(1,64)])):
            result=self.result(expansion(op(name,num(0),sym('x')),0,4))
            self.assertEqual(result['status'],'value',result)
            self.assertEqual([Decoder('radian').node(value) for value in result['expansion']['coefficients']],coefficients)
            self.assertEqual(result['expansion']['convergence']['kind'],'entire')
            self.assertFalse(result['expansion']['exact'])
        for name in ('bessely','besselk'):
            body=op('multiply',num(0),op(name,num(0),op('add',num(1),op('multiply',num(2),sym('x')))))
            result=self.result(expansion(body,0,2))
            self.assertEqual(result['status'],'value',result)
            self.assertEqual(result['expansion']['convergence']['kind'],'disk')
            self.assertEqual(Decoder('radian').node(result['expansion']['convergence']['radius']),s.Rational(1,2))
            self.assertNotEqual(self.result(expansion(body,-1,2))['status'],'value')

    def test_analytic_derivative_does_not_fill_holes_or_smooth_a_corner(self):
        variable=s.Symbol('t',real=True)
        self.assertFalse(analytic_at(s.besselj(1,s.Abs(variable)),variable,s.S.Zero))
        self.assertFalse(analytic_at(s.bessely(0,variable),variable,s.S.Zero))
        self.assertFalse(analytic_at(s.besseli(0,1/variable),variable,s.S.Zero))
        for name in ('besselj','besseli'):
            corner=op(name,num(1),op('absolute',sym('t')))
            self.assertNotEqual(self.result(derivative(corner,num(0)))['status'],'value')
            hole=op('multiply',num(0),op(name,num(0),op('divide',num(1),sym('t'))))
            self.assertNotEqual(self.result(derivative(hole,num(0)))['status'],'value')
            square=op(name,num(0),op('power',sym('t'),num(2)))
            self.assertEqual(self.value(derivative(square,num(0),2)),0)
            self.assertEqual(self.value(derivative(square,num(0),4)), -6 if name=='besselj' else 6)
        product=op('multiply',op('power',sym('t'),num(2)),op('besselj',num(0),sym('t')))
        self.assertEqual(self.value(derivative(product,num(0),2)),2)

    def test_generated_orders_do_not_bypass_the_public_bound(self):
        with self.assertRaises(CasInputProblem):
            Encoder(Decoder('radian')).node(s.besselj(129,1))
        self.assertNotEqual(self.result(derivative(op('besselj',num(128),sym('t')),num(1)))['status'],'value')


if __name__ == '__main__':
    unittest.main()
