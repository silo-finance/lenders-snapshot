#!/usr/bin/env python3
"""Remove a silo entry from distribution_snapshot.json."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_JSON = SCRIPT_DIR / "distribution_snapshot.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove a silo from the lender snapshot JSON.")
    parser.add_argument("--address", required=True, help="Silo contract address to remove.")
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON, help="Snapshot JSON file.")
    return parser.parse_args()


def normalize_address(address: str) -> str:
    value = address.strip().lower()
    if not value.startswith("0x") or len(value) != 42:
        raise ValueError(f"Invalid silo address: {address}")
    return value


def remove_silo(root: dict, silo_address: str) -> tuple[str, str]:
    normalized = normalize_address(silo_address)
    removed_chain = ""
    removed_key = ""

    for chain, chain_obj in root.items():
        if not isinstance(chain_obj, dict):
            continue
        silos = chain_obj.get("silos")
        if not isinstance(silos, dict):
            continue
        for key in list(silos.keys()):
            if str(key).lower() == normalized:
                del silos[key]
                removed_chain = chain
                removed_key = key
                return removed_chain, removed_key

    raise KeyError(f"Silo address not found in snapshot JSON: {silo_address}")


def main() -> int:
    args = parse_args()
    if not args.json.exists():
        print(f"[FAIL] snapshot JSON not found: {args.json}")
        return 1

    root = json.loads(args.json.read_text(encoding="utf-8"))
    if not isinstance(root, dict):
        print("[FAIL] snapshot JSON root must be an object")
        return 1

    try:
        chain, key = remove_silo(root, args.address)
    except ValueError as exc:
        print(f"[FAIL] {exc}")
        return 1
    except KeyError as exc:
        print(f"[FAIL] {exc}")
        return 1

    args.json.write_text(f"{json.dumps(root, indent=2)}\n", encoding="utf-8")
    print(f"[OK] Removed silo {key} from chain {chain}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
