# Lenders Snapshot UI

Static Vite + React + TypeScript UI for browsing Silo lender snapshots. Each snapshot category (e.g. `stream`) is rendered under its own path and bundled from its per-category `scripts/lender-snapshot/data/<slug>.json` file.

The app performs no runtime RPC, subgraph, or API calls. Snapshot data is imported into the Vite bundle at build time.

## Overview

This application helps lenders review balances used to prepare recovery submissions related to the Stream Finance default. It covers three snapshot categories: Stream, Trevee, and Pendle. SiloDAO uses the Stream balances to submit recovery positions on behalf of affected lenders, while Trevee and Pendle lenders should use the relevant project instructions for their recovery process.

For each lender, the application starts with the value of their position at a fixed snapshot moment. It then accounts for later deposits, withdrawals, transfers, borrowing activity, repayments, managed-vault fee share flows, and any distributions already received. The result is shown as the **Net Deposited Assets**.

The calculations are prepared before the application is built. The browser only displays the resulting snapshot files and does not fetch live blockchain data. The detailed methodology and its important limitations are described below.

## How net deposited assets are calculated

### 1. Starting balance

Each market is measured at a fixed snapshot moment. Markets on different networks use different block numbers matched to the same point in time.

For a direct lender, the starting balance is the value that could have been redeemed from their collateral position at that moment. For someone who deposited through a managed vault, it is their proportional share of the amount that the vault had lent into that market.

Vault contracts are not treated as recovery recipients. Their balances are assigned to the underlying depositors whenever those depositors can be identified.

### 2. Activity after the snapshot

The starting balance is adjusted for activity between the snapshot and the end of the review period:

- deposits and incoming transfers increase the net deposited assets;
- withdrawals and outgoing transfers reduce it;
- in markets that also include borrowing, outstanding debt at the snapshot and later borrows reduce the net deposited assets, while repayments increase it.

Deposits and withdrawals use the asset amounts recorded in their transactions. Peer-to-peer share transfers are different: the on-chain `Transfer` event records only a share quantity (no asset amount), so the scanner converts those shares to assets manually at the **snapshot-block exchange rate** — not at the rate on the transfer's own block.

For the three Stream markets that allowed borrowing xUSD, outstanding debt, borrows, and repayments are **not** taken one-to-one against the lending asset. Each xUSD amount is valued at the Silo debt oracle for that market (`quote` at the relevant block). The oracle returns a Silo Virtual Asset amount, which is treated as a USDC substitute and scaled into the lending asset's ledger decimals. Collateral assets (USDC / scUSD) remain one-to-one. The public breakdown shows `{xUSD amount} × {oracle price} = {valued amount}` for those rows.

- For a direct lender (silo collateral shares):
  `assets = silo.total_assets × shares ÷ silo.collateral_total_supply`
  using the silo's `total_assets` and `collateral_total_supply` stored at the snapshot block.
- For a vault depositor (vault shares attributed to this silo):
  `assets = vault.vault_silo_assets × shares ÷ vault.vault_total_supply`
  using that vault's snapshot position in this silo and its total share supply at the snapshot block.

Mint and burn transfers (`from` or `to` is the zero address) are not counted as ordinary transfers; they accompany deposits and withdrawals and are already covered by those events. On managed vaults, a mint that does not pair with a deposit is treated as a fee share mint instead (see below).

In simple terms:

```text
Net Deposited Assets =
  starting balance
    - outstanding debt at the snapshot
    + deposits + incoming transfers + repayments
    + received fees + fee in
    - withdrawals - outgoing transfers - new borrows
    - distributions already received
    - fee compensation
```

where deposits / withdrawals come from event asset amounts, debt / borrows / repayments on two-sided Stream markets use oracle-valued amounts as described above, and incoming / outgoing transfers are the share amounts converted with the snapshot-rate formulas above. Fee credits and fee compensation apply only to managed-vault depositors.

Debt, borrowing, and repayment adjustments apply only to the relevant Stream markets.

### 3. Managed vault fee shares

Silos do not mint fee shares; managed vaults may. A vault fee mint is a share mint to a recipient with no paired deposit. Those shares may later be forwarded to another address via an ordinary peer transfer.

