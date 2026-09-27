"""Closed integral transforms with explicit conventions and sufficient domains.

Forward Fourier uses exp(-2*pi*i*x*k); the inverse uses the positive sign.
Laplace and Z are unilateral. Inverse Laplace reports the positive-time part,
not a guessed value at a jump or an unrepresented distribution.
"""
import sympy as s
from sympy.integrals.transforms import IntegralTransform
from cas_input import CasInputProblem, fields, reference_key
from cas_result import Encoder
from cas_integrals import continuous_real_axis, finite_holes, integral_value
from cas_sequences import check_size, sequence_budget

OPERATIONS = frozenset(('fourier-transform', 'inverse-fourier-transform',
                        'laplace-transform', 'inverse-laplace-transform', 'z-transform'))


def convention(operation):
    if operation in ('fourier-transform', 'inverse-fourier-transform'):
        return 'fourier-cycles'
    return 'z-unilateral' if operation == 'z-transform' else 'laplace-unilateral'


def original_domain(body, variable, conditions, operation):
    """Keep original denominator restrictions before accepting a transform table result."""
    if operation == 'inverse-laplace-transform':
        # A Bromwich line may avoid finitely many rational poles. Do not erase
        # an unknown branch restriction while selecting an unspecified line.
        for condition in conditions:
            if condition is s.true:
                continue
            if not isinstance(condition, s.Unequality) or not (condition.lhs-condition.rhs).is_polynomial(variable):
                raise CasInputProblem('unevaluated', 'The inverse transform contour conditions remain unresolved')
        return
    if operation == 'z-transform':
        for condition in conditions:
            if condition is s.true:
                continue
            if not isinstance(condition, s.Unequality):
                raise CasInputProblem('unevaluated', 'An original sequence condition remains unresolved')
            zeros = s.solveset(condition.lhs-condition.rhs, variable, domain=s.S.Naturals0)
            if zeros is not s.S.EmptySet:
                raise CasInputProblem('domain' if isinstance(zeros, s.FiniteSet) else 'unevaluated',
                                      'The original sequence must be defined at every nonnegative index')
        return
    interval = s.Interval(0, s.oo) if operation == 'laplace-transform' else s.S.Reals
    available = continuous_real_axis(body, variable)
    points = finite_holes(interval, available, CasInputProblem)
    for condition in conditions:
        if condition is s.true:
            continue
        if not isinstance(condition, s.Unequality):
            raise CasInputProblem('unevaluated', 'An original transform domain remains unresolved')
        zeros = s.solveset(condition.lhs-condition.rhs, variable, domain=interval)
        if zeros is not s.S.EmptySet:
            if not isinstance(zeros, s.FiniteSet):
                raise CasInputProblem('unevaluated', 'Original singularities are not isolated')
            points.extend(zeros)
    if len(points) > 64:
        raise CasInputProblem('budget', 'There are too many original singularities')
    for point in set(points):
        if point.is_real is not True or point.is_finite is not True:
            raise CasInputProblem('unevaluated', 'An original singularity has not been located')
        left = s.Max(0, point-1) if operation == 'laplace-transform' else point-1
        # Ordinary improper integrability at a hole is needed; a principal value
        # cannot justify cancelling opposite divergences across the point.
        integral_value(s.Abs(body), variable, left, point+1, conditions, CasInputProblem)


