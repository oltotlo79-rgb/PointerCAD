"""Construct exact objects from MathNode data without parsing user program text.

Angle conventions, symbol identity, and binder scope belong to the saved input.
The fixed bundled runtime invokes this module; construction alone certifies no
coordinate. The application validates the returned type and original domain.
"""
import re
import sympy as s
from cas_linear import LINEAR_OPERATIONS, linear_operation, component


class CasInputProblem(ValueError):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


DECIMAL = re.compile(r'([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?[0-9]+))?\Z')
CONSTANTS = {
    'pi': s.pi, 'e': s.E, 'imaginary-unit': s.I, 'infinity': s.oo,
    'true': s.true, 'false': s.false, 'real-numbers': s.S.Reals,
    'complex-numbers': s.S.Complexes, 'integers': s.S.Integers,
    'naturals': s.S.Naturals0, 'rationals': s.S.Rationals, 'empty-set': s.S.EmptySet,
}
DIRECT = {
    'add': (2, 256, s.Add), 'multiply': (2, 256, s.Mul),
    'subtract': (2, 2, lambda a, b: a-b), 'negate': (1, 1, lambda a: -a),
    'absolute': (1, 1, s.Abs), 'conjugate': (1, 1, s.conjugate),
    'real-part': (1, 1, s.re), 'imaginary-part': (1, 1, s.im),
    'exponential': (1, 1, s.exp), 'natural-log': (1, 1, s.log),
    'sinh': (1, 1, s.sinh), 'cosh': (1, 1, s.cosh), 'tanh': (1, 1, s.tanh),
    'arsinh': (1, 1, s.asinh), 'arcosh': (1, 1, s.acosh), 'artanh': (1, 1, s.atanh),
}
TRIG = {'sin': s.sin, 'cos': s.cos, 'tan': s.tan,
        'cot': s.cot, 'sec': s.sec, 'csc': s.csc}
INVERSE_TRIG = {'arcsin': s.asin, 'arccos': s.acos, 'arctan': s.atan}


def fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise CasInputProblem('syntax', 'Unexpected input shape')


