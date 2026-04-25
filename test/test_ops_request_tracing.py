from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from services import ops_service as ops_module
from services.ops_service import OpsService, reset_request_id, set_request_id


class OpsRequestTracingTests(unittest.TestCase):
    def test_ops_database_url_follows_storage_backend(self) -> None:
        postgres_url = "postgresql://user:pass@example.com:5432/app"
        with mock.patch.dict(os.environ, {"STORAGE_BACKEND": "postgres", "DATABASE_URL": postgres_url}):
            self.assertEqual(ops_module._ops_database_url(), postgres_url)

        with mock.patch.dict(os.environ, {"STORAGE_BACKEND": "sqlite"}, clear=False):
            os.environ.pop("DATABASE_URL", None)
            self.assertTrue(ops_module._ops_database_url().endswith("/accounts.db"))

        with mock.patch.dict(os.environ, {"STORAGE_BACKEND": "json", "DATABASE_URL": postgres_url}):
            self.assertTrue(ops_module._ops_database_url().endswith("/ops.db"))

    def test_request_traces_only_return_v1_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = OpsService(Path(tmp_dir) / "ops.db")
            service.record_request_start(
                request_id="req_ops",
                method="GET",
                path="/api/ops/requests",
            )
            service.record_request_finish(request_id="req_ops", http_status=200, duration_ms=10)
            service.record_request_start(
                request_id="req_v1",
                method="POST",
                path="/v1/chat/completions",
            )

            traces = service.request_traces(range_hours=1, endpoint="")
            self.assertEqual(traces["total"], 1)
            self.assertEqual(traces["items"][0]["request_id"], "req_v1")

    def test_running_request_is_visible_before_account_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = OpsService(Path(tmp_dir) / "ops.db")
            service.record_request_start(
                request_id="req_running",
                method="POST",
                path="/v1/chat/completions",
            )

            traces = service.request_traces(range_hours=1, endpoint="/v1/chat/completions")
            self.assertEqual(traces["total"], 1)
            item = traces["items"][0]
            self.assertEqual(item["request_id"], "req_running")
            self.assertEqual(item["request_status"], "running")
            self.assertEqual(item["attempts"], 0)
            self.assertFalse(item["success"])

            detail = service.request_trace("req_running")
            self.assertIsNotNone(detail)
            self.assertEqual(detail["request_status"], "running")
            self.assertEqual(detail["attempts"], [])

    def test_running_account_attempt_is_visible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = OpsService(Path(tmp_dir) / "ops.db")
            service.record_request_start(
                request_id="req_attempt",
                method="POST",
                path="/v1/chat/completions",
            )
            token = set_request_id("req_attempt")
            try:
                attempt_id = service.record_account_attempt_start(
                    access_token="token-1",
                    endpoint="/v1/chat/completions",
                    model="gpt-image-2",
                )
            finally:
                reset_request_id(token)
            traces = service.request_traces(range_hours=1, endpoint="/v1/chat/completions")
            item = traces["items"][0]
            self.assertEqual(item["attempts"], 1)
            self.assertEqual(item["running_attempts"], 1)
            self.assertEqual(item["request_status"], "running")

            service.record_account_attempt_finish(
                attempt_id,
                success=False,
                latency_ms=321,
                error_message="image request returned text response: specific style or concept of images",
            )
            service.record_request_finish(request_id="req_attempt", http_status=502, duration_ms=350)

            detail = service.request_trace("req_attempt")
            self.assertIsNotNone(detail)
            attempts = detail["attempts"] if detail else []
            self.assertEqual(attempts[0]["status"], "completed")
            self.assertFalse(attempts[0]["success"])
            self.assertEqual(attempts[0]["error_type"], "text_response")

    def test_records_attempts_under_current_request_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = OpsService(Path(tmp_dir) / "ops.db")
            service.record_request_start(
                request_id="req_test",
                method="POST",
                path="/v1/chat/completions",
            )
            token = set_request_id("req_test")
            try:
                service.record_account_event(
                    access_token="token-1",
                    endpoint="/v1/chat/completions",
                    model="gpt-image-2",
                    success=False,
                    latency_ms=1200,
                    error_message="image generation failed",
                )
                service.record_account_event(
                    access_token="token-2",
                    endpoint="/v1/chat/completions",
                    model="gpt-image-2",
                    success=True,
                    latency_ms=900,
                )
            finally:
                reset_request_id(token)
            service.record_request_finish(request_id="req_test", http_status=200, duration_ms=1300)

            traces = service.request_traces(range_hours=1, endpoint="/v1/chat/completions")
            self.assertEqual(traces["total"], 1)
            self.assertEqual(traces["items"][0]["request_id"], "req_test")
            self.assertEqual(traces["items"][0]["attempts"], 2)
            self.assertEqual(traces["items"][0]["failed_attempts"], 1)
            self.assertTrue(traces["items"][0]["success"])

            detail = service.request_trace("req_test")
            self.assertIsNotNone(detail)
            attempts = detail["attempts"] if detail else []
            self.assertEqual([item["attempt_index"] for item in attempts], [1, 2])
            self.assertFalse(attempts[0]["success"])
            self.assertTrue(attempts[1]["success"])


if __name__ == "__main__":
    unittest.main()
