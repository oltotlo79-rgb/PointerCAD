"""Independent mapping obligations and exact, explicitly known images."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[5]
sys.dont_write_bytecode = True
sys.path[:0] = [str(Path(__file__).resolve().parent),
               str(ROOT/'vendor/exact-math/runtime/sympy-1.14.0-py3-none-any.whl'),
               str(ROOT/'vendor/exact-math/runtime/mpmath-1.3.0-py3-none-any.whl')]
import sympy as s
from cas_evaluate import calculate_exact_json
from cas_input import Decoder


def num(value):
    return {'kind': 'number', 'decimal': str(value)}


def op(name, *args):
    return {'kind': 'operation', 'operation': name, 'operands': list(args)}


def constant(name):
    return {'kind': 'constant', 'name': name}


REF = {'role': 'bound', 'id': 'local-x', 'label': 'x'}
X = {'kind': 'symbol', 'reference': REF}
R = constant('real-numbers')
C = constant('complex-numbers')
I = constant('imaginary-unit')


def mapping(body, domain=R, codomain=R):
    fn = {'kind': 'binder', 'operation': 'lambda', 'bindings': [
        {'variable': REF, 'domain': {'kind': 'unrestricted'}}], 'body': body}
    return op('mapping', fn, domain, codomain)


class MappingTests(unittest.TestCase):
    def result(self, source):
        return json.loads(calculate_exact_json(json.dumps({'expression': source, 'angleUnit': 'radian'})))

    def value(self, source):
        result = self.result(source)
        self.assertEqual(result['status'], 'value', result)
        self.assertIs(result['coordinateAuthorized'], False)
        return Decoder('radian').node(result['expression'])

    def test_inverse_is_not_reciprocal_and_swaps_declared_sets(self):
        f = mapping(op('add', op('multiply', num(2), X), num(1)))
        self.assertEqual(self.value(op('mapping-value', op('mapping-inverse', f), num(9))), 4)
        inverse = Decoder('radian').node(op('mapping-inverse', f))
        self.assertEqual(inverse.domain, s.S.Reals)
        self.assertEqual(inverse.codomain, s.S.Reals)

    def test_composition_keeps_order_and_rejects_incompatible_declared_domains(self):
        f = mapping(op('add', X, num(1)))
        g = mapping(op('multiply', num(2), X))
        self.assertEqual(self.value(op('mapping-value', op('mapping-compose', f, g), num(3))), 7)
        self.assertEqual(self.value(op('mapping-value', op('mapping-compose', g, f), num(3))), 8)
        inverse_composition = op('mapping-inverse', op('mapping-compose', f, g))
        self.assertEqual(self.value(op('mapping-value', inverse_composition, num(7))), 3)
        restricted = mapping(X, op('interval', num(0), num(1)), op('interval', num(0), num(1)))
        self.assertEqual(self.result(op('mapping-compose', restricted, f))['reason'], 'domain')

    def test_original_cancelled_holes_never_disappear(self):
        hole = mapping(op('divide', X, X))
        self.assertEqual(self.result(hole)['reason'], 'domain')
        self.assertEqual(self.result(op('multiply', num(0), op('mapping-value', hole, num(1))))['reason'], 'domain')
        valid = mapping(op('divide', X, X), op('interval', num(1), num(2)), op('set', num(1)))
        self.assertEqual(self.value(op('mapping-value', valid, num(1))), 1)

    def test_finite_complex_maps_preserve_all_images_and_preimages(self):
        f = mapping(op('multiply', X, I), op('set', num(1), num(2)), op('set', I, op('multiply', num(2), I)))
        self.assertEqual(self.value(op('mapping-image', f, op('set', num(1), num(2)))), s.FiniteSet(s.I, 2*s.I))
        self.assertEqual(self.value(op('mapping-preimage', f, op('set', I))), s.FiniteSet(1))
        self.assertEqual(self.value(op('mapping-value', op('mapping-inverse', f), I)), 1)

    def test_square_inverse_retains_nonnegative_branch_and_totality(self):
        positive = op('interval', num(0), constant('infinity'))
        f = mapping(op('power', X, num(2)), positive, positive)
        self.assertEqual(self.value(op('mapping-value', op('mapping-inverse', f), num(9))), 3)
        self.assertEqual(self.result(op('mapping-value', f, num(-1)))['reason'], 'domain')
        self.assertEqual(self.value(op('mapping-preimage', f, op('interval', num(1), num(4)))), s.Interval(1, 2))

    def test_non_bijections_never_become_inverse_functions(self):
        finite = op('set', num(-1), num(1))
        duplicate = mapping(op('power', X, num(2)), finite, op('set', num(1)))
        self.assertEqual(self.result(op('mapping-inverse', duplicate))['reason'], 'domain')
        not_onto = mapping(X, op('interval', num(0), num(1)), R)
        self.assertEqual(self.result(op('mapping-inverse', not_onto))['reason'], 'domain')
        square = mapping(op('power', X, num(2)), R, op('interval', num(0), constant('infinity')))
        self.assertNotEqual(self.result(op('mapping-inverse', square))['status'], 'value')

    def test_closed_endpoint_attainment_survives_equal_infinite_limit(self):
        domain = op('interval', num(0), constant('infinity'))
        body = op('multiply', X, op('exponential', op('negate', X)))
        f = mapping(body, domain, R)
        self.assertEqual(self.value(op('mapping-image', f, domain)), s.Interval(0, 1/s.E))

    def test_original_request_and_sets_are_retained_without_numeric_authority(self):
        source = mapping(op('add', X, num(1)))
        result = self.result(source)
        self.assertEqual(result, {'status': 'value', 'kind': 'function', 'request': source,
                                 'domainConditions': [], 'coordinateAuthorized': False})
        self.assertEqual(self.result(mapping(op('divide', num(1), num(0))))['reason'], 'domain')

    def test_real_range_proof_does_not_reinterpret_principal_complex_powers(self):
        body = op('power', X, op('divide', num(1), num(3)))
        # SymPy's principal value at -1 is complex, not the real cube root.
        self.assertIs((s.Integer(-1)**s.Rational(1, 3)).is_real, False)
        self.assertEqual(self.result(mapping(body))['status'], 'unresolved')
        self.assertEqual(self.result(mapping(body, R, C))['status'], 'unresolved')
        positive = op('interval', num(0), constant('infinity'))
        self.assertEqual(self.value(op('mapping-value', mapping(body, positive, positive), num(8))), 2)
        square_root = op('power', X, op('divide', num(1), num(2)))
        self.assertEqual(self.value(op('mapping-value', mapping(square_root, positive, positive), num(9))), 3)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 64:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
