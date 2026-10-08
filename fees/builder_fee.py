"""The Rivemont builder fee on Hyperliquid: its base, and the cap at what each customer approved (maxBuilderFee).

Hyperliquid refuses an order whose builder fee is above the maxBuilderFee the account approved for that builder, and a
builder may never charge more than 0.1% on perps. Every fee Rivemont attaches goes through approved_cap() (see
fees/tiers.py hl_fee).

Source: radar/auto/hl.py on the live server (the fee part).
"""
from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation

from signing.hl_actions import _info, builder_address

MAX_PERPS_TENTHS_BP = 100       # Hyperliquid: a builder may charge at most 0.1% on perps
LEGACY_APPROVED_TENTHS_BP = 50  # what every approval before 2026-10-06 was for (0.05%), until maxBuilderFee is read


def builder_fee_tenths_bp() -> int:
    """The base Rivemont fee in tenths of a basis point: 100 = 0.1% of each fill, lowered by the customer's 30-day
    volume tier or Points tier (fees/volume.py, fees/tiers.py best_share) and never above what the customer approved
    (approved_cap). Never above Hyperliquid's perps maximum, whatever AUTO_BUILDER_FEE_TENTHS_BP says."""
    try:
        v = int(os.environ.get("AUTO_BUILDER_FEE_TENTHS_BP", 100))
    except ValueError:
        v = 100
    return max(0, min(v, MAX_PERPS_TENTHS_BP))


def rate_tenths(rate: str) -> int:
    """A maxFeeRate text ("0.1%") in tenths of a basis point (100); 0 for anything unreadable."""
    try:
        d = Decimal(str(rate).strip().rstrip("%")) * 1000
    except (InvalidOperation, ValueError):
        return 0
    return int(d) if d.is_finite() and d >= 0 else 0


def approved_cap(u: dict | None) -> int | None:
    """The most Rivemont's builder may charge this account (tenths of a bp), as Hyperliquid has it: the stored
    maxBuilderFee (read when the customer approves and refreshed by the engine), or the old 0.05% approval for an
    account that approved before it was stored. None: no approval yet (nothing is attached; pages show the base)."""
    if not u or not u.get("builder_ok"):
        return None
    m = u.get("builder_max")
    if m is None:
        return LEGACY_APPROVED_TENTHS_BP
    try:
        return max(0, int(m))
    except (TypeError, ValueError):
        return LEGACY_APPROVED_TENTHS_BP


def builder_fee_approved(user: str, client=None) -> int:
    """Max builder fee (tenths of a basis point) the user approved for our builder address."""
    if not builder_address():
        return 0
    return int(_info({"type": "maxBuilderFee", "user": user, "builder": builder_address()}, client) or 0)
