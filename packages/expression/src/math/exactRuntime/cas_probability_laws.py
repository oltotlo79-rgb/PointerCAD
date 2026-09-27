"""Closed declarations of marginal and finite joint probability measures."""
from dataclasses import dataclass
from itertools import product
import sympy as s
import sympy.stats as st


@dataclass(frozen=True)
class Marginal:
    rv: object
    support: object
    finite: object = None
    gaussian: bool = False


def real(value, problem):
    if (not isinstance(value, s.Expr) or value.free_symbols
            or value.is_real is not True or value.is_finite is not True):
        raise problem('domain', 'Distribution parameters and outcomes must be finite real constants')
    return value


def require(condition, problem, detail):
    if condition is not s.true and condition is not True:
        raise problem('domain', detail)


def table(outcomes, weights, dimension, problem):
    if (type(outcomes) is not tuple or type(weights) is not tuple
            or not 1 <= len(outcomes) <= 256 or len(outcomes) != len(weights)):
        raise problem('dimension', 'A probability table needs matching nonempty rows and weights')
    rows = []
    for outcome, weight in zip(outcomes, weights):
        if type(outcome) is not tuple or len(outcome) != dimension:
            raise problem('dimension', 'Joint outcomes must match the declared variables')
        for value in outcome:
            real(value, problem)
        real(weight, problem)
        require(s.And(weight >= 0, weight <= 1), problem, 'Probability weights must be in [0,1]')
        rows.append((outcome, weight))
    require(s.Eq(sum(weights), 1), problem, 'Probability weights must sum exactly to one')
    return rows


def scalar_law(operation, args, name, problem):
    counts = {'normal-distribution': 2, 'uniform-distribution': 2, 'exponential-distribution': 1,
              'gamma-distribution': 2, 'beta-distribution': 2, 'chisquare-distribution': 1,
              't-distribution': 1, 'f-distribution': 2, 'binomial-distribution': 2,
              'poisson-distribution': 1, 'finite-distribution': 2}
    if operation not in counts or len(args) != counts[operation]:
        raise problem('domain', 'An explicit scalar distribution is required')
    if operation == 'finite-distribution':
        values, weights = args
        if type(values) is not tuple:
            raise problem('dimension', 'Finite outcomes must be a list')
        rows = table(tuple((value,) for value in values), weights, 1, problem)
        density = {}
        for (value,), weight in rows:
            density[value] = density.get(value, 0) + weight
        return Marginal(st.FiniteRV(name, density), s.FiniteSet(*values), rows)
    for arg in args:
        real(arg, problem)
    a = args[0]
    b = args[1] if len(args) == 2 else None
    positive = lambda value: require(value > 0, problem, 'This distribution parameter must be positive')
    if operation == 'normal-distribution':
        positive(b)
        return Marginal(st.Normal(name, a, b), s.S.Reals, gaussian=True)
    if operation == 'uniform-distribution':
        require(a < b, problem, 'Uniform bounds must be increasing')
        return Marginal(st.Uniform(name, a, b), s.Interval(a, b))
    if operation == 'binomial-distribution':
        require(a.is_integer is True and a >= 0, problem, 'Trial count must be a nonnegative integer')
        require(s.And(b >= 0, b <= 1), problem, 'The success probability must be in [0,1]')
        if a > 10000:
            raise problem('budget', 'The binomial trial count exceeds the calculation budget')
        if a == 0 or b == 0 or b == 1:
            return scalar_law('finite-distribution', ((a if b == 1 else s.S.Zero,), (s.S.One,)), name, problem)
        rows = [((s.Integer(k),), s.binomial(a, k)*b**k*(1-b)**(a-k)) for k in range(int(a)+1)] if a <= 128 else None
        return Marginal(st.Binomial(name, a, b), s.Range(0, a+1), rows)
    if operation == 'poisson-distribution':
        require(a >= 0, problem, 'The Poisson mean must be nonnegative')
        if a == 0:
            return scalar_law('finite-distribution', ((s.S.Zero,), (s.S.One,)), name, problem)
        return Marginal(st.Poisson(name, a), s.S.Naturals0)
    positive(a)
    if b is not None:
        positive(b)
    if operation == 'f-distribution':
        # F(d1,d2) = (d2/d1) BetaPrime(d1/2,d2/2), also for noninteger positive degrees.
        return Marginal(st.BetaPrime(name, a/2, b/2) * b/a, s.Interval.open(0, s.oo))
    constructors = {'exponential-distribution': st.Exponential, 'gamma-distribution': st.Gamma,
                    'beta-distribution': st.Beta, 'chisquare-distribution': st.ChiSquared,
                    't-distribution': st.StudentT}
    support = (s.S.Reals if operation == 't-distribution' else s.Interval.open(0, 1)
               if operation == 'beta-distribution' else s.Interval.open(0, s.oo))
    return Marginal(constructors[operation](name, *args), support)


def declared_law(decoder, raw, dimension, scope, depth, fields, problem):
    fields(raw, ('kind', 'operation', 'operands'))
    if raw['kind'] != 'operation' or type(raw['operands']) is not list:
        raise problem('syntax', 'An explicit distribution declaration is required')
    operation, operands = raw['operation'], raw['operands']
    if operation == 'joint-finite-distribution':
        if len(operands) != 2:
            raise problem('syntax', 'A joint probability table needs outcomes and weights')
        args = [decoder.node(child, scope, depth+1) for child in operands]
        return [], table(*args, dimension, problem)
    if operation == 'independent-distributions':
        if (len(operands) != 1 or type(operands[0]) is not dict or operands[0].get('kind') != 'operation'
                or operands[0].get('operation') != 'list'):
            raise problem('syntax', 'Independent distributions need an ordered list')
        fields(operands[0], ('kind', 'operation', 'operands'))
        declarations = operands[0]['operands']
        if type(declarations) is not list or len(declarations) != dimension:
            raise problem('dimension', 'The distribution count must match the local variables')
    else:
        if dimension != 1:
            raise problem('dimension', 'Multiple variables need an explicit joint or independent law')
        declarations = [raw]
    laws = []
    for index, declaration in enumerate(declarations):
        fields(declaration, ('kind', 'operation', 'operands'))
        if declaration['kind'] != 'operation' or type(declaration['operands']) is not list:
            raise problem('syntax', 'Invalid marginal distribution')
        args = [decoder.node(child, scope, depth+1) for child in declaration['operands']]
        laws.append(scalar_law(declaration['operation'], args, s.Dummy('pcad_random_' + str(index)), problem))
    rows = None
    if all(law.finite is not None for law in laws):
        size = 1
        for law in laws:
            size *= len(law.finite)
        if size > 4096:
            raise problem('budget', 'The joint finite sample space exceeds the enumeration budget')
        rows = [(tuple(item[0][0] for item in entry), s.prod(item[1] for item in entry))
                for entry in product(*(law.finite for law in laws))]
    return laws, rows
