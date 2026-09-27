"""Independent analytic areas, fluxes, volumes and conservative domain proofs."""
import time
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
from cas_evaluate import calculate_exact_json
from cas_input import Decoder, CasInputProblem
from cas_box_domain import BoxDomain
from cas_line_integrals_test import function
from cas_step_ranges_test import num, sym, op


def region(body, mapping, operation='surface-integral', lower=(0, 0), upper=(1, 1)):
    names = ('u', 'v', 'w') if operation == 'volume-integral' else ('u', 'v')
    return op(operation, function(body, ('x', 'y', 'z')), function(op('list', *mapping), names),
              op('list', *(num(value) for value in lower)), op('list', *(num(value) for value in upper)))


class RegionIntegrals(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'radian'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [])
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('radian').node(result['expression'])

    def test_plane_area_flux_and_density_against_cross_product(self):
        u, v = sym('u'), sym('v')
        plane = [op('multiply', num(2), u), op('multiply', num(3), v), num(0)]
        self.assertEqual(self.value(region(num(1), plane)), 6)
        self.assertEqual(self.value(region(sym('x'), plane)), 6)
        self.assertEqual(self.value(region(op('list', num(0), num(0), num(4)), plane, 'flux-integral')), 24)
        self.assertEqual(self.value(region(num(1), plane, lower=(1, 1), upper=(0, 0))), 6)

    def test_reflected_volume_keeps_measure_and_density(self):
        mapping = [op('multiply', num(-2), sym('u')), op('multiply', num(3), sym('v')), op('multiply', num(4), sym('w'))]
        self.assertEqual(self.value(region(num(1), mapping, 'volume-integral', (0, 0, 0), (1, 1, 1))), 24)
        self.assertEqual(self.value(region(sym('x'), mapping, 'volume-integral', (0, 0, 0), (1, 1, 1))), -24)
        self.assertEqual(self.value(region(num(1), mapping, 'volume-integral', (1, 0, 0), (0, 1, 1))), 24)

    def test_folded_mapping_counts_multiplicity(self):
        mapping = [op('square', sym('u')), sym('v'), num(0)]
        self.assertEqual(self.value(region(num(1), mapping, lower=(-1, 0))), 2)
        self.assertEqual(self.value(region(op('list', num(0), num(0), num(1)), mapping, 'flux-integral', (-1, 0))), 0)

    def test_original_holes_cannot_be_erased_by_cancellation_or_component(self):
        plane = [sym('u'), sym('v'), num(0)]
        hole = op('divide', sym('x'), sym('x'))
        expressions = [region(op('multiply', num(0), hole), plane),
                       region(op('subtract', hole, hole), plane),
                       region(op('component', op('list', num(1), hole), num(1)), plane),
                       region(num(1), [op('divide', sym('u'), sym('u')), sym('v'), num(0)])]
        for expression in expressions:
            self.assertNotEqual(self.result(expression)['status'], 'value')

    def test_cusp_mapping_and_invalid_field_with_zero_jacobian_stay_unresolved(self):
        cusp = region(num(1), [op('absolute', sym('u')), sym('v'), num(0)], lower=(-1, 0))
        self.assertEqual(self.result(cusp)['status'], 'unresolved')
        invalid = region(op('divide', num(1), sym('z')), [sym('u'), num(0), num(0)])
        self.assertEqual(self.result(invalid)['status'], 'invalid')
        self.assertEqual(self.value(region(num(3), [sym('u'), num(0), num(0)])), 0)

    def test_enclosures_include_interior_minima_for_powers_abs_and_cosh(self):
        variable = s.Symbol('t', real=True)
        domain = BoxDomain({variable: (-s.Integer(2), s.Integer(3))}, CasInputProblem)
        for expression, expected in [(variable**2, (0, 9)), (s.Abs(variable), (0, 3)),
                                     (s.cosh(variable), (1, s.cosh(3)))]:
            self.assertEqual(domain.enclosure(expression), expected)
        # Undecidable endpoint signs must also include the possible interior
        # minimum; interval overestimation is safe, silently excluding zero is not.
        a, b = s.symbols('a b', real=True)
        self.assertEqual(domain.power(variable**2, (a, b))[0], s.Min(0, a**2, b**2))
        self.assertEqual(domain.unary(s.Abs, (a, b))[0], 0)
        self.assertEqual(domain.unary(s.cosh, (a, b))[0], 1)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        items = json.load(sys.stdin)
        if not isinstance(items, list) or len(items) > 80:
            raise ValueError('A bounded batch is required')
        replies = []
        for index, item in enumerate(items):
            started = time.monotonic()
            print('Region case start: ' + str(index), file=sys.stderr, flush=True)
            replies.append(json.loads(calculate_exact_json(json.dumps(item))))
            print('Region case finish: ' + str(index) + ' / ' + str(round(time.monotonic()-started, 3)), file=sys.stderr, flush=True)
        print(json.dumps(replies))
    else:
        unittest.main()
