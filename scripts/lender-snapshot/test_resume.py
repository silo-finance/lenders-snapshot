import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import snapshot_lenders as sl


SILO_A = "0x1111111111111111111111111111111111111111"
SILO_B = "0x2222222222222222222222222222222222222222"
SILO_C = "0x3333333333333333333333333333333333333333"


def _category(silos: list[str], events_to_block: int = 200) -> dict:
    return {
        "targets": [
            {
                "chain": "sonic",
                "chain_id": 146,
                "block": 100,
                "events_to_block": events_to_block,
                "block_chunk": 1000,
                "silos": [{"address": address} for address in silos],
            }
        ]
    }


def _complete_root(addresses: list[str], events_to_block: int = 200) -> dict:
    return {
        "sonic": {
            "chain_id": 146,
            "silos": {
                address: {
                    "snapshot_block": 100,
                    "withdrawals_scanned_to_block": events_to_block,
                    "direct_lenders": {},
                    "vaults": {},
                }
                for address in addresses
            },
        }
    }


class ParseCliArgsTest(unittest.TestCase):
    def test_resume_from_space_and_equals(self) -> None:
        cats, resume = sl.parse_cli_args(["stream", "--resume-from", "4"])
        self.assertEqual(cats, ["stream"])
        self.assertEqual(resume, 4)

        cats, resume = sl.parse_cli_args(["--resume-from=3", "pendle"])
        self.assertEqual(cats, ["pendle"])
        self.assertEqual(resume, 3)

    def test_negative_and_unknown_flags_fail(self) -> None:
        with self.assertRaises(SystemExit):
            sl.parse_cli_args(["stream", "--resume-from", "-1"])
        with self.assertRaises(SystemExit):
            sl.parse_cli_args(["stream", "--nope"])


class SiloCompleteTest(unittest.TestCase):
    def test_complete_and_incomplete(self) -> None:
        root = _complete_root([SILO_A], events_to_block=200)
        self.assertTrue(sl.silo_is_complete(root, "sonic", SILO_A, 200))
        self.assertFalse(sl.silo_is_complete(root, "sonic", SILO_A, 201))
        self.assertFalse(sl.silo_is_complete(root, "sonic", SILO_B, 200))
        self.assertFalse(sl.silo_is_complete(None, "sonic", SILO_A, 200))


class ResumeRunCategoryTest(unittest.TestCase):
    def test_resume_from_skips_lower_indexes_and_logs_resume_with(self) -> None:
        category = _category([SILO_A, SILO_B, SILO_C])
        scanned_addresses: list[str] = []

        def fake_build_snapshot(*_args, **_kwargs):
            return {
                "snapshot_block": 100,
                "direct_lenders": {},
                "vaults": {},
                "withdrawals_scanned_to_block": 200,
            }

        def fake_write_output(silo_entry, chain, chain_id, silo_address, output_path):
            scanned_addresses.append(silo_address)

        output = StringIO()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "stream.json"
            with (
                patch.object(sl, "category_output_path", return_value=output_path),
                patch.object(sl, "resolve_rpc_url", return_value="http://rpc.example"),
                patch.object(sl, "RpcClient") as rpc_cls,
                patch.object(sl, "load_existing_chain_timestamp_cache", return_value={}),
                patch.object(sl, "compute_block_range", return_value=1),
                patch.object(sl, "build_snapshot", side_effect=fake_build_snapshot),
                patch.object(sl, "write_output", side_effect=fake_write_output),
                redirect_stdout(output),
            ):
                rpc_cls.return_value.eth_block_number.return_value = 250
                scanned = sl.run_category("stream", category, resume_from=2)

        self.assertEqual(scanned, 1)
        self.assertEqual(scanned_addresses, [SILO_C])
        log = output.getvalue()
        self.assertIn("[resume] category=stream starting at index=2 (skipping 0..1 of 3)", log)
        self.assertIn(f"[resume] skip index=0/3 chain=sonic silo={SILO_A}", log)
        self.assertIn(f"[resume] skip index=1/3 chain=sonic silo={SILO_B}", log)
        self.assertIn(
            f">>>>>>>>>> RESUME WITH: --resume-from 3  "
            f"(category=stream next=3/3 chain=sonic silo={SILO_C}) <<<<<<<<<<",
            log,
        )
        self.assertIn("scanned=1 skipped=2 total=3", log)

    def test_resume_from_out_of_range_fails(self) -> None:
        category = _category([SILO_A])
        with self.assertRaises(SystemExit):
            sl.run_category("stream", category, resume_from=2)


class CascadeGateTest(unittest.TestCase):
    def test_list_incomplete_reports_missing_and_partial(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            stream_path = data_dir / "stream.json"
            stream_path.write_text(
                json.dumps(
                    {
                        "sonic": {
                            "silos": {
                                SILO_A: {"withdrawals_scanned_to_block": 200},
                                SILO_B: {"withdrawals_scanned_to_block": 150},
                            }
                        }
                    }
                )
            )
            categories = {
                "stream": {
                    "output": "stream.json",
                    "targets": [
                        {
                            "chain": "sonic",
                            "events_to_block": 200,
                            "silos": [
                                {"address": SILO_A},
                                {"address": SILO_B},
                                {"address": SILO_C},
                            ],
                        }
                    ],
                }
            }
            with patch.object(sl, "DATA_DIR", data_dir):
                incomplete = sl.list_incomplete_configured_silos(categories)

        self.assertEqual(
            incomplete,
            [
                ("stream", 1, "sonic", SILO_B),
                ("stream", 2, "sonic", SILO_C),
            ],
        )

    def test_list_incomplete_empty_when_all_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            (data_dir / "stream.json").write_text(json.dumps(_complete_root([SILO_A, SILO_B])))
            categories = {
                "stream": {
                    "output": "stream.json",
                    "targets": [
                        {
                            "chain": "sonic",
                            "events_to_block": 200,
                            "silos": [{"address": SILO_A}, {"address": SILO_B}],
                        }
                    ],
                }
            }
            with patch.object(sl, "DATA_DIR", data_dir):
                self.assertEqual(sl.list_incomplete_configured_silos(categories), [])


if __name__ == "__main__":
    unittest.main()
