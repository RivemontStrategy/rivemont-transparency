"""Hyperliquid user-signed actions: approve Rivemont's trade-only API wallet ("agent") and the builder fee.

The customer's wallet signs EIP-712 data in the browser; the server verifies the signer and forwards the action to
Hyperliquid. Same format as the official SDK (hyperliquid.utils.signing.sign_agent / sign_approve_builder_fee).

Source: radar/auto/hl.py on the live server (the signing part; withdrawals are in withdraw/hl_withdraw.py and the fee
cap in fees/builder_fee.py, split out of the same file so each part can be read on its own).
"""
from __future__ import annotations

import os
import time

import httpx

AGENT_NAME = "rivemont"
# what customers approve: the ceiling of the builder fee (0.1%, Hyperliquid's maximum for perps; kept at 0.1% when the
# fee itself became "from 0.05%" on 2026-10-08). Accounts that approved before 2026-10-06 hold the old 0.05% approval: the
# fee attached to their orders is capped at what they approved (fees/builder_fee.py approved_cap, fees/tiers.py hl_fee),
# so their orders are never refused for it (and since the base is 0.05% now, they pay the same as everyone).
MAX_FEE_RATE = os.environ.get("AUTO_BUILDER_MAX_FEE_RATE", "0.1%")
NONCE_MAX_AGE_MS = 10 * 60 * 1000

TYPES = {
    "approveAgent": ("HyperliquidTransaction:ApproveAgent", [
        {"name": "hyperliquidChain", "type": "string"}, {"name": "agentAddress", "type": "address"},
        {"name": "agentName", "type": "string"}, {"name": "nonce", "type": "uint64"}]),
    "approveBuilderFee": ("HyperliquidTransaction:ApproveBuilderFee", [
        {"name": "hyperliquidChain", "type": "string"}, {"name": "maxFeeRate", "type": "string"},
        {"name": "builder", "type": "address"}, {"name": "nonce", "type": "uint64"}]),
    "withdraw3": ("HyperliquidTransaction:Withdraw", [
        {"name": "hyperliquidChain", "type": "string"}, {"name": "destination", "type": "string"},
        {"name": "amount", "type": "string"}, {"name": "time", "type": "uint64"}]),
    # moves a collateral token between the account's own perp dexs (HIP-3; SDK send_asset / SEND_ASSET_SIGN_TYPES)
    "sendAsset": ("HyperliquidTransaction:SendAsset", [
        {"name": "hyperliquidChain", "type": "string"}, {"name": "destination", "type": "string"},
        {"name": "sourceDex", "type": "string"}, {"name": "destinationDex", "type": "string"},
        {"name": "token", "type": "string"}, {"name": "amount", "type": "string"},
        {"name": "fromSubAccount", "type": "string"}, {"name": "nonce", "type": "uint64"}]),
}


class SignError(ValueError):
    pass


def mainnet() -> bool:
    return os.environ.get("AUTO_MODE", "testnet") == "live"


def api_url() -> str:
    return "https://api.hyperliquid.xyz" if mainnet() else "https://api.hyperliquid-testnet.xyz"


def builder_address() -> str:
    return (os.environ.get("AUTO_BUILDER_ADDRESS") or "").strip().lower()


def _chain_id(signature_chain_id: str) -> int:
    try:
        cid = int(signature_chain_id, 16)
    except (TypeError, ValueError):
        raise SignError("bad chain id")
    if not 0 < cid < 2**53:
        raise SignError("bad chain id")
    return cid


def build_action(kind: str, signature_chain_id: str, agent_address: str = "", now_ms: int | None = None) -> dict:
    """The action the customer should sign. signature_chain_id is their wallet's current chain (hex)."""
    _chain_id(signature_chain_id)
    base = {"type": kind, "signatureChainId": signature_chain_id.lower(),
            "hyperliquidChain": "Mainnet" if mainnet() else "Testnet", "nonce": now_ms or int(time.time() * 1000)}
    if kind == "approveAgent":
        return {**base, "agentAddress": agent_address.lower(), "agentName": AGENT_NAME}
    if kind == "approveBuilderFee":
        if not builder_address():
            raise SignError("builder fee is not configured")
        return {**base, "maxFeeRate": MAX_FEE_RATE, "builder": builder_address()}
    raise SignError("unknown action")


def typed_data(action: dict) -> dict:
    primary, fields = TYPES[action["type"]]
    return {
        "domain": {"name": "HyperliquidSignTransaction", "version": "1", "chainId": _chain_id(action["signatureChainId"]),
                   "verifyingContract": "0x0000000000000000000000000000000000000000"},
        "types": {primary: fields, "EIP712Domain": [
            {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}]},
        "primaryType": primary,
        "message": {f["name"]: action[f["name"]] for f in fields},
    }


def check_action(kind: str, action: dict, agent_address: str = "", now_ms: int | None = None):
    """Refuse anything but exactly the action we asked for (right agent/builder/fee/network, fresh nonce)."""
    try:
        expected = build_action(kind, action.get("signatureChainId", ""), agent_address, action.get("nonce"))
    except KeyError:
        raise SignError("incomplete action")
    if action != expected:
        raise SignError("signed action does not match")
    now_ms = now_ms or int(time.time() * 1000)
    if not isinstance(action["nonce"], int) or abs(now_ms - action["nonce"]) > NONCE_MAX_AGE_MS:
        raise SignError("signature expired; sign again")


def split_signature(sig: str) -> dict:
    s = sig[2:] if sig.startswith("0x") else sig
    if len(s) != 130 or any(c not in "0123456789abcdefABCDEF" for c in s):
        raise SignError("bad signature")
    v = int(s[128:], 16)
    # same encoding as the SDK (eth_utils.to_hex of the integers: no leading zeros)
    return {"r": hex(int(s[:64], 16)), "s": hex(int(s[64:128], 16)), "v": v + 27 if v < 27 else v}


def recover(action: dict, sig: str) -> str:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    split_signature(sig)
    try:
        return Account.recover_message(encode_typed_data(full_message=typed_data(action)), signature=sig).lower()
    except Exception as e:
        raise SignError("signature could not be verified") from e


def submit(action: dict, sig: str, client: httpx.Client | None = None) -> dict:
    """Forward a verified user-signed action to Hyperliquid. Raises SignError on a rejection."""
    c = client or httpx.Client(timeout=20)
    try:
        r = c.post(api_url() + "/exchange", json={"action": action, "nonce": action.get("nonce", action.get("time")),
                                                  "signature": split_signature(sig)})
        body = r.json() if r.content else {}
    finally:
        if client is None:
            c.close()
    if not r.is_success or body.get("status") != "ok":
        detail = body.get("response") if isinstance(body, dict) else body
        if "deposit" in str(detail).lower():
            raise SignError("This wallet has no Hyperliquid account yet: deposit USDC on Hyperliquid first, then try again.")
        raise SignError(f"Hyperliquid rejected it: {str(detail)[:200]}")
    return body


def _info(payload: dict, client=None):
    """POST to Hyperliquid's public /info endpoint. (On the live server this also debits a per-IP request-weight
    budget before the call; that rate limiter is left out here.)"""
    c = client or httpx.Client(timeout=20)
    try:
        r = c.post(api_url() + "/info", json=payload)
        r.raise_for_status()
        return r.json()
    finally:
        if client is None:
            c.close()
