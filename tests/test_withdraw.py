"""Withdrawals go only to the customer's own wallet, sign exactly the cents typed, and never more than the exchange lets
leave. USDC moves between Hyperliquid market groups stay inside the same account.

From the live repository's tests/test_auto.py (own wallet only), tests/test_hl_amounts.py (audit money-01: cents, the
$1 fee choice) and tests/test_money_model.py (the balance guard). Tests there that drive the HTTP endpoints against a
fake exchange are left out; the endpoints are in withdraw/routes_excerpt.py."""
import json
import random
import shutil
import subprocess
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from signing import hl_actions
from withdraw import balance_guard as money
from withdraw import hl_withdraw as hl

OWN = "0x" + "ab" * 20
USDC = "USDC:0xeb62eee3685fc4c43992febcd9e75443"
# typed amounts the old float floor lowered by a cent (and some the check then refused; 1.15 too, a move below)
LOWERED = [8.04, 10.04, 1024.11, 1024.1, 512.06, 2.3, 4.35, 100.06, 250.31, 2048.36, 5000.61, 9999.99]


def text(n: int) -> str:
    """n cents as the action carries them: "8.04", "25.5", "12"."""
    return f"{n // 100}.{n % 100:02d}".rstrip("0").rstrip(".")


# ---- only to the connected wallet (tests/test_auto.py) ----------------------------------------------------------------
def test_withdraw_only_goes_back_to_the_connected_wallet():
    acct = Account.create()
    a = hl.build_withdraw("0xa4b1", acct.address, 25.5)
    assert a["destination"] == acct.address.lower() and a["amount"] == "25.5"
    hl.check_withdraw(a, acct.address.lower())
    sig = Account.sign_message(encode_typed_data(full_message=hl_actions.typed_data(a)), acct.key).signature.hex()
    assert hl_actions.recover(a, "0x" + sig.removeprefix("0x")) == acct.address.lower()
    with pytest.raises(hl_actions.SignError):
        hl.check_withdraw({**a, "destination": "0x" + "9" * 40}, acct.address.lower())      # to someone else
    with pytest.raises(hl_actions.SignError):
        hl.build_withdraw("0xa4b1", acct.address, 1.5)                                       # below the $1 fee + $1


def test_every_field_of_a_signed_withdrawal_is_checked():
    a = hl.build_withdraw("0xa4b1", OWN, 50, now_ms=1)
    hl.check_withdraw(a, OWN, now_ms=1)
    for bad in ({"destination": "0x" + "cd" * 20}, {"hyperliquidChain": "Mainnet"}, {"type": "usdSend"},
                {"extra": 1}):
        with pytest.raises(hl_actions.SignError):
            hl.check_withdraw({**a, **bad}, OWN, now_ms=1)
    with pytest.raises(hl_actions.SignError, match="expired"):
        hl.check_withdraw(a, OWN, now_ms=1 + hl_actions.NONCE_MAX_AGE_MS + 1)
    with pytest.raises(hl_actions.SignError):
        hl.check_withdraw({k: v for k, v in a.items() if k != "destination"}, OWN, now_ms=1)


def test_a_usdc_move_stays_in_the_same_account_and_in_usdc():
    m = hl.build_dex_move("0x66eee", OWN, "", "xyz", 25, USDC, ["xyz"], now_ms=1)
    assert m["destination"] == OWN and m["fromSubAccount"] == "" and m["token"] == USDC
    hl.check_dex_move(m, OWN, ["xyz"], now_ms=1)
    for bad in ({"destination": "0x" + "cd" * 20}, {"token": "HYPE:0x" + "00" * 16},
                {"fromSubAccount": "0x" + "cd" * 20}, {"destinationDex": "abc"}, {"sourceDex": "xyz"}):
        with pytest.raises(hl_actions.SignError):
            hl.check_dex_move({**m, **bad}, OWN, ["xyz"], now_ms=1)


