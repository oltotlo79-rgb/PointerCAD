"""Known Legendre values and original-domain preservation through the fixed engine."""
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
from cas_evaluate import calculate_exact_json
from cas_step_ranges_test import num, sym, op
from cas_line_integrals_test import function
from cas_taylor_test import expansion


class LegendreTests(unittest.TestCase):
    def test_known_values_and_complex_components(self):
        for degree, x, expected in [(0, 7, 1), (2, 0, s.Rational(-1, 2)), (3, 2, 17),
                                    (4, 2, s.Rational(443, 8)), (128, 1, 1), (127, -1, -1)]:
            self.assertEqual(Decoder('radian').node(op('legendre', num(degree), num(x))), expected)
        imaginary = {'kind': 'constant', 'name': 'imaginary-unit'}
        self.assertEqual(Decoder('degree').node(op('legendre', num(3), imaginary)), -4*s.I)

    def test_degree_scalar_and_original_domain(self):
        bad = [op('legendre', num(-1), num(2)), op('legendre', num('0.5'), num(2)),
               op('legendre', num(0), op('divide', num(1), num(0))),
               op('legendre', num(0), {'kind': 'constant', 'name': 'infinity'}),
               op('legendre', num(0), {'kind': 'constant', 'name': 'true'})]
        for source in bad:
            for wrapped in [source, op('multiply', num(0), source), op('component', op('list', num(7), source), num(1))]:
                with self.assertRaises(CasInputProblem):
                    Decoder('radian').node(wrapped)
        with self.assertRaises(CasInputProblem) as caught:
            Decoder('radian').node(op('legendre', num(129), num(1)))
        self.assertEqual(caught.exception.code, 'budget')

    def test_taylor_and_original_hole(self):
        source = expansion(op('legendre', num(2), sym('x')), 0, 2)
        result = json.loads(calculate_exact_json(json.dumps({'expression': source, 'angleUnit': 'radian'})))
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['expansion']['coefficients'], [op('divide', num(-1), num(2)), num(0), op('divide', num(3), num(2))])
        bad = expansion(op('legendre', num(0), op('divide', num(1), sym('x'))), 0, 2)
        result = json.loads(calculate_exact_json(json.dumps({'expression': bad, 'angleUnit': 'radian'})))
        self.assertEqual(result['status'], 'invalid', result)

    def test_point_derivative(self):
        source = op('gradient-at', function(op('legendre', num(3), sym('x')), ('x',)), op('list', num(2)))
        self.assertEqual(Decoder('radian').node(source), (s.Rational(57, 2),))


if __name__ == '__main__':
    unittest.main()
