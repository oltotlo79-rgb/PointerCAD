"""Optional exact result transfer; this module never authorizes a coordinate.

Use the application's MathNode grammar, not Python text or an engine JSON format.
Unknown engine objects and local variables remain unresolved. Inexact Float
results require a separate numerical-error contract and are refused here.
"""
import sympy as s
from sympy.core.relational import Relational
from sympy.logic.boolalg import BooleanFunction
from cas_input import CasInputProblem
from cas_bessel_functions import FAMILIES
from cas_lambert_functions import branch_of
from cas_elliptic_functions import signature as elliptic_signature, amplitude_index
from cas_zeta_functions import real_finite, RealZeta, RealZetaDerivative, zeta_point


CONSTANTS = {
    s.pi: 'pi', s.E: 'e', s.I: 'imaginary-unit', s.oo: 'infinity',
    s.true: 'true', s.false: 'false', s.S.Reals: 'real-numbers',
    s.S.Complexes: 'complex-numbers', s.S.Integers: 'integers',
    s.S.Naturals0: 'naturals', s.S.Rationals: 'rationals', s.S.EmptySet: 'empty-set',
}
OPERATIONS = {
    s.Add: 'add', s.Mul: 'multiply', s.Pow: 'power', s.Abs: 'absolute',
    s.exp: 'exponential', s.log: 'natural-log', s.conjugate: 'conjugate',
    s.re: 'real-part', s.im: 'imaginary-part',
    s.sinh: 'sinh', s.cosh: 'cosh', s.tanh: 'tanh',
    s.asinh: 'arsinh', s.acosh: 'arcosh', s.atanh: 'artanh',
    s.airyai: 'airyai', s.airybi: 'airybi', s.airyaiprime: 'airyaiprime', s.airybiprime: 'airybiprime',
    s.gamma: 'gamma', s.polygamma: 'polygamma', s.beta: 'beta',
    s.besselj: 'besselj', s.bessely: 'bessely', s.besseli: 'besseli', s.besselk: 'besselk',
    s.Eq: 'equal', s.Ne: 'not-equal', s.Lt: 'less', s.Le: 'less-equal',
    s.Gt: 'greater', s.Ge: 'greater-equal', s.And: 'and', s.Or: 'or',
    s.Not: 'not', s.Implies: 'implies', s.Equivalent: 'equivalent',
    s.Union: 'union', s.Intersection: 'intersection', s.Complement: 'set-minus',
}
TRIG = {s.sin: 'sin', s.cos: 'cos', s.tan: 'tan',
        s.cot: 'cot', s.sec: 'sec', s.csc: 'csc'}
INVERSE_TRIG = {s.asin: 'arcsin', s.acos: 'arccos', s.atan: 'arctan'}


