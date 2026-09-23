"""Construct exact objects from MathNode data without parsing user program text.

Angle conventions, symbol identity, and binder scope belong to the saved input.
The fixed bundled runtime invokes this module; construction alone certifies no
coordinate. The application validates the returned type and original domain.
"""
import re
from cas_sequences import OPERATIONS as SEQUENCES, MAX_WORK, check_size, before_operation, sequence_operation
from cas_sequence_ranges import contains_sequence, finite_sequence_range
from cas_integer import ARITY as INTEGER_OPERATIONS, integer_operation
import sympy as s
from sympy.core.relational import Relational
from sympy.logic.boolalg import BooleanFunction
from cas_linear import LINEAR_OPERATIONS, linear_operation, component
from cas_sets import BOUNDS as SET_BOUNDS, OPERATIONS as SET_OPERATIONS, set_operation
from cas_limits import limit_value
from cas_integrals import integral_value
from cas_derivatives import decode_derivative
from cas_vector_calculus import OPERATIONS as VECTOR_AT, vector_at, smooth_operation, point_value
from cas_line_integrals import OPERATIONS as LINE_INTEGRALS, line_integral
from cas_region_integrals import OPERATIONS as REGION_INTEGRALS, region_integral
from cas_probability import OPERATIONS as PROBABILITY_OPERATIONS, probability_operation
from cas_gamma_functions import gamma_operation, beta_operation
from cas_bessel_functions import BESSEL, bessel_operation
from cas_lambert_functions import lambert_operation
from cas_airy_functions import AIRY, airy_operation
from cas_elliptic_functions import ARITY as ELLIPTIC, elliptic_operation
from cas_zeta_functions import zeta_operation
from cas_error_functions import error_point
from cas_fourier import OPERATIONS as FOURIER, fourier_operation


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
        self.sequence_depth = 0
        self.sequence_work = 0
        self.fourier_work = 0
        self.symbols = {}
        self.references = {}
        # Simplification may erase a denominator. Preserve its original domain
        # independently, including conditions containing locally bound variables.
        self.domain_conditions = []
        self.bound_domains = {}
        # Keep every original infinite binder even if an outer operation erases it.
        self.infinite_discrete = []
        self.smooth_point = None
        self.domain_observer = None
        self.gamma_domains = []
        self.beta_domains = []
        self.bessel_domains = []
        self.lambert_domains = []
        self.airy_arguments = []
        self.elliptic_domains = []
        self.zeta_domains = []
        self.error_arguments = []
        self.infinite_set_bound = False

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
        result = self._node(value, scope, depth)
        if self.sequence_depth:
            check_size(result, CasInputProblem)
        if self.smooth_point is not None and isinstance(result, s.Expr) and not isinstance(result, s.MatrixBase):
            point_value(result, self.smooth_point, CasInputProblem)
        if self.domain_observer is not None and isinstance(result, s.Expr) and not isinstance(result, s.MatrixBase):
            self.domain_observer(result)
        return result

    def _node(self, value, scope=None, depth=0):
        self.nodes += 1
        if self.sequence_depth:
            self.sequence_work += 1
            if self.sequence_work > MAX_WORK:
                raise CasInputProblem('budget', 'Sequence work exceeds the cumulative budget')
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
            if self.smooth_point is not None or self.domain_observer is not None:
                raise CasInputProblem('unevaluated', 'A nested calculation needs a separate field regularity proof')
            return self.binder(value, scope, depth)
        if kind != 'operation':
            raise CasInputProblem('unsupported', 'Unsupported MathNode kind')
        fields(value, ('kind', 'operation', 'operands'))
        operation, operands = value['operation'], value['operands']
        if type(operation) is not str or type(operands) is not list or len(operands) > 256:
            raise CasInputProblem('syntax', 'Invalid operation input')
        if operation == 'system-solution':
            from cas_equation_systems import system_solution
            return system_solution(self, operands, scope, depth)
        if operation == 'ode-value':
            from cas_ode import ode_value
            return ode_value(self, operands, scope, depth)
        if operation == 'partial-equations':
            raise CasInputProblem('unevaluated', 'A general PDE retains its original equations and conditions')
        if operation in ('solve-equation', 'polynomial-roots', 'solution-value'):
            from cas_equations import equation_operation
            return equation_operation(self, operation, operands, scope, depth)
        if operation in ('fourier-value', 'fourier-cosine', 'fourier-sine'):
            from cas_fourier_series import fourier_series_select
            return fourier_series_select(self, operation, operands, scope, depth)
        if operation == 'transform-value':
            from cas_transforms import transform_value
            return transform_value(self, operands, scope, depth)
        if operation == 'series-coefficient':
            if self.smooth_point is not None or self.domain_observer is not None:
                raise CasInputProblem('unevaluated', 'An inner expansion needs a separate regularity proof')
            from cas_taylor import series_coefficient
            return series_coefficient(self, operands, scope, depth)
        if (self.smooth_point is not None or self.domain_observer is not None) and operation in VECTOR_AT | LINE_INTEGRALS | REGION_INTEGRALS | PROBABILITY_OPERATIONS.keys() | SEQUENCES.keys() | {'limit', 'differentiate-at'}:
            raise CasInputProblem('unevaluated', 'A nested calculation needs a separate field regularity proof')
        if operation in SEQUENCES:
            return sequence_operation(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem)
        if operation in PROBABILITY_OPERATIONS:
            return probability_operation(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem)
        if operation in VECTOR_AT:
            return vector_at(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem)
        if operation in REGION_INTEGRALS:
            return region_integral(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem)
        if operation in LINE_INTEGRALS:
            return line_integral(self, operation, operands, scope, depth, fields, reference_key, CasInputProblem)
        if operation == 'limit':
            return self.limit_node(operands, scope, depth)
        if operation == 'differentiate-at':
            return self.derivative_node(operands, scope, depth)
        # Decode every child before evaluation so 0*invalid never hides invalid input.
        arguments = [self.node(child, scope, depth+1) for child in operands]
        if self.sequence_depth:
            before_operation(operation, arguments, CasInputProblem)
        result = self.operation(operation, arguments)
        if operation in SET_BOUNDS and result in (s.oo, -s.oo) and depth > 0:
            raise CasInputProblem('non-finite', 'An infinite bound is display-only, not a scalar operand')
        if self.domain_observer is not None and hasattr(self.domain_observer, 'operation'):
            self.domain_observer.operation(operation, arguments)
        if self.smooth_point is not None:
            smooth_operation(operation, arguments, self.smooth_point, self.angle_unit, CasInputProblem)
        return result

    def derivative_node(self, operands, scope, depth):
        return decode_derivative(self, operands, scope, depth, fields, reference_key, CasInputProblem)

    def operation(self, operation, args):
        count = len(args)
        if operation in SET_OPERATIONS:
            return set_operation(self, operation, args, CasInputProblem)
        if operation in FOURIER:
            return fourier_operation(self, operation, args, CasInputProblem)
        if operation in INTEGER_OPERATIONS:
            return integer_operation(self, operation, args, CasInputProblem)
        comparisons = {'equal': s.Eq, 'not-equal': s.Ne, 'less': s.Lt, 'less-equal': s.Le,
                       'greater': s.Gt, 'greater-equal': s.Ge}
        if operation in comparisons:
            if not 2 <= count <= 256 or any(not isinstance(value, s.Expr) for value in args):
                raise CasInputProblem('domain', 'A comparison needs scalar operands')
            pairs = ([(args[i], args[j]) for i in range(count) for j in range(i+1, count)]
                     if operation == 'not-equal' else zip(args, args[1:]))
            return s.And(*(comparisons[operation](a, b) for a, b in pairs))
        logic = {'and': s.And, 'or': s.Or, 'not': s.Not, 'implies': s.Implies, 'equivalent': s.Equivalent}
        if operation in logic:
            valid_count = count == 1 if operation == 'not' else count == 2 if operation == 'implies' else 2 <= count <= 256
            if not valid_count or any(value not in (s.true, s.false) and not isinstance(value, (Relational, BooleanFunction)) for value in args):
                raise CasInputProblem('domain', 'Logic requires propositions, not scalar truthiness')
            return logic[operation](*args)
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
        if operation in ('zeta', 'zetaderivative'):
            result = zeta_operation(self, operation, args, CasInputProblem)
        elif operation in ELLIPTIC:
            result = elliptic_operation(self, operation, args, CasInputProblem)
        elif operation in ('gamma', 'polygamma'):
            result = gamma_operation(self, operation, args, CasInputProblem)
        elif operation == 'beta':
            result = beta_operation(self, args, CasInputProblem)
        elif operation in BESSEL:
            result = bessel_operation(self, operation, args, CasInputProblem)
        elif operation in AIRY:
            result = airy_operation(self, operation, args, CasInputProblem)
        elif operation == 'lambertw':
            result = lambert_operation(self, args, CasInputProblem)
        elif operation in ('erf', 'erfc'):
            if count != 1 or args[0].is_finite is False or args[0].has(s.zoo, s.nan):
                raise CasInputProblem('domain', 'Error functions need one finite argument')
            if not args[0].free_symbols:
                error_point(args[0], CasInputProblem)
            self.error_arguments.append(args[0])
            # Keep erf(i*x) as the supported operation, not an unshipped erfi node.
            result = (s.erf if operation == 'erf' else s.erfc)(
                args[0], evaluate=args[0].is_real is True)
        elif operation == 'legendre':
            if count != 2 or not isinstance(args[0], s.Integer) or args[0] < 0:
                raise CasInputProblem('domain', 'Legendre degree must be a nonnegative integer')
            if args[0] > 128:
                raise CasInputProblem('budget', 'Legendre degree exceeds 128')
            if args[1].is_finite is False or args[1].has(s.nan, s.zoo):
                raise CasInputProblem('domain', 'Legendre needs a finite scalar argument')
            result = s.legendre(*args)
        elif operation in DIRECT:
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

    def limit_node(self, operands, outer_scope, depth):
        if len(operands) not in (2, 3):
            raise CasInputProblem('syntax', 'A limit requires a function, point and optional direction')
        function = operands[0]
        fields(function, ('kind', 'operation', 'bindings', 'body'))
        if (function['kind'] != 'binder' or function['operation'] != 'lambda'
                or type(function['bindings']) is not list or len(function['bindings']) != 1):
            raise CasInputProblem('syntax', 'A limit binds exactly one local variable')
        binding = function['bindings'][0]
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        if binding['domain']['kind'] != 'unrestricted':
            raise CasInputProblem('syntax', 'A limit function cannot carry an unrelated range')
        key = reference_key(binding['variable'])
        if key[0] != 'bound':
            raise CasInputProblem('syntax', 'A local limit variable is required')
        target = self.node(operands[1], outer_scope, depth+1)
        direction = self.node(operands[2], outer_scope, depth+1) if len(operands) == 3 else s.S.Zero
        if any(not isinstance(item, s.Expr) or isinstance(item, s.MatrixBase) for item in (target, direction)):
            raise CasInputProblem('domain', 'Scalar limit point and direction are required')
        variable = s.Dummy('pcad_limit_' + str(len(self.references)), real=True)
        self.references[variable] = dict(binding['variable'])
        scope = dict(outer_scope)
        scope[key] = variable
        condition_start = len(self.domain_conditions)
        body = self.node(function['body'], scope, depth+1)
        if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
            raise CasInputProblem('domain', 'A scalar function is required')
        conditions = self.domain_conditions[condition_start:]
        local = [condition for condition in conditions if variable in condition.free_symbols]
        self.domain_conditions[condition_start:] = [condition for condition in conditions if variable not in condition.free_symbols]
        return limit_value(body, variable, target, direction, local, CasInputProblem)

    def binder(self, value, outer_scope, depth):
        fields(value, ('kind', 'operation', 'bindings', 'body'))
        operation, bindings = value['operation'], value['bindings']
        if operation not in ('sum', 'product', 'integrate', 'differentiate'):
            raise CasInputProblem('unsupported', 'Unsupported binder')
        if type(bindings) is not list or not 1 <= len(bindings) <= 15:
            raise CasInputProblem('syntax', 'Invalid binder count')
        if operation in ('sum', 'product') and contains_sequence(value):
            return finite_sequence_range(self, value, outer_scope, depth, fields, reference_key, CasInputProblem)
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
                if step is not None and operation == 'integrate':
                    raise CasInputProblem('syntax', 'An integral cannot have a discrete step')
                if step is not None and (not isinstance(step, s.Expr)
                                         or step.is_integer is not True
                                         or step.is_positive is not True):
                    raise CasInputProblem('domain', 'A discrete step must be a positive integer')
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
            scope[key] = variable
            if operation in ('sum', 'product') and step is not None and step != 1:
                lower, upper = bounds
                if lower.is_finite is not True:
                    # An arithmetic progression needs a finite starting point.
                    # Do not silently choose a residue class at negative infinity.
                    raise CasInputProblem('unsupported', 'A non-unit step needs a finite starting point')
                if upper is -s.oo:
                    bounds = (s.S.Zero, -s.S.One)
                else:
                    bounds = (s.S.Zero, s.Max(-1, s.floor((upper-lower)/step)))
                # Translate at scope construction, so later bounds and nested
                # binders see the original index value rather than its ordinal.
                scope[key] = lower + step*variable
            self.bound_domains[variable] = {'operation': operation, 'bounds': bounds}
            local_keys.add(key)
            limits.append((variable, *bounds))
        condition_start = len(self.domain_conditions)
        body = self.node(value['body'], scope, depth+1)
        if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase):
            raise CasInputProblem('domain', 'A scalar binder body is required')
        if operation == 'differentiate':
            return s.Derivative(body, *(limit[0] for limit in reversed(limits)), evaluate=False)
        if operation == 'integrate':
            # Source bindings are outermost first. Prove every definite inner
            # integral before evaluating an outer range or ordinary operation.
            for limit in reversed(limits):
                variable = limit[0]
                if len(limit) == 1:
                    body = s.Integral(body, variable)
                    continue
                _, lower, upper = limit
                conditions = self.domain_conditions[condition_start:]
                local = [condition for condition in conditions if variable in condition.free_symbols]
                body = integral_value(body, variable, lower, upper, local, CasInputProblem)
                self.domain_conditions[condition_start:] = [condition for condition in conditions
                                                          if variable not in condition.free_symbols]
            return body
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
        result = constructor(body, *reversed(limits))
        if operation in ('sum', 'product') and any(
                bound in (s.oo, -s.oo) for limit in limits for bound in limit[1:]):
            self.infinite_discrete.append(result)
        return result
