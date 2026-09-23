"""Actual fixed runtime: analytic identities, independent quadrature, and original domains."""
from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
import mpmath as mp
from cas_input import CasInputProblem, Decoder
from cas_evaluate import calculate_exact_json
from cas_result import Encoder
from cas_transforms import TransformEncoder
from cas_step_ranges_test import num, op


def symbol(name):
    return {'kind': 'symbol', 'reference': {'role': 'bound', 'id': name, 'label': name}}


def query(operation, body, first='x', second='k'):
    return op(operation, {'kind': 'binder', 'operation': 'lambda', 'body': body,
                         'bindings': [{'variable': symbol(name)['reference'], 'domain': {'kind': 'unrestricted'}}
                                      for name in (first, second)]})


X = symbol('x')


class IntegralTransforms(unittest.TestCase):
    def test_only_the_declared_output_can_escape_inside_its_function(self):
        decoder = Decoder('radian')
        output, other = s.Dummy('output'), s.Dummy('other')
        reference = symbol('k')['reference']
        binding = {'variable': reference, 'domain': {'kind': 'unrestricted'}}
        decoder.references[output] = reference
        decoder.references[other] = symbol('x')['reference']
        self.assertEqual(TransformEncoder(decoder, output, binding).node(output), symbol('k'))
        for encoder, value in ((Encoder(decoder), output),
                               (TransformEncoder(decoder, output, binding), other),
                               (TransformEncoder(decoder, output, binding), output+other)):
            with self.assertRaises(CasInputProblem) as raised:
                encoder.node(value)
            self.assertEqual(raised.exception.code, 'unsupported')

    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['domainConditions'], [])
        return Decoder(unit).node(result['expression'])

    def at(self, operation, body, point, unit='radian'):
        return self.value(op('transform-value', query(operation, body), point), unit)

    def test_fourier_sign_normalization_inverse_and_complex_phase(self):
        gaussian = op('exponential', op('negate', op('power', X, num(2))))
        self.assertEqual(self.at('fourier-transform', gaussian, num(0)), s.sqrt(s.pi))
        self.assertEqual(s.simplify(self.at('fourier-transform', gaussian, num(1)) - s.sqrt(s.pi)*s.exp(-s.pi**2)), 0)
        shifted = op('exponential', op('negate', op('power', op('subtract', X, num(1)), num(2))))
        expected = -s.I*s.sqrt(s.pi)*s.exp(-s.pi**2/16)
        self.assertEqual(s.simplify(self.at('fourier-transform', shifted, op('divide', num(1), num(4)))-expected), 0)
        normalized = op('exponential', op('negate', op('multiply', {'kind': 'constant', 'name': 'pi'}, op('power', X, num(2)))))
        self.assertEqual(s.simplify(self.at('inverse-fourier-transform', normalized, num(1))-s.exp(-s.pi)), 0)

    def test_independent_numerical_integrals_and_finite_scalar_selection(self):
        gaussian = op('exponential', op('negate', op('power', X, num(2))))
        with mp.workdps(80):
            for frequency in (s.Rational(-1, 2), s.Rational(1, 4), s.Rational(3, 4)):
                point = op('divide', num(frequency.p), num(frequency.q))
                actual = self.at('fourier-transform', gaussian, point)
                f = mp.mpf(int(frequency.p))/int(frequency.q)
                independent = mp.quad(lambda x: mp.exp(-x*x)*mp.cos(2*mp.pi*f*x), [-mp.inf, 0, mp.inf])
                self.assertLess(abs(mp.mpf(str(s.N(actual, 75)))-independent), mp.mpf('1e-65'))
            body = op('multiply', op('power', X, num(2)), op('exponential', op('negate', X)))
            actual = self.at('laplace-transform', body, num(2))
            independent = mp.quad(lambda x: x*x*mp.exp(-3*x), [0, 1, mp.inf])
            self.assertLess(abs(mp.mpf(str(s.N(actual, 75)))-independent), mp.mpf('1e-65'))

    def test_laplace_half_plane_and_positive_time_inverse_are_explicit(self):
        body = op('exponential', op('negate', X))
        transform = query('laplace-transform', body)
        result = self.result(transform)
        self.assertEqual(result['kind'], 'transform', result)
        self.assertEqual(result['transform']['convention'], 'laplace-unilateral')
        self.assertEqual(result['transform']['formula']['bindings'], transform['operands'][0]['bindings'][1:])
        self.assertEqual(self.value(op('transform-value', transform, num(1))), s.Rational(1, 2))
        self.assertEqual(self.value(op('transform-value', transform, op('add', num(1), {'kind': 'constant', 'name': 'imaginary-unit'}))), s.Rational(2, 5)-s.I/5)
        for point in (-1, -2):
            self.assertEqual(self.result(op('transform-value', transform, num(point)))['reason'], 'domain')
        inverse = query('inverse-laplace-transform', op('divide', num(1), op('add', X, num(1))))
        self.assertEqual(self.value(op('transform-value', inverse, num(1))), s.exp(-1))
        for point in (0, -1):
            self.assertEqual(self.result(op('transform-value', inverse, num(point)))['reason'], 'domain')

    def test_z_transform_region_and_original_index_holes(self):
        geometric = query('z-transform', op('power', op('divide', num(1), num(2)), X))
        self.assertEqual(self.value(op('transform-value', geometric, num(2))), s.Rational(4, 3))
        self.assertEqual(self.value(op('transform-value', geometric, num(-2))), s.Rational(4, 5))
        for point in (num(0), op('divide', num(1), num(2)), op('divide', num(1), num(4))):
            self.assertEqual(self.result(op('transform-value', geometric, point))['reason'], 'domain')
        bad = query('z-transform', op('multiply', num(0), op('divide', num(1), op('subtract', X, num(3)))))
        self.assertEqual(self.result(bad)['reason'], 'domain')

    def test_angle_modes_apply_to_input_not_the_transform_kernel(self):
        gaussian = op('exponential', op('negate', op('power', X, num(2))))
        for unit in ('degree', 'radian'):
            self.assertEqual(self.at('fourier-transform', gaussian, num(0), unit), s.sqrt(s.pi))
        for unit, scale in (('degree', s.pi/180), ('radian', s.S.One)):
            actual = self.at('laplace-transform', op('sin', X), num(1), unit)
            self.assertEqual(s.simplify(actual-scale/(1+scale**2)), 0)

    def test_invalid_originals_and_unresolved_distributions_are_not_values(self):
        for outer in (lambda value: value, lambda value: op('multiply', num(0), value)):
            bad = op('transform-value', query('laplace-transform', op('divide', num(1), num(0))), num(1))
            self.assertEqual(self.result(outer(bad))['reason'], 'domain')
        pole = query('laplace-transform', op('divide', num(1), op('subtract', X, num(1))))
        self.assertIn(self.result(pole)['status'], ('invalid', 'unresolved'))
        self.assertEqual(self.result(query('fourier-transform', num(1)))['status'], 'unresolved')
        self.assertEqual(self.result(query('inverse-laplace-transform', num(1)))['status'], 'unresolved')
        self.assertEqual(self.result(query('laplace-transform', symbol('k')))['status'], 'unresolved')


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(payload))) for payload in json.load(sys.stdin)]))
    else:
        unittest.main()
