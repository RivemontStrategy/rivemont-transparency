"""How much may leave an exchange now: the server's balance check on a withdrawal Rivemont builds.

This is the amount side of a withdrawal (the destination side is withdraw/hl_withdraw.py). A withdrawal may take what
the exchange itself reports as free; nothing is held back by Rivemont for a bot or strategy. The browser runs the same
rule before asking the wallet (web/wallet/hl-wallet-flows.js GUARD.withdraw), and the server checks it again at both
steps of a withdrawal (withdraw/routes_excerpt.py withdraw_guard), because the balance may move in between.

`model` is the customer's money model as the server builds it: {"venues": [{venue, balance, exchange_free, live, ...}]}.

Source: radar/auto/money.py on the live server (withdraw_check and refusal).
"""
from __future__ import annotations

import math

VENUE_LABELS = {"hyperliquid": "Hyperliquid"}   # the live server reads the label from its venue list


def venue_label(v: str) -> str:
    return VENUE_LABELS.get(v, v)


EPS = 0.005


def venue(model: dict, v: str) -> dict | None:
    return next((x for x in model["venues"] if x["venue"] == v), None)


def withdraw_check(model: dict, v: str, amount: float, fee: float = 0.0) -> dict | None:
    """Taking `amount` out of exchange v (the exchange's `fee` on top): None when the exchange lets it leave (or it
    reports no free figure: then it decides itself), else {free, most}: what the exchange reports as free and the most
    that can leave now. The exchange's own limit only: nothing is kept for a strategy. The app's GUARD.withdraw
    (web/wallet/hl-wallet-flows.js) is the same function; tests/js/guard.test.mjs checks both give the same."""
    x = venue(model, v)
    if not x or not amount or amount <= 0 or x.get("exchange_free") is None or not x.get("live"):
        return None
    ex = max(0.0, x["exchange_free"])
    if amount + fee <= ex + EPS:
        return None
    return {"free": round(ex, 2), "most": max(0.0, math.floor((ex - fee) * 100 + 1e-6) / 100)}


def refusal(model: dict, v: str, amount: float, fee: float = 0.0) -> str | None:
    """The server's words when a withdrawal Rivemont builds is more than the exchange lets leave now (None: it may
    go; the exchange has the last word)."""
    g = withdraw_check(model, v, amount, fee)
    if not g:
        return None
    label = venue_label(v)
    if g["most"] >= 0.01:
        return f"at most ${g['most']:,.2f} can leave {label} now (the rest holds open positions or orders)"
    return f"nothing can leave {label} now"
