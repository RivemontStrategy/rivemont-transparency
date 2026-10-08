"""Rivemont's fee (since 2026-10-08): from 0.05% per fill (f=50 in Hyperliquid's tenths of a basis point), lower with
the customer's 30-day volume through Rivemont ($1M 0.045%, $5M 0.04%, $25M 0.035%); Points tiers Silver 0.048%, Gold
0.045%, Platinum 0.04%; the lower of the volume tier and the Points tier applies; never above what the customer approved
on Hyperliquid (an order above maxBuilderFee is refused there). New approvals stay a cap of 0.1%, and the old 0.05%
approvals cover every tier, so nobody is asked to approve again.

From the live repository's tests/test_fee_tiers.py. Tests there that need the whole server (the engine's trading
clients, the fill records behind the 30-day volume, the rendered pages) are left out; the engine's use of hl_fee is
shown in fees/attach_excerpt.py. The account rows are a small SQLite table with the same columns."""
from __future__ import annotations

import sqlite3
import threading
import time

import pytest

from fees import builder_fee as hl
from fees import tiers, volume
from signing import hl_actions

NOW = int(time.time())


@pytest.fixture
def season(monkeypatch):
    monkeypatch.setenv("POINTS_S1_START", str(NOW - 86400))     # the Points season is live: its tiers lower the fee


class Store:
    """The account rows the fee code reads and writes (id, address, builder approval, volume tier)."""

    def __init__(self):
        self.db, self.lock = sqlite3.connect(":memory:", check_same_thread=False), threading.Lock()
        self.db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, address TEXT, builder_ok INTEGER DEFAULT 0, "
                        "builder_max INTEGER, builder_max_ts INTEGER, vol_30d REAL, vol_tier INTEGER, vol_ts INTEGER)")

    def add(self, **kw) -> int:
        cols = ", ".join(kw)
        return self.db.execute(f"INSERT INTO users ({cols}) VALUES ({', '.join('?' * len(kw))})", tuple(kw.values())).lastrowid

    def get(self, uid: int) -> dict:
        cur = self.db.execute("SELECT * FROM users WHERE id=?", (uid,))
        return dict(zip([c[0] for c in cur.description], cur.fetchone()))


# ---- the tiers ------------------------------------------------------------------------------------------------------
def test_the_base_is_five_hundredths_of_a_percent_and_the_approval_ceiling_stays_one_tenth():
    assert hl.BASE_TENTHS_BP == 50 and hl.builder_fee_tenths_bp() == 50
    assert hl.MAX_PERPS_TENTHS_BP == 100 and hl.LEGACY_APPROVED_TENTHS_BP == 50
    assert hl_actions.MAX_FEE_RATE == "0.1%" and hl.rate_tenths(hl_actions.MAX_FEE_RATE) == 100
    a = hl_actions.build_action("approveBuilderFee", "0x66eee", now_ms=1)
    assert a["maxFeeRate"] == "0.1%"                       # new approvals still ask for 0.1%


def test_a_new_tier_zero_customer_pays_f50(season):
    base = hl.builder_fee_tenths_bp()
    u = {"builder_ok": 1, "builder_max": 100, "points_tier": 0, "vol_tier": 0, "vol_30d": 0}
    assert tiers.hl_fee(u, base) == 50
    assert tiers.hl_fee({"builder_ok": 1}, base) == 50      # an old 0.05% approval: the same 50
    assert tiers.hl_fee(None, base) == 50                   # signed out: the fee that will apply is shown


def test_the_base_never_passes_hyperliquids_perps_maximum(monkeypatch):
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "250")
    assert hl.builder_fee_tenths_bp() == 100
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "100")
    assert hl.builder_fee_tenths_bp() == 100               # the server may set another base, up to the maximum
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "40")
    assert hl.builder_fee_tenths_bp() == 40
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "-5")
    assert hl.builder_fee_tenths_bp() == 0
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "abc")
    assert hl.builder_fee_tenths_bp() == 50                # unreadable: the base


