"""Rivemont's fee by 30-day volume.

The Rivemont fee starts at the base rate (fees/builder_fee.py builder_fee_tenths_bp, 0.1% of each fill: Hyperliquid's
builder-fee maximum for perps) and drops with the customer's trading volume through Rivemont over the last 30 days
(rolling): every fill of all of the account's bots and orders placed through Rivemont, from Rivemont's own records.

    30-day volume      Rivemont fee   share of the base
    under $500K        0.100%         1.00
    $500K and up       0.085%         0.85
    $2.5M and up       0.070%         0.70
    $10M and up        0.055%         0.55
    $50M and up        0.040%         0.40

The tiers are shares of the base, so the table stays true if the base is changed on the server. Points tiers
(fees/tiers.py) are shares too; the LOWER of the two applies, never both multiplied (tiers.tier_fee). On Hyperliquid
the result is then capped at what the customer approved (tiers.hl_fee, builder_fee.approved_cap): an order above the
approved maxBuilderFee would be refused by Hyperliquid.

The engine recomputes each connected account's volume and tier every few minutes and keeps them on the account row
(vol_30d, vol_tier, vol_ts); save() below is how they are stored. (Summing the 30-day volume reads Rivemont's internal
fill records and is not part of this repository.)

Source: radar/auto/volume.py on the live server.
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("radar.auto.volume")

WINDOW_S = 30 * 86400              # the rolling window the volume is summed over
# (30-day volume in USD from which the tier applies, share of the base fee)
TIERS = ((0, 1.0), (500_000, 0.85), (2_500_000, 0.70), (10_000_000, 0.55), (50_000_000, 0.40))


def tier_index(volume_usd: float) -> int:
    t = 0
    for i, (need, _) in enumerate(TIERS):
        if (volume_usd or 0) >= need:
            t = i
    return t


def tier_of(u: dict | None) -> int:
    """The volume tier the fee uses, as the engine last kept it on the account row."""
    if not u:
        return 0
    try:
        return max(0, min(int(u.get("vol_tier") or 0), len(TIERS) - 1))
    except (TypeError, ValueError):
        return 0


def share(u: dict | None) -> float:
    return TIERS[tier_of(u)][1]


def _usd(v: int) -> str:
    return f"${v / 1_000_000:g}M" if v >= 1_000_000 else f"${v / 1_000:g}K"


def table(base_pct: float | None = None) -> list[dict]:
    """The public tier table: [{from_usd, label, fee_pct, share}] (labels in English; the page translates them)."""
    if base_pct is None:
        from . import builder_fee
        base_pct = builder_fee.builder_fee_tenths_bp() / 1000
    out = []
    for i, (need, sh) in enumerate(TIERS):
        label = ("Under {v}", _usd(TIERS[1][0])) if i == 0 else ("{v} and up", _usd(need))
        out.append({"from_usd": need, "label": label, "fee_pct": round(base_pct * sh, 4), "share": sh})
    return out


def save(store, uid: int, vol: float, tier: int, now: float | None = None):
    """Keep the volume and tier on the account row (straight SQL: not an account change, so `updated` stays)."""
    with store.lock:
        store.db.execute("UPDATE users SET vol_30d=?, vol_tier=?, vol_ts=? WHERE id=?",
                         (vol, int(tier), int(now or time.time()), uid))
        store.db.commit()


# ---- the approved Hyperliquid cap (maxBuilderFee), kept on the account row -------------------------------------------
CAPS_EVERY_S = 3600                 # each account's approval read again at most hourly (it changes only when they sign)
_caps_last = {"t": 0.0}


def save_cap(store, uid: int, tenths_bp: int, now: float | None = None):
    with store.lock:
        store.db.execute("UPDATE users SET builder_max=?, builder_max_ts=? WHERE id=?",
                         (int(tenths_bp), int(now or time.time()), uid))
        store.db.commit()


def refresh_caps(store, client=None, now: float | None = None, force: bool = False, every_s: int = CAPS_EVERY_S) -> int:
    """Read each Hyperliquid-connected account's maxBuilderFee for Rivemont's builder (builder_fee.builder_fee_approved) when its
    stored value is older than every_s, so the fee attached never passes what Hyperliquid will accept. A failed read
    keeps the stored value (or the old-approval assumption)."""
    from signing.hl_actions import builder_address
    from . import builder_fee as hl
    now = time.time() if now is None else now
    if not builder_address() or (not force and now - _caps_last["t"] < 60):
        return 0
    _caps_last["t"] = now
    n = 0
    rows = store.db.execute("SELECT id, address, builder_max_ts FROM users WHERE builder_ok=1 AND address IS NOT NULL").fetchall()
    for uid, addr, ts in rows:
        if not force and ts and now - ts < every_s:
            continue
        try:
            save_cap(store, uid, hl.builder_fee_approved(addr, client), now)
            n += 1
        except Exception as e:             # noqa: BLE001 - Hyperliquid unreachable: keep what is stored
            log.warning("builder cap: u%s not read: %s", uid, e)
    return n
