from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from api.support import raise_image_quota_error, require_auth_key, resolve_image_base_url
from services.account_service import account_service
from services.chatgpt_service import ChatGPTService, ImageGenerationError, ImageRequestRejectedError
from utils.helper import has_response_image_generation_tool, is_image_chat_request, sse_json_stream


def _has_image_stream_result(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    data = item.get("data")
    return isinstance(data, list) and len(data) > 0


def _has_response_image_result(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    if item.get("type") == "response.output_item.done":
        output_item = item.get("item")
        return isinstance(output_item, dict) and output_item.get("type") == "image_generation_call"
    return item.get("type") == "response.completed"


def _prefetch_stream_items(items, ready=None):
    iterator = iter(items)
    buffered = []
    while True:
        try:
            item = next(iterator)
        except StopIteration:
            return buffered, iterator
        buffered.append(item)
        if ready is None or ready(item):
            return buffered, iterator


def _chain_stream_items(buffered, iterator):
    yield from buffered
    yield from iterator


async def _streaming_response(items, *, ready=None) -> StreamingResponse:
    try:
        buffered, iterator = await run_in_threadpool(_prefetch_stream_items, items, ready)
    except HTTPException:
        raise
    except ImageRequestRejectedError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
    return StreamingResponse(
        sse_json_stream(_chain_stream_items(buffered, iterator)),
        media_type="text/event-stream",
    )


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = None
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


def create_router(chatgpt_service: ChatGPTService) -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        try:
            return await run_in_threadpool(chatgpt_service.list_models)
        except Exception as exc:
            raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        base_url = resolve_image_base_url(request)
        if body.stream:
            try:
                await run_in_threadpool(account_service.get_available_access_token)
            except RuntimeError as exc:
                raise_image_quota_error(exc)
            return await _streaming_response(
                chatgpt_service.stream_image_generation(
                    body.prompt, body.model, body.n, body.size, body.response_format, base_url
                ),
                ready=_has_image_stream_result,
            )
        try:
            return await run_in_threadpool(
                chatgpt_service.generate_with_pool, body.prompt, body.model, body.n, body.size, body.response_format, base_url
            )
        except ImageGenerationError as exc:
            raise_image_quota_error(exc)

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: str | None = Form(default=None),
            response_format: str = Form(default="b64_json"),
            stream: bool | None = Form(default=None),
    ):
        require_auth_key(authorization)
        if n < 1 or n > 4:
            raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
        uploads = [*(image or []), *(image_list or [])]
        if not uploads:
            raise HTTPException(status_code=400, detail={"error": "image file is required"})
        base_url = resolve_image_base_url(request)
        images: list[tuple[bytes, str, str]] = []
        for upload in uploads:
            image_data = await upload.read()
            if not image_data:
                raise HTTPException(status_code=400, detail={"error": "image file is empty"})
            images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
        if stream:
            if not account_service.has_available_account():
                raise_image_quota_error(RuntimeError("no available image quota"))
            return await _streaming_response(
                chatgpt_service.stream_image_edit(prompt, images, model, n, size, response_format, base_url),
                ready=_has_image_stream_result,
            )
        try:
            return await run_in_threadpool(
                chatgpt_service.edit_with_pool, prompt, images, model, n, size, response_format, base_url
            )
        except ImageGenerationError as exc:
            raise_image_quota_error(exc)

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        payload = body.model_dump(mode="python")
        if bool(payload.get("stream")):
            if is_image_chat_request(payload):
                try:
                    await run_in_threadpool(account_service.get_available_access_token)
                except RuntimeError as exc:
                    raise_image_quota_error(exc)
            return await _streaming_response(chatgpt_service.stream_chat_completion(payload))
        return await run_in_threadpool(chatgpt_service.create_chat_completion, payload)

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        payload = body.model_dump(mode="python")
        if bool(payload.get("stream")):
            return await _streaming_response(
                chatgpt_service.stream_response(payload),
                ready=_has_response_image_result if has_response_image_generation_tool(payload) else None,
            )
        return await run_in_threadpool(chatgpt_service.create_response, payload)

    return router
