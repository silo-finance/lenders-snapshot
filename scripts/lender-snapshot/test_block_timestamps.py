import json
import tempfile
import unittest
from pathlib import Path

from snapshot_lenders import (
    load_existing_chain_timestamp_cache,
    stamp_silo_flow_timestamps,
)


SILO = "0x1111111111111111111111111111111111111111"
OTHER_SILO = "0x3333333333333333333333333333333333333333"
LENDER = "0x2222222222222222222222222222222222222222"


class FakeRpc:
    def __init__(self, timestamps: dict[int, int]) -> None:
        self.timestamps = timestamps
        self.requested_blocks: list[int] = []

    def eth_get_block_timestamp(self, block_number: int) -> int:
        self.requested_blocks.append(block_number)
        return self.timestamps[block_number]


class BlockTimestampCacheTest(unittest.TestCase):
    def test_existing_json_timestamps_are_reused_and_only_missing_blocks_are_fetched(self) -> None:
        existing_silo = {
            "snapshot_block": 100,
            "snapshot_block_timestamp": 1_000,
            "direct_lenders": {
                LENDER: {
                    "withdrawals": [
                        {
                            "block_number": 101,
                            "block_timestamp": 1_001,
                        }
                    ]
                }
            },
            "vaults": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "stream.json"
            output_path.write_text(
                json.dumps(
                    {
                        "sonic": {
                            "chain_id": 146,
                            "silos": {
                                SILO: existing_silo,
                                OTHER_SILO: {
                                    "direct_lenders": {
                                        LENDER: {
                                            "deposits": [
                                                {
                                                    "block_number": 99,
                                                    "block_timestamp": 999,
                                                }
                                            ]
                                        }
                                    },
                                    "vaults": {},
                                },
                            },
                        }
                    }
                )
            )
            cache = load_existing_chain_timestamp_cache(output_path, "sonic")

        self.assertEqual(cache, {99: 999, 100: 1_000, 101: 1_001})

        current_silo = {
            "direct_lenders": {
                LENDER: {
                    "withdrawals": [{"block_number": 101}],
                    "deposits": [{"block_number": 102}],
                }
            },
            "vaults": {},
        }
        rpc = FakeRpc({102: 1_002})

        stamp_silo_flow_timestamps(current_silo, rpc, 100, cache)

        self.assertEqual(rpc.requested_blocks, [102])
        lender = current_silo["direct_lenders"][LENDER]
        self.assertEqual(lender["withdrawals"][0]["block_timestamp"], 1_001)
        self.assertEqual(lender["deposits"][0]["block_timestamp"], 1_002)
        self.assertEqual(current_silo["snapshot_block_timestamp"], 1_000)

    def test_conflicting_persisted_timestamps_are_not_reused(self) -> None:
        existing_silo = {
            "direct_lenders": {
                LENDER: {
                    "withdrawals": [
                        {"block_number": 101, "block_timestamp": 1_001},
                        {"block_number": 101, "block_timestamp": 9_999},
                    ]
                }
            },
            "vaults": {},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "stream.json"
            output_path.write_text(
                json.dumps({"sonic": {"silos": {SILO: existing_silo}}})
            )

            cache = load_existing_chain_timestamp_cache(output_path, "sonic")

        self.assertEqual(cache, {})


if __name__ == "__main__":
    unittest.main()
