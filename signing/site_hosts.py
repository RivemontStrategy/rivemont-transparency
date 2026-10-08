"""The site's own host names, which a wallet sign-in message may name (signing/signin.py).

SITE_URL (default https://rivemont.xyz) is the brand site; RV_APP_HOST optionally a separate app host.
Source: radar/hosts.py on the live server.
"""
from __future__ import annotations

import os
import re


def app_host() -> str:
    """The app's host name ("app.rivemont.xyz"), or "" when the app shares the brand site's host."""
    h = os.environ.get("RV_APP_HOST", "").strip().lower()
    h = re.sub(r"^https?://", "", h).split("/")[0]
    return h if re.fullmatch(r"[a-z0-9.-]{1,253}(?::\d{1,5})?", h or "-") else ""


def brand_origin() -> str:
    return os.environ.get("SITE_URL", "").rstrip("/") or "https://rivemont.xyz"


def app_origin() -> str:
    h = app_host()
    if not h:
        return ""
    scheme = "http" if brand_origin().startswith("http://") else "https"
    return f"{scheme}://{h}"


def brand_hosts() -> set[str]:
    h = re.sub(r"^https?://", "", brand_origin()).split("/")[0].lower()
    return {h, "www." + h.removeprefix("www.")}
