# flake8: noqa
"""EXCERPT, for reading only: not importable on its own.

The live server's withdrawal endpoints for Hyperliquid, copied from its FastAPI router (radar/auto/api.py, nested
inside build_auto_router()). `hl` there is the server's Hyperliquid module; in this repository its functions are
split into signing/hl_actions.py (typed_data, recover, submit, SignError) and withdraw/hl_withdraw.py
(withdraw_amounts, build_withdraw, check_withdraw, build_dex_move, check_dex_move). `customer()`, `store`, `money_of`,
`notices`, `strategies` and the request models come from the server and are not part of this repository.

What to look for, in order, in withdraw():
  1. step 1 (no signature): the action is built by the server with destination = u["address"], the wallet that
     connected the account (never a value from the request);
  2. step 2: check_withdraw() rebuilds that action from the signed one and refuses any difference (destination,
     amount text, network, chain id, type) or a timestamp older than 10 minutes;
  3. the balance guard runs again (the balance may have moved since step 1);
  4. the signature must recover to u["address"];
  5. only then is it forwarded to Hyperliquid, which itself only accepts a withdrawal signed by the account's wallet.
The browser makes the same destination check before it asks the wallet to sign (web/wallet/hl-wallet-flows.js
wdHLCore), so a tampered server answer is refused there too.
"""

def withdraw_guard(u: dict, venue: str, usd: float, fee: float = 0.0):
    """A withdrawal Rivemont builds may take what the exchange itself reports as free (money.withdraw_check, the
    same function as the app's guard). Nothing is kept for a strategy."""
    why = money.refusal(money_of(u), venue, float(usd or 0), float(fee or 0))
    if why:
        raise HTTPException(status_code=400, detail=why)


@r.post("/api/auto/withdraw")
def withdraw(body: WithdrawIn):
    """Hyperliquid -> the customer's own wallet on Arbitrum. Step 1 (no signature) returns what to sign; step 2
    checks the signed withdrawal goes back to the same wallet that connected, then hands it to Hyperliquid."""
    sub, u = customer(body.key)
    if not (u["address"] and u["agent_ok"]):
        raise HTTPException(status_code=400, detail="connect Hyperliquid first")
    try:
        if not body.signature:
            amt = hl.withdraw_amounts(body.usd, body.receive_full)    # the signed (gross) amount includes the $1 fee
            withdraw_guard(u, strategies.HL, amt["gross_usd"])
            action = hl.build_withdraw(body.chain_id, u["address"], amt["gross"])
            return {"action": action, "typed_data": hl.typed_data(action), "gross_usd": amt["gross_usd"],
                    "receive_usd": amt["receive_usd"], "fee_usd": amt["fee_usd"]}
        hl.check_withdraw(body.action or {}, u["address"])
        try:
            signed = float((body.action or {}).get("amount"))
        except (TypeError, ValueError):
            raise hl.SignError("that is not a withdrawal Rivemont prepared")
        withdraw_guard(u, strategies.HL, signed)              # checked again: the balance may have moved since
        if hl.recover(body.action, body.signature) != u["address"]:
            raise hl.SignError("sign with the wallet you connected")
        hl.submit(body.action, body.signature, http_client)
    except hl.SignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:            # sent: its history row and notice never turn it into an error (the page would invite a second send)
        store.add_money_move(u["id"], "withdrawal", strategies.HL, signed)
        notices.money_sent(store, u["id"], strategies.HL, signed)
    except Exception as e:
        log.warning("withdraw bookkeeping: %s", e)
    return {"ok": True, "amount": body.action["amount"]}


@r.post("/api/auto/hl/dex-move")
def hl_dex_move(body: DexMoveIn):
    """USDC between the account's own Hyperliquid balances: the main dex and a builder dex's market group (HIP-3,
    e.g. trade.xyz), which a classic account keeps apart. Step 1 (no signature) returns what to sign; step 2 checks
    it moves USDC between this same account's own balances only, then hands it to Hyperliquid. Money never leaves
    the account, so no strategy's set-aside rule applies (a move off the main dex is checked like a withdrawal)."""
    sub, u = customer(body.key)
    if not (u["address"] and u["agent_ok"]):
        raise HTTPException(status_code=400, detail="connect Hyperliquid first")
    dexs = hl.tradable_dexs(http_client)
    try:
        if not body.signature:
            if body.from_dex == "":
                withdraw_guard(u, strategies.HL, body.usd)
            action = hl.build_dex_move(body.chain_id, u["address"], body.from_dex, body.to_dex, body.usd,
                                       hl.usdc_token(http_client), dexs)
            return {"action": action, "typed_data": hl.typed_data(action)}
        hl.check_dex_move(body.action or {}, u["address"], dexs)
        if (body.action or {}).get("sourceDex") == "":
            withdraw_guard(u, strategies.HL, float(body.action["amount"]))     # again: the balance may have moved
        if hl.recover(body.action, body.signature) != u["address"]:
            raise hl.SignError("sign with the wallet you connected")
        hl.submit(body.action, body.signature, http_client)
    except hl.SignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "amount": body.action["amount"], "from": body.action["sourceDex"], "to": body.action["destinationDex"]}