# ---- exact cents (tests/test_hl_amounts.py, audit money-01) -------------------------------------------------------------
def test_every_cent_from_2_to_10000_is_signed_as_typed_and_reads_back_the_same():
    for n in range(200, 1_000_001):
        t = hl.amount_text(n / 100)              # the number the page sends (JSON) for n cents typed
        assert t == text(n), (n, t)
        assert hl.amount_text(t) == t, (n, t)    # what the check rebuilds from the signed text: the same text


def test_a_prepared_withdrawal_and_move_pass_their_own_check():
    for usd in LOWERED + [n / 100 for n in range(200, 1_000_001, 97)]:
        n = round(usd * 100)
        a = hl.build_withdraw("0xa4b1", OWN, usd, now_ms=1)
        assert a["amount"] == text(n), usd
        hl.check_withdraw(a, OWN, now_ms=1)
        if usd < 2.5:
            continue
        m = hl.build_dex_move("0x66eee", OWN, "", "xyz", usd, USDC, ["xyz"], now_ms=1)
        assert m["amount"] == text(n), usd
        hl.check_dex_move(m, OWN, ["xyz"], now_ms=1)
        back = hl.build_dex_move("0x66eee", OWN, "xyz", "", usd, USDC, ["xyz"], now_ms=1)
        hl.check_dex_move(back, OWN, ["xyz"], now_ms=1)
    hl.check_dex_move(hl.build_dex_move("0x66eee", OWN, "", "xyz", 1.15, USDC, ["xyz"], now_ms=1), OWN, ["xyz"], now_ms=1)


def test_an_amount_not_as_rivemont_prepared_it_is_refused_plainly():
    a = hl.build_withdraw("0xa4b1", OWN, 25.5, now_ms=1)
    for bad in ("25.50", "25.505", " 25.5", "2.55e1", 25.5, None, "NaN", "Infinity", "0x19"):
        with pytest.raises(hl_actions.SignError, match="not a withdrawal Rivemont prepared"):
            hl.check_withdraw({**a, "amount": bad}, OWN, now_ms=1)
    for low in ("1.99", "-25.5"):
        with pytest.raises(hl_actions.SignError, match="at least"):
            hl.check_withdraw({**a, "amount": low}, OWN, now_ms=1)
    m = hl.build_dex_move("0x66eee", OWN, "", "xyz", 25.5, USDC, ["xyz"], now_ms=1)
    for bad in ("25.50", "25.505", 25.5, "1e1"):
        with pytest.raises(hl_actions.SignError, match="only move between your own"):
            hl.check_dex_move({**m, "amount": bad}, OWN, ["xyz"], now_ms=1)
    for bad in (float("nan"), float("inf"), "abc", True):
        with pytest.raises(hl_actions.SignError):
            hl.build_withdraw("0xa4b1", OWN, bad, now_ms=1)
    assert hl.build_withdraw("0xa4b1", OWN, 2.999, now_ms=1)["amount"] == "2.99"          # floored, never rounded up
    with pytest.raises(hl_actions.SignError, match="at least"):
        hl.build_withdraw("0xa4b1", OWN, 1.999, now_ms=1)


# ---- the $1 fee: "Fee from the amount" (default) or "Receive the full amount" -------------------------------------------
def test_withdraw_amounts_fee_from_the_amount_and_on_top():
    a = hl.withdraw_amounts(50)                              # default: withdraw 50, receive 49
    assert (a["gross"], a["gross_usd"], a["receive_usd"], a["fee_usd"]) == ("50", 50.0, 49.0, 1.0)
    a = hl.withdraw_amounts(50, receive_full=True)           # receive 50: the wallet signs 51
    assert (a["gross"], a["gross_usd"], a["receive_usd"], a["fee_usd"]) == ("51", 51.0, 50.0, 1.0)
    a = hl.withdraw_amounts(8.04, receive_full=True)         # cents kept exactly (audit money-01)
    assert (a["gross"], a["receive_usd"]) == ("9.04", 8.04)
    assert hl.withdraw_amounts(2.999)["gross"] == "2.99"     # floored, never rounded up
    for n in range(100, 100_001, 37):                        # every amount: receive + fee == signed, in both modes
        for full in (False, True) if n >= 200 else (True,):
            a = hl.withdraw_amounts(n / 100, full)
            assert round(a["receive_usd"] + a["fee_usd"], 2) == a["gross_usd"] == float(a["gross"])
            assert a["gross"] == text(n + 100 if full else n)
            hl.check_withdraw(hl.build_withdraw("0xa4b1", OWN, a["gross"], now_ms=1), OWN, now_ms=1)


