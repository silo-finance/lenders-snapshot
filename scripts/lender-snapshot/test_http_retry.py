import http.client
import io
import json
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from snapshot_lenders import _http_post_json


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class HttpRetryTest(unittest.TestCase):
    def test_retries_remote_disconnected_then_succeeds(self) -> None:
        calls = {"n": 0}

        def fake_urlopen(req, timeout=120):
            calls["n"] += 1
            if calls["n"] == 1:
                raise http.client.RemoteDisconnected("Remote end closed connection without response")
            return FakeResponse({"result": "0x1"})

        output = StringIO()
        with patch("snapshot_lenders.urllib.request.urlopen", side_effect=fake_urlopen):
            with patch("snapshot_lenders.time.sleep") as sleep:
                with redirect_stdout(output):
                    result = _http_post_json("https://rpc.example", {"jsonrpc": "2.0"}, {"Content-Type": "application/json"})

        self.assertEqual(result, {"result": "0x1"})
        self.assertEqual(calls["n"], 2)
        sleep.assert_called_once_with(2.0)
        self.assertIn("HTTP POST retry 1/5", output.getvalue())
        self.assertIn("RemoteDisconnected", output.getvalue())

    def test_exhausted_retries_raise_runtime_error(self) -> None:
        def always_disconnect(req, timeout=120):
            raise http.client.RemoteDisconnected("Remote end closed connection without response")

        with patch("snapshot_lenders.urllib.request.urlopen", side_effect=always_disconnect):
            with patch("snapshot_lenders.time.sleep"):
                with redirect_stdout(io.StringIO()):
                    with self.assertRaises(RuntimeError) as ctx:
                        _http_post_json(
                            "https://rpc.example",
                            {"jsonrpc": "2.0"},
                            {"Content-Type": "application/json"},
                        )

        self.assertIn("Remote end closed connection without response", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