def test_rate_text_in_tenths_of_a_basis_point():
    assert [hl.rate_tenths(x) for x in ("0.1%", "0.05%", "0.045%", "0%", " 0.1 ", "abc", "-1%", "NaN", "")] == \
        [100, 50, 45, 0, 100, 0, 0, 0, 0]


@pytest.mark.parametrize("vol,tier,fee", [(0, 0, 50), (999_999.99, 0, 50), (1_000_000, 1, 45), (4_999_999.99, 1, 45),
                                          (5_000_000, 2, 40), (24_999_999.99, 2, 40), (25_000_000, 3, 35), (1e10, 3, 35)])
def test_volume_tier_boundaries(vol, tier, fee):
    assert volume.tier_index(vol) == tier
    u = {"builder_ok": 1, "builder_max": 100, "vol_tier": tier, "vol_30d": vol}
    assert tiers.hl_fee(u, hl.builder_fee_tenths_bp()) == fee


@pytest.mark.parametrize("pts,tier,fee", [(0, 0, 50), (999, 0, 50), (1_000, 1, 48), (9_999, 1, 48), (10_000, 2, 45),
                                          (49_999, 2, 45), (50_000, 3, 40), (10**9, 3, 40)])
def test_points_tier_boundaries(season, pts, tier, fee):
    assert tiers.tier_index(pts) == tier
    u = {"builder_ok": 1, "builder_max": 100, "points_tier": tier}
    assert tiers.hl_fee(u, hl.builder_fee_tenths_bp()) == fee


def test_the_table_the_site_shows():
    t = volume.table()
    assert [(x["from_usd"], f'{x["fee_pct"]:.3f}%') for x in t] == [
        (0, "0.050%"), (1_000_000, "0.045%"), (5_000_000, "0.040%"), (25_000_000, "0.035%")]
    assert [x["label"] for x in t] == [("Under {v}", "$1M"), ("{v} and up", "$1M"), ("{v} and up", "$5M"),
                                       ("{v} and up", "$25M")]
    assert [tiers.fee({"vol_tier": i}, 50) for i in range(4)] == [50, 45, 40, 35]
    assert [round(0.05 * sh, 4) for _n, _p, sh in tiers.TIERS] == [0.05, 0.048, 0.045, 0.04]


def test_a_tier_kept_under_the_old_table_never_lowers_the_fee_below_what_the_volume_reaches():
    # $600K kept as tier 1 under the 2026-10-06 table ($500K): today's table starts at $1M, so tier 0 until it is recomputed
    assert volume.tier_of({"vol_tier": 1, "vol_30d": 600_000}) == 0
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 100, "vol_tier": 1, "vol_30d": 600_000}, 50) == 50
    assert volume.tier_of({"vol_tier": 4, "vol_30d": 60_000_000}) == 3          # clamped to the last tier
    assert volume.tier_of({"vol_tier": 2}) == 2                                  # no stored volume: the stored tier


# ---- Points and volume: the lower fee wins, never both --------------------------------------------------------------------
@pytest.mark.parametrize("pts,vol,fee", [(0, 0, 50), (1, 0, 48), (0, 1, 45), (1, 1, 45), (2, 1, 45), (2, 0, 45),
                                         (3, 1, 40), (1, 2, 40), (3, 2, 40), (2, 3, 35), (3, 3, 35), (1, 3, 35)])
def test_points_and_volume_the_lower_wins(season, pts, vol, fee):
    u = {"points_tier": pts, "vol_tier": vol}
    assert tiers.tier_fee(u, 50) == fee
    assert tiers.fee(u, 50) == fee


def test_points_tiers_lower_nothing_before_the_season_but_volume_does():
    assert tiers.fee({"points_tier": 3, "vol_tier": 1}, 50) == 45
    assert tiers.fee({"points_tier": 3, "vol_tier": 0}, 50) == 50
    assert tiers.fee({"points_tier": 3, "vol_tier": 1, "fee_free_until": NOW + 60}, 50, now=NOW) == 0   # a welcome month