The calculation credits fee share mints as **received fee**, and reclassifies peer transfers that consume those fee shares as **fee in** (instead of ordinary transfer in). The same fee credit amount is then subtracted once as **fee compensation**, clamped so that this subtraction alone cannot create a negative net deposited assets balance:

```text
fee compensation = min(max(balance before compensation, 0), received fees + fee in)
```

Fee rows appear in the lender's operation history. Accrued vault interest itself is still not added as a separate positive entry; only the fee-share bookkeeping described above is tracked.

### 4. Distributions already received

If a lender has already received an eligible distribution, that amount is deducted to avoid counting the same value twice. These deductions are applied across the Trevee, Pendle, and Stream categories in that order. The final applicable category absorbs any remaining deduction, which can produce negative net deposited assets.

### 5. What the application shows

**Deposited Assets** is the lender's starting balance at the snapshot moment. **Net Deposited Assets** is the final value after all tracked adjustments. Expanding a lender row shows the individual operations used in the calculation, including fee rows where applicable.

The generated data stores Net Deposited Assets under the internal name `pending_assets`. Both names refer to the same value.

### Important limitations and disclaimers

- Interest earned after the snapshot moment is not included. Negative net deposited assets may therefore reflect interest timing or over-accrual related to the Stream Finance incident.
- In some borrowing markets, an asset depeg and sharply higher interest rates allowed borrowers to take out more than their snapshot collateral was worth. A negative result can therefore be a valuation-timing effect rather than evidence of missing data.
- Managed vault fee share mints and fee-forwarding transfers are tagged and compensated as described above. Accrued vault interest is still not added as its own operation.
- Transfers are valued with the snapshot-block share-to-asset formulas above (not the exchange rate at the transfer's block). Deposits and withdrawals use the actual asset amounts recorded in their transactions. On two-sided Stream markets, xUSD debt, borrows, and repayments are valued with the Silo debt oracle at the relevant block (Silo Virtual Asset as a USDC substitute), not one-to-one.
- When a vault lends into several markets, its remaining net deposited assets may be assigned to one market for calculation purposes only.
- Some vaults cannot provide a complete depositor list. Their assets are still displayed, but individual depositors may not be shown.
- Share creation and removal that happen as part of deposits and withdrawals are not counted as separate transfers, which prevents the same activity from being applied twice.
- A small number of economically immaterial contract positions do not follow the standard vault accounting model. These known cases are identified explicitly and reported as validation warnings; any change to them causes validation to fail.
- The data collection process can be repeated to capture additional activity. Rare infrastructure gaps may still exist; the operator-level limitations and validation rules are documented in [`scripts/lender-snapshot/README.md`](scripts/lender-snapshot/README.md).

## Features

- Chain and silo browsing for bundled snapshot data.
- Direct lender and vault depositor tables with address filtering and sortable shares, deposited assets, and net deposited assets.
- Operation breakdown with fee rows (`received fee`, `fee in`, `fee compensation`) and a Fee filter where applicable.
- Explorer links for supported chains.
- Vault warning cards when depositors cannot be enumerated.
- CSV export for lenders and vault depositors.

## Development

```bash
npm ci
npm run lint
npm run type-check
npm run build
npm run dev
```

## Automation

- `ci.yml` runs lint, type-check, and build on PRs to `master`.
- `deploy-pages.yml` builds and deploys the static Vite app to GitHub Pages.
- `version-bump.yml` sets `package.json` (and the lockfile) to the version in the `release/X.Y.Z` or `hotfix/X.Y.Z` branch name on PRs to `master`; non-release PRs fall back to an automatic patch bump.
- `snapshot-scan.yml` manually generates a fresh snapshot release asset.
- `snapshot-qa.yml` validates PR changes to `scripts/lender-snapshot/data/*.json`.

## Snapshot tooling

Python tooling lives in `scripts/lender-snapshot/`.


# Recovery

## Stream Finance recovery

SiloDAO has submitted recovery submissions through its legal counsel on behalf of affected lenders. Users do not need to submit individual submissions. For transparency, all submitted Net Deposited Assets are publicly available through the Lender Snapshots UI and the exported balances spreadsheet:
- Lender Snapshots UI: https://silo-finance.github.io/lenders-snapshot/
- Submitted Claims Export: [stream-all-claims.csv](/csv/stream-all-claims.csv)
