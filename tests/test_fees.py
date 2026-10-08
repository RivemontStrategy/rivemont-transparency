"""Rivemont's fee: from 0.1% per fill, lower with the customer's 30-day volume; the lower of the volume tier and the
Points tier applies; never above what the customer approved on Hyperliquid (an order above maxBuilderFee is refused
there, so existing 0.05% approvals keep working).

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
def test_the_base_is_one_tenth_of_a_percent_and_the_approval_ceiling_too():
    assert hl.builder_fee_tenths_bp() == 100
    assert hl_actions.MAX_FEE_RATE == "0.1%" and hl.rate_tenths(hl_actions.MAX_FEE_RATE) == 100
    a = hl_actions.build_action("approveBuilderFee", "0x66eee", now_ms=1)
    assert a["maxFeeRate"] == "0.1%"                       # new approvals ask for 0.1%


def test_the_base_never_passes_hyperliquids_perps_maximum(monkeypatch):
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "250")
    assert hl.builder_fee_tenths_bp() == 100
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "50")
    assert hl.builder_fee_tenths_bp() == 50                # the server may still set a lower base
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "-5")
    assert hl.builder_fee_tenths_bp() == 0
    monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", "abc")
    assert hl.builder_fee_tenths_bp() == 100


def test_rate_text_in_tenths_of_a_basis_point():
    assert [hl.rate_tenths(x) for x in ("0.1%", "0.05%", "0.085%", "0%", " 0.1 ", "abc", "-1%", "NaN", "")] == \
        [100, 50, 85, 0, 100, 0, 0, 0, 0]


@pytest.mark.parametrize("vol,tier", [(0, 0), (499_999.99, 0), (500_000, 1), (2_499_999, 1), (2_500_000, 2),
                                      (9_999_999, 2), (10_000_000, 3), (49_999_999, 3), (50_000_000, 4), (1e10, 4)])
def test_tier_boundaries(vol, tier):
    assert volume.tier_index(vol) == tier


def test_the_table_the_site_shows():
    t = volume.table()
    assert [(x["from_usd"], f'{x["fee_pct"]:.3f}%') for x in t] == [
        (0, "0.100%"), (500_000, "0.085%"), (2_500_000, "0.070%"), (10_000_000, "0.055%"), (50_000_000, "0.040%")]
    assert [x["label"] for x in t] == [("Under {v}", "$500K"), ("{v} and up", "$500K"), ("{v} and up", "$2.5M"),
                                       ("{v} and up", "$10M"), ("{v} and up", "$50M")]
    assert [tiers.fee({"vol_tier": i}, 100) for i in range(5)] == [100, 85, 70, 55, 40]


# ---- Points and volume: the lower fee wins, never both --------------------------------------------------------------------
@pytest.mark.parametrize("pts,vol,fee", [(0, 0, 100), (1, 0, 90), (0, 1, 85), (2, 1, 80), (1, 2, 70), (3, 2, 70),
                                         (3, 3, 55), (3, 4, 40), (2, 4, 40)])
def test_points_and_volume_the_lower_wins(season, pts, vol, fee):
    u = {"points_tier": pts, "vol_tier": vol}
    assert tiers.tier_fee(u, 100) == fee
    assert tiers.fee(u, 100) == fee


def test_points_tiers_lower_nothing_before_the_season_but_volume_does():
    assert tiers.fee({"points_tier": 3, "vol_tier": 1}, 100) == 85
    assert tiers.fee({"points_tier": 3, "vol_tier": 1, "fee_free_until": NOW + 60}, 100, now=NOW) == 0   # a welcome month


# ---- never above what the customer approved ----------------------------------------------------------------------------
def test_the_fee_attached_never_passes_the_approved_cap(season):
    new = {"builder_ok": 1, "builder_max": 100}
    old = {"builder_ok": 1}                                  # approved before the cap was stored: the old 0.05%
    assert hl.approved_cap(old) == 50 and hl.approved_cap(new) == 100 and hl.approved_cap({"builder_ok": 0}) is None
    assert tiers.hl_fee(new, 100) == 100 and tiers.hl_fee(old, 100) == 50
    assert tiers.hl_fee({**old, "vol_tier": 4}, 100) == 40          # a tier below the old cap: the tier
    assert tiers.hl_fee({**old, "vol_tier": 1}, 100) == 50          # 0.085% > the 0.05% approved: capped
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 30}, 100) == 30
    assert tiers.hl_fee({"builder_ok": 1, "builder_max": 0}, 100) == 0      # revoked on Hyperliquid: no fee, orders still go
    assert tiers.hl_fee(None, 100) == 100                    # signed out: the fee that will apply is shown
    v = tiers.view({**old, "id": 1})
    assert v["fee_reapprove"] and v["builder_max_pct"] == 0.05 and v["fee_pct"] == 0.05
    assert not tiers.view({**new, "id": 1})["fee_reapprove"]
    assert not tiers.view({**old, "vol_tier": 4, "id": 1})["fee_reapprove"]    # 0.04% fits the old cap: nothing to ask


def test_every_combination_stays_within_the_approval_and_hyperliquids_maximum(season, monkeypatch):
    for base in (0, 50, 100, 250):
        monkeypatch.setenv("AUTO_BUILDER_FEE_TENTHS_BP", str(base))
        b = hl.builder_fee_tenths_bp()
        for cap in (None, 0, 30, 50, 85, 100):
            for pts in range(4):
                for vol in range(5):
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
    assert (u["vol_30d"], u["vol_tier"], u["vol_ts"]) == (3_000_000, 2, NOW)
    assert tiers.hl_fee(u, hl.builder_fee_tenths_bp()) == 70     # $3M of 30-day volume: 0.07%
    for bad in ("x", None, -3, 99):
        assert volume.tier_of({"vol_tier": bad}) in (0, len(volume.TIERS) - 1)