def compute_transform(source, decoder, scope=None, depth=0):
    fields(source, ('kind', 'operation', 'operands'))
    operation, operands = source['operation'], source['operands']
    if source['kind'] != 'operation' or operation not in OPERATIONS or type(operands) is not list or len(operands) != 1:
        raise CasInputProblem('syntax', 'A transform needs one explicitly bound function')
    function = operands[0]
    fields(function, ('kind', 'operation', 'bindings', 'body'))
    if (function['kind'] != 'binder' or function['operation'] != 'lambda'
            or type(function['bindings']) is not list or len(function['bindings']) != 2):
        raise CasInputProblem('syntax', 'Declare the input and output variables of the transform')
    keys = []
    for binding in function['bindings']:
        fields(binding, ('variable', 'domain'))
        fields(binding['domain'], ('kind',))
        key = reference_key(binding['variable'])
        if key[0] != 'bound' or binding['domain']['kind'] != 'unrestricted':
            raise CasInputProblem('syntax', 'The transform variable must be locally bound')
        keys.append(key)
    if keys[0] == keys[1] or function['bindings'][0]['variable']['label'] == function['bindings'][1]['variable']['label']:
        raise CasInputProblem('syntax', 'Transform variables must be distinct')
    decoder.transform_work = getattr(decoder, 'transform_work', 0) + 1
    if decoder.transform_work > 8:
        raise CasInputProblem('budget', 'Too many transforms in one calculation')
    variable = (s.Dummy('pcad_transform_input', integer=True, nonnegative=True) if operation == 'z-transform'
                else s.Dummy('pcad_transform_input', complex=True) if operation == 'inverse-laplace-transform'
                else s.Dummy('pcad_transform_input', real=True))
    output = (s.Dummy('pcad_transform_output', positive=True) if operation == 'inverse-laplace-transform'
              else s.Dummy('pcad_transform_output', complex=True) if operation in ('laplace-transform', 'z-transform')
              else s.Dummy('pcad_transform_output', real=True))
    decoder.references[variable] = dict(function['bindings'][0]['variable'])
    decoder.references[output] = dict(function['bindings'][1]['variable'])
    nested = dict(scope or {})
    nested.update(zip(keys, (variable, output)))
    condition_start = len(decoder.domain_conditions)
    body = decoder.node(function['body'], nested, depth+1)
    if not isinstance(body, s.Expr) or isinstance(body, s.MatrixBase) or body.free_symbols - {variable}:
        raise CasInputProblem('unevaluated', 'Resolve all parameters and keep the output variable out of the original function')
    conditions = decoder.domain_conditions[condition_start:]
    original_domain(body, variable, conditions, operation)
    condition = s.true
    if operation == 'fourier-transform':
        result = s.fourier_transform(body, variable, output, noconds=False)
    elif operation == 'inverse-fourier-transform':
        result = s.inverse_fourier_transform(body, variable, output, noconds=False)
    elif operation == 'laplace-transform':
        result, plane, auxiliary = s.laplace_transform(body, variable, output, noconds=False)
        if plane is s.oo or auxiliary is s.false:
            raise CasInputProblem('divergent', 'The Laplace transform has no established convergence half-plane')
        condition = s.And(s.re(output) > plane, auxiliary)
    elif operation == 'inverse-laplace-transform':
        result = s.inverse_laplace_transform(body, variable, output)
        # The output Dummy's positivity must also survive as a visible condition.
        condition = s.StrictGreaterThan(output, 0, evaluate=False)
        if not result.has(IntegralTransform, s.DiracDelta, s.Heaviside):
            restored, _, auxiliary = s.laplace_transform(result, output, variable, noconds=False)
            if auxiliary is not s.true or s.simplify(restored-body) != 0:
                raise CasInputProblem('unevaluated', 'The inverse Laplace result did not establish the forward identity')
    else:
        result = s.summation(body*output**(-variable), (variable, 0, s.oo))
        condition = s.Ne(output, 0)
        if isinstance(result, s.Piecewise):
            branches = [(formula, domain) for formula, domain in result.args if not formula.has(s.Sum)]
            if len(branches) != 1:
                raise CasInputProblem('unevaluated', 'A single exact Z-transform convergence region was not established')
            result, region = branches[0]
            condition = s.And(condition, region)
    if type(result) is tuple:
        result, auxiliary = result
        condition = s.And(condition, auxiliary)
    if (not isinstance(result, s.Expr) or result.has(IntegralTransform, s.Sum, s.Integral, s.DiracDelta, s.Heaviside,
                                                  s.oo, -s.oo, s.zoo, s.nan, s.AccumBounds)
            or result.free_symbols - {output}):
        raise CasInputProblem('unevaluated', 'The transform remains unresolved or is a distribution')
    if condition is s.false:
        raise CasInputProblem('divergent', 'The transform has no established convergence region')
    check_size(result, CasInputProblem)
    check_size(condition, CasInputProblem)
    del decoder.domain_conditions[condition_start:]
    return operation, function['bindings'][1], output, result, condition


class TransformEncoder(Encoder):
    """Permit only the result variable inside its explicitly returned lambda."""
    def __init__(self, decoder, variable, binding):
        super().__init__(decoder)
        self.variable, self.binding = variable, binding

    def node(self, value, depth=0):
        if value == self.variable:
            return self.made({'kind': 'symbol', 'reference': dict(self.binding['variable'])}, depth)
        return super().node(value, depth)


def transform_result(source, decoder):
    try:
        with sequence_budget(decoder):
            operation, binding, variable, formula, condition = compute_transform(source, decoder)
        encoder = TransformEncoder(decoder, variable, binding)
        def bound(value):
            return {'kind': 'binder', 'operation': 'lambda', 'bindings': [binding], 'body': encoder.node(value)}
        return {'status': 'value', 'kind': 'transform', 'transform': {
                    'operation': operation, 'convention': convention(operation),
                    'formula': bound(formula), 'condition': bound(condition)},
                'domainConditions': [], 'coordinateAuthorized': False}
    except NotImplementedError:
        raise CasInputProblem('unevaluated', 'The transform domain or exact formula remains unresolved') from None
    except CasInputProblem as error:
        if error.code == 'unsupported':
            raise CasInputProblem('unevaluated', 'The exact transform result has no supported representation') from None
        raise


def transform_value(decoder, operands, scope, depth):
    if len(operands) != 2:
        raise CasInputProblem('syntax', 'Select a transform and a value in its established domain')
    with sequence_budget(decoder):
        _, _, variable, formula, condition = compute_transform(operands[0], decoder, scope, depth+1)
        point = decoder.node(operands[1], scope, depth+1)
        if not isinstance(point, s.Expr) or point.free_symbols or point.is_finite is not True:
            raise CasInputProblem('domain', 'The transform argument must be a resolved finite scalar')
        # Fourier output variables are real; Laplace and Z variables may be complex.
        operation = operands[0]['operation']
        if operation not in ('laplace-transform', 'z-transform') and point.is_real is not True:
            raise CasInputProblem('domain', 'The Fourier or inverse-time argument must be real')
        truth = s.simplify(condition.subs(variable, point))
        if truth is s.false:
            raise CasInputProblem('domain', 'The requested value is outside the established convergence region')
        if truth is not s.true:
            raise CasInputProblem('unevaluated', 'The transform convergence condition could not be proved at this value')
        result = s.simplify(formula.subs(variable, point))
        if result.is_finite is not True:
            raise CasInputProblem('unevaluated', 'The transform did not establish a finite value')
        check_size(result, CasInputProblem)
        return result
