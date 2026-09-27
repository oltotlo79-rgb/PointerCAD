"""Both real W branches, original domains and removable origin derivatives."""
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
import mpmath as m
from cas_input import Decoder, CasInputProblem
from cas_result import Encoder
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, sym, op
from cas_derivatives_test import derivative
from cas_lambert_functions import real_finite, analytic_at


class LambertFunctionTests(unittest.TestCase):
    def result(self, expression):
        result = json.loads(calculate_exact_json(json.dumps({'expression':expression, 'angleUnit':'radian'})))
        if result['status'] != 'value':
            try:
                Decoder('radian').node(expression)
            except CasInputProblem as error:
                result['diagnosis'] = str(error)
        return result

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_branch_and_argument_order_round_trip_exactly(self):
        for branch in (0,-1):
            source = op('lambertw',num(branch),op('divide',num(-1),num(8)))
            decoder = Decoder('radian')
            value = decoder.node(source)
            self.assertEqual(value, s.LambertW(-s.Rational(1,8),branch))
            self.assertEqual(Encoder(decoder).node(value),source)
            self.assertTrue(real_finite(value))
            self.assertEqual(self.result(source)['kind'],'real')
            boundary = op('divide',num(-1),{'kind':'constant','name':'e'})
            self.assertEqual(self.value(op('lambertw',num(branch),boundary)),-1)
        self.assertEqual(self.value(op('lambertw',num(0),num(0))),0)
        self.assertEqual(self.value(op('lambertw',num(0),{'kind':'constant','name':'e'})),1)

    def test_original_domains_survive_zero_and_component_selection(self):
        for branch, x in [(0,'-0.368'),(-1,'-0.368'),(-1,'0'),(-1,'1e-1000'),(1,'1'),('0.5','1')]:
            source = op('lambertw',num(branch),num(x))
            for wrapped in (source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))):
                with self.subTest(source=wrapped), self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)
        self.assertFalse(real_finite(s.LambertW(s.Symbol('x'))))
        with self.assertRaises(CasInputProblem):
            Encoder(Decoder('radian')).node(s.LambertW(1,2))

    def test_origin_and_composition_derivatives_have_no_removable_division(self):
        body = op('lambertw',num(0),sym('t'))
        for order, expected in [(1,1),(2,-2),(3,9),(4,-64)]:
            self.assertEqual(self.value(derivative(body,num(0),order)),expected)
        square = op('lambertw',num(0),op('power',sym('t'),num(2)))
        self.assertEqual(self.value(derivative(square,num(0),2)),2)
        self.assertEqual(self.value(derivative(square,num(0),4)),-24)

    def test_both_branches_match_independent_first_to_fourth_derivatives(self):
        for branch in (0,-1):
            for order in (1,2,3,4):
                body = op('lambertw',num(branch),sym('t'))
                actual = self.value(derivative(body,num('-0.125'),order))
                with m.workdps(80):
                    expected = m.diff(lambda x:m.lambertw(x,branch),m.mpf('-0.125'),order)
                    self.assertLess(abs(m.mpf(str(s.N(actual,70)))/expected-1),m.mpf('1e-60'))

    def test_zero_and_component_cannot_hide_original_branch_boundary(self):
        boundary = op('divide',num(-1),{'kind':'constant','name':'e'})
        for branch in (0,-1):
            call = op('lambertw',num(branch),sym('t'))
            for body in (call,op('multiply',num(0),call),op('component',op('list',num(7),call),num(1))):
                with self.subTest(branch=branch,body=body):
                    self.assertNotEqual(self.result(derivative(body,boundary))['status'],'value')
        constant = op('lambertw',num(0),boundary)
        self.assertEqual(self.value(derivative(op('multiply',sym('t'),constant),num(0))),-1)

    def test_branch_point_zero_poles_and_corners_are_not_smooth(self):
        variable = s.Symbol('t',real=True)
        self.assertFalse(analytic_at(s.LambertW(s.Abs(variable)),variable,s.S.Zero))
        self.assertFalse(analytic_at(s.LambertW(variable),variable,-1/s.E))
        self.assertFalse(analytic_at(s.LambertW(1/variable),variable,s.S.Zero))
        for branch in (0,-1):
            body = op('lambertw',num(branch),sym('t'))
            point = op('divide',num(-1),{'kind':'constant','name':'e'})
            self.assertNotEqual(self.result(derivative(body,point))['status'],'value')
        for body in (op('lambertw',num(0),op('absolute',sym('t'))),
                     op('multiply',num(0),op('lambertw',num(-1),sym('t'))),
                     op('multiply',num(0),op('lambertw',num(0),op('divide',num(1),sym('t'))))):
            self.assertNotEqual(self.result(derivative(body,num(0)))['status'],'value')


if __name__ == '__main__':
    unittest.main()
