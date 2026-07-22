#!/usr/bin/env python3
"""Unit tests for apply_vault_fees two-pass tagging and compensation."""

from __future__ import annotations

import copy
import unittest

from apply_vault_fees import pass1_tag_fees, pass2_recompute


def _root(
    fee_recipient: str,
    other: str,
    *,
    base_fr: int = 32,
    base_other: int = 0,
    fee_shares: int = 100,
    fee_assets: int = 100,
    out_shares: int = 100,
    out_assets: int = 100,
) -> dict:
    vault = "0x1111111111111111111111111111111111111111"
    fr = fee_recipient.lower()
    ot = other.lower()
    return {
        "avalanche": {
            "silos": {
                "0x2222222222222222222222222222222222222222": {
                    "vaults": {
                        vault: {
                            "depositors": {
                                fr: {
                                    "address_type": "eoa",
                                    "attributed_silo_assets": str(base_fr),
                                    "fee_mints": [
                                        {
                                            "block_number": 1,
                                            "tx_hash": "0xfee",
                                            "log_index": 0,
                                            "assets": str(fee_assets),
                                            "shares": str(fee_shares),
                                        }
                                    ],
                                    "transfers": [
                                        {
                                            "block_number": 2,
                                            "tx_hash": "0xout",
                                            "log_index": 1,
                                            "assets": str(out_assets),
                                            "shares": str(out_shares),
                                            "direction": "out",
                                            "counterparty": ot,
                                        }
                                    ],
                                    "withdrawals": [],
                                    "deposits": [],
                                    "airdrops": [],
                                },
                                ot: {
                                    "address_type": "eoa",
                                    "attributed_silo_assets": str(base_other),
                                    "fee_mints": [],
                                    "transfers": [
                                        {
                                            "block_number": 2,
                                            "tx_hash": "0xout",
                                            "log_index": 1,
                                            "assets": str(out_assets),
                                            "shares": str(out_shares),
                                            "direction": "in",
                                            "counterparty": fr,
                                        }
                                    ],
                                    "withdrawals": [],
                                    "deposits": [],
                                    "airdrops": [],
                                },
                            }
                        }
                    }
                }
            }
        }
    }


class ApplyVaultFeesTests(unittest.TestCase):
    def test_fee_recipient_compensates_to_zero_net_fee_cycle(self) -> None:
        fr = "0x50de2fb5cd259c1b99dbd3bb4e7aac76be7288fc"
        ot = "0xcccccccccccccccccccccccccccccccccccccccc"
        root = _root(fr, ot, base_fr=32, fee_assets=100, out_assets=100)
        pass1_tag_fees(root)
        pass2_recompute(root)
        entry = root["avalanche"]["silos"]["0x2222222222222222222222222222222222222222"]["vaults"][
            "0x1111111111111111111111111111111111111111"
        ]["depositors"][fr]
        # 32 + 100 fee - 100 out = 32; compensate 32 → 0
        self.assertEqual(entry["pending_assets"], "0")
        self.assertEqual(entry["fee_compensation"], "32")
        kinds = [r["kind"] for r in entry.get("fees") or []]
        self.assertIn("received_fee", kinds)
        self.assertIn("fee_compensation", kinds)

        other = root["avalanche"]["silos"]["0x2222222222222222222222222222222222222222"]["vaults"][
            "0x1111111111111111111111111111111111111111"
        ]["depositors"][ot]
        # other: 0 + 100 fee_in; compensate 100 → 0; no residual transfer-in
        self.assertEqual(other["pending_assets"], "0")
        self.assertEqual(other["total_fee_in"], "100")
        self.assertEqual(other["total_transfers_in"], "0")
        self.assertTrue(any(r.get("kind") == "fee_in" for r in other.get("fees") or []))

    def test_compensation_clamps_at_zero(self) -> None:
        fr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ot = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        root = _root(fr, ot, base_fr=8, fee_assets=10, out_assets=0, out_shares=0)
        # No outs: clear transfers
        for dep in root["avalanche"]["silos"]["0x2222222222222222222222222222222222222222"]["vaults"][
            "0x1111111111111111111111111111111111111111"
        ]["depositors"].values():
            dep["transfers"] = []
        pass1_tag_fees(root)
        pass2_recompute(root)
        entry = root["avalanche"]["silos"]["0x2222222222222222222222222222222222222222"]["vaults"][
            "0x1111111111111111111111111111111111111111"
        ]["depositors"][fr]
        # 8 + 10 = 18; compensate min(18, 10) = 10 → 8
        self.assertEqual(entry["pending_assets"], "8")
        self.assertEqual(entry["fee_compensation"], "10")

    def test_idempotent(self) -> None:
        fr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ot = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        root = _root(fr, ot)
        pass1_tag_fees(root)
        pass2_recompute(root)
        first = copy.deepcopy(root)
        pass1_tag_fees(root)
        pass2_recompute(root)
        self.assertEqual(root, first)

    def test_nested_fee_out_errors(self) -> None:
        fr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        mid = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        end = "0xcccccccccccccccccccccccccccccccccccccccc"
        root = _root(fr, mid)
        vault = root["avalanche"]["silos"]["0x2222222222222222222222222222222222222222"]["vaults"][
            "0x1111111111111111111111111111111111111111"
        ]["depositors"]
        vault[end] = {
            "address_type": "eoa",
            "attributed_silo_assets": "0",
            "fee_mints": [],
            "transfers": [
                {
                    "block_number": 3,
                    "tx_hash": "0xnested",
                    "log_index": 0,
                    "assets": "50",
                    "shares": "50",
                    "direction": "in",
                    "counterparty": mid,
                }
            ],
            "withdrawals": [],
            "deposits": [],
            "airdrops": [],
        }
        vault[mid]["transfers"].append(
            {
                "block_number": 3,
                "tx_hash": "0xnested",
                "log_index": 0,
                "assets": "50",
                "shares": "50",
                "direction": "out",
                "counterparty": end,
            }
        )
        errors = pass1_tag_fees(root)
        self.assertGreaterEqual(errors, 1)


if __name__ == "__main__":
    unittest.main()