class Encoder:
    def __init__(self, decoder):
        self.decoder = decoder
        self.nodes = 0

    def made(self, value, depth):
        self.nodes += 1
        if self.nodes > 4096 or depth > 64:
            raise CasInputProblem('budget', 'The result exceeds the structured output budget')
        return value

    def number(self, value, depth):
        # Avoid building a huge decimal string before checking the exact integer.
        if abs(int(value)).bit_length() > 6804:
            raise CasInputProblem('budget', 'The result integer exceeds the digit budget')
        decimal = str(value)
        if len(decimal.lstrip('-')) > 2048:
            raise CasInputProblem('budget', 'The result integer exceeds the digit budget')
        return self.made({'kind': 'number', 'decimal': decimal}, depth)

    def operation(self, operation, operands, depth):
        if len(operands) > 256:
            raise CasInputProblem('budget', 'The result has too many operands')
        return self.made({'kind': 'operation', 'operation': operation, 'operands': operands}, depth)

    def node(self, value, depth=0):
        if depth > 64:
            raise CasInputProblem('budget', 'The result nesting exceeds the budget')
        if type(value) is tuple or isinstance(value, s.Tuple):
            if len(value) > 256:
                raise CasInputProblem('budget', 'The result list exceeds the budget')
            return self.operation('list', [self.node(item, depth+1) for item in value], depth)
        if isinstance(value, s.MatrixBase):
            if not value.rows or not value.cols or value.rows*value.cols > 4096:
                raise CasInputProblem('budget', 'The result matrix has invalid dimensions')
            rows = [self.operation('list', [self.node(value[row, col], depth+3)
                    for col in range(value.cols)], depth+2) for row in range(value.rows)]
            return self.operation('matrix', [self.operation('list', rows, depth+1)], depth)
        if not isinstance(value, s.Basic):
            raise CasInputProblem('unsupported', 'The result is not an allowed symbolic object')
        # Boolean atoms must be handled before integer comparisons (True != 1).
        constant = CONSTANTS.get(value)
        if constant is not None:
            return self.made({'kind': 'constant', 'name': constant}, depth)
        if value in (s.zoo, s.nan):
            raise CasInputProblem('domain', 'The result is undefined')
        if value is -s.oo:
            return self.operation('negate', [self.node(s.oo, depth+1)], depth)
        if value is s.EulerGamma:
            # Preserve the exact constant without introducing a rounded literal
            # or an engine-specific constant into the saved input grammar.
            return self.operation('negate', [self.operation('polygamma',
                [self.number(0, depth+2), self.number(1, depth+2)], depth+1)], depth)
        if value is s.Catalan:
            psi = self.operation('polygamma', [self.number(1, depth+3), self.node(s.Rational(1, 4), depth+3)], depth+2)
            difference = self.operation('subtract', [psi, self.node(s.pi**2, depth+2)], depth+1)
            return self.operation('divide', [difference, self.number(8, depth+1)], depth)
        if value.func in (RealZeta, RealZetaDerivative):
            order, argument = (s.S.Zero, value.args[0]) if value.func is RealZeta else value.args
            if not argument.free_symbols:
                zeta_point(order, argument, CasInputProblem)
            elif not isinstance(order, s.Integer) or not 0 <= order <= 17:
                raise CasInputProblem('budget', 'Generated zeta derivative exceeds its work bound')
            return (self.operation('zeta', [self.node(argument, depth+1)], depth) if order == 0
                    else self.operation('zetaderivative', [self.number(order, depth+1), self.node(argument, depth+1)], depth))
        if value.func is s.zeta and isinstance(value.args[0], s.Integer) and 2 <= value.args[0] <= 18:
            order = int(value.args[0])-1
            argument = value.args[1] if len(value.args) == 2 else s.S.One
            psi = self.operation('polygamma', [self.number(order, depth+2), self.node(argument, depth+2)], depth+1)
            factor = self.node(s.Rational((-1)**(order+1), s.factorial(order)), depth+1)
            return self.operation('multiply', [factor, psi], depth)
        if isinstance(value, s.Integer):
            return self.number(value, depth)
        if isinstance(value, s.Rational):
            return self.operation('divide', [self.number(value.p, depth+1),
                                            self.number(value.q, depth+1)], depth)
        if isinstance(value, s.Float):
            raise CasInputProblem('unsupported', 'An approximate result needs an explicit error contract')
        if isinstance(value, s.Symbol):
            reference = self.decoder.references.get(value)
            if reference is None or reference['role'] == 'bound':
                raise CasInputProblem('unsupported', 'A local or unknown symbol cannot escape its scope')
            return self.made({'kind': 'symbol', 'reference': dict(reference)}, depth)
        if isinstance(value, s.FiniteSet):
            return self.operation('set', [self.node(item, depth+1) for item in value.args], depth)
        if isinstance(value, s.ProductSet):
            if not 2 <= len(value.sets) <= 16:
                raise CasInputProblem('budget', 'The result product has invalid dimensions')
            return self.operation('cartesian-product', [self.node(item, depth+1) for item in value.sets], depth)
        if isinstance(value, s.Interval):
            ends = []
            for endpoint, opened in ((value.start, value.left_open), (value.end, value.right_open)):
                node = self.node(endpoint, depth+2 if opened else depth+1)
                ends.append(self.operation('open-endpoint', [node], depth+1) if opened else node)
            return self.operation('interval', ends, depth)
        elliptic = elliptic_signature(value)
        if elliptic is not None:
            operation, arguments = elliptic
            arguments = list(arguments)
            index = amplitude_index(operation)
            if index is not None and self.decoder.angle_unit == 'degree':
                arguments[index] *= 180/s.pi
            return self.operation(operation, [self.node(argument, depth+1) for argument in arguments], depth)
        if value.func in TRIG:
            argument = value.args[0]
            if self.decoder.angle_unit == 'degree':
                argument = argument*180/s.pi
            return self.operation(TRIG[value.func], [self.node(argument, depth+1)], depth)
        if value.func in INVERSE_TRIG:
            # SymPy returns radians; the application operation returns its stored unit.
            inner_depth = depth+1 if self.decoder.angle_unit == 'degree' else depth
            inner = self.operation(INVERSE_TRIG[value.func], [self.node(value.args[0], inner_depth+1)], inner_depth)
            if self.decoder.angle_unit == 'degree':
                return self.operation('multiply', [inner, self.node(s.pi/180, depth+1)], depth)
            return inner
        if value.func in (s.erf, s.erfc):
            # Transfer the original function; 1-rounded(erf) destroys a small tail.
            return self.operation('erf' if value.func is s.erf else 'erfc',
                                  [self.node(value.args[0], depth+1)], depth)
        if value.is_Add and value.has(s.erf):
            # Cancel complementary constants symbolically before finite-precision
            # evaluation, e.g. a normal upper tail (1-erf(x))/2 -> erfc(x)/2.
            rewritten = s.expand(value.rewrite(s.erfc))
            if not rewritten.has(s.erf):
                return self.node(rewritten, depth)
        if value.func is s.LambertW:
            branch = value.args[1] if len(value.args) == 2 else s.S.Zero
            branch_of(branch, CasInputProblem)
            return self.operation('lambertw', [self.node(branch, depth+1), self.node(value.args[0], depth+1)], depth)
        if value.func in FAMILIES and (not isinstance(value.args[0], s.Integer) or abs(value.args[0]) > 128):
            raise CasInputProblem('budget', 'The generated Bessel order exceeds the numerical input bound')
        operation = OPERATIONS.get(value.func)
        if operation is None:
            raise CasInputProblem('unsupported', 'An unevaluated or unsupported operation remains')
        if len(value.args) > 256:
            raise CasInputProblem('budget', 'The result has too many operands')
        return self.operation(operation, [self.node(item, depth+1) for item in value.args], depth)


