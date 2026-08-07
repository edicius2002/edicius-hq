"""
Just enough protobuf to read one message.

Yahoo's streaming endpoint answers in base64-encoded protobuf. Pulling in a
protobuf runtime and a generated schema for a single message shape would be a
dependency, a build step and a `.proto` file to keep in sync with an endpoint
that is undocumented and can change without notice — for something the wire
format itself makes readable in fifty lines.

So this reads fields by number and type and hands back a plain dict. It does not
know what a Ticker is; that belongs with the adapter that asked. Unknown fields
are skipped rather than rejected, because an upstream that adds one should not
take the price with it.

The wire format: https://protobuf.dev/programming-guides/encoding/
"""

import base64
import struct

# Wire types, from the spec.
_VARINT = 0
_FIXED64 = 1
_LENGTH = 2
_FIXED32 = 5

# A varint is at most ten bytes. Anything longer is a corrupt frame rather than
# a large number, and reading on would walk off into the rest of the message.
_MAX_VARINT_BYTES = 10


class WireError(ValueError):
    """The bytes are not a protobuf message we can read."""


def _read_varint(data: bytes, index: int) -> tuple[int, int]:
    value = 0
    shift = 0
    start = index
    while True:
        if index >= len(data):
            raise WireError("varint runs past the end of the message")
        if index - start >= _MAX_VARINT_BYTES:
            raise WireError("varint is too long to be a number")
        byte = data[index]
        index += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, index
        shift += 7


def read_message(data: bytes) -> dict[int, object]:
    """
    Field number to value, for the fields this understands.

    A repeated field keeps its last value: none of what we read is repeated, and
    guessing at a list for something that turns out not to be one would be a
    worse answer than the last one wins.
    """
    fields: dict[int, object] = {}
    index = 0

    while index < len(data):
        key, index = _read_varint(data, index)
        number, kind = key >> 3, key & 0x07

        if number == 0:
            raise WireError("field number 0 is not valid")

        if kind == _VARINT:
            fields[number], index = _read_varint(data, index)
        elif kind == _FIXED32:
            if index + 4 > len(data):
                raise WireError("fixed32 runs past the end of the message")
            # Every fixed32 we care about is a float; an integer one would be
            # read wrongly here, and the adapter is where that would show up.
            fields[number] = struct.unpack_from("<f", data, index)[0]
            index += 4
        elif kind == _FIXED64:
            if index + 8 > len(data):
                raise WireError("fixed64 runs past the end of the message")
            fields[number] = struct.unpack_from("<d", data, index)[0]
            index += 8
        elif kind == _LENGTH:
            length, index = _read_varint(data, index)
            if index + length > len(data):
                raise WireError("length-delimited field runs past the end")
            # Kept as bytes: whether it is text or a nested message is the
            # caller's question, not this one's.
            fields[number] = data[index : index + length]
            index += length
        else:
            # Groups, deprecated since 2010. Nothing here sends them, and
            # skipping one correctly means tracking nesting depth for a case
            # that would already mean we are reading the wrong endpoint.
            raise WireError(f"unsupported wire type {kind}")

    return fields


def read_base64_message(payload: str) -> dict[int, object]:
    """The form Yahoo sends: a JSON string holding a base64 protobuf."""
    try:
        raw = base64.b64decode(payload, validate=True)
    except (ValueError, TypeError) as error:
        raise WireError("payload is not valid base64") from error
    return read_message(raw)


def as_text(value: object) -> str | None:
    """A length-delimited field read as UTF-8, or None if it is not text."""
    if not isinstance(value, bytes):
        return None
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return None


def zigzag(value: object) -> int | None:
    """
    Undoes the encoding protobuf uses for signed integers.

    A `sint64` is stored with its sign in the low bit so that small negatives
    stay small on the wire. Read as a plain varint it comes out doubled — which
    is why an un-decoded Yahoo timestamp lands in the year 2083 rather than in
    the last minute.
    """
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return (value >> 1) ^ -(value & 1)


def as_float(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None
