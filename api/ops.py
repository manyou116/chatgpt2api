from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from api.support import require_auth_key
from services.account_service import account_service
from services.ops_service import ops_service


class AccountCooldownRequest(BaseModel):
    minutes: int = Field(default=30, ge=1, le=1440)
    reason: str = "manual cooldown"


def _account_counts(accounts: list[dict]) -> dict[str, int]:
    return {
        "total": len(accounts),
        "normal": sum(1 for item in accounts if item.get("status") == "正常"),
        "limited": sum(1 for item in accounts if item.get("status") == "限流"),
        "abnormal": sum(1 for item in accounts if item.get("status") == "异常"),
        "disabled": sum(1 for item in accounts if item.get("status") == "禁用"),
        "cooling": sum(1 for item in accounts if item.get("runtimeStatus") == "cooling"),
        "suspect": sum(1 for item in accounts if item.get("runtimeStatus") == "suspect"),
        "degraded": sum(1 for item in accounts if item.get("runtimeStatus") == "degraded"),
    }


def _sort_accounts(items: list[dict], sort: str, order: str) -> list[dict]:
    reverse = order != "asc"

    def key(item: dict):
        if sort == "success_rate":
            return float(item.get("successRate24h") or 0)
        if sort == "failed":
            return int(item.get("failed24h") or 0)
        if sort == "consecutive_failures":
            return int(item.get("consecutiveFailures") or 0)
        if sort == "health_score":
            return int(item.get("healthScore") or 0)
        return str(item.get("lastUsedAt") or "")

    return sorted(items, key=key, reverse=reverse)


def _account_lookup() -> dict[str, dict]:
    return {str(item.get("id") or ""): item for item in account_service.list_accounts()}


def _public_trace_account(account_id: str, accounts_by_id: dict[str, dict]) -> dict:
    account = accounts_by_id.get(account_id) or {}
    return {
        "id": account_id,
        "email": account.get("email"),
        "type": account.get("type"),
        "status": account.get("status"),
        "quota": account.get("quota"),
        "runtimeStatus": account.get("runtimeStatus"),
        "healthScore": account.get("healthScore"),
        "access_token": account.get("access_token"),
    }


def create_router() -> APIRouter:
    router = APIRouter(prefix="/api/ops")

    @router.get("/overview")
    async def overview(
        authorization: str | None = Header(default=None),
        range_hours: int = Query(default=24, ge=1, le=168),
    ):
        require_auth_key(authorization)
        accounts = account_service.list_accounts()
        return {
            "metrics": ops_service.overview(range_hours=range_hours),
            "accounts": _account_counts(accounts),
        }

    @router.get("/accounts/health")
    async def accounts_health(
        authorization: str | None = Header(default=None),
        range_hours: int = Query(default=24, ge=1, le=168),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=100, ge=1, le=5000),
        sort: str = Query(default="health_score"),
        order: str = Query(default="asc"),
    ):
        require_auth_key(authorization)
        stats = ops_service.account_stats(range_hours=range_hours)
        accounts = []
        for item in account_service.list_accounts():
            account_stats = stats.get(str(item.get("id") or ""), {})
            total = int(account_stats.get("total") or 0)
            success = int(account_stats.get("success") or 0)
            account = {
                **item,
                "total24h": total,
                "success24h": success,
                "failed24h": int(account_stats.get("failed") or 0),
                "successRate24h": float(account_stats.get("success_rate") or 0),
                "avgLatencyMs24h": int(account_stats.get("avg_latency_ms") or 0),
                "lastErrorType24h": account_stats.get("last_error_type") or "",
                "lastError24h": account_stats.get("last_error") or "",
            }
            accounts.append(account)

        sorted_items = _sort_accounts(accounts, sort, order)
        start = (page - 1) * page_size
        end = start + page_size
        return {
            "items": sorted_items[start:end],
            "total": len(sorted_items),
            "page": page,
            "page_size": page_size,
        }

    @router.get("/requests")
    async def request_traces(
        authorization: str | None = Header(default=None),
        range_hours: int = Query(default=24, ge=1, le=168),
        endpoint: str = Query(default=""),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=200),
    ):
        require_auth_key(authorization)
        result = ops_service.request_traces(
            range_hours=range_hours,
            endpoint=endpoint,
            page=page,
            page_size=page_size,
        )
        accounts_by_id = _account_lookup()
        items = []
        for item in result["items"]:
            account_ids = [str(account_id) for account_id in item.get("account_ids") or []]
            items.append(
                {
                    **item,
                    "accounts": [
                        _public_trace_account(account_id, accounts_by_id)
                        for account_id in account_ids
                    ],
                }
            )
        return {**result, "items": items}

    @router.get("/requests/{request_id}")
    async def request_trace(request_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        trace = ops_service.request_trace(request_id)
        if trace is None:
            raise HTTPException(status_code=404, detail={"error": "request trace not found"})
        accounts_by_id = _account_lookup()
        return {
            **trace,
            "attempts": [
                {
                    **attempt,
                    "account": _public_trace_account(str(attempt.get("account_id") or ""), accounts_by_id),
                }
                for attempt in trace["attempts"]
            ],
        }

    @router.post("/accounts/{account_id}/cooldown")
    async def cooldown_account(
        account_id: str,
        body: AccountCooldownRequest,
        authorization: str | None = Header(default=None),
    ):
        require_auth_key(authorization)
        account = account_service.cooldown_account(account_id, body.minutes, body.reason)
        if account is None:
            raise HTTPException(status_code=404, detail={"error": "account not found"})
        return {"ok": True, "account_id": account_id}

    @router.post("/accounts/{account_id}/restore")
    async def restore_account(account_id: str, authorization: str | None = Header(default=None)):
        require_auth_key(authorization)
        account = account_service.restore_account_runtime(account_id)
        if account is None:
            raise HTTPException(status_code=404, detail={"error": "account not found"})
        return {"ok": True, "account_id": account_id}

    return router
