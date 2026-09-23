"""Finite entire error functions and their original numerical work bounds."""
import sympy as s

ENTIRE = (s.erf, s.erfc, s.erfi, s.exp, s.sin, s.cos, s.sinh, s.cosh)


def complex_finite(value):
    if not isinstance(value, s.Expr) or value.has(s.oo, -s.oo, s.zoo, s.nan):
        return False
    if value.is_finite is True:
        return True
    if value.func in ENTIRE or value.func in (s.re, s.im) or value.is_Add or value.is_Mul:
        return all(complex_finite(argument) for argument in value.args)
    if value.is_Pow and value.exp.is_Integer:
        return complex_finite(value.base) and (value.exp >= 0 or value.base.is_zero is False)
    return False


def error_point(argument, problem):
    if not complex_finite(argument):
        raise problem('unevaluated', 'A finite error-function argument has not been established')
    real, imaginary = argument.as_real_imag()
    bound = 500000 if imaginary.is_zero is True else 8
    for component in (real, imaginary):
        if (component < -bound) is s.true or (component > bound) is s.true:
            raise problem('budget', 'Error-function argument exceeds its numerical work bound')
        if (component >= -bound) is not s.true or (component <= bound) is not s.true:
            raise problem('unevaluated', 'The error-function numerical bound has not been established')


def error_analytic_at(value, variable, target):
    if value == variable:
        return True
    if not value.has(variable):
        return complex_finite(value)
    if value.func in ENTIRE or value.func in (s.re, s.im) or value.is_Add or value.is_Mul:
        return all(error_analytic_at(argument, variable, target) for argument in value.args)
    if value.is_Pow and value.exp.is_Integer:
        return (error_analytic_at(value.base, variable, target)
                and (value.exp >= 0 or value.base.subs(variable, target).is_zero is False))
    return False
