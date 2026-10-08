# flake8: noqa
"""EXCERPT, for reading only: not importable on its own.

The HTTP endpoints of the live server that use signing/: the wallet sign-in (EIP-4361) and the two Hyperliquid
approvals (the trade-only API wallet, and the builder fee). They are copied from the server's FastAPI router
(radar/auto/api.py), where they are nested inside build_auto_router(); names such as `r` (the router), `store` (the
account database), `customer()` (looks up the signed-in account from its key), `billing`, `open_gate` and the request
models come from that module and are not part of this repository. Lines that only send internal notifications or
count analytics events are left out and marked "[left out]".

What to look for:
  * login_checked: the signer is recovered from the signature first, then Pending.finish() checks that the text is the
    exact one Rivemont issued, unexpired, and signed by the wallet it names, before any account is looked up or made.
  * prepare: the server builds the action (signing/hl_actions.py build_action); the browser checks it again before the
    wallet sees it (web/wallet/hl-wallet-flows.js checkHLApproval).
  * submit: check_action rebuilds the expected action and refuses any difference (agent, builder, fee rate, network,
    nonce age); the builder-fee approval must be signed by the wallet that connected; the approved rate is stored as
    the account's fee cap (fees/builder_fee.py approved_cap).
"""

from . import signin
pending_signins = signin.Pending()
login_lock = _threading.Lock()           # one account per wallet: two sign-ins at once make it once
signins_ip, signins_all = RateLimiter(SIGNINS_PER_MINUTE, 60.0), RateLimiter(SIGNINS_ALL_PER_MINUTE, 60.0)

def signin_limits(request: Request):
    enforce(signins_ip, client_ip(request), "Too many sign-ins from this network. Wait a minute and try again.")
    enforce(signins_all, "all", "Many people are signing in right now. Try again in a minute.")

@r.post("/api/auto/login/start")
def login_start(request: Request, body: LoginStartIn | None = None):
    """Sign in with the wallet: the message to sign (EIP-4361: it names this site and the wallet, so the wallet
    shows whose sign-in it is). Used on a new device or when the key is lost."""
    signin_limits(request)
    body = body or LoginStartIn()
    try:
        return {"message": pending_signins.start(request.headers.get("host"), (body.address or "").strip(), body.chain_id)}
    except signin.SignInError as e:
        raise HTTPException(status_code=400, detail=str(e))

# [left out] @r.post("/api/auto/login"): calls login_checked() below and counts success / failure anonymously.

def login_checked(body: LoginIn, request: Request, seen: dict):
    """Connect wallet + one signature = signed in (as Hyperliquid and the CEXs): the wallet's account, or, for a
    wallet Rivemont has not seen, a new free account made on the spot and bound to it (terms box ticked, the same
    gate as every new account). The signature proves the wallet before anything is looked up or made: Rivemont's own
    text, unchanged, within five minutes, signed by the wallet it names."""
    signin_limits(request)
    try:
        addr = signin.signer_of(body.message, body.signature).lower()
    except Exception:
        addr = None
    seen["addr"] = addr
    try:
        pending_signins.finish(body.message, addr or "")
    except signin.SignInError as e:
        raise HTTPException(status_code=400, detail=str(e))
    with login_lock:
        u = store.by_address(addr)
        sub = billing.sub(u["sub_id"]) if u else None
        if u and sub:
            if sub["plan"] not in AUTO_PLANS:
                raise HTTPException(status_code=403, detail="This wallet's account can't be opened here. Write to us on Telegram (@rivemont_bot).")
            if sub["expires"] < time.time():        # Rivemont is free to use: a lapsed free plan just gets its time again
                billing.renew(sub["id"], FREE_DAYS)
            if body.terms and not u.get("terms_at"):
                store.update(u["id"], terms_at=int(time.time()))
            return {"key": billing.add_key(sub["id"]), "created": False}
        if not body.terms:
            raise HTTPException(status_code=400, detail="Tick the box to accept the terms first.")
        open_gate(request, body.invite)
        key = billing.grant("free:" + secrets.token_hex(8), "auto", FREE_DAYS)
        new = store.ensure(billing.by_key(key)["id"])
        store.update(new["id"], address=addr, terms_at=int(time.time()))
    return {"key": key, "created": True}


@r.post("/api/auto/prepare")
def prepare(body: PrepareIn):
    sub, u = customer(body.key, create=True)
    if body.kind == "approveBuilderFee" and not u["agent_ok"]:
        raise HTTPException(status_code=400, detail="approve the API wallet first")
    try:
        action = hl.build_action(body.kind, body.chain_id, u["agent_address"])
        return {"action": action, "typed_data": hl.typed_data(action)}
    except hl.SignError as e:
        raise HTTPException(status_code=400, detail=str(e))

@r.post("/api/auto/submit")
def submit(body: SubmitIn):
    sub, u = customer(body.key)
    try:
        hl.check_action(body.kind, body.action, u["agent_address"] or "")
        signer = hl.recover(body.action, body.signature)
        if body.kind == "approveBuilderFee" and signer != u["address"]:
            raise hl.SignError("sign with the same wallet you connected")
        changed = body.kind == "approveAgent" and bool(u["address"]) and u["address"].lower() != signer.lower()
        if changed:
            # every other exchange is connected to the old wallet's accounts and is forgotten below, so nothing may
            # still trade there (its positions could no longer be closed)
            running = strategies.active(u, store.follow(u["id"]), store.hook(u["id"]), store.live_bots(u["id"]))
            if running or u["status"] == "closing" or accounts.in_use_anywhere(store, u):
                raise hl.SignError("this is a different wallet from the one connected. Stop your strategies first "
                                   "(Stop everything), then connect the new wallet")
        hl.submit(body.action, body.signature, http_client)
    except hl.SignError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if body.kind == "approveAgent":
        # a different wallet: forget every other exchange's key (they belong to the old wallet's accounts) and put
        # a waived Orderly fee back; the same wallet approving again keeps them
        wipe = {"builder_ok": 0, "builder_max": None, "builder_max_ts": None, **VENUE_WIPE,
                **orderly_api.wipe_fields(u, http_client)} if changed else {}
        store.update(u["id"], address=signer, agent_ok=1, **wipe)
        # [left out] an internal notification on a customer's first connection
        out = view(store.get(u["id"]), sub)
        if changed:
            out["notice"] = ("You connected a different wallet, so Rivemont deleted the keys it held for your other "
                             "exchanges: they belonged to the old wallet's accounts. Connect them again with this "
                             "wallet.")
        return out
    # the rate the customer just approved (the action's maxFeeRate, checked above): the fee attached is capped at it
    store.update(u["id"], builder_ok=1, builder_max=hl.rate_tenths(body.action.get("maxFeeRate")),
                 builder_max_ts=int(time.time()))
    return view(store.get(u["id"]), sub)
