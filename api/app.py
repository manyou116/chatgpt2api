from __future__ import annotations

from contextlib import asynccontextmanager
from threading import Event
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, ops, system
from api.support import resolve_web_asset, start_limited_account_watcher
from services.account_service import account_service
from services.chatgpt_service import ChatGPTService
from services.config import config
from services.ops_service import new_request_id, ops_service, reset_request_id, set_request_id


class RequestContextMiddleware:
    def __init__(self, app):
        self.app = app

    @staticmethod
    def _should_trace_path(path: str) -> bool:
        return str(path or "").startswith("/v1/")

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        request_id = new_request_id()
        path = str(scope.get("path") or "")
        should_trace = self._should_trace_path(path)
        context_token = set_request_id(request_id)
        started_at = time.perf_counter()
        response_status = 0
        finished = False
        if should_trace:
            ops_service.record_request_start(
                request_id=request_id,
                method=str(scope.get("method") or ""),
                path=path,
            )

        async def send_with_request_id(message):
            nonlocal response_status
            if message.get("type") == "http.response.start":
                response_status = int(message.get("status") or 0)
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", request_id.encode("utf-8")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        except Exception as exc:
            finished = True
            if should_trace:
                ops_service.record_request_finish(
                    request_id=request_id,
                    http_status=response_status or 500,
                    duration_ms=int(max(0, time.perf_counter() - started_at) * 1000),
                    error_message=str(exc),
                )
            raise
        finally:
            if should_trace and not finished:
                ops_service.record_request_finish(
                    request_id=request_id,
                    http_status=response_status,
                    duration_ms=int(max(0, time.perf_counter() - started_at) * 1000),
                )
            reset_request_id(context_token)


def create_app() -> FastAPI:
    chatgpt_service = ChatGPTService(account_service)
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["x-request-id"],
    )
    app.add_middleware(RequestContextMiddleware)
    app.include_router(ai.create_router(chatgpt_service))
    app.include_router(accounts.create_router())
    app.include_router(ops.create_router())
    app.include_router(system.create_router(app_version))
    if config.images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(config.images_dir)), name="images")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
