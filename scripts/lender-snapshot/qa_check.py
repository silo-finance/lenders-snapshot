#!/usr/bin/env python3
"""
QA check for the lender snapshot.

Purely validates the produced JSON (no RPC / no subgraph) by asserting the
share-sum invariants against the stored total supplies, with ZERO tolerance
(exact equality to 1 wei):

  - sum(direct_lenders[].collateral_shares) == collateral_total_supply
  - for each indexed vault with in_withdraw_queue == true:
        sum(depositors[].vault_shares) == vault_total_supply
  - for each lender/depositor (exact, signed, NOT clamped to zero):
    pending_assets == base_assets - debt_at_snapshot + total_deposits + total_transfers_in
                      + total_fee_credits + total_repays - total_withdrawals - total_transfers_out
                      - total_borrows - total_airdrops - fee_compensation
    where total_fee_credits = total_received_fees + total_fee_in (vault depositors; else 0)
    and fee_compensation == min(max(pending_before_compensation, 0), total_fee_credits)
    (total_borrows/total_repays/debt_at_snapshot are 0 except on two-sided-market lenders)
  - for each lender/depositor:
    sum(withdrawals[].assets) == total_withdrawals
    sum(deposits[].assets) == total_deposits
    sum(transfers[in].assets) == total_transfers_in
    sum(transfers[out].assets) == total_transfers_out
    sum(borrows[].assets) == total_borrows      (two-sided markets)
    sum(repays[].assets) == total_repays        (two-sided markets)
    sum(airdrops[].assets) == total_airdrops
  - two-sided markets, chronological sanity (WARNING only): replaying a lender's flows in
    (block, log_index, tx) order with net borrow seeded from debt_at_snapshot, cumulative
    net borrow exceeding cumulative collateral basis is flagged (distressed/incident
    positions can be legitimately underwater, so this warns rather than errors).

Any non-zero difference in the above is an error and yields a non-zero exit code,
with an expected/actual/diff report per contract.

Negative pending policy (share-based): shares are the conserved quantity (assets drift
with accrued interest, shares do not). For each lender/depositor we reconcile in shares:

    share_residual = base_shares + sum(deposits.shares) + sum(transfers_in.shares)
                     - sum(withdrawals.shares) - sum(transfers_out.shares)

  - share_residual < -SHARE_DUST is physically impossible (more shares moved out than the
    account ever held): it flags a missed inflow / unreconciled flow and is a HARD error --
    UNLESS the position is economically moot (base_assets == 0 and pending_assets == 0, e.g.
    a vault whose attributed assets in this silo are 0 so every flow values to 0 assets), in
    which case the share mismatch carries no distribution value and is only a WARNING; OR the
    (chain, silo, vault, account) identity with that EXACT share_residual is in the pinned
    KNOWN_FEE_MINT_RESIDUALS allowlist (accepted gaps deliberately not fixed
    upstream), in which case it is downgraded to a visible WARNING. The pin is exact on both
    identity and residual, so any change re-triggers the hard error; and a pinned entry whose
    chain is scanned but never matched is itself a HARD error (stale-exception guard).
  - share_residual >= 0 with a negative `pending_assets` is an asset-side effect: usually
    interest accrued between the snapshot block and a later full withdrawal, or an airdrop
    deduction that exhausted the final eligible position. That is expected and reported as
    a WARNING, not an error.

SHARE_DUST is overridable via QA_SHARE_DUST (default 0; shares come from raw on-chain
balances/log values and should reconcile exactly).

Vaults flagged vault_not_indexed or with in_withdraw_queue == false are reported
as warnings (their depositors are intentionally not enumerated), not errors.

Optional: --verify-onchain re-reads the *_total_supply values from each chain at
the snapshot block (reuses the main script's per-chain RPC client / Multicall
layer) to confirm the stored totals match the chain.

    python3 scripts/lender-snapshot/qa_check.py
    python3 scripts/lender-snapshot/qa_check.py --verify-onchain
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"

# Negative-pending policy (see module docstring): reconciliation is done in shares, the
# conserved quantity. A negative share residual means more shares left the account than it
# ever held (a missed inflow) and is a hard error; shares come from raw on-chain balances /
# log values, so they should reconcile exactly (default dust 0).
SHARE_DUST = int(os.environ.get("QA_SHARE_DUST", "0"))

# Known, accepted fee-mint unreconciled-share residuals: protocol fee shares minted straight
# to a recipient (Transfer from 0x0) with no paired Deposit, so the flow scan does not credit
# them. Each exception is pinned to the exact identity (chain, silo, vault-or-None, account,
# all lowercase) AND the exact share_residual, so any change (different silo/account, or a
# different share amount after regeneration) fails to match and the hard error returns.
# Currently empty: apply_vault_fees tags fee mints and applies fee_compensation, so the
# previously pinned residuals reconcile and no longer need exceptions.
KNOWN_FEE_MINT_RESIDUALS: dict[tuple[str, str, str | None, str], int] = {}

# Filled in as exceptions are matched, so a stale (no-longer-present) exception can be flagged.
_matched_fee_mint_keys: set[tuple[str, str, str | None, str]] = set()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="QA check for lender snapshot JSON.")
    p.add_argument(
        "--json",
        type=Path,
        action="append",
        default=[],
        help="Snapshot JSON file (repeatable). Defaults to all data/*.json.",
    )
    p.add_argument("--chain", action="append", default=[], help="Optional chain filter (repeatable).")
    p.add_argument(
        "--verify-onchain",
        action="store_true",
        help="Re-read *_total_supply from chain at the snapshot block and compare.",
    )
    return p.parse_args()


def resolve_json_paths(args: argparse.Namespace) -> list[Path]:
    """The explicit --json files, or every data/*.json when none were given."""
    if args.json:
        return list(args.json)
    return sorted(DATA_DIR.glob("*.json"))


def to_int(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("unexpected bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise ValueError(f"cannot parse integer from {value!r}")


def check_flow_sum(label: str, entries: Any, expected_total: int, report: "Report") -> None:
    """Assert sum(entries[].assets) == expected_total (used for withdrawals and deposits)."""
    if not isinstance(entries, list):
        report.warn(f"{label}: flow entries must be an array")
        return
    summed = 0
    for item in entries:
        if not isinstance(item, dict):
            continue
        summed += to_int(item.get("assets", 0))
    report.check_equal(label, expected_total, summed)


def check_transfer_sums(
    label: str,
    transfers: Any,
    expected_in: int,
    expected_out: int,
    report: "Report",
) -> None:
    """Assert sum of 'in'/'out' transfer assets matches total_transfers_in/out."""
    if not isinstance(transfers, list):
        if expected_in or expected_out:
            report.warn(f"{label}: transfers must be an array")
        return
    summed_in = 0
    summed_out = 0
    for item in transfers:
        if not isinstance(item, dict):
            continue
        assets = to_int(item.get("assets", 0))
        if item.get("direction") == "out":
            summed_out += assets
        else:
            summed_in += assets
    report.check_equal(f"{label} transfers_in_sum vs total_transfers_in", expected_in, summed_in)
    report.check_equal(f"{label} transfers_out_sum vs total_transfers_out", expected_out, summed_out)


def share_residual(
    base_shares: int,
    deposits: Any,
    withdrawals: Any,
    transfers: Any,
    fee_mints: Any = None,
    fees: Any = None,
) -> int:
    """Net shares still held per the recorded flows: base + in - out.

    Complete data yields residual >= 0 (the account cannot move out more shares than it ever
    held). A negative residual means an inflow (deposit / transfer-in) was missed upstream.

    Vault fee_mints / fee_in are share inflows (received_fee duplicates fee_mints and is ignored).
    """

    def _sum_shares(items: Any) -> int:
        if not isinstance(items, list):
            return 0
        return sum(to_int(i.get("shares", 0)) for i in items if isinstance(i, dict))

    transfers_in = []
    transfers_out = []
    if isinstance(transfers, list):
        for t in transfers:
            if not isinstance(t, dict):
                continue
            (transfers_out if t.get("direction") == "out" else transfers_in).append(t)

    fee_in_shares = 0
    if isinstance(fees, list):
        for row in fees:
            if isinstance(row, dict) and row.get("kind") == "fee_in":
                fee_in_shares += to_int(row.get("shares", 0))

    return (
        base_shares
        + _sum_shares(deposits)
        + _sum_shares(transfers_in)
        + _sum_shares(fee_mints)
        + fee_in_shares
        - _sum_shares(withdrawals)
        - _sum_shares(transfers_out)
    )


def check_borrow_backing(label: str, base_assets: int, entry: dict[str, Any], report: "Report") -> None:
    """Two-sided sanity: a Borrow can never exceed the collateral backing it up to that point.

    Replays this lender's deposits/withdrawals/transfers/borrows/repays in chronological
    (block_number, log_index, tx_hash) order, tracking cumulative collateral basis and
    cumulative net borrow. Net borrow is seeded with the outstanding debt at the snapshot
    block (maxRepay). At each Borrow, the net borrow so far must not exceed the collateral
    basis so far. With the pre-snapshot debt baseline, distressed/incident positions can
    legitimately be underwater (debt > collateral), so a violation is reported as a WARNING
    (keeps the per-tx diagnostic without blocking CI). All amounts are in this silo's asset
    units. Debt shares are irrelevant here (value-only check).
    """
    debt_at_snapshot = to_int(entry.get("debt_at_snapshot", 0))
    borrows = entry.get("borrows")
    has_borrows = isinstance(borrows, list) and bool(borrows)
    if not has_borrows and debt_at_snapshot == 0:
        return

    events: list[tuple[dict[str, Any], str]] = []

    def _collect(list_key: str, kind: str) -> None:
        rows = entry.get(list_key)
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict):
                    events.append((row, kind))

    _collect("deposits", "deposit")
    _collect("withdrawals", "withdrawal")
    _collect("borrows", "borrow")
    _collect("repays", "repay")
    transfers = entry.get("transfers")
    if isinstance(transfers, list):
        for row in transfers:
            if isinstance(row, dict):
                events.append((row, "transfer-out" if row.get("direction") == "out" else "transfer-in"))

    events.sort(
        key=lambda pair: (
            to_int(pair[0].get("block_number", 0)),
            to_int(pair[0].get("log_index", 0)),
            str(pair[0].get("tx_hash", "")),
        )
    )

    basis = base_assets
    # Seed with the pre-snapshot debt: it is the borrow already outstanding when the walk starts.
    net_borrow = debt_at_snapshot
    if net_borrow > basis:
        report.warn(
            f"{label}: snapshot debt exceeds collateral basis "
            f"(debt_at_snapshot={net_borrow} > collateral_basis={basis})"
        )
    for row, kind in events:
        assets = to_int(row.get("assets", 0))
        if kind in ("deposit", "transfer-in"):
            basis += assets
        elif kind in ("withdrawal", "transfer-out"):
            basis -= assets
        elif kind == "repay":
            net_borrow -= assets
        elif kind == "borrow":
            net_borrow += assets
            if net_borrow > basis:
                report.warn(
                    f"{label}: borrow not backed by collateral at tx {row.get('tx_hash')} "
                    f"(cumulative net_borrow={net_borrow} > collateral_basis={basis})"
                )


def check_pending(
    label: str,
    base_assets: int,
    total_deposits: int,
    total_transfers_in: int,
    total_withdrawals: int,
    total_transfers_out: int,
    pending_assets: int,
    residual_shares: int,
    report: "Report",
    exception_key: tuple[str, str, str | None, str],
    total_borrows: int = 0,
    total_repays: int = 0,
    debt_at_snapshot: int = 0,
    total_airdrops: int = 0,
    total_fee_credits: int = 0,
    fee_compensation: int = 0,
) -> None:
    """Exact signed pending invariant plus the share-based negative-pending policy.

    Borrows/repays and debt_at_snapshot are only present for two-sided markets (converted to
    this silo's asset decimals). They are debt-side quantities and deliberately do NOT enter
    `residual_shares` (which conserves collateral shares).

    Vault fee credits (received_fee + fee_in) and fee_compensation come from apply_vault_fees.
    """
    pending_before = (
        base_assets
        - debt_at_snapshot
        + total_deposits
        + total_transfers_in
        + total_fee_credits
        + total_repays
        - total_withdrawals
        - total_transfers_out
        - total_borrows
        - total_airdrops
    )
    expected_compensation = min(max(pending_before, 0), total_fee_credits)
    report.check_equal(f"{label} fee_compensation", expected_compensation, fee_compensation)
    expected = pending_before - fee_compensation
    report.check_equal(f"{label} pending_assets consistency", expected, pending_assets)
    if residual_shares < -SHARE_DUST:
        # More shares left the account than it ever held: an inflow was missed upstream.
        if base_assets == 0 and pending_assets == 0:
            # Economically moot: e.g. a vault whose attributed assets in this silo are 0, so
            # every flow values to 0 assets. The share bookkeeping does not reconcile, but it
            # carries no distribution value -- warn rather than fail.
            report.warn(
                f"{label}: unreconciled shares on a zero-value position "
                f"(base_assets=0, pending_assets=0, share_residual={residual_shares})"
            )
        elif KNOWN_FEE_MINT_RESIDUALS.get(exception_key) == residual_shares:
            # Pinned, accepted fee-mint exception (exact identity + exact residual). Kept as a
            # visible WARNING so it does not vanish; any change to the residual or identity
            # misses this branch and falls through to a hard error below.
            _matched_fee_mint_keys.add(exception_key)
            report.warn(
                f"{label}: KNOWN accepted fee-mint exception "
                f"(share_residual={residual_shares}); not fixed upstream"
            )
        else:
            report.error(f"{label}: unreconciled shares (missed inflow): share_residual={residual_shares}")
    elif pending_assets < 0:
        # Shares reconcile, so the negative value is an asset-side effect (event-time
        # valuation and/or an airdrop deduction), not evidence of a missed share inflow.
        report.warn(f"{label}: negative pending with reconciled shares ({pending_assets}, share_residual={residual_shares})")


class Report:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.checks = 0
        # Collected messages so they can be replayed as a recap at the end.
        self.error_messages: list[str] = []
        self.warning_messages: list[str] = []

    def check_equal(self, label: str, expected: int, actual: int) -> None:
        self.checks += 1
        diff = actual - expected
        if diff == 0:
            print(f"[OK]   {label}: {actual}")
            return
        self.errors += 1
        msg = f"{label}: expected={expected} actual={actual} diff={diff:+d}"
        self.error_messages.append(msg)
        print(f"[FAIL] {msg}")

    def error(self, label: str) -> None:
        """Record a hard failure that is not an expected/actual numeric comparison."""
        self.errors += 1
        self.error_messages.append(label)
        print(f"[FAIL] {label}")

    def warn(self, label: str) -> None:
        self.warnings += 1
        self.warning_messages.append(label)
        print(f"[WARN] {label}")

    def print_recap(self) -> None:
        """Replay all collected warnings then errors so they are easy to find at the end."""
        print()
        print("=" * 100)
        print(f"RECAP  ({self.warnings} warning(s), {self.errors} error(s))")
        print("=" * 100)

        print()
        print(f"--- WARNINGS ({self.warnings}) " + "-" * 79)
        if self.warning_messages:
            for msg in self.warning_messages:
                print(f"[WARN] {msg}")
        else:
            print("(none)")

        print()
        print(f"--- ERRORS ({self.errors}) " + "-" * 81)
        if self.error_messages:
            for msg in self.error_messages:
                print(f"[FAIL] {msg}")
        else:
            print("(none)")


def check_silo(chain: str, silo_addr: str, silo: dict[str, Any], report: Report) -> None:
    prefix = f"{chain}/{silo_addr}"

    direct = silo.get("direct_lenders", {})
    if not isinstance(direct, dict):
        direct = {}

    collateral_sum = 0
    for entry in direct.values():
        collateral_sum += to_int(entry.get("collateral_shares", 0))

    report.check_equal(
        f"{prefix} collateral_shares_sum vs collateral_total_supply",
        to_int(silo.get("collateral_total_supply", 0)),
        collateral_sum,
    )

    for lender_addr, entry in direct.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("address_type") == "silo_vault":
            # Direct vault rows are not distribution recipients in the UI.
            # They still should map to a vault object under silo.vaults.
            vaults_obj = silo.get("vaults", {})
            if not isinstance(vaults_obj, dict):
                vaults_obj = {}
            vault_keys = {str(addr).lower() for addr in vaults_obj}
            if lender_addr.lower() not in vault_keys:
                report.warn(f"{prefix} silo_vault {lender_addr} missing matching vaults entry")
            continue
        base_assets = to_int(entry.get("assets_collateral", entry.get("total_assets", 0)))
        total_withdrawals = to_int(entry.get("total_withdrawals", 0))
        total_deposits = to_int(entry.get("total_deposits", 0))
        total_transfers_in = to_int(entry.get("total_transfers_in", 0))
        total_transfers_out = to_int(entry.get("total_transfers_out", 0))
        total_borrows = to_int(entry.get("total_borrows", 0))
        total_repays = to_int(entry.get("total_repays", 0))
        total_airdrops = to_int(entry.get("total_airdrops", 0))
        debt_at_snapshot = to_int(entry.get("debt_at_snapshot", 0))
        pending_assets = to_int(entry.get("pending_assets", base_assets))
        residual_shares = share_residual(
            to_int(entry.get("collateral_shares", 0)),
            entry.get("deposits", []),
            entry.get("withdrawals", []),
            entry.get("transfers", []),
        )
        check_pending(
            f"{prefix} lender {lender_addr}",
            base_assets,
            total_deposits,
            total_transfers_in,
            total_withdrawals,
            total_transfers_out,
            pending_assets,
            residual_shares,
            report,
            (chain.lower(), silo_addr.lower(), None, lender_addr.lower()),
            total_borrows=total_borrows,
            total_repays=total_repays,
            debt_at_snapshot=debt_at_snapshot,
            total_airdrops=total_airdrops,
        )
        check_flow_sum(
            f"{prefix} lender {lender_addr} withdrawals_sum vs total_withdrawals",
            entry.get("withdrawals", []),
            total_withdrawals,
            report,
        )
        check_flow_sum(
            f"{prefix} lender {lender_addr} deposits_sum vs total_deposits",
            entry.get("deposits", []),
            total_deposits,
            report,
        )
        check_transfer_sums(
            f"{prefix} lender {lender_addr}",
            entry.get("transfers", []),
            total_transfers_in,
            total_transfers_out,
            report,
        )
        if "borrows" in entry or total_borrows:
            check_flow_sum(
                f"{prefix} lender {lender_addr} borrows_sum vs total_borrows",
                entry.get("borrows", []),
                total_borrows,
                report,
            )
        if "repays" in entry or total_repays:
            check_flow_sum(
                f"{prefix} lender {lender_addr} repays_sum vs total_repays",
                entry.get("repays", []),
                total_repays,
                report,
            )
        if "airdrops" in entry or total_airdrops:
            check_flow_sum(
                f"{prefix} lender {lender_addr} airdrops_sum vs total_airdrops",
                entry.get("airdrops", []),
                total_airdrops,
                report,
            )
        check_borrow_backing(f"{prefix} lender {lender_addr}", base_assets, entry, report)

    vaults = silo.get("vaults", {})
    if not isinstance(vaults, dict):
        vaults = {}
    for vault_addr, vault in vaults.items():
        status = vault.get("status")
        in_queue = bool(vault.get("in_withdraw_queue"))
        indexed = bool(vault.get("indexed_in_subgraph"))
        vlabel = f"{prefix} vault {vault_addr}"

        if not in_queue:
            report.warn(f"{vlabel}: in_withdraw_queue=false (skipped intentionally)")
            continue
        if not indexed or status == "vault_not_indexed":
            report.warn(f"{vlabel}: vault_not_indexed (depositors not enumerated)")
            continue

        if status == "ok" and vault.get("vault_total_supply") is None:
            report.warn(f"{vlabel}: status=ok but vault_total_supply is null")

        depositors = vault.get("depositors", {})
        if not isinstance(depositors, dict):
            depositors = {}
        shares_sum = sum(to_int(d.get("vault_shares", 0)) for d in depositors.values())
        report.check_equal(
            f"{vlabel} vault_shares_sum vs vault_total_supply",
            to_int(vault.get("vault_total_supply", 0)),
            shares_sum,
        )
        for depositor_addr, depositor in depositors.items():
            if not isinstance(depositor, dict):
                continue
            base_assets = to_int(depositor.get("attributed_silo_assets", 0))
            total_withdrawals = to_int(depositor.get("total_withdrawals", 0))
            total_deposits = to_int(depositor.get("total_deposits", 0))
            total_transfers_in = to_int(depositor.get("total_transfers_in", 0))
            total_transfers_out = to_int(depositor.get("total_transfers_out", 0))
            total_airdrops = to_int(depositor.get("total_airdrops", 0))
            total_received_fees = to_int(depositor.get("total_received_fees", 0))
            total_fee_in = to_int(depositor.get("total_fee_in", 0))
            total_fee_credits = to_int(depositor.get("total_fee_credits", total_received_fees + total_fee_in))
            fee_compensation = to_int(depositor.get("fee_compensation", 0))
            pending_assets = to_int(depositor.get("pending_assets", base_assets))
            residual_shares = share_residual(
                to_int(depositor.get("vault_shares", 0)),
                depositor.get("deposits", []),
                depositor.get("withdrawals", []),
                depositor.get("transfers", []),
                fee_mints=depositor.get("fee_mints", []),
                fees=depositor.get("fees", []),
            )
            check_pending(
                f"{vlabel} depositor {depositor_addr}",
                base_assets,
                total_deposits,
                total_transfers_in,
                total_withdrawals,
                total_transfers_out,
                pending_assets,
                residual_shares,
                report,
                (chain.lower(), silo_addr.lower(), vault_addr.lower(), depositor_addr.lower()),
                total_airdrops=total_airdrops,
                total_fee_credits=total_fee_credits,
                fee_compensation=fee_compensation,
            )
            check_flow_sum(
                f"{vlabel} depositor {depositor_addr} withdrawals_sum vs total_withdrawals",
                depositor.get("withdrawals", []),
                total_withdrawals,
                report,
            )
            check_flow_sum(
                f"{vlabel} depositor {depositor_addr} deposits_sum vs total_deposits",
                depositor.get("deposits", []),
                total_deposits,
                report,
            )
            check_transfer_sums(
                f"{vlabel} depositor {depositor_addr}",
                depositor.get("transfers", []),
                total_transfers_in,
                total_transfers_out,
                report,
            )
            if "airdrops" in depositor or total_airdrops:
                check_flow_sum(
                    f"{vlabel} depositor {depositor_addr} airdrops_sum vs total_airdrops",
                    depositor.get("airdrops", []),
                    total_airdrops,
                    report,
                )


def verify_onchain(root: dict[str, Any], chain_filter: set[str], report: Report) -> None:
    """Re-confirm stored *_total_supply against chain at snapshot block."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("snapshot_lenders", SCRIPT_DIR / "snapshot_lenders.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.load_secrets()

    for chain, chain_obj in root.items():
        if chain_filter and chain.lower() not in chain_filter:
            continue
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos", {})
        if not isinstance(silos, dict):
            continue
        rpc_url = mod.resolve_rpc_url(chain)
        for silo_addr, silo in silos.items():
            block = int(silo.get("snapshot_block"))
            rpc = mod.RpcClient(rpc_url, block)
            mc = mod.Multicall(rpc, mod.MULTICALL3, mod.MULTICALL_BATCH)
            res = mc.aggregate([(mod.cs(silo_addr), mod.call_total_supply())])
            chain_collateral = mod.dec_uint(res[0][1]) if res[0][0] else None

            report.check_equal(
                f"[onchain] {chain}/{silo_addr} collateral_total_supply",
                chain_collateral if chain_collateral is not None else -1,
                to_int(silo.get("collateral_total_supply", 0)),
            )

            vaults = silo.get("vaults", {})
            if not isinstance(vaults, dict):
                continue
            for vault_addr, vault in vaults.items():
                if vault.get("status") != "ok" or vault.get("vault_total_supply") is None:
                    continue
                vres = mc.aggregate([(mod.cs(vault_addr), mod.call_total_supply())])
                chain_ts = mod.dec_uint(vres[0][1]) if vres[0][0] else None
                report.check_equal(
                    f"[onchain] {chain}/{silo_addr} vault {vault_addr} total_supply",
                    chain_ts if chain_ts is not None else -1,
                    to_int(vault.get("vault_total_supply", 0)),
                )


def main() -> int:
    args = parse_args()
    json_paths = resolve_json_paths(args)
    if not json_paths:
        print(f"[FAIL] no snapshot JSON files found (looked in {DATA_DIR})")
        return 1

    chain_filter = {c.strip().lower() for c in args.chain} if args.chain else set()
    report = Report()

    checked_chains: set[str] = set()
    for json_path in json_paths:
        if not json_path.exists():
            print(f"[FAIL] snapshot JSON not found: {json_path}")
            report.error(f"snapshot JSON not found: {json_path}")
            continue

        root = json.loads(json_path.read_text(encoding="utf-8"))
        if not isinstance(root, dict):
            print(f"[FAIL] snapshot JSON root must be an object: {json_path}")
            report.error(f"snapshot JSON root must be an object: {json_path}")
            continue

        print()
        print(f"===== validating {json_path.name} =====")
        for chain, chain_obj in root.items():
            if chain_filter and chain.lower() not in chain_filter:
                continue
            if not isinstance(chain_obj, dict):
                continue
            silos = chain_obj.get("silos", {})
            if not isinstance(silos, dict):
                continue
            checked_chains.add(chain.lower())
            for silo_addr, silo in silos.items():
                if isinstance(silo, dict):
                    check_silo(chain, silo_addr, silo, report)

        if args.verify_onchain:
            print()
            print(f"[verify-onchain] re-reading total supplies from chain for {json_path.name} ...")
            verify_onchain(root, chain_filter, report)

    # Stale-exception guard: a pinned fee-mint exception whose chain was fully scanned but was
    # never matched means the underlying residual/identity moved (or was fixed). Fail loudly so
    # the allowlist cannot silently rot -- the entry must be re-verified and re-pinned or removed.
    for key in KNOWN_FEE_MINT_RESIDUALS:
        if key[0] in checked_chains and key not in _matched_fee_mint_keys:
            report.error(
                f"stale fee-mint exception no longer present (re-verify/remove): "
                f"chain={key[0]} silo={key[1]} vault={key[2]} account={key[3]}"
            )

    report.print_recap()

    print()
    print("=" * 100)
    print(f"SUMMARY  Checks: {report.checks}  Warnings: {report.warnings}  Errors: {report.errors}")
    if report.errors == 0:
        print("[OK] QA passed (exact invariants; negative asset-side effects reported as warnings)")
        return 0
    print("[FAIL] QA failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
