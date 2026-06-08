#!/usr/bin/env python3
"""
QA check for the lender snapshot.

Purely validates the produced JSON (no RPC / no subgraph) by asserting the
share-sum invariants against the stored total supplies, with ZERO tolerance
(exact equality to 1 wei):

  - sum(direct_lenders[].collateral_shares) == collateral_total_supply
  - for each indexed vault with in_withdraw_queue == true:
        sum(depositors[].vault_shares) == vault_total_supply

Any non-zero difference is an error and yields a non-zero exit code, with an
expected/actual/diff report per contract.

Vaults flagged vault_not_indexed or with in_withdraw_queue == false are reported
as warnings (their depositors are intentionally not enumerated), not errors.

Optional: --verify-onchain re-reads the *_total_supply values from each chain at
the snapshot block (reuses the main script's per-chain RPC client / Multicall
layer) to confirm the stored totals match the chain.

    python3 scripts/tasks/lender-snapshot/qa_check.py
    python3 scripts/tasks/lender-snapshot/qa_check.py --verify-onchain
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_JSON = SCRIPT_DIR / "distribution_snapshot.json"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="QA check for lender snapshot JSON.")
    p.add_argument("--json", type=Path, default=DEFAULT_JSON, help="Snapshot JSON file.")
    p.add_argument("--chain", action="append", default=[], help="Optional chain filter (repeatable).")
    p.add_argument(
        "--verify-onchain",
        action="store_true",
        help="Re-read *_total_supply from chain at the snapshot block and compare.",
    )
    return p.parse_args()


def to_int(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("unexpected bool")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise ValueError(f"cannot parse integer from {value!r}")


class Report:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.checks = 0

    def check_equal(self, label: str, expected: int, actual: int) -> None:
        self.checks += 1
        diff = actual - expected
        if diff == 0:
            print(f"[OK]   {label}: {actual}")
            return
        self.errors += 1
        print(f"[FAIL] {label}: expected={expected} actual={actual} diff={diff:+d}")

    def warn(self, label: str) -> None:
        self.warnings += 1
        print(f"[WARN] {label}")


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
        if entry.get("address_type") != "silo_vault":
            continue
        vaults_obj = silo.get("vaults", {})
        if not isinstance(vaults_obj, dict):
            vaults_obj = {}
        vault_keys = {str(addr).lower() for addr in vaults_obj}
        if lender_addr.lower() not in vault_keys:
            report.warn(f"{prefix} silo_vault {lender_addr} missing matching vaults entry")

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
    if not args.json.exists():
        print(f"[FAIL] snapshot JSON not found: {args.json}")
        return 1

    root = json.loads(args.json.read_text(encoding="utf-8"))
    if not isinstance(root, dict):
        print("[FAIL] snapshot JSON root must be an object")
        return 1

    chain_filter = {c.strip().lower() for c in args.chain} if args.chain else set()
    report = Report()

    for chain, chain_obj in root.items():
        if chain_filter and chain.lower() not in chain_filter:
            continue
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos", {})
        if not isinstance(silos, dict):
            continue
        for silo_addr, silo in silos.items():
            if isinstance(silo, dict):
                check_silo(chain, silo_addr, silo, report)

    if args.verify_onchain:
        print()
        print("[verify-onchain] re-reading total supplies from chain ...")
        verify_onchain(root, chain_filter, report)

    print()
    print(f"Checks: {report.checks}  Warnings: {report.warnings}  Errors: {report.errors}")
    if report.errors == 0:
        print("[OK] QA passed (zero tolerance)")
        return 0
    print("[FAIL] QA failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
