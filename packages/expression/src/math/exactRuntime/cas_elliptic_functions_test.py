"""Independent Legendre values, derivatives, original domains and transport."""
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
from cas_elliptic_functions import real_finite, analytic_at


class EllipticFunctions(unittest.TestCase):
    def result(self, expression, angle='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': angle})))

    def value(self, expression, angle='radian'):
        result = self.result(expression, angle)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(angle).node(result['expression'])

    def close(self, actual, expected):
        with m.workdps(100):
            self.assertLess(abs(m.mpf(str(s.N(actual, 90)))-expected), m.mpf('1e-70'))

    def test_six_heads_keep_parameters_angle_and_exact_transport(self):
        cases = [('elliptick', ['0.5'], lambda: m.ellipk(m.mpf('.5'))),
                 ('elliptice', ['0.5'], lambda: m.ellipe(m.mpf('.5'))),
                 ('ellipticf', ['1', '0.5'], lambda: m.ellipf(1, m.mpf('.5'))),
                 ('ellipticeinc', ['1', '0.5'], lambda: m.ellipe(1, m.mpf('.5'))),
                 ('ellipticpi', ['0.25', '0.5'], lambda: m.ellippi(m.mpf('.25'), m.mpf('.5'))),
                 ('ellipticpiinc', ['0.25', '1', '0.5'], lambda: m.ellippi(m.mpf('.25'), 1, m.mpf('.5')))]
        for operation, arguments, reference in cases:
            with self.subTest(operation=operation), m.workdps(100):
                source = op(operation, *(num(argument) for argument in arguments))
                decoder = Decoder('radian')
                value = decoder.node(source)
                self.assertTrue(real_finite(value))
                self.close(self.value(source), reference())
                restored = Decoder('radian').node(Encoder(decoder).node(value))
                self.assertEqual(restored, value)
                self.assertEqual(self.result(source)['kind'], 'real')

    def test_complete_parameter_derivatives_include_removable_zero(self):
        for operation, reference in [('elliptick', m.ellipk), ('elliptice', m.ellipe)]:
            for target in ('0', '0.5'):
                for order in (1, 2):
                    with self.subTest(operation=operation, target=target, order=order), m.workdps(100):
                        self.close(self.value(derivative(op(operation, sym('t')), num(target), order)),
                                   m.diff(reference, m.mpf(target), order))
        for target in ('0', '0.25'):
            with self.subTest(third=target), m.workdps(100):
                source = op('ellipticpi', sym('t'), num('0.5'))
                self.close(self.value(derivative(source, num(target))),
                           m.diff(lambda n: m.ellippi(n, m.mpf('.5')), m.mpf(target)))

    def test_amplitude_derivatives_match_the_defining_integrands(self):
        for operation in ('ellipticf', 'ellipticeinc', 'ellipticpiinc'):
            body = op(operation, *([num('.25')] if operation == 'ellipticpiinc' else []), sym('t'), num('.5'))
            for target in ('0', '0.5', '2'):
                with self.subTest(operation=operation, target=target), m.workdps(100):
                    def integrand(phi):
                        radical = m.sqrt(1-m.mpf('.5')*m.sin(phi)**2)
                        return radical if operation == 'ellipticeinc' else 1/radical if operation == 'ellipticf' else 1/((1-m.mpf('.25')*m.sin(phi)**2)*radical)
                    self.close(self.value(derivative(body, num(target))), integrand(m.mpf(target)))
                    self.close(self.value(derivative(body, num(target), 2)), m.diff(integrand, m.mpf(target)))

    def test_characteristic_zero_uses_integral_moments_through_fourth_order(self):
        for operation, phi in [('ellipticpi', None), ('ellipticpiinc', '1'), ('ellipticpiinc', '4')]:
            for parameter in ('-1', '0', '0.5'):
                args = [sym('t')] + ([] if phi is None else [num(phi)]) + [num(parameter)]
                for order in (1, 2, 4):
                    with self.subTest(operation=operation, phi=phi, parameter=parameter, order=order), m.workdps(100):
                        def reference(n):
                            return m.ellippi(n, m.mpf(parameter)) if phi is None else m.ellippi(n, m.mpf(phi), m.mpf(parameter))
                        self.close(self.value(derivative(op(operation, *args), num(0), order)), m.diff(reference, 0, order))
        # All three arguments move. This also checks mixed terms in the local
        # two-parameter series, rather than only the constant-parameter formula.
        body = op('ellipticpiinc', sym('t'), op('add', num(1), sym('t')), op('multiply', num(2), sym('t')))
        with m.workdps(100):
            self.close(self.value(derivative(body, num(0), 3)), m.diff(lambda t: m.ellippi(t, 1+t, 2*t), 0, 3))

    def test_degree_conversion_changes_only_amplitude_and_derivative_chain(self):
        for operation in ('ellipticf', 'ellipticeinc', 'ellipticpiinc'):
            args = ([num('.25')] if operation == 'ellipticpiinc' else []) + [num(30), num('.5')]
            source = op(operation, *args)
            decoder = Decoder('degree')
            value = decoder.node(source)
            self.assertEqual(Decoder('degree').node(Encoder(decoder).node(value)), value)
            body_args = args[:-2] + [sym('t'), num('.5')]
            actual = self.value(derivative(op(operation, *body_args), num(30)), 'degree')
            with m.workdps(100):
                radical = m.sqrt(m.mpf(7)/8)
                expected = radical if operation == 'ellipticeinc' else 1/radical if operation == 'ellipticf' else 16/(15*radical)
                self.close(actual, expected*m.pi/180)

    def test_poles_and_complex_paths_are_not_hidden_by_zero_or_component(self):
        half_pi = op('divide', {'kind':'constant','name':'pi'}, num(2))
        sources = [op('elliptick', num(1)), op('elliptice', num(2)), op('ellipticpi', num(1), num('.5')),
                   op('ellipticf', half_pi, num(1)), op('ellipticf', num('3.14'), num(2)),
                   op('ellipticpiinc', num(2), num('3.14'), num('.5')),
                   op('elliptick', {'kind':'constant','name':'imaginary-unit'}), op('elliptick', op('list', num(1)))]
        for source in sources:
            for wrapped in (source, op('multiply', num(0), source), op('component', op('list', num(7), source), num(1))):
                with self.subTest(source=wrapped), self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)

    def test_original_parameter_boundary_survives_simplification_before_derivative(self):
        for source in (op('elliptick', sym('t')), op('elliptice', sym('t')), op('ellipticpi', sym('t'), num('.5'))):
            for body in (source, op('multiply', num(0), source), op('component', op('list', num(7), source), num(1))):
                with self.subTest(body=body):
                    self.assertNotEqual(self.result(derivative(body, num(1)))['status'], 'value')
        self.assertEqual(self.value(derivative(op('elliptice', num(1)), num(1))), 0)
        self.assertEqual(self.value(derivative(op('ellipticeinc', num(0), sym('t')), num(2))), 0)
        t = s.Symbol('t', real=True)
        self.assertFalse(analytic_at(s.elliptic_f(s.Abs(t), s.Rational(1, 2)), t, s.S.Zero))
        self.assertFalse(analytic_at(s.elliptic_k(1/t), t, s.S.Zero))

    def test_second_kind_at_one_uses_the_absolute_cosine_integral(self):
        for phi in ('-4', '1', '4'):
            with m.workdps(100):
                self.close(self.value(op('ellipticeinc', num(phi), num(1))), m.ellipe(m.mpf(phi), 1))
        self.assertEqual(self.value(op('ellipticeinc', num(90), num(1)), 'degree'), 1)

    def test_third_kind_transport_keeps_periods_when_parameter_is_zero(self):
        for phi in ('-4', '-1', '1', '4', '7'):
            with self.subTest(phi=phi), m.workdps(100):
                source = op('ellipticpiinc', num('.25'), num(phi), num(0))
                self.close(self.value(source), m.ellippi(m.mpf('.25'), m.mpf(phi), 0))


if __name__ == '__main__':
    unittest.main()
