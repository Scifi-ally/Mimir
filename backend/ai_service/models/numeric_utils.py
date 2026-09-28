"""
NaN/Inf-safe numeric helpers.
─────────────────────────────────────────────────────────────────────────────
Python's `min`/`max` return their FIRST argument unless the second is strictly
smaller/larger, and every comparison against NaN is False. That makes the
idiomatic clamp silently wrong for non-finite input:

    min(100, nan)  ->  100      # NOT nan
    max(0, 100)    ->  100      # composite score becomes a PERFECT score
    min(0.3, nan)  ->  0.3      # trend bias becomes MAXIMUM bullish

So a single missing price, a null->NaN mapping, or a Postgres `double precision`
NaN turns corrupt data into the most bullish, highest-conviction, full-size
trade the system can produce — with no error, no null, and no fallback marker.
Every clamp in a scoring or sizing path must go through these helpers instead.
"""

from __future__ import annotations

import math
from typing import Optional

__all__ = [
    "is_finite_number",
    "sanitize_float",
    "finite_clamp",
    "safe_div",
    "finite_or_none",
]


def is_finite_number(value: object) -> bool:
    """True only for real, finite int/float values (bools are rejected)."""
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def sanitize_float(
    value: object,
    default: float = 0.0,
    low: Optional[float] = None,
    high: Optional[float] = None,
) -> float:
    """
    Coerce any input to a finite float, then clamp it.

    Non-numeric, NaN and +/-Inf all collapse to `default` (which is itself
    clamped). This is the only safe way to bound a value that came from an
    untrusted source.
    """
    result = default
    if is_finite_number(value):
        result = float(value)  # type: ignore[arg-type]
    if low is not None and result < low:
        result = low
    if high is not None and result > high:
        result = high
    return result


def finite_clamp(value: float, low: float, high: float, default: float = 0.0) -> float:
    """Clamp a float into [low, high], substituting `default` for non-finite input."""
    return sanitize_float(value, default=default, low=low, high=high)


def safe_div(
    numerator: float,
    denominator: float,
    default: float = 0.0,
    low: Optional[float] = None,
    high: Optional[float] = None,
) -> float:
    """
    Divide with full non-finite protection.

    Guards the three ways IEEE-754 breaks division: 0/0 -> NaN, x/0 -> +/-Inf,
    and Inf/Inf -> NaN. Without this, a single zero price propagates Infinity
    into stop distances and position sizes.
    """
    num = sanitize_float(numerator, default=0.0)
    den = sanitize_float(denominator, default=0.0)
    if den == 0.0:
        result = default
    else:
        try:
            result = num / den
        except (ZeroDivisionError, OverflowError):
            result = default
    if not math.isfinite(result):
        result = default
    if low is not None and result < low:
        result = low
    if high is not None and result > high:
        result = high
    return result


def finite_or_none(value: object) -> Optional[float]:
    """Return a finite float, or None. Useful for optional numeric fields."""
    return float(value) if is_finite_number(value) else None  # type: ignore[arg-type]
