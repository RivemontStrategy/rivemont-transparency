"""Shared test setup: the repository root on sys.path, and a test network with a placeholder builder address."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

BUILDER = "0x" + "b1" * 20          # a placeholder: the live builder address is server configuration


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("AUTO_MODE", "testnet")
    monkeypatch.setenv("AUTO_BUILDER_ADDRESS", BUILDER)
    for k in ("AUTO_BUILDER_FEE_TENTHS_BP", "AUTO_BUILDER_MAX_FEE_RATE", "POINTS_S1_START", "POINTS_S1_END",
              "SITE_URL", "RV_APP_HOST"):
        monkeypatch.delenv(k, raising=False)
