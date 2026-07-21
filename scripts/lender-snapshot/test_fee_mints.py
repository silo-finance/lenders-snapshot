#!/usr/bin/env python3
"""Unit tests for vault fee-mint classification (Deposit ↔ mint Transfer matching)."""

from __future__ import annotations

import unittest

from snapshot_lenders import classify_fee_mints


def _dep(tx: str, owner: str, shares: int, log_index: int = 1) -> dict:
    return {
        "tx_hash": tx,
        "owner": owner,
        "shares": shares,
        "block_number": 1,
        "log_index": log_index,
    }


def _mint(tx: str, to: str, shares: int, log_index: int) -> dict:
    return {
        "tx_hash": tx,
        "from": "0x" + "0" * 40,
        "to": to,
        "value": shares,
        "block_number": 1,
        "log_index": log_index,
        "is_mint": True,
    }


class ClassifyFeeMintsTests(unittest.TestCase):
    def test_deposit_matched_mint_excluded(self) -> None:
        owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        deposits = [_dep("0xtx1", owner, 100, 2)]
        mints = [_mint("0xtx1", owner, 100, 1)]
        self.assertEqual(classify_fee_mints(deposits, mints), [])

    def test_unmatched_mint_is_fee(self) -> None:
        fee_to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        mints = [_mint("0xtx1", fee_to, 50, 0)]
        fee = classify_fee_mints([], mints)
        self.assertEqual(len(fee), 1)
        self.assertEqual(fee[0]["value"], 50)

    def test_same_tx_deposit_and_fee_mint(self) -> None:
        owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        fee_to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        deposits = [_dep("0xtx1", owner, 1000, 5)]
        mints = [
            _mint("0xtx1", fee_to, 42, 1),
            _mint("0xtx1", owner, 1000, 4),
        ]
        fee = classify_fee_mints(deposits, mints)
        self.assertEqual(len(fee), 1)
        self.assertEqual(fee[0]["to"], fee_to)
        self.assertEqual(fee[0]["value"], 42)

    def test_fee_recipient_also_deposits_same_tx(self) -> None:
        fee_to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        deposits = [_dep("0xtx1", fee_to, 1000, 5)]
        mints = [
            _mint("0xtx1", fee_to, 42, 1),
            _mint("0xtx1", fee_to, 1000, 4),
        ]
        fee = classify_fee_mints(deposits, mints)
        self.assertEqual(len(fee), 1)
        self.assertEqual(fee[0]["value"], 42)

    def test_any_match_among_identical_candidates(self) -> None:
        owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        deposits = [_dep("0xtx1", owner, 100, 1), _dep("0xtx1", owner, 100, 3)]
        mints = [_mint("0xtx1", owner, 100, 0), _mint("0xtx1", owner, 100, 2)]
        self.assertEqual(classify_fee_mints(deposits, mints), [])


if __name__ == "__main__":
    unittest.main()