def test_withdraw_amounts_minimums():
    with pytest.raises(hl_actions.SignError, match="at least \\$2"):
        hl.withdraw_amounts(1.99)                            # fee from the amount: at least $2 signed
    assert hl.withdraw_amounts(1, receive_full=True)["gross"] == "2"         # receive $1, sign $2
    with pytest.raises(hl_actions.SignError, match="receive at least \\$1"):
        hl.withdraw_amounts(0.99, receive_full=True)
    for bad in (float("nan"), float("inf"), "abc", True):
        with pytest.raises(hl_actions.SignError):
            hl.withdraw_amounts(bad, receive_full=True)


# ---- what may leave now (tests/test_money_model.py) ------------------------------------------------------------------------
def venue(v, balance, free, live=True):
    """A venue of the money model, with only the fields the guard reads."""
    return {"venue": v, "balance": balance, "exchange_free": free, "live": live, "withdrawable": free, "running": []}


def test_the_exchanges_free_figure_is_the_only_limit_on_what_leaves():
    rnd = random.Random(7)
    for _ in range(300):
        bal = round(rnd.uniform(0, 800), 2)
        free = round(rnd.uniform(0, bal), 2)
        m = {"venues": [venue("hyperliquid", bal, free)], "strategies": []}
        amount = round(rnd.uniform(0, 900), 2)
        g = money.withdraw_check(m, "hyperliquid", amount)
        assert (g is None) == (amount <= free + money.EPS or amount <= 0)
        if g:
            assert g["most"] == pytest.approx(free, abs=0.011)
            assert money.refusal(m, "hyperliquid", amount).startswith(("at most $", "nothing can leave"))


def test_the_guard_with_the_fee_on_top_and_without_a_free_figure():
    m = {"venues": [venue("hyperliquid", 300, 300), venue("lighter", 500, None), venue("aster", 400, 100, live=False)],
         "strategies": []}
    assert money.withdraw_check(m, "hyperliquid", 299, 1) is None                 # receive 299: sign 300, fits
    g = money.withdraw_check(m, "hyperliquid", 300, 1)                            # receive 300: needs 301
    assert g == {"free": 300, "most": 299}
    assert money.refusal(m, "hyperliquid", 300, 1) == ("at most $299.00 can leave Hyperliquid now "
                                                       "(the rest holds open positions or orders)")
    assert money.withdraw_check(m, "lighter", 490) is None                       # no free figure: it decides itself
    assert money.withdraw_check(m, "aster", 300) is None                         # a stale reading: no guess
    assert money.refusal({"venues": [venue("hyperliquid", 10, 0)]}, "hyperliquid", 5) == "nothing can leave Hyperliquid now"


def test_the_page_guard_answers_exactly_as_the_server(tmp_path):
    """tests/js/guard.test.mjs runs the browser's GUARD.withdraw on these cases and must give the same answers."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    rnd, cases = random.Random(11), []
    for i in range(400):
        free = None if i % 9 == 0 else round(rnd.uniform(0, 800), 2)
        m = {"venues": [venue("hyperliquid", 800, free, live=i % 13 != 0)], "strategies": []}
        amount, fee = round(rnd.uniform(-5, 900), 2), rnd.choice([0, 1])
        cases.append({"name": f"c{i}", "model": m, "venue": "hyperliquid", "amount": amount, "fee": fee,
                      "expect": money.withdraw_check(m, "hyperliquid", amount, fee)})
    f = tmp_path / "cases.json"
    f.write_text(json.dumps(cases))
    js = Path(__file__).resolve().parent / "js" / "guard.test.mjs"
    out = subprocess.run([node, str(js), str(f)], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert "guard matches the server on 400 cases" in out.stdout
