"""Withdrawals from Hyperliquid, and USDC moves between the account's own Hyperliquid balances, only ever to the
customer's own wallet / own account.

Rivemont's server builds the exact action the customer's wallet signs (destination = the address that connected) and,
when the signed action comes back, rebuilds it and refuses anything that differs (check_withdraw, check_dex_move)
before forwarding it to Hyperliquid. The API wallet Rivemont trades with cannot withdraw at all: Hyperliquid lets only
the account's own wallet sign a withdrawal (signing/hl_actions.py, approveAgent).

Source: radar/auto/hl.py on the live server (the withdrawal part).
"""
from __future__ import annotations

import time
from decimal import ROUND_FLOOR, Decimal, InvalidOperation

import httpx

from signing.hl_actions import NONCE_MAX_AGE_MS, SignError, _chain_id, _info, mainnet

DEX_MOVE_MIN_USD = 1.0
WITHDRAW_MIN_USD = 2.0            # Hyperliquid takes a $1 fee per withdrawal
WITHDRAW_FEE_USD = 1.0            # ... out of the amount signed: what arrives is the signed amount less $1


_CENT = Decimal("0.01")


def _cents(usd) -> Decimal:
    """usd floored to whole cents, read through its decimal text: 8.04 stays 8.04 (int(8.04 * 100) is 803, so the old
    float floor signed a cent less than typed, and rebuilding from that amount floored once more, so the server refused
    its own action; audit money-01). Anything that is not a finite number is refused."""
    try:
        d = Decimal(str(usd).strip()) if not isinstance(usd, bool) else Decimal("NaN")
        if not d.is_finite():
            raise InvalidOperation
        return d.quantize(_CENT, rounding=ROUND_FLOOR)
    except (InvalidOperation, ValueError, TypeError):
        raise SignError("enter an amount")


def amount_text(usd) -> str:
    """The amount as a signed action carries it: whole cents, no trailing zeros ("25.5", "8.04", "12")."""
    return f"{_cents(usd):.2f}".rstrip("0").rstrip(".")


def _signed_amount(action: dict, refusal: str) -> str:
    """The amount text of a signed action, exactly as Rivemont prepared it (a string, whole cents, nothing to round),
    so a check rebuilds the very same action instead of a float round trip of it."""
    a = action.get("amount")
    try:
        ok = isinstance(a, str) and amount_text(a) == a
    except SignError:
        ok = False
    if not ok:
        raise SignError(refusal)
    return a


def build_withdraw(signature_chain_id: str, destination: str, usd, now_ms: int | None = None) -> dict:
    """A withdrawal from the customer's Hyperliquid account to their own wallet on Arbitrum. Only the customer's wallet
    can sign it; we pass it on after checking it goes back to the same wallet. usd: a number or its text."""
    _chain_id(signature_chain_id)
    amount = _cents(usd)
    if not amount >= Decimal(str(WITHDRAW_MIN_USD)):
        raise SignError(f"withdraw at least ${WITHDRAW_MIN_USD:.0f} (Hyperliquid charges $1)")
    return {"type": "withdraw3", "signatureChainId": signature_chain_id.lower(),
            "hyperliquidChain": "Mainnet" if mainnet() else "Testnet", "destination": destination.lower(),
            "amount": amount_text(amount), "time": now_ms or int(time.time() * 1000)}


def withdraw_amounts(usd, receive_full: bool = False) -> dict:
    """What a Hyperliquid withdrawal signs and what arrives. Hyperliquid takes its $1 out of the
    signed amount, so by default the customer withdraws `usd` and receives usd - $1; with receive_full the customer
    receives `usd` and the signed amount is usd + $1. gross is the text the wallet signs (amount_text)."""
    typed, fee = _cents(usd), _cents(WITHDRAW_FEE_USD)
    gross = typed + fee if receive_full else typed
    if not gross >= Decimal(str(WITHDRAW_MIN_USD)):
        raise SignError(f"receive at least ${WITHDRAW_MIN_USD - WITHDRAW_FEE_USD:.0f}" if receive_full else
                        f"withdraw at least ${WITHDRAW_MIN_USD:.0f} (Hyperliquid charges $1)")
    return {"gross": amount_text(gross), "receive_usd": float(gross - fee), "fee_usd": float(fee), "gross_usd": float(gross)}


