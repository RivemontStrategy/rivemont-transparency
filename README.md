# Rivemont transparency code

Rivemont ([rivemont.xyz](https://rivemont.xyz)) is a site for building, backtesting and running trading bots on
Hyperliquid. Your money stays in your own Hyperliquid account: you sign in with your wallet, approve a trade-only API
wallet, and Rivemont earns a builder fee on the fills it sends (from 0.1%, lower with your 30-day volume).

This repository publishes the parts of Rivemont that touch your wallet and your money, **so anyone can verify how
signing, fees and withdrawals work**. It is a source-available excerpt of the live code, not the full product: the
trading engine, the bot logic on the server, the backtester, account storage and the rest of the site are not here.

## What is here, and what each part shows

| Folder | What it shows |
| --- | --- |
| [`signing/`](signing) | Exactly what your wallet is asked to sign. The server builds each Hyperliquid action itself (`hl_actions.py` `build_action`), and when the signature comes back it rebuilds the expected action and refuses any difference: another agent or builder address, a higher fee rate, another network, a nonce older than 10 minutes (`check_action`). The API wallet approval (`approveAgent`) lets Rivemont place orders only; Hyperliquid does not let an API wallet withdraw. The sign-in message is EIP-4361 (`signin.py`): it names the site's domain and your address, each nonce is single use, bound to the exact text, and expires in 5 minutes. |
| [`fees/`](fees) | Which fee your orders carry. The base is 0.1% per fill and can never exceed Hyperliquid's 0.1% perps maximum (`builder_fee.py`). It drops with your 30-day volume (`volume.py`: 0.100% / 0.085% / 0.070% / 0.055% / 0.040% at $0 / $500K / $2.5M / $10M / $50M) or your Points tier, whichever is lower, never both (`tiers.py`). It is then capped at the `maxBuilderFee` you approved on Hyperliquid (`approved_cap`, `hl_fee`): an account that approved 0.05% pays at most 0.05%. `attach_excerpt.py` shows where that number is attached to every order. No builder fee is attached before you approve one. |
| [`withdraw/`](withdraw) | That money only goes back to you. A withdrawal's destination is always the wallet that connected the account, taken from the account, never from the request (`hl_withdraw.py` `build_withdraw`); the signed withdrawal is rebuilt and compared field by field, and must be signed by that same wallet (`check_withdraw`, `routes_excerpt.py`). USDC moves between Hyperliquid market groups stay inside the same account (`build_dex_move` / `check_dex_move`). Amounts are signed to the exact cent you typed. `balance_guard.py` is the "how much may leave now" check, run before and after you sign. |
| [`web/wallet/`](web/wallet) | The browser side. `wallet.js` is the one module that talks to your wallet (EIP-6963 injected wallets and WalletConnect). `hl-wallet-flows.js` holds the sign-in, approval and withdrawal flows: before your wallet is asked to sign, the page checks the server's answer again (right action type, network, chain id, fresh nonce, your own address as destination, the configured builder and at most 0.1%), and refuses to ask the wallet otherwise. |
| [`web/bot-setup/`](web/bot-setup) | The bot setup front end: the guided setup at `/bots/new` (`bot-flow.js`), the bot panel, presets and backtest display (`terminal-bots.js`, `terminal-core.js`), the chart adapter (`chart-adapter.js`) and the styles (`ws.css`, `bot-flow.css`). |
| [`tests/`](tests) | The unit tests for the above, copied from the live repository and adapted to this layout. |

### How it maps to the live site

| On rivemont.xyz | Code here |
| --- | --- |
| **Connect wallet** / Log in | `web/wallet/hl-wallet-flows.js` (sign-in), `signing/signin.py`, `signing/routes_excerpt.py` (`/api/auto/login/start`, `/api/auto/login`) |
| **Wallet & exchanges**: approve the API wallet, approve the fee | `web/wallet/hl-wallet-flows.js` (`checkHLApproval`, `approve`), `signing/hl_actions.py`, `signing/routes_excerpt.py` (`/api/auto/prepare`, `/api/auto/submit`) |
| **Withdraw** from Hyperliquid, **Move** USDC between market groups | `web/wallet/hl-wallet-flows.js` (`wdHLCore`, `hdxCheck`, `hlDexMove`), `withdraw/`, `withdraw/routes_excerpt.py` (`/api/auto/withdraw`, `/api/auto/hl/dex-move`) |
| **Fees** (`/help/fees`), the fee shown next to every bot | `fees/` |
| **New bot** (`/bots/new`), the Bot terminal | `web/bot-setup/` |

### Notes for readers

- **Excerpts.** Files named `*_excerpt.py` are copied from the server's HTTP router and trading engine for reading
  only; they refer to names from the rest of the server (the account store, the router, request models) and are not
  importable here. Lines left out of them are marked `[left out]`. Everything else under `signing/`, `fees/` and
  `withdraw/` is importable and tested.
- **One server module, three files.** On the server, the Hyperliquid actions, the fee cap and the withdrawals live in
  one module (`radar/auto/hl.py`), referred to as `hl` in the excerpts. Here it is split into `signing/hl_actions.py`,
  `fees/builder_fee.py` and `withdraw/hl_withdraw.py`; the code is unchanged apart from imports, comments, and a
  request-rate limiter left out of `_info`.
- **Configuration, not constants.** The builder address is read from `AUTO_BUILDER_ADDRESS` (the address is the one
  your wallet shows in the approval request), the network from `AUTO_MODE` (`live` = mainnet), the base fee from
  `AUTO_BUILDER_FEE_TENTHS_BP` (clamped to 0-100). The tests use placeholder addresses.
- **The front end does not run on its own.** The files under `web/` are the live scripts and stylesheets, but they run
  inside the app's pages, which provide the server's APIs, the account state, translations, and vendored libraries
  (KLineChart for charts, the WalletConnect provider). They are published to be read and audited; the Node tests run
  their pure parts with those names mocked.
- This is a snapshot of the code running on rivemont.xyz on the date in [CHANGELOG.md](CHANGELOG.md). It will be
  updated when these parts change.

## Running the tests

Python 3.10+ and Node 18+:

```sh
pip install -r requirements.txt
python -m pytest            # 50 tests: signing, fees, withdrawals
npm test                    # 6 Node test files: wallet module, approval and withdrawal checks, bot setup
```

`pip install hyperliquid-python-sdk==0.24.0` additionally checks Rivemont's signatures byte for byte against the
official Hyperliquid SDK (`tests/test_signing.py::test_signature_matches_official_sdk`; skipped without it).

## License and security

Source-available under the [Business Source License 1.1](LICENSE): you may read, copy, modify and redistribute this
code for non-production use. On 2030-10-08 (or four years after a version's publication, if earlier) it converts to
the Apache License 2.0.

To report a vulnerability, see [SECURITY.md](SECURITY.md) (contact@rivemont.xyz).
