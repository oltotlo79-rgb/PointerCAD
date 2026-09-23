"""Real bundled symbolic engine with independent limit identities and side checks."""
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
from cas_input import Decoder
from cas_step_ranges_test import num, sym, op


INF = {'kind': 'constant', 'name': 'infinity'}


def limit(body, target=None, direction=None):
    fn = {'kind': 'binder', 'operation': 'lambda', 'body': body, 'bindings': [
        {'variable': sym('t')['reference'], 'domain': {'kind': 'unrestricted'}}]}
    operands = [fn, num(0) if target is None else target]
    if direction is not None:
        operands.append(direction)
    return op('limit', *operands)


class ExactLimits(unittest.TestCase):
    def result(self, expression, unit='radian'):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': unit})))

    def value(self, expression, unit='radian'):
        result = self.result(expression, unit)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder(unit).node(result['expression'])

    def test_polynomial_and_removable_pole(self):
        rational = op('divide', op('subtract', op('power', sym('t'), num(2)), num(1)),
                      op('subtract', sym('t'), num(1)))
        self.assertEqual(self.value(limit(rational, num(1))), 2)
        self.assertEqual(self.value(limit(op('power', sym('t'), num(2)), num(-3))), 9)

    def test_sinc_preserves_degree_and_radian(self):
        sinc = op('divide', op('sin', sym('t')), sym('t'))
        self.assertEqual(self.value(limit(sinc)), 1)
        self.assertEqual(self.value(limit(sinc), 'degree'), s.pi/180)

    def test_vanishing_trigonometric_denominator_has_a_punctured_domain(self):
        body = op('divide', op('subtract', num(1), op('cos', sym('t'))),
                  op('power', op('sin', sym('t')), num(2)))
        self.assertEqual(self.value(limit(body)), s.Rational(1, 2))

    def test_two_sides_must_agree_and_explicit_sides_are_preserved(self):
        body = op('divide', op('absolute', sym('t')), sym('t'))
        self.assertEqual(self.result(limit(body))['reason'], 'no-limit')
        self.assertEqual(self.value(limit(body, direction=num(-1))), -1)
        self.assertEqual(self.value(limit(body, direction=num(1))), 1)
        self.assertEqual(self.result(limit(body, direction=num(0)))['reason'], 'no-limit')

    def test_opposite_infinities_and_nonfinite_results_are_distinct(self):
        body = op('divide', num(1), sym('t'))
        self.assertEqual(self.result(limit(body))['reason'], 'no-limit')
        self.assertEqual(self.result(limit(body, direction=num(1)))['reason'], 'non-finite')
        self.assertEqual(self.result(limit(op('power', body, num(2))))['reason'], 'non-finite')

    def test_infinite_points_use_their_natural_direction(self):
        body = op('arctan', sym('t'))
        self.assertEqual(self.value(limit(body, INF)), s.pi/2)
        self.assertEqual(self.value(limit(body, op('negate', INF)), 'degree'), -90)
        self.assertEqual(self.value(limit(op('divide', num(1), sym('t')), INF)), 0)

    def test_oscillation_is_not_a_numerical_cutoff(self):
        oscillation = op('sin', op('divide', num(1), sym('t')))
        self.assertEqual(self.result(limit(oscillation))['reason'], 'no-limit')
        self.assertEqual(self.value(limit(op('multiply', sym('t'), oscillation))), 0)

    def test_outer_zero_cannot_hide_missing_two_sided_limit(self):
        bad = limit(op('divide', op('absolute', sym('t')), sym('t')))
        self.assertEqual(self.result(op('multiply', num(0), bad))['reason'], 'no-limit')

    def test_cancelled_terms_are_checked_in_the_punctured_neighborhood(self):
        self.assertEqual(self.value(limit(op('divide', sym('t'), sym('t')))), 1)
        denominator = op('subtract', sym('t'), num(3))
        self.assertEqual(self.value(limit(op('divide', denominator, denominator))), 1)
        self.assertEqual(self.result(limit(op('divide', num(1), num(0))))['reason'], 'domain')

    def test_invalid_directions_and_unestablished_domains_are_not_applied(self):
        for direction in [num(2), op('divide', num(1), num(2))]:
            self.assertEqual(self.result(limit(sym('t'), direction=direction))['reason'], 'domain')
        self.assertEqual(self.result(limit(sym('t'), INF, num(1)))['reason'], 'domain')
        denominator = op('sin', op('divide', num(1), sym('t')))
        unknown = self.result(limit(op('divide', denominator, denominator)))
        self.assertEqual(unknown['status'], 'unresolved', unknown)
        self.assertEqual(unknown['reason'], 'unevaluated')


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 32:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
