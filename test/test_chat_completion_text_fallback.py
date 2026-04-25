from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

from fastapi import HTTPException

from services import chatgpt_service as chatgpt_module
from services.chatgpt_service import ChatGPTService
from services.openai_backend_api import ImageTextResultError, OpenAIBackendAPI, TEXT_ONLY_IMAGE_RESULT_MARKER


class FakeAccountService:
    def __init__(self, tokens: list[str] | None = None) -> None:
        self.tokens = tokens or ["token-1"]
        self.token = self.tokens[0]
        self.index = 0
        self.marked_results: list[dict[str, object]] = []

    def list_tokens(self) -> list[str]:
        return list(self.tokens)

    def get_available_access_token(self, excluded_tokens: set[str] | None = None) -> str:
        excluded = set(excluded_tokens or set())
        candidates = [token for token in self.tokens if token not in excluded]
        if not candidates:
            raise RuntimeError("no available image quota")
        token = candidates[self.index % len(candidates)]
        self.index += 1
        return token

    def get_account(self, access_token: str) -> dict[str, object] | None:
        if access_token not in self.tokens:
            return None
        return {"quota": 3, "status": "正常"}

    def mark_image_result(self, access_token: str, success: bool, **kwargs: object) -> dict[str, object]:
        self.marked_results.append({"access_token": access_token, "success": success, **kwargs})
        return {"quota": 3, "status": "正常"}

    def remove_token(self, access_token: str) -> bool:
        return False


class NonStreamTextBackend:
    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    def images_generations(self, **kwargs: object) -> dict[str, object]:
        raise ImageTextResultError("Hey! Want to create an image together?", "conversation-1")


class RetryableTextThenImageBackend:
    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    def images_generations(self, **kwargs: object) -> dict[str, object]:
        if self.access_token == "token-1":
            raise ImageTextResultError("We experienced an error when generating images.", "conversation-1")
        return {
            "created": 1,
            "data": [{"b64_json": "aW1hZ2U=", "revised_prompt": "hello"}],
        }


class StreamTextBackend:
    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    def stream_image_chat_completions(self, **kwargs: object):
        model = str(kwargs.get("model") or "gpt-image-2")
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "Hey! Want to create an image together?"},
                "finish_reason": None,
            }],
        }
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }],
            TEXT_ONLY_IMAGE_RESULT_MARKER: True,
        }


class StreamRetryableThenSuccessBackend:
    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    def stream_image_chat_completions(self, **kwargs: object):
        model = str(kwargs.get("model") or "gpt-image-2")
        if self.access_token == "token-1":
            yield {
                "id": "chatcmpl-test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": "We experienced an error when generating images."},
                    "finish_reason": None,
                }],
            }
            yield {
                "id": "chatcmpl-test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }],
                TEXT_ONLY_IMAGE_RESULT_MARKER: True,
            }
            return

        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": "![image](data:image/png;base64,aW1hZ2U=)"},
                "finish_reason": None,
            }],
        }
        yield {
            "id": "chatcmpl-test",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }],
        }


