"""Sign in with the wallet: the message the wallet signs (Sign-In with Ethereum, EIP-4361) and the nonces waiting for it.

The message names the site's own domain and the wallet's address, so a wallet shows a sign-in request for rivemont.xyz and
warns when another site asks for it (audit sec-03: the old plain text named no domain, so a phishing page could relay it
and get the victim's key). Each nonce is single use, bound to the exact text Rivemont issued, and expires in five minutes.

Pages loaded before this change ask without an address; until LEGACY_UNTIL they still get the old text, so a sign-in
started in an open tab is not refused; after it they are asked to reload. The old text is
the one a phishing page can relay, so the grace is only the launch deploy's morning: sign-ins pending in memory never
survive a deploy anyway, and "Reload the page" covers every tab left open across it.

signer_of() (at the end) recovers the wallet that signed the text (EIP-191 personal_sign); the sign-in endpoint
(signing/routes_excerpt.py) checks it with Pending.finish() before any account is looked up or made.

Source: radar/auto/signin.py on the live server (signer_of: radar/auto/lighter_link.py).
"""
from __future__ import annotations

import os
import re
import secrets
import threading
import time
from collections import OrderedDict

NONCE_TTL_S = 300
MAX_PENDING = 20_000                # sign-ins started and not finished, at most (the oldest go first)
STATEMENT = "Sign in to Rivemont. This only proves the wallet is yours. It costs nothing and moves no money."
LEGACY_PREFIX = "Sign in to Rivemont\n"
# the old text, for pages loaded before the EIP-4361 message (until LEGACY_UNTIL, RV_LEGACY_SIGNIN_UNTIL overrides: 0
# turns it off at once)
LEGACY_UNTIL = int(os.environ.get("RV_LEGACY_SIGNIN_UNTIL", 1_791_201_600))        # 2026-10-05 12:00 UTC
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")


class SignInError(ValueError):
    pass


def hosts() -> set[str]:
    """The domains a sign-in may name: the brand site's (rivemont.xyz, www) and the app's (app.rivemont.xyz)."""
    from . import site_hosts as h
    out = {x for x in h.brand_hosts() if x}
    if h.app_host():
        out.add(h.app_host())
    return {x.lower() for x in out}


def domain_for(host_header: str | None) -> str:
    """The domain the message names: the host the page was opened on when it is one of ours, else the brand site's."""
    from . import site_hosts as h
    host = (host_header or "").strip().lower()
    ok = hosts()
    if host in ok:
        return host
    return re.sub(r"^https?://", "", h.brand_origin()).split("/")[0].lower()


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(t)))


def chain_id(raw) -> int:
    """The wallet's chain id (hex text or a number); 1 when not given or not a sane one."""
    try:
        cid = int(raw, 16) if isinstance(raw, str) and raw.lower().startswith("0x") else int(raw)
    except (TypeError, ValueError):
        return 1
    return cid if 0 < cid < 2 ** 53 else 1


def message(domain: str, address: str, cid: int, nonce: str, issued: float, ttl: int = NONCE_TTL_S) -> str:
    """EIP-4361 text: domain, checksummed address, statement, URI, version, chain id, nonce, issued and expiry times."""
    from eth_utils import to_checksum_address
    return (f"{domain} wants you to sign in with your Ethereum account:\n{to_checksum_address(address)}\n\n{STATEMENT}\n\n"
            f"URI: https://{domain}\nVersion: 1\nChain ID: {int(cid)}\nNonce: {nonce}\n"
            f"Issued At: {_iso(issued)}\nExpiration Time: {_iso(issued + ttl)}")


def legacy_message(nonce: str) -> str:
    return f"{LEGACY_PREFIX}\nThis only proves the wallet is yours. It costs nothing and moves no money.\n\nnonce: {nonce}"


def nonce_of(text: str) -> str:
    """The nonce a signed text carries ("Nonce: x" in EIP-4361, "nonce: x" in the old text); "" when none."""
    m = re.search(r"(?m)^(?:Nonce|nonce): ([0-9a-f]{8,64})$", text or "")
    return m.group(1) if m else ""


class Pending:
    """Sign-ins started (login/start) and not finished: nonce -> (issued, exact text, address or "" for the old text).
    Bounded: past MAX_PENDING the oldest are dropped, never a scan of all of them (audit sec-05)."""

    def __init__(self, max_items: int = MAX_PENDING, ttl: int = NONCE_TTL_S):
        self.items: OrderedDict[str, tuple[float, str, str]] = OrderedDict()
        self.max_items, self.ttl, self.lock = max_items, ttl, threading.Lock()

    def start(self, host: str | None, address: str = "", cid=None, now: float | None = None) -> str:
        """The text for the wallet to sign. address "" (a page from before EIP-4361): the old text, until LEGACY_UNTIL."""
        now = time.time() if now is None else now
        nonce = secrets.token_hex(12)
        if address:
            if not ADDRESS.fullmatch(address):
                raise SignInError("connect your wallet first")
            text = message(domain_for(host), address, chain_id(cid), nonce, now, self.ttl)
        else:
            if now >= LEGACY_UNTIL:
                raise SignInError("Rivemont was updated. Reload the page, then connect your wallet again.")
            text = legacy_message(nonce)
        with self.lock:
            self.items[nonce] = (now, text, address.lower())
            while self.items:                                   # the expired ones at the front, then the cap
                first = next(iter(self.items.values()))
                if len(self.items) > self.max_items or now - first[0] > self.ttl:
                    self.items.popitem(last=False)
                else:
                    break
        return text

    def finish(self, text: str, signer: str, now: float | None = None) -> None:
        """Check a signed sign-in (its nonce is used up either way): Rivemont's exact text, in time, signed by the wallet
        it names. Raises SignInError."""
        now = time.time() if now is None else now
        nonce = nonce_of(text)
        with self.lock:
            got = self.items.pop(nonce, None) if nonce else None
        if got is None or now - got[0] > self.ttl or text != got[1]:
            raise SignInError("The sign-in request expired. Press Connect wallet again.")
        if not signer:
            raise SignInError("That signature could not be read. Try again.")
        if got[2] and signer.lower() != got[2]:
            raise SignInError("That signature is from another wallet than the one connected. Try again.")
        if not got[2] and now >= LEGACY_UNTIL:
            raise SignInError("Rivemont was updated. Reload the page, then connect your wallet again.")

    def __len__(self):
        return len(self.items)


def signer_of(message: str, signature: str) -> str:
    from eth_account import Account
    from eth_account.messages import encode_defunct
    return Account.recover_message(encode_defunct(text=message), signature=signature).lower()
