# Changelog

## 2026-10-08: first publication

- `signing/`: Hyperliquid approvals (trade-only API wallet, builder fee) built and verified on the server; the wallet
  sign-in message (EIP-4361) and its nonce checks.
- `fees/`: the builder fee (from 0.1% per fill), the 30-day volume tiers, the Points tiers (the lower one applies), and
  the cap at each customer's approved `maxBuilderFee`.
- `withdraw/`: Hyperliquid withdrawals and USDC moves between the account's own market groups, only to the connected
  wallet / the same account; the balance guard.
- `web/`: the browser's wallet module and checks before signing; the bot setup front end (guided setup, bot panel,
  presets, chart adapter, styles).
- `tests/`: 50 Python tests and 6 Node test files, copied from the live repository and adapted to this layout.
