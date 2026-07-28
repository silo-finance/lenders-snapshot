# Lender snapshot

Builds block-pinned snapshots of all lenders for configured Silos, splitting them into:

- **direct lenders** – every account holding collateral shares of the Silo, and
- **SiloVault depositors** – holders of any SiloVault that itself lends into the Silo, attributed by their share of the vault.

Redeemable `assets` per address are computed purely via on-chain `previewRedeem` at the snapshot block. The subgraph is only used to enumerate addresses (lenders of the Silo and depositors of each vault).

After the snapshot is assembled, the script also scans post-snapshot events (`snapshot_block + 1` through the configured `events_to_block`) on:

- the Silo contract (for direct lenders), and
- each indexed vault contract (for vault depositors), and
- the paired borrow/repay Silo for configured two-sided markets.

It records `Withdraw(...)`, `Deposit(...)`, and peer-to-peer share `Transfer(...)` events to reconcile post-snapshot position changes. For two-sided markets it also records `Borrow(...)` and `Repay(...)` events and deducts the borrower's `debt_at_snapshot` (initially on a decimals-only / par basis). A later post-processor revalues those xUSD debt amounts with the Silo debt oracle (see [Debt pricing](#debt-pricing)). These flows are merged into the same per-category `data/<slug>.json` consumed by the UI (`total_withdrawals`, `total_deposits`, `total_transfers_in`, `total_transfers_out`, `total_borrows`, `total_repays`, `debt_at_snapshot`, `pending_assets`, and their per-event breakdowns).

