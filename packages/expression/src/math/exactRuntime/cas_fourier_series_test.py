"""Independent analytic coefficients and quadrature through the shipped exact runtime."""
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
import mpmath as mp
from cas_evaluate import calculate_exact_json
from cas_input import Decoder
from cas_step_ranges_test import num, op

X = {'kind': 'symbol', 'reference': {'role': 'bound', 'id': 'x', 'label': 'x'}}
PI = {'kind': 'constant', 'name': 'pi'}


def series(body, degree=2, lower=None, upper=None):
    return op('fourier-series', {'kind': 'binder', 'operation': 'lambda', 'body': body,
                                'bindings': [{'variable': X['reference'], 'domain': {'kind': 'unrestricted'}}]},
              op('negate', PI) if lower is None else lower, PI if upper is None else upper, num(degree))


class FourierSeriesTests(unittest.TestCase):
    def result(self, node, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': node, 'angleUnit': unit})))

    def expansion(self, node, unit='radian'):
        result = self.result(node, unit)
        if result['status'] != 'value':
            from cas_fourier_series import compute_series
            compute_series(node, Decoder(unit))
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['kind'], 'fourier-series')
        self.assertEqual(result['request'], node)
        self.assertFalse(result['coordinateAuthorized'])
        self.assertEqual(result['domainConditions'], [])
        return result['series']

    def scalar(self, node, unit='radian'):
        result = self.result(node, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        return Decoder(unit).node(result['expression'])

    def test_odd_even_harmonics_and_periodic_endpoint_mean(self):
        linear = self.expansion(series(X))
        decode = Decoder('radian').node
        self.assertEqual(decode(linear['constant']), 0)
        self.assertEqual([decode(node) for node in linear['cosine']], [0, 0])
        self.assertEqual([decode(node) for node in linear['sine']], [2, -1])
        self.assertEqual(linear['convergence'], 'piecewise-smooth')
        self.assertEqual(decode(linear['endpointMean']), 0)
        quadratic = self.expansion(series(op('power', X, num(2))))
        self.assertEqual(decode(quadratic['constant']), s.pi**2/3)
        self.assertEqual([decode(node) for node in quadratic['cosine']], [-4, 1])
        self.assertEqual([decode(node) for node in quadratic['sine']], [0, 0])
        self.assertEqual(decode(quadratic['endpointMean']), s.pi**2)

    def test_independent_quadrature_with_shifted_interval(self):
        with mp.workdps(80):
            result = self.expansion(series(X, 2, num(0), num(2)))
            decode = Decoder('radian').node
            self.assertEqual(decode(result['constant']), 1)
            for n, node in enumerate(result['sine'], 1):
                actual = decode(node)
                self.assertEqual(s.simplify(actual+2/(s.pi*n)), 0)
                expected = mp.quad(lambda x: x*mp.sin(n*mp.pi*x), [0, 1, 2])
                self.assertLess(abs(mp.mpf(str(actual.evalf(75)))-expected), mp.mpf('1e-70'))
            self.assertEqual([decode(node) for node in result['cosine']], [0, 0])

    def test_partial_sum_is_explicit_and_not_the_original(self):
        expression = series(X)
        value = self.scalar(op('fourier-value', expression, op('divide', PI, num(2))))
        self.assertEqual(value, 2)
        self.assertNotEqual(value, s.pi/2)
        self.assertEqual(self.scalar(op('fourier-value', expression, op('multiply', num(5), op('divide', PI, num(2))))), 2)
        self.assertEqual(self.scalar(op('fourier-cosine', series(num(3), 0), num(0))), 6)
        self.assertEqual(self.scalar(op('fourier-sine', series(num(3), 0), num(0))), 0)
        self.assertEqual(self.scalar(op('fourier-value', series(num(3), 0), num(1000))), 3)

    def test_basis_is_radian_but_source_keeps_its_angle(self):
        body = op('sin', X)
        for unit, expression, point in (
                ('degree', series(body, 1, num(-180), num(180)), num(90)),
                ('radian', series(body, 1), op('divide', PI, num(2)))):
            self.assertEqual(self.scalar(op('fourier-sine', expression, num(1)), unit), 1)
            self.assertEqual(self.scalar(op('fourier-value', expression, point), unit), 1)

    def test_corner_and_unproved_convergence_are_distinct(self):
        corner = self.expansion(series(op('absolute', X), 1))
        decode = Decoder('radian').node
        self.assertEqual(decode(corner['constant']), s.pi/2)
        self.assertEqual(decode(corner['cosine'][0]), -4/s.pi)
        self.assertEqual(corner['convergence'], 'piecewise-smooth')
        logarithm = self.expansion(series(op('natural-log', X), 0, num(0), num(1)))
        self.assertEqual(decode(logarithm['constant']), -1)
        self.assertEqual(logarithm['convergence'], 'unknown')
        self.assertIsNone(logarithm['endpointMean'])
        positive = self.expansion(series(op('natural-log', X), 0, num(1), num(2)))
        self.assertEqual(s.simplify(decode(positive['constant'])-(2*s.log(2)-1)), 0)

    def test_original_poles_invalid_ranges_and_shared_work_budget(self):
        for body in (op('divide', num(1), X), op('multiply', num(0), op('divide', num(1), X))):
            for node in (series(body), op('fourier-cosine', series(body), num(0)),
                         op('multiply', num(0), op('fourier-value', series(body), num(1)))):
                self.assertNotEqual(self.result(node)['status'], 'value')
        for node in (series(X, -1), series(X, 13), series(X, 1, num(1), num(1)),
                     series(X, 1, num(2), num(1)), series(X, 1, num(0), {'kind': 'constant', 'name': 'infinity'}),
                     op('fourier-cosine', series(X, 1), num(2))):
            self.assertNotEqual(self.result(node)['status'], 'value')


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(item))) for item in json.loads(sys.stdin.read())], separators=(',', ':')))
    else:
        unittest.main()
