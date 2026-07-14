import csv
import json
import tempfile
import unittest
from pathlib import Path

from apply_airdrops import CATEGORY_ORDER, apply_airdrops


ADDRESS = "0x1111111111111111111111111111111111111111"
UNMATCHED = "0x2222222222222222222222222222222222222222"


class ApplyAirdropsCascadeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_category(self, category: str, positions: list[tuple[str, str, int]]) -> None:
        silos: dict[str, dict] = {}
        for silo, address, balance in positions:
            silo_entry = silos.setdefault(
                silo,
                {
                    "snapshot_block": 100,
                    "snapshot_block_timestamp": 1_700_000_000,
                    "input_token": {"decimals": 0, "symbol": "TEST"},
                    "direct_lenders": {},
                    "vaults": {},
                },
            )
            silo_entry["direct_lenders"][address] = {
                "address_type": "eoa",
                "assets_collateral": str(balance),
                "pending_assets": str(balance),
            }
        root = {"sonic": {"chain_id": 146, "silos": silos}}
        (self.data_dir / f"{category}.json").write_text(json.dumps(root, indent=2) + "\n")

    def _prepare_categories(self, positions: dict[str, list[tuple[str, str, int]]]) -> None:
        for category in CATEGORY_ORDER:
            self._write_category(category, positions.get(category, []))

    def _run(
        self,
        amount: int,
        category_silos: dict[str, list[str]],
        address: str = ADDRESS,
    ) -> dict:
        csv_path = self.data_dir / "airdrop.csv"
        with csv_path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["address", "Amount sent"])
            writer.writeheader()
            writer.writerow({"address": address, "Amount sent": str(amount)})
        config = {
            "id": "test-airdrop",
            "csv": str(csv_path),
            "decimals": 0,
            "categories": category_silos,
        }
        return apply_airdrops(self.data_dir, [config])

    def _entry(self, category: str, silo: str, address: str = ADDRESS) -> dict:
        root = json.loads((self.data_dir / f"{category}.json").read_text())
        return root["sonic"]["silos"][silo]["direct_lenders"][address]

    def test_single_category_has_no_one_of_one_metadata(self) -> None:
        self._prepare_categories({"trevee": [("t1", ADDRESS, 10)]})

        self._run(3, {"trevee": ["t1"]})

        entry = self._entry("trevee", "t1")
        self.assertEqual(entry["pending_assets"], "7")
        self.assertEqual(entry["airdrops"][0]["assets"], "3")
        self.assertNotIn("airdrop_part", entry["airdrops"][0])
        self.assertNotIn("airdrop_parts", entry["airdrops"][0])

    def test_all_three_categories_receive_numbered_parts(self) -> None:
        self._prepare_categories(
            {
                "trevee": [("t1", ADDRESS, 3)],
                "pendle": [("p1", ADDRESS, 5)],
                "stream": [("s1", ADDRESS, 2)],
            }
        )

        self._run(10, {"trevee": ["t1"], "pendle": ["p1"], "stream": ["s1"]})

        for part, (category, silo) in enumerate(
            [("trevee", "t1"), ("pendle", "p1"), ("stream", "s1")],
            start=1,
        ):
            row = self._entry(category, silo)["airdrops"][0]
            self.assertEqual(row["airdrop_part"], part)
            self.assertEqual(row["airdrop_parts"], 3)

    def test_address_starts_at_first_category_where_it_exists(self) -> None:
        self._prepare_categories({"pendle": [("p1", ADDRESS, 5)]})

        report = self._run(2, {"trevee": ["t1"], "pendle": ["p1"], "stream": ["s1"]})

        self.assertEqual(report["airdrops"][0]["matched"], 1)
        self.assertEqual(self._entry("pendle", "p1")["pending_assets"], "3")

    def test_address_only_in_stream_absorbs_whole_amount_there(self) -> None:
        self._prepare_categories({"stream": [("s1", ADDRESS, 1)]})

        report = self._run(4, {"trevee": ["t1"], "pendle": ["p1"], "stream": ["s1"]})

        self.assertEqual(report["airdrops"][0]["matched"], 1)
        entry = self._entry("stream", "s1")
        self.assertEqual(entry["pending_assets"], "-3")
        row = entry["airdrops"][0]
        self.assertEqual(row["assets"], "4")
        self.assertNotIn("airdrop_part", row)
        self.assertNotIn("airdrop_parts", row)

    def test_zero_allocation_category_is_omitted_from_numbering(self) -> None:
        self._prepare_categories(
            {
                "trevee": [("t1", ADDRESS, 0)],
                "pendle": [("p1", ADDRESS, 5)],
            }
        )

        self._run(2, {"trevee": ["t1"], "pendle": ["p1"]})

        self.assertNotIn("airdrops", self._entry("trevee", "t1"))
        pendle_row = self._entry("pendle", "p1")["airdrops"][0]
        self.assertNotIn("airdrop_part", pendle_row)
        self.assertNotIn("airdrop_parts", pendle_row)

    def test_last_compatible_category_absorbs_remainder(self) -> None:
        self._prepare_categories(
            {
                "trevee": [("t1", ADDRESS, 2)],
                "pendle": [("p1", ADDRESS, 1)],
            }
        )

        self._run(5, {"trevee": ["t1"], "pendle": ["p1"]})

        self.assertEqual(self._entry("trevee", "t1")["pending_assets"], "0")
        self.assertEqual(self._entry("pendle", "p1")["pending_assets"], "-2")

    def test_positions_in_same_category_share_category_part(self) -> None:
        self._prepare_categories(
            {
                "trevee": [("t1", ADDRESS, 4), ("t2", ADDRESS, 3)],
                "pendle": [("p1", ADDRESS, 5)],
            }
        )

        self._run(8, {"trevee": ["t1", "t2"], "pendle": ["p1"]})

        for silo in ("t1", "t2"):
            row = self._entry("trevee", silo)["airdrops"][0]
            self.assertEqual((row["airdrop_part"], row["airdrop_parts"]), (1, 2))
        pendle_row = self._entry("pendle", "p1")["airdrops"][0]
        self.assertEqual((pendle_row["airdrop_part"], pendle_row["airdrop_parts"]), (2, 2))

    def test_unmatched_is_reported_and_rerun_is_idempotent(self) -> None:
        self._prepare_categories({"trevee": [("t1", ADDRESS, 10)]})

        unmatched_report = self._run(3, {"trevee": ["t1"]}, address=UNMATCHED)
        self.assertEqual(unmatched_report["airdrops"][0]["unmatched"], [UNMATCHED])

        self._run(3, {"trevee": ["t1"]})
        first = {
            category: (self.data_dir / f"{category}.json").read_text()
            for category in CATEGORY_ORDER
        }
        self._run(3, {"trevee": ["t1"]})
        second = {
            category: (self.data_dir / f"{category}.json").read_text()
            for category in CATEGORY_ORDER
        }
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
