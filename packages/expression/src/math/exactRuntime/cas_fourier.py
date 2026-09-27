"""Finite exact transforms; fixed negative forward sign and 1/N inverse scale.

SymPy's FFT uses the opposite sign. Reverse that convention explicitly without
requesting decimal approximations. Validate the length before its auto-padding.
"""
import sympy as s
from sympy.discrete.transforms import fft, ifft
from cas_sequences import check_size, scalar

OPERATIONS = frozenset(('dft', 'idft', 'fft', 'ifft'))
MAX_DFT = 64
MAX_FFT = 256
MAX_WORK = 16384


def fourier_operation(decoder, operation, arguments, problem):
    if len(arguments) != 1 or type(arguments[0]) is not tuple or not arguments[0]:
        raise problem('domain', 'A nonempty vector of finite scalars is required')
    values = arguments[0]
    count = len(values)
    fast = operation in ('fft', 'ifft')
    inverse = operation in ('idft', 'ifft')
    if count > (MAX_FFT if fast else MAX_DFT):
        raise problem('budget', 'Discrete transform length exceeds the exact calculation budget')
    if fast and count & (count - 1):
        raise problem('domain', 'FFT length must be a power of two; no zero padding is performed')
    for value in values:
        scalar(value, problem)
        if value.free_symbols:
            raise problem('unevaluated', 'Discrete transform entries must have established values')
    decoder.fourier_work += count * (count.bit_length() if fast else count)
    if decoder.fourier_work > MAX_WORK:
        raise problem('budget', 'Discrete transforms exceed the cumulative calculation budget')
    if fast:
        result = tuple(value / count for value in fft(values)) if inverse else tuple(value * count for value in ifft(values))
    else:
        sign = 1 if inverse else -1
        roots = tuple(s.cos(2*s.pi*j/count) + sign*s.I*s.sin(2*s.pi*j/count) for j in range(count))
        result = tuple(s.expand_mul(sum(value * roots[(j*k) % count] for j, value in enumerate(values)))
                       / (count if inverse else 1) for k in range(count))
    for value in result:
        check_size(value, problem)
    return result