def name(value):
    if (type(value) is not str or not value or len(value) > 16_384
            or any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise CasInputProblem('syntax', 'Invalid symbol identity')
    return value


def reference_key(reference):
    if type(reference) is not dict:
        raise CasInputProblem('syntax', 'Invalid symbol reference')
    role = reference.get('role')
    if role in ('axis', 'parameter'):
        fields(reference, ('role', 'name'))
        allowed = ('X', 'Y', 'Z') if role == 'axis' else ('T', 'U', 'V')
        if reference['name'] not in allowed:
            raise CasInputProblem('syntax', 'Invalid axis or parameter')
        return role, reference['name']
    if role in ('coefficient', 'bound', 'declared'):
        fields(reference, ('role', 'id', 'label'))
        name(reference['label'])
        return role, name(reference['id'])
    raise CasInputProblem('syntax', 'Unknown symbol role')


class Decoder:
    """One conversion owns all symbols; labels never become executable source."""
    def __init__(self, angle_unit):
        if angle_unit not in ('degree', 'radian'):
            raise CasInputProblem('syntax', 'An explicit angle unit is required')
        self.angle_unit = angle_unit
        self.nodes = 0
        self.symbols = {}
        self.references = {}
        # Simplification may erase a denominator. Preserve its original domain
        # independently, including conditions containing locally bound variables.
        self.domain_conditions = []
        self.bound_domains = {}

    def nonzero(self, value):
        if value.is_zero is True:
            raise CasInputProblem('domain', 'The original expression requires a nonzero value')
        if value.is_zero is not False:
            self.domain_conditions.append(s.Ne(value, 0, evaluate=False))

    def decimal(self, source):
        if type(source) is not str or len(source) > 16_384:
            raise CasInputProblem('syntax', 'Invalid decimal source')
        match = DECIMAL.fullmatch(source)
        if match is None:
            raise CasInputProblem('syntax', 'Only a decimal literal is accepted')
        sign, whole, fraction, fraction_only, exponent_text = match.groups()
        fraction = fraction_only if fraction_only is not None else fraction or ''
        digits = (whole or '') + fraction
        if len(digits) > 2048 or len((exponent_text or '').lstrip('+-')) > 6:
            raise CasInputProblem('budget', 'Decimal input exceeds the digit budget')
        exponent = int(exponent_text or '0')
        if abs(exponent) > 10_000:
            raise CasInputProblem('budget', 'Decimal exponent exceeds the budget')
        numerator = int(digits) * (-1 if sign == '-' else 1)
        exponent -= len(fraction)
        return (s.Integer(numerator) * s.Integer(10)**exponent if exponent >= 0
                else s.Rational(numerator, 10**(-exponent)))

    def node(self, value, scope=None, depth=0):
        self.nodes += 1
        if self.nodes > 4096 or depth > 64:
            raise CasInputProblem('budget', 'MathNode structure exceeds the budget')
        if type(value) is not dict:
            raise CasInputProblem('syntax', 'A structured MathNode is required')
        scope = {} if scope is None else scope
        kind = value.get('kind')
        if kind == 'number':
            fields(value, ('kind', 'decimal'))
            return self.decimal(value['decimal'])
        if kind == 'constant':
            fields(value, ('kind', 'name'))
            if type(value['name']) is not str or value['name'] not in CONSTANTS:
                raise CasInputProblem('unsupported', 'Unknown constant')
            return CONSTANTS[value['name']]
        if kind == 'symbol':
            fields(value, ('kind', 'reference'))
            key = reference_key(value['reference'])
            if key[0] == 'bound':
                if key not in scope:
                    raise CasInputProblem('syntax', 'Unbound local variable')
                return scope[key]
            if key not in self.symbols:
                # No assumptions about free declared variables or coefficients.
                # Axis and parameter values are real under the current CAD contract.
                assumptions = {'real': True} if key[0] in ('axis', 'parameter') else {}
                symbol = s.Dummy('pcad_input_' + str(len(self.symbols)), **assumptions)
                self.symbols[key] = symbol
                self.references[symbol] = dict(value['reference'])
            return self.symbols[key]
        if kind == 'binder':
            return self.binder(value, scope, depth)
        if kind != 'operation':
            raise CasInputProblem('unsupported', 'Unsupported MathNode kind')
        fields(value, ('kind', 'operation', 'operands'))
        operation, operands = value['operation'], value['operands']
        if type(operation) is not str or type(operands) is not list or len(operands) > 256:
            raise CasInputProblem('syntax', 'Invalid operation input')
        # Decode every child before evaluation so 0*invalid never hides invalid input.
        arguments = [self.node(child, scope, depth+1) for child in operands]
        return self.operation(operation, arguments)

    def operation(self, operation, args):
        count = len(args)
        if operation in LINEAR_OPERATIONS:
            return linear_operation(operation, args, lambda rows: self.operation('matrix', [rows]), CasInputProblem)
        if operation == 'component':
            return component(args, CasInputProblem)
        if operation == 'list':
            return tuple(args)
        if operation == 'matrix':
            if count != 1 or type(args[0]) is not tuple or not args[0]:
                raise CasInputProblem('syntax', 'A matrix requires explicit rows')
            rows = args[0]
            if any(type(row) is not tuple or not row for row in rows):
                raise CasInputProblem('syntax', 'A matrix row is invalid')
            columns = len(rows[0])
            if any(len(row) != columns for row in rows):
                raise CasInputProblem('domain', 'Matrix rows have different lengths')
            if len(rows)*columns > 4096:
                raise CasInputProblem('budget', 'Matrix entry budget exceeded')
            if any(not isinstance(item, s.Expr) for row in rows for item in row):
                raise CasInputProblem('domain', 'Matrix entries must be scalar expressions')
            return s.ImmutableMatrix(rows)
        if operation in ('determinant', 'transpose', 'conjugate-transpose', 'trace', 'rank', 'inverse-matrix'):
            if count != 1:
                raise CasInputProblem('domain', 'A matrix is required')
            # Text input stores explicit rows as nested lists; structured input
            # may carry the matrix wrapper. Both must follow the same checks.
            matrix = self.operation('matrix', [args[0]]) if type(args[0]) is tuple else args[0]
            if not isinstance(matrix, s.MatrixBase):
                raise CasInputProblem('domain', 'A matrix is required')
            if operation in ('determinant', 'trace', 'inverse-matrix') and matrix.rows != matrix.cols:
                raise CasInputProblem('domain', 'A square matrix is required')
            if max(matrix.rows, matrix.cols) > 16:
                raise CasInputProblem('budget', 'Candidate matrix calculation limit exceeded')
            if operation in ('rank', 'inverse-matrix') and matrix.free_symbols:
                raise CasInputProblem('unsupported', 'Rank or inverse requires resolved conditions')
            if operation == 'inverse-matrix' and matrix.det().is_zero is True:
                raise CasInputProblem('domain', 'A singular matrix has no inverse')
            dispatch = {'determinant': lambda: matrix.det(), 'transpose': lambda: matrix.T,
                        'conjugate-transpose': lambda: matrix.H, 'trace': lambda: matrix.trace(),
                        # Matrix.rank returns a Python int; keep the same exact
                        # scalar type as every other operation, also when nested.
                        'rank': lambda: s.Integer(matrix.rank()), 'inverse-matrix': lambda: matrix.inv()}
            return dispatch[operation]()
        if any(not isinstance(arg, s.Expr) or isinstance(arg, s.MatrixBase) for arg in args):
            raise CasInputProblem('domain', 'Scalar operands are required')
        if operation in DIRECT:
            minimum, maximum, function = DIRECT[operation]
            if not minimum <= count <= maximum:
                raise CasInputProblem('syntax', 'Invalid operand count')
            if operation == 'natural-log':
                self.nonzero(args[0])
            result = function(*args)
        elif operation in TRIG or operation in INVERSE_TRIG:
            if count != 1:
                raise CasInputProblem('syntax', 'One angle operand is required')
            scale = s.pi/180 if self.angle_unit == 'degree' else s.Integer(1)
            if operation in ('tan', 'sec'):
                self.nonzero(s.cos(args[0]*scale))
            elif operation in ('cot', 'csc'):
                self.nonzero(s.sin(args[0]*scale))
            result = (TRIG[operation](args[0]*scale) if operation in TRIG
                      else INVERSE_TRIG[operation](args[0])/scale)
        elif operation in ('divide', 'power', 'complex'):
            if count != 2:
                raise CasInputProblem('syntax', 'Two operands are required')
            a, b = args
            if operation == 'divide':
                self.nonzero(b)
                result = a/b
            elif operation == 'power':
                if b.is_positive is not True:
                    self.nonzero(a)
                result = a**b
            else:
                if a.is_real is not True or b.is_real is not True:
                    raise CasInputProblem('unsupported', 'Complex components require established real values')
                result = a + s.I*b
        elif operation in ('sqrt', 'square'):
            if count != 1:
                raise CasInputProblem('syntax', 'One operand is required')
            result = s.sqrt(args[0]) if operation == 'sqrt' else args[0]**2
        else:
            raise CasInputProblem('unsupported', 'Operation is not in the candidate adapter')
        if result.has(s.zoo, s.nan):
            raise CasInputProblem('domain', 'Operation produced an undefined value')
        return result

    def binder(self, value, outer_scope, depth):
        fields(value, ('kind', 'operation', 'bindings', 'body'))
        operation, bindings = value['operation'], value['bindings']
        if operation not in ('sum', 'product', 'integrate', 'differentiate'):
            raise CasInputProblem('unsupported', 'Unsupported binder')
        if type(bindings) is not list or not 1 <= len(bindings) <= 15:
            raise CasInputProblem('syntax', 'Invalid binder count')
        scope, limits = dict(outer_scope), []
        local_keys = set()
        for binding in bindings:
            fields(binding, ('variable', 'domain'))
            key = reference_key(binding['variable'])
            if key[0] != 'bound' or key in local_keys:
                raise CasInputProblem('syntax', 'Invalid or duplicate bound identity')
            domain = binding['domain']
            if type(domain) is not dict:
                raise CasInputProblem('syntax', 'Invalid binding domain')
            # Resolve bounds BEFORE adding this variable, preserving the source contract.
            if domain.get('kind') == 'range' and operation != 'differentiate':
                fields(domain, ('kind', 'lower', 'upper', 'step'))
                lower = self.node(domain['lower'], scope, depth+1)
                upper = self.node(domain['upper'], scope, depth+1)
                step = None if domain['step'] is None else self.node(domain['step'], scope, depth+1)
                if step is not None and (operation == 'integrate' or step != 1):
                    raise CasInputProblem('unsupported', 'Non-unit or integral steps need explicit semantics')
                if not isinstance(lower, s.Expr) or not isinstance(upper, s.Expr):
                    raise CasInputProblem('domain', 'Scalar bounds are required')
                for bound in (lower, upper):
                    if bound.is_extended_real is False:
                        raise CasInputProblem('domain', 'Real binding bounds are required')
                    if bound.is_extended_real is not True:
                        raise CasInputProblem('unsupported', 'Real binding bounds need established assumptions')
                    if operation in ('sum', 'product') and bound not in (s.oo, -s.oo) and bound.is_integer is not True:
                        raise CasInputProblem('domain', 'Discrete binding bounds must be integers')
                bounds = (lower, upper)
            elif domain.get('kind') == 'unrestricted' and operation in ('integrate', 'differentiate'):
                fields(domain, ('kind',))
                bounds = ()
            else:
                raise CasInputProblem('unsupported', 'Binding domain is not supported')
            assumptions = {'integer': True} if operation in ('sum', 'product') else {'real': True}
            variable = s.Dummy('pcad_bound_' + str(len(self.references)), **assumptions)
            self.references[variable] = dict(binding['variable'])
            self.bound_domains[variable] = {'operation': operation, 'bounds': bounds}
            scope[key] = variable
            local_keys.add(key)
            limits.append((variable, *bounds))
        body = self.node(value['body'], scope, depth+1)
        if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
            raise CasInputProblem('domain', 'A scalar binder body is required')
        if operation == 'differentiate':
            return s.Derivative(body, *(limit[0] for limit in reversed(limits)), evaluate=False)
        constructor = {'sum': s.Sum, 'product': s.Product, 'integrate': s.Integral}[operation]
        # SymPy extends reversed discrete ranges using Karr's convention. The
        # application's ranges enumerate an empty set instead: sum=0, product=1.
        # Clamp to the adjacent empty range, including limits depending on an
        # outer index. Do not reverse integration limits; their sign is meaningful.
        if operation in ('sum', 'product'):
            limits = [(variable, 0, -1) if lower is s.oo or upper is -s.oo
                      else (variable, lower, s.Max(lower-1, upper))
                      for variable, lower, upper in limits]
        # Earlier source bindings are outer scopes; SymPy's first limit is innermost.
        return constructor(body, *reversed(limits))
