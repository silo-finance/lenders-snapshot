# Lender snapshot

Builds block-pinned snapshots of all lenders for configured Silos, splitting them into:

- **direct lenders** – every account holding collateral shares of the Silo, and
- **SiloVault depositors** – holders of any SiloVault that itself lends into the Silo, attributed by their share of the vault.

Redeemable `assets` per address are computed purely via on-chain `previewRedeem` at the snapshot block. The subgraph is only used to enumerate addresses (lenders of the Silo and depositors of each vault).

After the snapshot is assembled, the script also scans post-snapshot events (`snapshot_block + 1` through the configured `events_to_block`) on:

- the Silo contract (for direct lenders), and
- each indexed vault contract (for vault depositors), and
- the paired borrow/repay Silo for configured two-sided markets.

It records `Withdraw(...)`, `Deposit(...)`, and peer-to-peer share `Transfer(...)` events to reconcile post-snapshot position changes. For two-sided markets it also records `Borrow(...)` and `Repay(...)` events and deducts the borrower's `debt_at_snapshot`. These flows are merged into the same per-category `data/<slug>.json` consumed by the UI (`total_withdrawals`, `total_deposits`, `total_transfers_in`, `total_transfers_out`, `total_borrows`, `total_repays`, `debt_at_snapshot`, `pending_assets`, and their per-event breakdowns).

Withdrawal attribution differs by lender type:

- **direct lenders:** the raw on-chain `Withdraw` event `assets` (a silo-level withdrawal in the silo asset) is subtracted directly from `assets_collateral`.
- **vault depositors:** a SiloVault can lend into several silos, and one vault `Withdraw` burns vault shares for the vault's *total* underlying across all of them. Subtracting the raw event assets from every silo entry would both double-count across silos and credit withdrawals to silos where the vault held nothing at the snapshot block. Instead, the burned vault shares are valued at the snapshot per-share rate and translated into the assets attributable to **this** silo: `assets = vault_silo_assets * shares_burned / vault_total_supply`. This scales each silo by its own position (no cross-silo double counting) and yields `0` for silos where the vault held nothing/dust at the snapshot block, so a depositor can never show withdrawals exceeding a zero snapshot position.

For vault depositors, each `withdrawals[]` entry also keeps the raw on-chain amount for reference (`vault_assets`); only `assets` reduces `pending_assets`.

## Layout

- `snapshot_lenders.py` – main script that produces one `data/<category>.json` per category.
- `apply_airdrops.py` – idempotent post-processor that applies configured off-chain distributions to pending balances across Trevee, Pendle, and Stream. The main scanner invokes it after all requested categories are scanned; it can also be run independently with `python3 apply_airdrops.py`.
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

# Reapply the configured airdrops without rescanning on-chain data:
python3 scripts/lender-snapshot/apply_airdrops.py

# Validate the JSON invariants for all data/*.json (zero tolerance, exact wei equality):
python3 scripts/lender-snapshot/qa_check.py

# Validate a specific file:
python3 scripts/lender-snapshot/qa_check.py --json scripts/lender-snapshot/data/stream.json

# Optionally re-confirm stored total supplies against the chain:
python3 scripts/lender-snapshot/qa_check.py --verify-onchain
```

Re-running for the same Silo **merges (unions)** its flow events into the existing entry rather than overwriting: recorded `withdrawals[]` / `deposits[]` / `transfers[]` are combined and de-duplicated (by `tx_hash`+`log_index`[+`direction`]) and the derived totals are recomputed. This is deliberate — the RPC endpoint is load-balanced and `eth_getLogs` can silently return an **incomplete** set of logs for a range (identical queries hit different backends and return different counts), so a plain overwrite could let an unlucky run replace a more complete result with a smaller one. Because writes are append-only per event, repeating the run can only ever grow the recorded set; other Silos and chains are preserved. **To start clean, delete the category's `data/<slug>.json`.**

## Airdrop cascade

Configured airdrops are matched by recipient address and applied in category order:
**Trevee → Pendle → Stream**. If an address is absent from Trevee, processing starts
at the first later category where a compatible position exists.

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
            "debt_at_snapshot": "…",      // two-sided markets only
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
            "borrows": [ { "...": "..." } ],
            "repays": [ { "...": "..." } ],
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
                "pending_assets": "…",
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
- for each lender/depositor (exact, signed, NOT clamped to zero): `pending_assets == base_assets - debt_at_snapshot + total_deposits + total_transfers_in + total_repays - total_withdrawals - total_transfers_out - total_borrows - total_airdrops`
- for each lender/depositor: `sum(withdrawals[].assets) == total_withdrawals`, `sum(deposits[].assets) == total_deposits`, `sum(transfers[in].assets) == total_transfers_in`, `sum(transfers[out].assets) == total_transfers_out`, `sum(airdrops[].assets) == total_airdrops`

Vaults with `status == vault_not_indexed` or `in_withdraw_queue == false` are reported as warnings (their depositors are intentionally not enumerated), not errors.

## Known limitations & disclaimers

- **RPC log completeness.** The Sonic RPC is load-balanced and `eth_getLogs` can silently return a *partial* log set for a block range (identical queries hit different backends — some pruned to ~block 63.2M — and return different counts, with no JSON-RPC error). Mitigations: (a) flows are unioned across runs (see [Usage](#usage)), so repeated runs can only grow the recorded set; and (b) `qa_check.py` reconciles each account in shares and hard-fails on a negative residual (more shares left than the account ever held ⇒ a missed inflow). **Caveat:** a dropped inflow whose residual stays ≥ 0 is *not* detected by QA. A `balanceOf`-based reconciliation (walking each lender's on-chain balance and bisecting against the recorded events) can locate such gaps deterministically if stronger guarantees are needed.
- **SiloVault contract rows are not distribution recipients.** A direct-lender with `address_type == silo_vault` is never credited directly; its holders are attributed via that vault's `depositors`. Silo-level `Deposit`/`Withdraw`/`Transfer` events performed by vault addresses are treated as vault rebalances and skipped.
- **Mint/burn transfers are excluded** from the peer-`Transfer` scan (mint `from==0x0`, burn `to==0x0`): they accompany `Deposit`/`Withdraw` and counting them would double-count.
- **Accepted unreconciled residuals.** A few contract accounts have share residuals that don't reconcile under the ERC4626 model even with complete data (their `Deposit`/`Withdraw`-event shares differ from the actual mint/burn amounts, or fee shares are minted with no paired `Deposit`). These are net-zero / economically immaterial contract positions, pinned exactly in `KNOWN_FEE_MINT_RESIDUALS` (exact identity **and** residual) and surfaced as warnings; any change to the identity or amount re-triggers a hard error.
