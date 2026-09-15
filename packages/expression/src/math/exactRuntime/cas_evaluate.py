"""JSON is data; only fixed application code invokes the optional exact runtime."""
import json
import sympy as s
from cas_input import Decoder, CasInputProblem, fields
from cas_result import encode_result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CasInputProblem('syntax', 'Duplicate input member')
        result[key] = value
    return result


def invalid_constant(value):
    raise CasInputProblem('syntax', 'Non-JSON number is forbidden')


def evaluate_structure(value):
    if isinstance(value, (s.Basic, s.MatrixBase)):
        return value.doit(deep=True)
    if type(value) is not tuple:
        raise CasInputProblem('unsupported', 'Unsupported calculation value')
    # The application parser represents both vectors and matrices as nested lists.
    # Preserve that contract without flattening ragged or higher-rank data.
    if any(type(item) is tuple for item in value):
        if (not value or any(type(row) is not tuple or not row for row in value)
                or any(len(row) != len(value[0]) for row in value)
                or any(not isinstance(item, s.Expr) or isinstance(item, s.MatrixBase)
                       for row in value for item in row)):
            raise CasInputProblem('dimension', 'A rectangular scalar matrix is required')
        return s.ImmutableMatrix([[item.doit(deep=True) for item in row] for row in value])
    return tuple(evaluate_structure(item) for item in value)


def calculate_exact_json(payload):
    try:
        if type(payload) is not str:
            raise CasInputProblem('syntax', 'A JSON data string is required')
        if len(payload) > 1_048_576:
            raise CasInputProblem('budget', 'Input exceeds the transport budget')
        raw = json.loads(payload, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        fields(raw, ('expression', 'angleUnit'))
        decoder = Decoder(raw['angleUnit'])
        expression = decoder.node(raw['expression'])
        # Decoder has already checked all operands and recorded domain obligations.
        # Unknown/inexact/unevaluated results still pass through the closed encoder.
        expression = evaluate_structure(expression)
        result = encode_result(expression, decoder)
    except CasInputProblem as error:
        result = ({'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False}
                  if error.code == 'budget' else {'status': 'invalid', 'reason': error.code, 'coordinateAuthorized': False})
    except (RecursionError, MemoryError):
        result = {'status': 'stopped', 'reason': 'budget', 'coordinateAuthorized': False}
    except (ValueError, TypeError, KeyError, OverflowError, ZeroDivisionError):
        result = {'status': 'invalid', 'reason': 'syntax', 'coordinateAuthorized': False}
    encoded = json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
    if len(encoded) > 1_048_576:
        return '{"status":"stopped","reason":"budget","coordinateAuthorized":false}'
    return encoded
