"""Prove original scalar operands on their declared support before simplification."""
import sympy as s
from sympy.calculus.util import continuous_domain


class ProbabilityDomain:
    def __init__(self, supports, problem):
        self.supports, self.problem, self.cache = supports, problem, set()

    def unknown(self):
        raise self.problem('unevaluated', 'The original expression is not proved real and defined on the declared support')

    def __call__(self, value):
        if value in self.cache:
            return
        if len(self.cache) > 4096:
            raise self.problem('budget', 'The probability domain proof exceeds its budget')
        if value.has(s.zoo, s.nan, s.oo, -s.oo) or value.free_symbols - self.supports.keys():
            self.unknown()
        if value.is_real is not True:
            variables = value.free_symbols
            if len(variables) != 1:
                self.unknown()
            variable = next(iter(variables))
            support = self.supports[variable]
            try:
                domain = continuous_domain(value, variable, s.S.Reals)
            except (NotImplementedError, ValueError):
                self.unknown()
            if support.is_subset(domain) is not True:
                self.unknown()
        self.cache.add(value)

    def conditions(self, conditions):
        for condition in conditions:
            if condition is s.true:
                continue
            if condition is s.false:
                raise self.problem('domain', 'The original probability expression is undefined')
            if not isinstance(condition, s.Unequality):
                self.unknown()
            value = condition.lhs-condition.rhs
            if value.is_zero is False:
                continue
            variables = value.free_symbols
            if len(variables) != 1:
                self.unknown()
            variable = next(iter(variables))
            zeros = s.solveset(value, variable, domain=self.supports[variable])
            if zeros != s.S.EmptySet:
                self.unknown()
