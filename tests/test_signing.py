"""Hyperliquid approvals (API wallet, builder fee) and the wallet sign-in (EIP-4361).

From the live repository's tests/test_auto.py (signing) and tests/test_sec_audit.py (sec-03, sec-05). The sign-in tests
there drive the HTTP endpoints; here they call signing/signin.py directly, the same checks the endpoint runs
(signing/routes_excerpt.py login_checked: recover the signer, then Pending.finish)."""
import re
import time
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct, encode_typed_data

from signing import hl_actions as hl
from signing import signin


def sign(acct, action):
    return acct.sign_message(encode_typed_data(full_message=hl.typed_data(action))).signature.hex()


# ---- crypto and signing (tests/test_auto.py) ----------------------------------------------------------------------
def test_signature_matches_official_sdk():
    sign_agent = pytest.importorskip("hyperliquid.utils.signing").sign_agent
    acct = Account.create()
    a = hl.build_action("approveAgent", "0x66eee", "0x" + "ab" * 20)
    sdk_action = {"type": "approveAgent", "agentAddress": a["agentAddress"], "agentName": "rivemont", "nonce": a["nonce"]}
    ref = sign_agent(acct, sdk_action, False)
    ours = hl.split_signature(sign(acct, a))
    assert ours == {"r": ref["r"], "s": ref["s"], "v": ref["v"]}
    assert hl.recover(a, sign(acct, a)) == acct.address.lower()


def test_recover_gives_the_signer():
    acct = Account.create()
    a = hl.build_action("approveAgent", "0xa4b1", "0x" + "ab" * 20)
    assert hl.recover(a, sign(acct, a)) == acct.address.lower()
    assert hl.recover({**a, "nonce": a["nonce"] + 1}, sign(acct, a)) != acct.address.lower()     # another action
    for bad in ("0x12", "zz" * 65, ""):
        with pytest.raises(hl.SignError):
            hl.recover(a, bad)


def test_check_action_rejects_tampering():
    agent = "0x" + "ab" * 20
    a = hl.build_action("approveAgent", "0xa4b1", agent)
    hl.check_action("approveAgent", a, agent)
    with pytest.raises(hl.SignError):
        hl.check_action("approveAgent", {**a, "agentAddress": "0x" + "cd" * 20}, agent)
    with pytest.raises(hl.SignError):
        hl.check_action("approveAgent", {**a, "hyperliquidChain": "Mainnet"}, agent)
    old = hl.build_action("approveAgent", "0xa4b1", agent, now_ms=int(time.time() * 1000) - 3600_000)
    with pytest.raises(hl.SignError):
        hl.check_action("approveAgent", old, agent)
    b = hl.build_action("approveBuilderFee", "0xa4b1")
    with pytest.raises(hl.SignError):
        hl.check_action("approveBuilderFee", {**b, "maxFeeRate": "1%"})


def test_builder_fee_approval_names_the_configured_builder_and_at_most_0_1_percent():
    b = hl.build_action("approveBuilderFee", "0xa4b1")
    assert b["builder"] == hl.builder_address() and b["maxFeeRate"] == "0.1%"
    hl.check_action("approveBuilderFee", b)
    with pytest.raises(hl.SignError):
        hl.check_action("approveBuilderFee", {**b, "builder": "0x" + "cd" * 20})
    td = hl.typed_data(b)
    assert td["primaryType"] == "HyperliquidTransaction:ApproveBuilderFee" and td["domain"]["chainId"] == 42161
    assert td["domain"]["verifyingContract"] == "0x" + "0" * 40 and td["message"]["maxFeeRate"] == "0.1%"


def test_no_builder_configured_means_no_fee_approval(monkeypatch):
    monkeypatch.delenv("AUTO_BUILDER_ADDRESS")
    with pytest.raises(hl.SignError, match="not configured"):
        hl.build_action("approveBuilderFee", "0xa4b1")


def test_bad_chain_ids_and_unknown_actions_are_refused():
    for cid in ("", "0x0", "0xzz", None, hex(2 ** 53)):
        with pytest.raises(hl.SignError):
            hl.build_action("approveAgent", cid, "0x" + "ab" * 20)
    with pytest.raises(hl.SignError, match="unknown"):
        hl.build_action("withdraw3", "0xa4b1")


# ---- sec-03: the wallet sign-in names the site (EIP-4361) (tests/test_sec_audit.py) --------------------------------
def personal(acct, text):
    return acct.sign_message(encode_defunct(text=text)).signature.to_0x_hex()


