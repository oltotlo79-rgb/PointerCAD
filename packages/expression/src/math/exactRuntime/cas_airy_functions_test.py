"""Independent Airy values, exact expression transfer and original input rejection."""
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
from cas_airy_functions import AIRY, real_finite, analytic_at


class AiryFunctionTests(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression':expression,'angleUnit':'radian'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'],'value',result)
        self.assertEqual(result['domainConditions'],[],result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_all_four_heads_round_trip_and_remain_real(self):
        for operation, function in AIRY.items():
            source = op(operation,num(-1))
            decoder = Decoder('radian')
            value = decoder.node(source)
            self.assertEqual(value,function(-1))
            self.assertEqual(Encoder(decoder).node(value),source)
            self.assertTrue(real_finite(value))
            self.assertEqual(self.result(source)['kind'],'real')

    def test_original_invalid_arguments_survive_zero_and_component(self):
        for operation in AIRY:
            for argument in (num(33),num(-33),{'kind':'constant','name':'imaginary-unit'},op('divide',num(1),num(0)),op('list',num(1))):
                source = op(operation,argument)
                for wrapped in (source,op('multiply',num(0),source),op('component',op('list',num(7),source),num(1))):
                    with self.subTest(source=wrapped),self.assertRaises(CasInputProblem):
                        Decoder('radian').node(wrapped)

    def test_first_to_fourth_derivatives_match_independent_mpmath(self):
        for operation in AIRY:
            function = m.airyai if operation.startswith('airyai') else m.airybi
            prime = 1 if operation.endswith('prime') else 0
            body = op(operation,sym('t'))
            for target in (-1,0,1):
                for order in (1,2,3,4):
                    with self.subTest(operation=operation,target=target,order=order):
                        actual = self.value(derivative(body,num(target),order))
                        with m.workdps(90):
                            expected = function(target,derivative=prime+order)
                            self.assertLess(abs(m.mpf(str(s.N(actual,80)))-expected),m.mpf('1e-70'))

    def test_holes_corners_and_original_work_bound_are_not_erased(self):
        variable = s.Symbol('t',real=True)
        self.assertFalse(analytic_at(s.airyai(s.Abs(variable)),variable,s.S.Zero))
        self.assertFalse(analytic_at(s.airybi(1/variable),variable,s.S.Zero))
        for operation in AIRY:
            for body in (op(operation,op('absolute',sym('t'))),
                         op('multiply',num(0),op(operation,op('divide',num(1),sym('t'))))):
                self.assertNotEqual(self.result(derivative(body,num(0)))['status'],'value')
            call = op(operation,sym('t'))
            for body in (call,op('multiply',num(0),call),op('component',op('list',num(7),call),num(1))):
                self.assertNotEqual(self.result(derivative(body,num(33)))['status'],'value')

    def test_analytic_composition_with_existing_special_functions(self):
        variable = s.Symbol('t',real=True)
        for body in (s.airyai(s.LambertW(variable)),s.LambertW(s.airyai(variable)),s.besselj(0,s.airyai(variable)),s.airybi(s.besselj(0,variable))):
            self.assertTrue(analytic_at(body,variable,s.S.One))


if __name__ == '__main__':
    unittest.main()
