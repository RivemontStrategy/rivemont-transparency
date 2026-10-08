# Changelog

## 2026-10-08: lower fee

- `fees/`: the base Rivemont fee goes from 0.1% to 0.05% per fill (`builder_fee.py` `BASE_TENTHS_BP` = 50 tenths of a
  basis point).
- 30-day volume tiers (`volume.py`): $500K / $2.5M / $10M / $50M become $1M / $5M / $25M, i.e. 0.050% under $1M,
  0.045% from $1M, 0.040% from $5M, 0.035% from $25M. A volume tier kept under the old table never lowers the fee below
  what the stored 30-day volume reaches on the new one (`tier_of`).
- Points tiers (`tiers.py`): Silver / Gold / Platinum go from 0.09% / 0.08% / 0.07% to 0.048% / 0.045% / 0.04% (Bronze
  0.05%). The lower of the volume tier and the Points tier still applies, never both.
- The approval you sign is unchanged: a cap of 0.1% (`signing/hl_actions.py` `MAX_FEE_RATE`). Old 0.05% approvals cover
  every tier, so no re-approval is needed; the re-approve prompt shows only for an approval below the fee due.
- `tests/test_fees.py`: the new tiers, their boundaries, the cap and the old-table clamp (61 Python tests).

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