# ---- never above what the customer approved ----------------------------------------------------------------------------
def test_the_fee_attached_never_passes_the_approved_cap(season):
    base = hl.builder_fee_tenths_bp()
    new = {"builder_ok": 1, "builder_max": 100}
    old = {"builder_ok": 1}                                  # approved before the cap was stored: the old 0.05%
    assert hl.approved_cap(old) == 50 and hl.approved_cap(new) == 100 and hl.approved_cap({"builder_ok": 0}) is None
    assert tiers.hl_fee(new, base) == 50 and tiers.hl_fee(old, base) == 50     # a 0.1% approval simply pays less
    assert tiers.hl_fee({**old, "points_tier": 3}, base) == 40                # cap 0.05% + Platinum: 0.04%
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 50, "points_tier": 3}, base) == 40
    assert tiers.hl_fee({**old, "vol_tier": 3}, base) == 35
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 30}, base) == 30     # a 0.03% cap: never above it
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 30, "points_tier": 3}, base) == 30
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 0}, base) == 0    # revoked on Hyperliquid: no fee, orders still go
    assert tiers.hl_fee(None, base) == 50                    # signed out: the fee that will apply is shown
    # an old 0.05% approval covers every tier now: no re-approve prompt
    v = tiers.view({**old, "id": 1})
    assert not v["fee_reapprove"] and v["builder_max_pct"] == 0.05 and v["fee_pct"] == 0.05
    assert not tiers.view({**new, "id": 1})["fee_reapprove"]
    assert not tiers.view({**old, "vol_tier": 3, "id": 1})["fee_reapprove"]
    # only an approval below the fee due is still asked about (a 0.03% approval, hypothetical)
    v = tiers.view({"builder_ok": 1, "builder_max": 30, "id": 1})
    assert v["fee_reapprove"] and v["fee_pct"] == 0.03
    assert tiers.view({"builder_ok": 1, "builder_max": 30, "vol_tier": 3, "vol_30d": 3e7, "id": 1})["fee_reapprove"]  # 0.035% > 0.03%


def test_every_combination_stays_within_the_approval_and_hyperliquids_maximum(season, monkeypatch):
    for base in (0, 50, 100, 250):
        monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", str(base))
        b = hl.builder_fee_tenths_bp()
        for cap in (None, 0, 30, 50, 85, 100):
            for pts in range(4):
                for vol in range(4):
                    u = {"builder_ok": 1, "builder_max": cap, "points_tier": pts, "vol_tier": vol}
                    f = tiers.hl_fee(u, b)
                    assert 0 <= f <= hl.MAX_PERPS_TENTHS_BP
                    assert f <= (hl.LEGACY_APPROVED_TENTHS_BP if cap is None else cap)
                    assert f <= b


def test_approving_stores_the_signed_cap_and_the_engine_reads_it_back(monkeypatch):
    s = Store()
    uid = s.add(address="0x" + "01" * 20, builder_ok=1)
    monkeypatch.setattr(hl, "builder_fee_approved", lambda addr, client=None: 50)
    assert volume.refresh_caps(s, now=NOW, force=True) == 1
    assert s.get(uid)["builder_max"] == 50
    assert volume.refresh_caps(s, now=NOW + 120) == 0        # read again only once it is an hour old
    monkeypatch.setattr(hl, "builder_fee_approved", lambda addr, client=None: (_ for _ in ()).throw(RuntimeError("down")))
    volume.refresh_caps(s, now=NOW + 7200)
    assert s.get(uid)["builder_max"] == 50                   # Hyperliquid unreachable: the stored cap stays


def test_the_stored_volume_tier_is_what_the_fee_uses():
    s = Store()
    uid = s.add(address="0x" + "01" * 20, builder_ok=1, builder_max=100)
    volume.save(s, uid, 3_000_000, volume.tier_index(3_000_000), NOW)
    u = s.get(uid)
    assert (u["vol_30d"], u["vol_tier"], u["vol_ts"]) == (3_000_000, 1, NOW)
    assert tiers.hl_fee(u, hl.builder_fee_tenths_bp()) == 45     # $3M of 30-day volume: 0.045%
    for bad in ("x", None, -3, 99):
        assert volume.tier_of({"vol_tier": bad}) in (0, len(volume.TIERS) - 1)