class ChatCompletionTextFallbackTests(unittest.TestCase):
    def test_detects_user_reported_text_only_image_response(self) -> None:
        text = (
            "appearances. However, if you're looking for a specific style or concept of images "
            "(like art, landscapes, or abstract concepts), I can definitely help with that! "
            "Just let me know what you're looking for."
        )
        self.assertTrue(OpenAIBackendAPI._looks_like_text_only_image_response(text))
        self.assertTrue(OpenAIBackendAPI._looks_like_text_only_image_response(
            "I cannot generate images based on this request. Let me know if you have any other ideas!"
        ))

    def test_non_stream_image_chat_text_response_returns_error_without_account_penalty(self) -> None:
        account_service = FakeAccountService()
        service = ChatGPTService(account_service)  # type: ignore[arg-type]
        service._new_backend = lambda access_token="": NonStreamTextBackend(access_token)  # type: ignore[method-assign]

        with (
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_start", return_value=123),
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_finish") as finish_attempt,
        ):
            with self.assertRaises(HTTPException) as caught:
                service.create_chat_completion(
                    {
                        "model": "gpt-image-2",
                        "messages": [{"role": "user", "content": "hello"}],
                    }
                )

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(account_service.marked_results, [])
        finish_attempt.assert_called_once()
        self.assertFalse(finish_attempt.call_args.kwargs["success"])
        self.assertIn("image request returned text response", finish_attempt.call_args.kwargs["error_message"])

    def test_retryable_image_error_retries_next_account_and_marks_failure(self) -> None:
        account_service = FakeAccountService(["token-1", "token-2"])
        service = ChatGPTService(account_service)  # type: ignore[arg-type]
        service._new_backend = lambda access_token="": RetryableTextThenImageBackend(access_token)  # type: ignore[method-assign]

        with (
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_start", side_effect=[123, 456]),
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_finish") as finish_attempt,
            mock.patch.object(chatgpt_module, "_save_image_bytes", return_value="http://test/image.png"),
        ):
            result = service.create_chat_completion(
                {
                    "model": "gpt-image-2",
                    "messages": [{"role": "user", "content": "hello"}],
                }
            )

        self.assertEqual(result["object"], "chat.completion")
        self.assertEqual([item["access_token"] for item in account_service.marked_results], ["token-1", "token-2"])
        self.assertFalse(account_service.marked_results[0]["success"])
        self.assertIn("We experienced an error when generating images", str(account_service.marked_results[0]["error"]))
        self.assertTrue(account_service.marked_results[1]["success"])
        self.assertEqual(finish_attempt.call_count, 2)

    def test_retryable_image_error_returns_400_after_accounts_exhausted(self) -> None:
        account_service = FakeAccountService(["token-1"])
        service = ChatGPTService(account_service)  # type: ignore[arg-type]
        service._new_backend = lambda access_token="": RetryableTextThenImageBackend(access_token)  # type: ignore[method-assign]

        with (
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_start", return_value=123),
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_finish") as finish_attempt,
        ):
            with self.assertRaises(HTTPException) as caught:
                service.create_chat_completion(
                    {
                        "model": "gpt-image-2",
                        "messages": [{"role": "user", "content": "hello"}],
                    }
                )

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(len(account_service.marked_results), 1)
        self.assertFalse(account_service.marked_results[0]["success"])
        self.assertEqual(finish_attempt.call_count, 1)

    def test_stream_image_chat_text_response_returns_error_without_leaking_text(self) -> None:
        account_service = FakeAccountService()
        service = ChatGPTService(account_service)  # type: ignore[arg-type]
        service._new_backend = lambda access_token="": StreamTextBackend(access_token)  # type: ignore[method-assign]

        with (
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_start", return_value=123),
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_finish") as finish_attempt,
        ):
            with self.assertRaises(HTTPException) as caught:
                list(
                    service.stream_chat_completion(
                        {
                            "model": "gpt-image-2",
                            "stream": True,
                            "messages": [{"role": "user", "content": "hello"}],
                        }
                    )
                )

        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(account_service.marked_results, [])
        finish_attempt.assert_called_once()
        self.assertFalse(finish_attempt.call_args.kwargs["success"])
        self.assertIn("image request returned text response", finish_attempt.call_args.kwargs["error_message"])

    def test_stream_retryable_image_error_retries_next_account_and_marks_failure(self) -> None:
        account_service = FakeAccountService(["token-1", "token-2"])
        service = ChatGPTService(account_service)  # type: ignore[arg-type]
        service._new_backend = lambda access_token="": StreamRetryableThenSuccessBackend(access_token)  # type: ignore[method-assign]

        with (
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_start", side_effect=[123, 456]),
            mock.patch.object(chatgpt_module.ops_service, "record_account_attempt_finish") as finish_attempt,
        ):
            chunks = list(
                service.stream_chat_completion(
                    {
                        "model": "gpt-image-2",
                        "stream": True,
                        "messages": [{"role": "user", "content": "hello"}],
                    }
                )
            )

        self.assertEqual([item["access_token"] for item in account_service.marked_results], ["token-1", "token-2"])
        self.assertFalse(account_service.marked_results[0]["success"])
        self.assertTrue(account_service.marked_results[1]["success"])
        self.assertEqual(finish_attempt.call_count, 2)
        content = "".join(
            str(chunk["choices"][0]["delta"].get("content") or "")
            for chunk in chunks
            if isinstance(chunk.get("choices"), list)
        )
        self.assertIn("data:image/png", content)


if __name__ == "__main__":
    unittest.main()
