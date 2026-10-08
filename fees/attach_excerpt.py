# flake8: noqa
"""EXCERPT, for reading only: not importable on its own.

Where the fee chosen in fees/tiers.py is attached to a customer's Hyperliquid orders on the live server.

1. AutoEngine.copy_venue (radar/auto/engine.py): one trading client per customer. The fee is promo.hl_fee(...) (in this
   repository: fees/tiers.py hl_fee), i.e. the base at the customer's tier and never above the maxBuilderFee they
   approved. No builder (and so no fee) is attached until the customer has approved the builder fee (builder_ok). The
   client is rebuilt whenever the fee, the tier or the approved cap changes (the fingerprint `fp`).
2. HyperliquidVenue (radar/live/adapters.py): the client. It keeps {"b": builder, "f": fee in tenths of a basis point}
   and passes it to the official Hyperliquid SDK on every order (exchange.order(..., builder=self.builder)).
   Hyperliquid itself refuses an order whose fee is above the account's approval.

`promo`, `hl`, `secretbox` and the engine class are the live server's; only the lines that decide and attach the
fee are shown.
"""


class AutoEngine:  # (excerpt)
    def copy_venue(self, u: dict, fee_tenths_bp: int | None = None):
        """One Hyperliquid client per customer, rebuilt only when their connection (or the fee to attach) changes.
        Every product pays the same builder fee: the base at the customer's volume or Points tier, never above what they
        approved on Hyperliquid (promo.hl_fee)."""
        from ..live.adapters import HyperliquidVenue
        fee = promo.hl_fee(u, hl.builder_fee_tenths_bp() if fee_tenths_bp is None else fee_tenths_bp)
        fp = (u["address"], u["agent_address"], u["builder_ok"], fee, promo.fee_state(u))
        cached = self.hl_venues.get(u["id"])
        if cached and cached[0] == fp:
            return cached[1]
        if cached:
            self._drop_hl_venue(u["id"])
        builder = hl.builder_address() if u["builder_ok"] else ""
        # a Points fee-free day: the client carries the fee and FreeDayGate takes it off the orders the day's cap covers
        v = promo.gate(self.store, u, "hyperliquid", HyperliquidVenue(u["address"], secretbox.unseal(u["agent_key"]),
                                                                      self.mode != "live", builder, fee if builder else 0))
        self.hl_venues[u["id"]] = (fp, v)
        return v


class HyperliquidVenue:
    """Hyperliquid perps via the official SDK, trading through an API wallet on behalf of the main account."""

    name = "hyperliquid"
    TIMEOUT_S = 10                  # seconds per request to Hyperliquid (connect and read)
    # A client's start reads Hyperliquid's market lists (the same for every customer). When that read found Hyperliquid
    # silent, every other client started within START_BACKOFF_S fails at once instead of waiting ~20 s more each: one
    # engine pass over many customers stays short while the path to Hyperliquid is down (audit R-reliability-01).
    START_BACKOFF_S = 30.0
    _start_failed: dict = {}        # API url -> when a client's start last found Hyperliquid not answering

    def __init__(self, account_address: str, api_private_key: str, testnet: bool = False,
                 builder_address: str = "", builder_fee_tenths_bp: int = 0):
        import eth_account
        import requests
        from hyperliquid.exchange import Exchange
        from hyperliquid.info import Info
        from hyperliquid.utils import constants
        from hyperliquid.utils.error import ServerError

        url = constants.TESTNET_API_URL if testnet else constants.MAINNET_API_URL
        failed = HyperliquidVenue._start_failed.get(url)
        if failed and time.time() - failed < self.START_BACKOFF_S:
            raise ConnectionError("Hyperliquid did not answer a moment ago; Rivemont tries again in a few seconds")
        wallet = eth_account.Account.from_key(api_private_key)
        self.address = account_address or wallet.address
        # every call has a time limit (the SDK's default is none): one silent connection must never hold the engine's
        # loop (stops Rivemont watches, signals, copies, bots) or a web thread with its customer's order lock forever
        try:
            self.info = Info(url, skip_ws=True, timeout=self.TIMEOUT_S)
            self.agent = wallet.address
            meta = self.info.meta()
            self.exchange = Exchange(wallet, url, account_address=self.address, meta=meta, timeout=self.TIMEOUT_S)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout, ServerError):
            HyperliquidVenue._start_failed[url] = time.time()      # silent or down: the next starts fail at once
            raise
        HyperliquidVenue._start_failed.pop(url, None)
        self.sz_decimals = {a["name"]: a["szDecimals"] for a in meta["universe"]}
        # the same builder fee on every order, the builder dexs' markets (HIP-3) included
        self.builder = ({"b": builder_address.lower(), "f": builder_fee_tenths_bp}
                        if builder_address and builder_fee_tenths_bp > 0 else None)
        self._dex_loaded: set[str] = set()

    # ... (market helpers left out) ...

    def _order(self, coin, is_buy, size, px, tif, reduce_only=False):
        s = self._scale(coin)
        r = self.exchange.order(self._name(coin), is_buy, size / s, self._wire_px(coin, px * s), {"limit": {"tif": tif}},
                                reduce_only=reduce_only, builder=self.builder)
        return r["response"]["data"]["statuses"][0] if r.get("status") == "ok" else {"error": str(r)}

    # ... (left out) ...

    def place(self, coin, is_buy, size, px, tif="Gtc", reduce_only=False, cloid=None) -> dict:
        """Limit order (tif Alo = post-only, Gtc, Ioc) tagged with our client order id, builder fee attached."""
        s = self._scale(coin)
        r = self.exchange.order(self._name(coin), is_buy, self._wire_sz(coin, size), self._wire_px(coin, px * s),
                                {"limit": {"tif": tif}}, reduce_only=reduce_only, cloid=self._cl(cloid), builder=self.builder)
        return self._placed(r, s)

    def place_trigger(self, coin, is_buy, size, trigger_px, tpsl, cloid=None) -> dict:
        """Reduce-only take-profit / stop-loss held by Hyperliquid itself: it fires even if our server is down. It
        executes as a market order once the mark price reaches trigger_px (at most 10% slippage). Both the trigger and
        that 10% limit go out on Hyperliquid's tick (_wire_px)."""
        s = self._scale(coin)
        tp = self._wire_px(coin, trigger_px * s)
        limit = self._wire_px(coin, tp * (1.1 if is_buy else 0.9))
        r = self.exchange.order(self._name(coin), is_buy, self._wire_sz(coin, size), limit,
                                {"trigger": {"triggerPx": tp, "isMarket": True, "tpsl": tpsl}},
                                reduce_only=True, cloid=self._cl(cloid), builder=self.builder)
        return self._placed(r, s)

