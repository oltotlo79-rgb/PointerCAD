"""Independent identities, original poles and convergence before scalar transfer."""
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
from cas_step_ranges_test import num, sym, op, binding, binder


INF = {'kind': 'constant', 'name': 'infinity'}


def series(operation, body, start=1, step=None):
    return binder(operation, [binding('k', num(start), INF, None if step is None else num(step))], body)


class InfiniteRanges(unittest.TestCase):
    def result(self, expression):
        return json.loads(calculate_exact_json(json.dumps({'expression': expression, 'angleUnit': 'degree'})))

    def value(self, expression):
        result = self.result(expression)
        self.assertEqual(result['status'], 'value', result)
        self.assertEqual(result['domainConditions'], [], result)
        self.assertFalse(result['coordinateAuthorized'])
        return Decoder('degree').node(result['expression'])

    def test_geometric_and_stepped_geometric(self):
        body = op('power', op('divide', num(1), num(2)), sym('k'))
        self.assertEqual(self.value(series('sum', body, 0)), 2)
        self.assertEqual(self.value(series('sum', body, 0, 2)), s.Rational(4, 3))

    def test_inverse_square_and_conditional_convergence(self):
        inverse_square = op('divide', num(1), op('power', sym('k'), num(2)))
        alternating = op('divide', op('power', num(-1), op('add', sym('k'), num(1))), sym('k'))
        self.assertEqual(self.value(series('sum', inverse_square)), s.pi**2/6)
        self.assertEqual(self.value(series('sum', alternating)), s.log(2))

    def test_divergent_and_oscillating_are_not_finite_cutoffs(self):
        for body in [op('divide', num(1), sym('k')), op('power', num(-1), sym('k'))]:
            result = self.result(series('sum', body))
            self.assertEqual(result, {'status': 'invalid', 'reason': 'divergent', 'coordinateAuthorized': False})

    def test_finite_poles_are_checked_even_when_the_tail_converges(self):
        denominator = op('power', op('subtract', sym('k'), num(3)), num(2))
        result = self.result(series('sum', op('divide', num(1), denominator)))
        self.assertEqual(result['status'], 'invalid', result)
        self.assertEqual(result['reason'], 'domain', result)

    def test_cancelled_original_pole_does_not_disappear(self):
        denominator = op('subtract', sym('k'), num(3))
        body = op('multiply', op('divide', denominator, denominator),
                  op('power', op('divide', num(1), num(2)), sym('k')))
        result = self.result(series('sum', body))
        self.assertEqual(result['reason'], 'domain', result)

    def test_outer_zero_does_not_erase_divergence(self):
        expression = op('multiply', num(0), series('sum', op('divide', num(1), sym('k'))))
        self.assertEqual(self.result(expression)['reason'], 'divergent')

    def test_wallis_and_telescoping_products_use_exact_limits(self):
        square = op('power', sym('k'), num(2))
        numerator = op('multiply', num(4), square)
        wallis = op('divide', numerator, op('subtract', numerator, num(1)))
        telescoping = op('subtract', num(1), op('divide', num(1), square))
        self.assertEqual(self.value(series('product', wallis)), s.pi/2)
        self.assertEqual(self.value(series('product', telescoping, 2)), s.Rational(1, 2))

    def test_zero_factors_and_zero_limit_have_separate_results(self):
        zero_factor = op('subtract', num(1), op('divide', num(1), op('power', sym('k'), num(2))))
        zero_limit = op('divide', sym('k'), op('add', sym('k'), num(1)))
        self.assertEqual(self.result(series('product', zero_factor))['reason'], 'domain')
        self.assertEqual(self.result(series('product', zero_limit))['reason'], 'divergent')

    def test_local_original_conditions_can_be_proved_for_finite_steps(self):
        expression = binder('sum', [binding('k', num(1), num(9), num(2))], op('divide', sym('k'), sym('k')))
        self.assertEqual(self.value(expression), 5)


if __name__ == '__main__':
    if sys.argv[1:] == ['--batch']:
        payloads = json.loads(sys.stdin.read(1_048_577))
        if type(payloads) is not list or len(payloads) > 32:
            raise ValueError('Invalid test batch')
        print(json.dumps([json.loads(calculate_exact_json(json.dumps(value))) for value in payloads]))
    else:
        unittest.main(verbosity=2)