def check_withdraw(action: dict, owner: str, now_ms: int | None = None):
    try:
        amount = _signed_amount(action, "that is not a withdrawal Rivemont prepared")
        expected = build_withdraw(action.get("signatureChainId", ""), owner, amount, action.get("time"))
    except SignError:
        raise
    except (KeyError, ValueError, TypeError, AttributeError):
        raise SignError("incomplete withdrawal")
    if action != expected:
        raise SignError("withdrawals can only go back to your own wallet")
    now_ms = now_ms or int(time.time() * 1000)
    if not isinstance(action["time"], int) or abs(now_ms - action["time"]) > NONCE_MAX_AGE_MS:
        raise SignError("signature expired; sign again")


def usdc_token(client=None) -> str:
    """USDC as sendAsset names it ("USDC:<token id>", from spotMeta); the known mainnet / testnet ids when unreadable."""
    try:
        for t in _info({"type": "spotMeta"}, client).get("tokens", []):
            if t.get("name") == "USDC" and t.get("tokenId"):
                return f"USDC:{t['tokenId']}"
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        pass
    return "USDC:0x6d1e7cde53ba9467b783cb7c530ce054" if mainnet() else "USDC:0xeb62eee3685fc4c43992febcd9e75443"


def build_dex_move(signature_chain_id: str, owner: str, source_dex: str, destination_dex: str, usd, token: str,
                   dexs=(), now_ms: int | None = None) -> dict:
    """USDC from one of the account's own Hyperliquid perp dexs to another ("" = the main dex, else a builder dex Rivemont
    lists: dexs), always to the same account (destination = the owner). Only the customer's wallet signs it."""
    _chain_id(signature_chain_id)
    ok = {""} | set(dexs)
    if source_dex not in ok or destination_dex not in ok or source_dex == destination_dex:
        raise SignError("pick the main Hyperliquid balance and one market group to move USDC between")
    amount = _cents(usd)
    if not amount >= Decimal(str(DEX_MOVE_MIN_USD)):
        raise SignError(f"move at least ${DEX_MOVE_MIN_USD:.0f}")
    if not str(token).startswith("USDC:"):
        raise SignError("only USDC moves between market groups here")
    return {"type": "sendAsset", "signatureChainId": signature_chain_id.lower(),
            "hyperliquidChain": "Mainnet" if mainnet() else "Testnet", "destination": owner.lower(),
            "sourceDex": source_dex, "destinationDex": destination_dex, "token": token,
            "amount": amount_text(amount), "fromSubAccount": "",
            "nonce": now_ms or int(time.time() * 1000)}


def check_dex_move(action: dict, owner: str, dexs=(), now_ms: int | None = None):
    """Refuse anything but a USDC move between the owner's own dexs, to the owner's own account, freshly signed."""
    try:
        expected = build_dex_move(action.get("signatureChainId", ""), owner, action.get("sourceDex"),
                                  action.get("destinationDex"),
                                  _signed_amount(action, "USDC can only move between your own Hyperliquid balances"),
                                  action.get("token", ""),
                                  dexs, action.get("nonce"))
    except (KeyError, ValueError, TypeError, AttributeError) as e:
        raise SignError(str(e) if isinstance(e, SignError) else "incomplete transfer")
    if action != expected:
        raise SignError("USDC can only move between your own Hyperliquid balances")
    now_ms = now_ms or int(time.time() * 1000)
    if not isinstance(action["nonce"], int) or abs(now_ms - action["nonce"]) > NONCE_MAX_AGE_MS:
        raise SignError("signature expired; sign again")