class AntiderivativeEncoder(Encoder):
    """Permit only the indefinite integral's own variable, inside its returned lambda."""
    def __init__(self, decoder, variable):
        super().__init__(decoder)
        self.variable = variable

    def node(self, value, depth=0):
        if value == self.variable:
            return self.made({'kind': 'symbol', 'reference': dict(self.decoder.references[value])}, depth)
        return super().node(value, depth)


def encode_antiderivative(value, decoder, variable):
    """A whole-formula indefinite integral is the family F+C, never one value or a coordinate.

    Always return a one-variable lambda over the source's own binding, also when F is
    constant (integrate(0,t)). A condition on that variable (t != 0 for 1/t) only says
    where F applies; it is not an obligation of the whole answer and is not transferred.
    Other conditions and every other bound or unknown symbol keep the ordinary rules.
    """
    if not isinstance(value, s.Expr) or isinstance(value, s.MatrixBase) or value.free_symbols - {variable}:
        return {'status': 'unresolved', 'reason': 'unevaluated', 'coordinateAuthorized': False}
    encoder = AntiderivativeEncoder(decoder, variable)
    conditions = []
    for condition in decoder.domain_conditions:
        if condition is s.false:
            raise CasInputProblem('domain', 'The original input domain is false')
        if condition is not s.true and variable not in condition.free_symbols:
            conditions.append(encoder.node(condition))
    binding = {'variable': dict(decoder.references[variable]), 'domain': {'kind': 'unrestricted'}}
    body = encoder.node(value, 1)
    return {'status': 'value', 'kind': 'antiderivative',
            'expression': encoder.made({'kind': 'binder', 'operation': 'lambda', 'bindings': [binding], 'body': body}, 0),
            'domainConditions': conditions, 'coordinateAuthorized': False}


def encode_result(value, decoder):
    """Transfer an exact value and original domain obligations, without evaluating it."""
    encoder = Encoder(decoder)
    try:
        if decoder.antiderivative is not None:
            return encode_antiderivative(value, decoder, decoder.antiderivative)
        conditions = []
        for condition in decoder.domain_conditions:
            if condition is s.false:
                raise CasInputProblem('domain', 'The original input domain is false')
            if condition is not s.true:
                conditions.append(encoder.node(condition))
        expression = encoder.node(value)
        if isinstance(value, s.MatrixBase):
            kind = 'matrix'
        elif type(value) is tuple or isinstance(value, s.Tuple):
            # Nested array/tensor semantics have a separate dimension contract.
            if any(not isinstance(item, s.Expr) or isinstance(item, s.MatrixBase) for item in value):
                return {'status': 'invalid', 'reason': 'dimension', 'coordinateAuthorized': False}
            kind = 'vector'
        # Reals inherits Interval in SymPy, but its public node is a set constant.
        # Classify the transferred meaning, not just the engine's class hierarchy.
        elif value is s.S.Reals:
            kind = 'set'
        elif isinstance(value, s.Interval):
            kind = 'interval'
        elif isinstance(value, s.Set):
            kind = 'set'
        elif value is s.true or value is s.false or isinstance(value, (Relational, BooleanFunction)):
            kind = 'boolean'
        elif value in (s.oo, -s.oo) and decoder.infinite_bound:
            kind = 'infinite-bound'
        elif value.free_symbols:
            kind = 'symbolic'
        elif value.is_finite is False:
            return {'status': 'invalid', 'reason': 'non-finite', 'coordinateAuthorized': False}
        elif value.is_real is True or real_finite(value):
            kind = 'real'
        elif value.is_complex is True:
            kind = 'complex'
        else:
            return {'status': 'unresolved', 'reason': 'unevaluated', 'coordinateAuthorized': False}
        return {'status': 'value', 'kind': kind, 'expression': expression,
                'domainConditions': conditions, 'coordinateAuthorized': False}
    except CasInputProblem as error:
        if error.code == 'budget':
            return {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False}
        return {'status': 'unresolved' if error.code == 'unsupported' else 'invalid',
                'reason': 'unevaluated' if error.code == 'unsupported' else error.code,
                'coordinateAuthorized': False}
