"""Which fee a customer's Hyperliquid orders carry: the base, lowered by the better of two tiers, capped at the approval.

    hl_fee(u, base) = min( fee(u, base), approved_cap(u) )
    fee(u, base)    = 0 during a fee-free welcome period, else base x min(Points tier share, 30-day volume tier share)

The Points and volume tiers never stack (the lower fee wins), and the result never passes the maxBuilderFee the account
approved on Hyperliquid (fees/builder_fee.py approved_cap), so an order is never refused for its builder fee.

Source: radar/auto/points.py (the Points tiers and the season dates) and radar/auto/promo.py (fee, hl_fee and the fee
part of view) on the live server. Points earning, fee-free days bought with Points and their daily cap only ever lower
the fee and are not included here.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone

# name, Season points needed, share of the standard Rivemont fee (since 2026-10-08: 0.05% -> 0.048% -> 0.045% -> 0.04%,
# i.e. 50 / 48 / 45 / 40 tenths of a basis point on Hyperliquid); the volume tiers (fees/volume.py) are shares too and the
# lower of the two applies (best_share)
TIERS = (("Bronze", 0, 1.0), ("Silver", 1_000, 0.96), ("Gold", 10_000, 0.9), ("Platinum", 50_000, 0.8))


# ---- the season -------------------------------------------------------------------------------------------------
def _when(raw: str | None) -> int | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    try:
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())


def season_start() -> int | None:
    """POINTS_S1_START (unix seconds, YYYY-MM-DD or an ISO time, UTC); unset: the season has not started."""
    return _when(os.environ.get("POINTS_S1_START"))


def season_end() -> int | None:
    return _when(os.environ.get("POINTS_S1_END"))


def status(now: float | None = None) -> str:
    now, s, e = time.time() if now is None else now, season_start(), season_end()
    if s is None or now < s:
        return "soon"
    return "ended" if e and now >= e else "live"


def live(now: float | None = None) -> bool:
    return status(now) != "soon"


# ---- tiers and the fee ------------------------------------------------------------------------------------------
def tier_index(points: float) -> int:
    t = 0
    for i, (_, need, _) in enumerate(TIERS):
        if points >= need:
            t = i
    return t


def tier_of(u: dict | None) -> int:
    """The tier the fee uses: the job keeps it on the customer row (0 before the season or while frozen)."""
    if not u or not live():
        return 0
    try:
        return max(0, min(int(u.get("points_tier") or 0), len(TIERS) - 1))
    except (TypeError, ValueError):
        return 0


def best_share(u: dict | None) -> float:
    """The share of the base Rivemont fee this customer pays: the LOWER of their Points tier's share and their 30-day
    volume tier's share (fees/volume.py). The two never stack: a Gold holder (0.9) with $5M of volume (0.8) pays 0.8
    of the base, not 0.72."""
    from . import volume
    t = tier_of(u)
    return min(TIERS[t][2] if t else 1.0, volume.share(u))


def tier_fee(u: dict | None, amount: int) -> int:
    """A per-order fee (tenths of a basis point) at the customer's tier: the lower of the Points tier and the 30-day
    volume tier (best_share)."""
    sh = best_share(u)
    return amount if sh >= 1.0 or not amount else int(round(amount * sh))


# ---- the fee attached to orders ----------------------------------------------------------------------------------
def welcome(u: dict | None, now: float | None = None) -> bool:
    """A welcome offer's fee-free days run now (no daily cap: the campaign's own terms)."""
    now = time.time() if now is None else now
    return bool(u) and not u.get("promo_elsewhere") and (u.get("fee_free_until") or 0) > now


def fee(u: dict | None, tenths_bp: int, now: float | None = None) -> int:
    """The builder fee to attach to this customer's trading clients: 0 during a welcome offer, else the base lowered by
    the better of their 30-day volume tier and their Rivemont Points tier (best_share: the lower fee wins, the two never
    stack). On Hyperliquid use hl_fee, which also caps it at what the customer approved."""
    if welcome(u, now):
        return 0
    return tier_fee(u, tenths_bp)


def hl_fee(u: dict | None, tenths_bp: int, now: float | None = None) -> int:
    """The builder fee on this customer's Hyperliquid orders: fee() and never above the maxBuilderFee they approved
    (builder_fee.approved_cap). Accounts that approved the old 0.05% are charged at most 0.05% (since 2026-10-08 the base
    is 0.05%, so they pay the same as a 0.1% approval): Hyperliquid refuses an order whose builder fee is above the
    approval, so a bot would otherwise stop."""
    from . import builder_fee as hl
    f = fee(u, tenths_bp, now)
    cap = hl.approved_cap(u)
    return f if cap is None else min(f, cap)


def view(u: dict) -> dict:
    """The fee part of what the app shows the customer (the live server adds the welcome-offer fields)."""
    from signing.hl_actions import builder_address
    from . import builder_fee as hl, volume
    base = hl.builder_fee_tenths_bp()
    cap = hl.approved_cap(u)
    return {# Rivemont's fee by 30-day volume (fees/volume.py) and what this account pays on Hyperliquid now
            "volume_30d": round(float(u.get("vol_30d") or 0), 2), "volume_tier": volume.tier_of(u),
            "fee_pct": hl_fee(u, base) / 1000,
            # fee_reapprove: the approval is below the fee this account would pay (cap < fee). Since 2026-10-08 the base is
            # 0.05%, so an old 0.05% approval covers every tier and nothing is asked; only an approval below that does
            "builder_max_pct": None if cap is None else cap / 1000,
            "fee_reapprove": bool(builder_address()) and cap is not None and cap < fee(u, base)}