def login(p, text, sig):
    """What the sign-in endpoint does before it looks anything up: recover the signer, then Pending.finish."""
    try:
        addr = signin.signer_of(text, sig)
    except Exception:
        addr = None
    p.finish(text, addr or "")
    return addr


def test_the_sign_in_message_is_eip_4361_and_bound_to_the_site_and_the_wallet(monkeypatch):
    p = signin.Pending()
    me, other = Account.create(), Account.create()
    m = p.start("app.rivemont.xyz", me.address, "0xa4b1")
    lines = m.split("\n")
    assert lines[0] == "rivemont.xyz wants you to sign in with your Ethereum account:"   # app host not set: the brand's
    assert lines[1] == me.address and "moves no money" in lines[3]
    assert "URI: https://rivemont.xyz" in lines and "Version: 1" in lines and "Chain ID: 42161" in lines
    assert any(x.startswith("Nonce: ") for x in lines) and any(x.startswith("Expiration Time: ") for x in lines)
    # another wallet's signature of it is refused, and the nonce is gone
    with pytest.raises(signin.SignInError):
        login(p, m, personal(other, m))
    with pytest.raises(signin.SignInError):
        login(p, m, personal(me, m))
    # a text changed in any way (another domain) is refused, even with a live nonce
    m = p.start("rivemont.xyz", me.address)
    evil = m.replace("rivemont.xyz", "rivemont-login.xyz")
    with pytest.raises(signin.SignInError):
        login(p, evil, personal(me, evil))
    with pytest.raises(signin.SignInError):
        login(p, m, personal(me, m))                                            # that nonce is used up either way
    m = p.start("rivemont.xyz", me.address)
    assert login(p, m, personal(me, m)) == me.address.lower()                   # the exact text, signed by its wallet
    with pytest.raises(signin.SignInError):
        login(p, m, personal(me, m))                                            # single use
    # the app host names itself once it is set up; any other host gets the brand's domain
    monkeypatch.setenv("RV_APP_HOST", "app.rivemont.xyz")
    m = p.start("app.rivemont.xyz", me.address)
    assert m.startswith("app.rivemont.xyz wants you") and "URI: https://app.rivemont.xyz" in m
    assert p.start("evil.example", me.address).startswith("rivemont.xyz wants you")
    assert signin.domain_for("www.rivemont.xyz") == "www.rivemont.xyz"


def test_a_sign_in_expires_after_five_minutes():
    p = signin.Pending()
    me = Account.create()
    m = p.start("rivemont.xyz", me.address, now=1000.0)
    with pytest.raises(signin.SignInError, match="expired"):
        p.finish(m, me.address.lower(), now=1000.0 + signin.NONCE_TTL_S + 1)


def test_a_page_from_before_the_change_signs_in_until_the_grace_ends(monkeypatch):
    p = signin.Pending()
    me = Account.create()
    monkeypatch.setattr(signin, "LEGACY_UNTIL", time.time() + 3600)
    m = p.start("rivemont.xyz")                                                  # the old page sends no address
    assert m.startswith("Sign in to Rivemont\n") and "nonce: " in m
    assert login(p, m, personal(me, m)) == me.address.lower()
    monkeypatch.setattr(signin, "LEGACY_UNTIL", time.time() - 1)
    with pytest.raises(signin.SignInError, match="Reload"):
        p.start("rivemont.xyz")


def test_the_old_sign_in_text_ends_on_launch_morning():
    """The old text (no domain) is the one a phishing page can relay: its grace ends at 2026-10-05 12:00 UTC at the latest."""
    src = (Path(__file__).resolve().parents[1] / "signing/signin.py").read_text()
    default = int(re.search(r'RV_LEGACY_SIGNIN_UNTIL", ([0-9_]+)\)', src).group(1).replace("_", ""))
    assert default <= 1_791_201_600


# ---- sec-05: pending sign-ins are bounded ----------------------------------------------------------------------------
def test_pending_sign_ins_are_bounded():
    addr = "0x" + "ab" * 20
    p = signin.Pending(max_items=50)
    for i in range(500):
        p.start("rivemont.xyz", addr, now=1000.0 + i * 0.001)
    assert len(p) == 50
    p2 = signin.Pending(max_items=1000, ttl=300)
    p2.start("rivemont.xyz", addr, now=0.0)
    p2.start("rivemont.xyz", addr, now=400.0)              # the expired one is dropped on the next start
    assert len(p2) == 1