On vault contracts, mint `Transfer`s (`from == 0x0`) that do not pair 1:1 with a `Deposit` (same owner and share amount) are stored as `fee_mints[]` on the recipient depositor. They do **not** change `pending_assets` during the scan; fee tagging and compensation happen in a later post-processor (see [Vault fees](#vault-fees)).

Withdrawal attribution differs by lender type:

- **direct lenders:** the raw on-chain `Withdraw` event `assets` (a silo-level withdrawal in the silo asset) is subtracted directly from `assets_collateral`.
- **vault depositors:** a SiloVault can lend into several silos, and one vault `Withdraw` burns vault shares for the vault's *total* underlying across all of them. Subtracting the raw event assets from every silo entry would both double-count across silos and credit withdrawals to silos where the vault held nothing at the snapshot block. Instead, the burned vault shares are valued at the snapshot per-share rate and translated into the assets attributable to **this** silo: `assets = vault_silo_assets * shares_burned / vault_total_supply`. This scales each silo by its own position (no cross-silo double counting) and yields `0` for silos where the vault held nothing/dust at the snapshot block, so a depositor can never show withdrawals exceeding a zero snapshot position.

For vault depositors, each `withdrawals[]` entry also keeps the raw on-chain amount for reference (`vault_assets`); only `assets` reduces `pending_assets`.

## Layout

- `snapshot_lenders.py` – main script that produces one `data/<category>.json` per category.
- `apply_airdrops.py` – idempotent post-processor that applies configured off-chain distributions to pending balances across Trevee, Pendle, and Stream. The main scanner invokes it after all requested categories are scanned; it can also be run independently with `python3 apply_airdrops.py`.
- `apply_vault_fees.py` – tags vault fee mints / fee-forwarding transfers and applies fee compensation. The main scanner invokes it after the airdrop cascade; it can also be run independently with `python3 apply_vault_fees.py`.
- `apply_debt_prices.py` – post-processor for Stream two-sided markets: prices xUSD Initial Debt / Borrow / Repay via hardcoded Silo debt oracles (`quote` → Silo Virtual Asset as USDC substitute). USDC/scUSD stays 1:1. Automatically fetches only missing per-block unit quotes into durable `data/debt_oracle_quotes.json` (resume-safe; survives re-running `snapshot_lenders.py`), then applies them into `data/stream.json` once complete. Not invoked by the main scanner; run after snapshot / airdrops / fees.
- `airdrops/` – source CSV files for configured distributions. Only the `Amount sent` column is applied.
- `qa_check.py` – pure-JSON validator (no RPC/graph) that asserts share-sum invariants against the stored total supplies.
- `data/` – generated per-category snapshot files (e.g. `data/stream.json`), imported by the UI.
- `requirements.txt` – Python dependencies (`web3`).
- `.env.example` – template for the required secrets.

## Configuration

Non-secret parameters are hardcoded near the top of `snapshot_lenders.py` in the `CATEGORIES`
dict. Each **category** is a self-contained snapshot rendered under its own path in the UI
(e.g. `/lenders-snapshot/stream`) and written to its own `data/<slug>.json` file. Categories
are intentionally hardcoded: adding one is a rare, deliberate edit.

Each category maps to a list of chain `targets`:

- `chain`, `chain_id`, `subgraph_url`, `block` (the single snapshot block shared by every silo on that chain)
- `events_to_block` (required): the single block up to which post-snapshot events are scanned on that chain. Declared per chain because block numbers are chain-specific, and timestamp-matched across chains so the post-snapshot window ends at the same wall-clock time everywhere. There is no per-silo or env override.
- `block_chunk` (required): the number of blocks per `eth_getLogs` call. It is tuned per chain to stay within the provider's result-count and query-duration limits. There is no per-silo or env override; the scanner auto-halves the range on RPC rejection.
- `silos[]` entries with:
  - `address`
  - optional `type` (`"silo"` default, or `"silo_vault"`)
  - optional `borrow_repay_silo` for the paired debt Silo in a two-sided market

A category may also set an explicit `output` filename (defaults to `<slug>.json`).

`MULTICALL3` address / `MULTICALL_BATCH` and the per-category output directory (`data/`) are
also defined near the top of the script.

The `trevee` and `pendle` categories currently contain Sonic markets. The `stream`
category contains markets on Sonic, Arbitrum, Avalanche, and Ethereum. Snapshot and
event-window blocks are timestamp-matched across chains, so each chain has its own block
numbers for the same wall-clock boundaries.

Secrets are read **only** from the environment (or a local, gitignored `.env`):

- `SONIC_RPC_URL` – archive RPC endpoint for Sonic (must support `eth_call` at the historical block).
- `ARBITRUM_RPC_URL` – archive RPC endpoint for Arbitrum (set when scanning Stream unless `RPC_URL` is used).
- `AVALANCHE_RPC_URL` – archive RPC endpoint for Avalanche (set when scanning Stream unless `RPC_URL` is used).
- `ETHEREUM_RPC_URL` – archive RPC endpoint for Ethereum (set when scanning Stream unless `RPC_URL` is used).
- `RPC_URL` – optional fallback used if a chain-specific URL is not set.
- `THE_GRAPH_API_KEY` – The Graph gateway Bearer token.

```bash
cp scripts/lender-snapshot/.env.example scripts/lender-snapshot/.env
# edit .env and fill the RPC URLs required by the selected category, plus THE_GRAPH_API_KEY
```

The script auto-loads `scripts/lender-snapshot/.env` if present; you can also export the variables in your shell.

## Usage

```bash
python3 -m pip install -r scripts/lender-snapshot/requirements.txt

# Produce / refresh a snapshot for one category (a category slug is REQUIRED;
# writes data/<slug>.json). Scanning is per-category, never implicitly all:
python3 scripts/lender-snapshot/snapshot_lenders.py stream

# You can pass several slugs to scan more than one category in a single run:
python3 scripts/lender-snapshot/snapshot_lenders.py stream pendle

# Resume after an interrupted scan. Flat silo indexes are 0-based in config
# order across all chains. After each successfully written silo the scanner
# prints a hard-to-miss line:
#   >>>>>>>>>> RESUME WITH: --resume-from N  (category=... next=N/T ...) <<<<<<<<<<
# Copy that flag to skip indexes 0..N-1 and continue from N. Assumes the
# category's silo list/order is unchanged since the interrupted run:
python3 scripts/lender-snapshot/snapshot_lenders.py stream --resume-from 4
# Docker:
./scripts/lender-snapshot/run.sh snapshot_lenders.py stream --resume-from 4

# Reapply the configured airdrops without rescanning on-chain data:
python3 scripts/lender-snapshot/apply_airdrops.py

# Retag vault fee mints / fee-forwarding transfers and recompute fee compensation:
python3 scripts/lender-snapshot/apply_vault_fees.py

# Price xUSD debt on Stream two-sided markets (requires archive RPC + ORACLE_BY_DEBT_SILO).
# Fetches only missing quotes into data/debt_oracle_quotes.json, then patches stream.json:
python3 scripts/lender-snapshot/apply_debt_prices.py
# Docker:
./scripts/lender-snapshot/run.sh apply_debt_prices.py

# Validate the JSON invariants for all data/*.json (zero tolerance, exact wei equality):
python3 scripts/lender-snapshot/qa_check.py

# Validate a specific file:
python3 scripts/lender-snapshot/qa_check.py --json scripts/lender-snapshot/data/stream.json

# Optionally re-confirm stored total supplies against the chain:
python3 scripts/lender-snapshot/qa_check.py --verify-onchain
```

Re-running for the same Silo **merges (unions)** its flow events into the existing entry rather than overwriting: recorded `withdrawals[]` / `deposits[]` / `transfers[]` are combined and de-duplicated (by `tx_hash`+`log_index`[+`direction`]) and the derived totals are recomputed. This is deliberate — the RPC endpoint is load-balanced and `eth_getLogs` can silently return an **incomplete** set of logs for a range (identical queries hit different backends and return different counts), so a plain overwrite could let an unlucky run replace a more complete result with a smaller one. Because writes are append-only per event, repeating the run can only ever grow the recorded set; other Silos and chains are preserved. **To start clean, delete the category's `data/<slug>.json`.**

## Vault fees

Managed vaults may mint performance-fee shares to a recipient (a mint `Transfer`
with no paired `Deposit`). Those mints, and later peer transfers that forward the
same fee shares, would otherwise distort claim balances: the recipient looks
under-credited in shares, while a counterparty who received forwarded fee shares
looks over-credited if the transfer is treated as an ordinary inflow.

After the airdrop cascade, `apply_vault_fees.py` runs two passes over every
vault depositor in the snapshot files:

1. **Tag.** Each scanner `fee_mints[]` row becomes a `received_fee` entry in
   `fees[]`. Remaining fee shares on that address are then matched FIFO against
   later transfer-outs; the mirrored transfer-in on the counterparty is reclassified
   from `transfers[]` into `fees[]` as `fee_in` (same `tx_hash` / `log_index`).
   Nested forwarding (`fee_in` followed by a later transfer-out) is reported as a
   non-fatal error and is not re-tagged further.
2. **Recompute.** Totals are rebuilt from the tagged rows. Fee credits
   (`total_received_fees + total_fee_in`) are added into the pending formula,
   then a single `fee_compensation` is subtracted:
   `fee_compensation = min(max(pending_before, 0), total_fee_credits)`.
   That clamp ensures the compensation step alone cannot create a negative
   `pending_assets`.

The post-processor is idempotent (previous fee annotations are cleared before
pass 1). The main scanner invokes it after a successful airdrop cascade; it can
also be run standalone with `python3 apply_vault_fees.py`.

## Debt pricing

On Stream two-sided markets (Sonic USDC/xUSD, Sonic scUSD/xUSD, Arbitrum USDC/xUSD),
the scanner initially stores `debt_at_snapshot`, `borrows[]`, and `repays[]` in the
lending asset's decimals with a **par / one-to-one** assumption. Collateral (USDC /
scUSD) stays that way. xUSD debt is then revalued by `apply_debt_prices.py`:

1. Collect unique blocks that need a price: the silo `snapshot_block` for each
   non-zero `debt_at_snapshot`, and each Borrow / Repay `block_number`.
2. For each required `(chain, debt oracle, xUSD token, block)`, read
   `ISiloOracle.quote(10**decimals, xUSD)` at that block. Hardcoded
   `ORACLE_BY_DEBT_SILO` maps each debt silo to its solvency oracle and token;
   a missing mapping is a hard error. Quotes are stored in durable
   `data/debt_oracle_quotes.json` (only missing keys are fetched; each new quote
   is persisted immediately so an interrupted run keeps progress).
3. Once every required quote is present, rewrite the snapshot: keep the original
   xUSD amount as `debt_at_snapshot_raw` / `assets_raw`, store the unit price, and
   replace `debt_at_snapshot` / `borrows[].assets` / `repays[].assets` with the
   valued ledger amount (oracle quote scaled from 18-dec Silo Virtual Asset into
   the silo's `input_token.decimals`). Recompute `total_borrows`, `total_repays`,
   and `pending_assets`.

Silo Virtual Asset is treated as a **USDC substitute**; there is no second quote
of the collateral asset. Re-running `snapshot_lenders.py` can wipe priced fields
from `stream.json`; re-running `apply_debt_prices.py` re-applies from
`debt_oracle_quotes.json` without RPC unless new blocks appeared. The main
scanner does **not** invoke this step automatically.

## Airdrop cascade

The scanner runs the airdrop cascade only after every configured silo for the
selected categories is complete on disk (`withdrawals_scanned_to_block` at least
the chain's `events_to_block`). An interrupted or partial scan therefore defers
the cascade; finish the remaining silos (optionally with `--resume-from`) or run
`apply_airdrops.py` yourself once the JSON files are complete.

Configured airdrops are matched by recipient address and applied in category order:
**Trevee → Pendle → Stream**. If an address is absent from Trevee, processing starts
at the first later category where a compatible position exists.

An `unmatched` recipient is an address present in the airdrop CSV that is not a
direct lender or vault depositor in any target silo configured for that airdrop.
No claim balance is adjusted for that CSV row. The application log lists the
unmatched address, its CSV amount, and all target silos that were searched.

- ETH allocations use 18-decimal WETH/scETH positions. Stream has no compatible
  ETH position, so Pendle is the final possible category.
- USDC allocations use 6-decimal USD positions: USDC in Trevee/Pendle and
  USDC/scUSD/AUSD/USDt in Stream.

Each category before the final compatible one is capped at the recipient's positive
pending balance. The last compatible category absorbs the remainder and may therefore
end with a negative `pending_assets`. When one allocation is split across categories,
its synthetic `airdrops[]` rows carry `airdrop_part` and `airdrop_parts`; all positions
within the same category share the same part. A single-category allocation has no part
metadata, so the UI displays simply `airdrop` rather than `airdrop 1 of 1`.

## Performance

All historical reads are batched through Multicall3 (`aggregate3` with `allowFailure=true`) via `eth_call` pinned at `BLOCK`. `eth_getCode` (used for contract detection) cannot go through Multicall3 and is issued in JSON-RPC batches instead.

Transient RPC/subgraph failures (`RemoteDisconnected`, connection resets, 429/502/503/504) are retried inside `_http_post_json` with exponential backoff before the scanner aborts.

Before fetching block timestamps, a rescan loads timestamps already stored for all
silos on the same chain in `data/<category>.json`. Only unique blocks without a
valid persisted timestamp trigger `eth_getBlockByNumber`; cached timestamps are
reused to stamp the freshly scanned flow rows and shared across silos in the run.

## Output shape

```jsonc
{
  "<chain>": {
    "chain_id": 146,
    "silos": {
      "<silo_address>": {
        "snapshot_block": 54144258,
        "silo_id": "12",
        "input_token": { "address": "0x..", "decimals": 6, "symbol": "USDC" },
        "total_assets": "…",              // raw integer string from silo.totalAssets()
        "collateral_total_supply": "…",   // raw integer string
        "withdrawals_scanned_to_block": 55000000,
        "borrow_repay_silo": "0x..",      // two-sided markets only
        "direct_lenders": {
          "<addr>": {
            "address_type": "eoa|silo_vault|gnosis_safe|erc4626_unresolved|contract_other",
            "collateral_shares": "…",
            "assets_collateral": "…",
            "total_assets": "…",
            // present for non-vault direct lenders:
            "debt_at_snapshot": "…",      // two-sided; oracle-valued after apply_debt_prices
            "debt_at_snapshot_raw": "…",  // original xUSD amount (after apply_debt_prices)
            "debt_price": "…",            // unit oracle price in ledger units
            "total_withdrawals": "…",
            "total_deposits": "…",
            "total_transfers_in": "…",
            "total_transfers_out": "…",
            "total_borrows": "…",         // two-sided markets only
            "total_repays": "…",          // two-sided markets only
            "total_airdrops": "…",
            "pending_assets": "…",
            "withdrawals": [ { "...": "..." } ],
            "deposits": [ { "...": "..." } ],
            "transfers": [ { "...": "..." } ],
            "borrows": [ { "assets": "…", "assets_raw": "…", "price": "…", "...": "..." } ],
            "repays": [ { "assets": "…", "assets_raw": "…", "price": "…", "...": "..." } ],
            "airdrops": [ { "...": "..." } ]
          }
        },
        "vaults": {
          "<vault_addr>": {
            "name": "…",
            "indexed_in_subgraph": true,
            "in_withdraw_queue": true,
            "status": "ok|vault_not_indexed|not_in_withdraw_queue",
            "vault_silo_assets": "…",
            "vault_total_supply": "…",
            "depositors": {
              "<addr>": {
                "address_type": "…",
                "vault_shares": "…",
                "fraction": "0.1234",
                "attributed_silo_assets": "…",
                "total_withdrawals": "…",
                "total_deposits": "…",
                "total_transfers_in": "…",
                "total_transfers_out": "…",
                "total_airdrops": "…",
                "total_received_fees": "…",   // after apply_vault_fees
                "total_fee_in": "…",
                "total_fee_credits": "…",     // received_fees + fee_in
                "fee_compensation": "…",
                "pending_assets": "…",
                "fee_mints": [ { "...": "..." } ],  // scanner raw; pending applied by apply_vault_fees
                "fees": [
                  { "kind": "received_fee|fee_in|fee_compensation", "...": "..." }
                ],
                "withdrawals": [
                  {
                    "block_number": 54150000,
                    "tx_hash": "0x…",
                    "log_index": 7,
                    "assets": "…",         // snapshot-rate, attributed to this silo (reduces pending)
                    "shares": "…",         // vault shares burned
                    "vault_assets": "…"    // raw vault underlying from the on-chain Withdraw event
                  }
                ],
                "deposits": [ { "...": "..." } ],
                "transfers": [ { "...": "..." } ],
                "airdrops": [ { "...": "..." } ]
              }
            }
          }
        }
      }
    }
  }
}
```

All share/supply amounts are raw integers (as strings, to preserve precision), expressed in the same units as the corresponding `totalSupply`, so that sums match exactly.

## QA invariants

`qa_check.py` enforces, with **zero tolerance** (exact equality to 1 wei):

- `sum(direct_lenders[].collateral_shares) == collateral_total_supply`
- for each indexed vault with `in_withdraw_queue == true`: `sum(depositors[].vault_shares) == vault_total_supply`
- for each lender/depositor (exact, signed, NOT clamped to zero):
  `pending_assets == base_assets - debt_at_snapshot + total_deposits + total_transfers_in + total_fee_credits + total_repays - total_withdrawals - total_transfers_out - total_borrows - total_airdrops - fee_compensation`
  where `total_fee_credits = total_received_fees + total_fee_in` (vault depositors; else 0) and
  `fee_compensation == min(max(pending_before_compensation, 0), total_fee_credits)`
- for each lender/depositor: `sum(withdrawals[].assets) == total_withdrawals`, `sum(deposits[].assets) == total_deposits`, `sum(transfers[in].assets) == total_transfers_in`, `sum(transfers[out].assets) == total_transfers_out`, `sum(airdrops[].assets) == total_airdrops`

Vaults with `status == vault_not_indexed` or `in_withdraw_queue == false` are reported as warnings (their depositors are intentionally not enumerated), not errors.

## Known limitations & disclaimers

- **RPC log completeness.** The Sonic RPC is load-balanced and `eth_getLogs` can silently return a *partial* log set for a block range (identical queries hit different backends — some pruned to ~block 63.2M — and return different counts, with no JSON-RPC error). Mitigations: (a) flows are unioned across runs (see [Usage](#usage)), so repeated runs can only grow the recorded set; and (b) `qa_check.py` reconciles each account in shares and hard-fails on a negative residual (more shares left than the account ever held ⇒ a missed inflow). **Caveat:** a dropped inflow whose residual stays ≥ 0 is *not* detected by QA. A `balanceOf`-based reconciliation (walking each lender's on-chain balance and bisecting against the recorded events) can locate such gaps deterministically if stronger guarantees are needed.
- **SiloVault contract rows are not distribution recipients.** A direct-lender with `address_type == silo_vault` is never credited directly; its holders are attributed via that vault's `depositors`. Silo-level `Deposit`/`Withdraw`/`Transfer` events performed by vault addresses are treated as vault rebalances and skipped.
- **Mint/burn transfers are excluded** from the peer-`Transfer` scan (mint `from==0x0`, burn `to==0x0`): they accompany `Deposit`/`Withdraw` and counting them would double-count. Unmatched vault mint transfers are instead kept as `fee_mints[]` and handled by [Vault fees](#vault-fees).
- **Nested fee forwarding.** If an address receives `fee_in` and later transfers those shares out again, the post-processor logs a non-fatal error and does not reclassify the second hop. Such cases should be rare; they remain visible in the apply_vault_fees log.
- **Accepted unreconciled residuals.** A few contract accounts can still have share residuals that don't reconcile under the ERC4626 model even with complete data (e.g. `Deposit`/`Withdraw`-event shares differ from the actual mint/burn amounts). Economically moot zero-value positions are reported as warnings. Any remaining pinned exceptions live in `KNOWN_FEE_MINT_RESIDUALS` (exact identity **and** residual); the allowlist is currently empty because fee-mint residuals are resolved by `apply_vault_fees`.
