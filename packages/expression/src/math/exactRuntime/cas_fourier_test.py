"""Independent identities, signs, ordering, domains and exact scalar preservation."""
import cmath
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT / 'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT / 'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_input import Decoder, CasInputProblem
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, op


def vector(*values):
    return op('list', *(num(value) if not isinstance(value, dict) else value for value in values))


class DiscreteFourier(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_sign_order_normalization_and_both_angle_modes(self):
        for unit in ('degree', 'radian'):
            for operation in ('dft', 'fft'):
                with self.subTest(unit=unit, operation=operation):
                    self.assertEqual(self.value(op(operation, vector(1, 2, 3, 4)), unit),
                                     (10, -2+2*s.I, -2, -2-2*s.I))
            for operation in ('idft', 'ifft'):
                self.assertEqual(self.value(op(operation, vector(1, 2, 3, 4)), unit),
                                 (s.Rational(5, 2), -s.Rational(1, 2)-s.I/2,
                                  -s.Rational(1, 2), -s.Rational(1, 2)+s.I/2))

    def test_all_entries_against_independent_direct_complex_sum(self):
        for count in (3, 5, 7, 8, 16):
            values = [complex(j-2, (j*j) % 5-1) for j in range(count)]
            source = vector(*(op('complex', num(value.real), num(value.imag)) for value in values))
            for operation in (('dft', 'idft', 'fft', 'ifft') if count & (count-1) == 0 else ('dft', 'idft')):
                inverse = operation.startswith('i')
                actual = self.value(op(operation, source))
                expected = [sum(value*cmath.exp((1 if inverse else -1)*2j*cmath.pi*j*k/count)
                                for j, value in enumerate(values))/(count if inverse else 1) for k in range(count)]
                self.assertEqual(len(actual), count)
                for value, reference in zip(actual, expected):
                    self.assertLess(abs(complex(value.evalf(30))-reference), 1e-10)

    def test_inverse_roundtrip_complex_rational_and_tiny_components(self):
        tiny = op('divide', num(1), num('1e100'))
        source = vector(op('complex', num('0.125'), tiny), 2, -3, tiny)
        expected = Decoder('radian').node(source)
        for forward, inverse in (('dft', 'idft'), ('fft', 'ifft')):
            self.assertEqual(self.value(op(inverse, op(forward, source))), expected)
        for count in (1, 3, 5):
            source = vector(1, *([0]*(count-1)))
            result = self.value(op('idft', op('dft', source)))
            self.assertTrue(all(s.simplify(a-b) == 0 for a, b in zip(result, Decoder('radian').node(source))))

    def test_parseval_and_complex_conjugate_symmetry(self):
        source = vector(2, -1, 4, 7, 0, -5, 3, 9)
        values = self.value(op('fft', source))
        self.assertEqual(s.simplify(sum(s.expand_complex(value*s.conjugate(value)) for value in values)),
                         8*sum(value**2 for value in (2, -1, 4, 7, 0, -5, 3, 9)))
        for index in range(1, len(values)):
            self.assertEqual(s.simplify(values[-index]-s.conjugate(values[index])), 0)

    def test_invalid_entries_cannot_be_hidden_by_zero_or_selection(self):
        bad = op('dft', vector(1, op('divide', num(1), num(0))))
        for expression in (bad, op('multiply', num(0), bad), op('component', bad, num(1)),
                           op('fft', vector(1, 2, 3)), op('ifft', vector(1, 2, 3)),
                           op('dft', vector()), op('fft', num(3)), op('dft', vector(vector(1), vector(2))),
                           op('dft', vector({'kind': 'constant', 'name': 'infinity'}))):
            result = self.result(expression)
            self.assertEqual(result['status'], 'invalid', result)
            self.assertEqual(result['reason'], 'domain', result)
            self.assertNotIn('expression', result)

    def test_limits_are_bounded_and_never_pad_or_return_partial_vectors(self):
        for operation, count in (('dft', 64), ('fft', 256)):
            self.assertEqual(self.value(op(operation, vector(1, *([0]*(count-1))))), (1,)*count)
        for operation, count in (('dft', 65), ('fft', 257)):
            self.assertEqual(self.result(op(operation, vector(*([0]*count))))['status'], 'stopped' if count < 257 else 'invalid')
        decoder = Decoder('radian')
        values = tuple(s.Integer(0) for _ in range(256))
        with self.assertRaises(CasInputProblem) as context:
            for _ in range(8):
                decoder.operation('fft', [values])
        self.assertEqual(context.exception.code, 'budget')


if __name__ == '__main__':
    if '--batch' in sys.argv:
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in json.load(sys.stdin)]))
    else:
        unittest.main()
