from __future__ import annotations

from contextlib import contextmanager
import hashlib
import sqlite3
import time
import uuid
from contextvars import ContextVar, Token
from pathlib import Path
from threading import Lock
from typing import Any, Iterator

from services.config import DATA_DIR


OPS_DB_FILE = DATA_DIR / "ops.db"
_REQUEST_ID: ContextVar[str] = ContextVar("ops_request_id", default="")


def _is_v1_endpoint(value: str) -> bool:
    return str(value or "").startswith("/v1/")


def account_id_for_token(access_token: str) -> str:
    token = str(access_token or "").strip()
    if not token:
        return ""
    return hashlib.sha1(token.encode("utf-8")).hexdigest()[:16]


def _now_epoch() -> int:
    return int(time.time())


def new_request_id() -> str:
    return f"req_{uuid.uuid4().hex}"


def current_request_id() -> str:
    return _REQUEST_ID.get("").strip()


def set_request_id(request_id: str) -> Token[str]:
    return _REQUEST_ID.set(str(request_id or "").strip())


def reset_request_id(token: Token[str]) -> None:
    _REQUEST_ID.reset(token)


class OpsService:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ops_account_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at INTEGER NOT NULL,
                    account_id TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    model TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    latency_ms INTEGER NOT NULL,
                    error_type TEXT NOT NULL DEFAULT '',
                    error_message TEXT NOT NULL DEFAULT ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ops_requests (
                    request_id TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    completed_at INTEGER NOT NULL DEFAULT 0,
                    method TEXT NOT NULL DEFAULT '',
                    path TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'running',
                    http_status INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT NOT NULL DEFAULT ''
                )
                """
            )
            columns = {
                str(item["name"])
                for item in conn.execute("PRAGMA table_info(ops_account_events)").fetchall()
            }
            if "request_id" not in columns:
                conn.execute(
                    """
                    ALTER TABLE ops_account_events
                    ADD COLUMN request_id TEXT NOT NULL DEFAULT ''
                    """
                )
            if "attempt_index" not in columns:
                conn.execute(
                    """
                    ALTER TABLE ops_account_events
                    ADD COLUMN attempt_index INTEGER NOT NULL DEFAULT 0
                    """
                )
            if "status" not in columns:
                conn.execute(
                    """
                    ALTER TABLE ops_account_events
                    ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
                    """
                )
            if "completed_at" not in columns:
                conn.execute(
                    """
                    ALTER TABLE ops_account_events
                    ADD COLUMN completed_at INTEGER NOT NULL DEFAULT 0
                    """
                )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ops_account_events_created
                ON ops_account_events(created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ops_account_events_account_created
                ON ops_account_events(account_id, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ops_account_events_endpoint_created
                ON ops_account_events(endpoint, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ops_account_events_request_created
                ON ops_account_events(request_id, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_ops_requests_created
                ON ops_requests(created_at)
                """
            )

    @staticmethod
    def _error_type(error_message: str) -> str:
        text = str(error_message or "").lower()
        if not text:
            return ""
        if "image request returned text response" in text:
            return "text_response"
        if "token_invalid" in text or "token_revoked" in text or "invalidated oauth token" in text:
            return "token_invalid"
        if "401" in text or "unauthorized" in text:
            return "unauthorized"
        if "quota" in text or "rate limit" in text or "限流" in text:
            return "quota_or_rate_limit"
        if "timeout" in text or "timed out" in text:
            return "timeout"
        if "no downloadable image" in text or "image generation failed" in text or "image edit failed" in text:
            return "generation_failed"
        return "upstream_error"

    def record_request_start(self, *, request_id: str, method: str, path: str) -> None:
        request_id = str(request_id or "").strip()[:80]
        if not request_id:
            return
        now = _now_epoch()
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO ops_requests
                    (request_id, created_at, updated_at, method, path, status)
                VALUES (?, ?, ?, ?, ?, 'running')
                ON CONFLICT(request_id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    method = excluded.method,
                    path = excluded.path,
                    status = 'running'
                """,
                (request_id, now, now, str(method or ""), str(path or "")),
            )

    def _ensure_request_row(
        self,
        conn: sqlite3.Connection,
        *,
        request_id: str,
        created_at: int,
        path: str = "",
        status: str = "running",
    ) -> None:
        if not request_id:
            return
        conn.execute(
            """
            INSERT INTO ops_requests
                (request_id, created_at, updated_at, path, status)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(request_id) DO UPDATE SET
                updated_at = MAX(updated_at, excluded.updated_at),
                path = CASE WHEN ops_requests.path = '' THEN excluded.path ELSE ops_requests.path END
            """,
            (
                request_id,
                created_at,
                created_at,
                str(path or ""),
                str(status or "running"),
            ),
        )

    def record_request_finish(
        self,
        *,
        request_id: str,
        http_status: int = 0,
        duration_ms: int = 0,
        error_message: str = "",
    ) -> None:
        request_id = str(request_id or "").strip()[:80]
        if not request_id:
            return
        now = _now_epoch()
        with self._lock, self._connection() as conn:
            self._ensure_request_row(
                conn,
                request_id=request_id,
                created_at=now,
                status="completed",
            )
            conn.execute(
                """
                UPDATE ops_requests
                SET
                    updated_at = ?,
                    completed_at = ?,
                    status = ?,
                    http_status = ?,
                    duration_ms = ?,
                    error_message = ?
                WHERE request_id = ?
                """,
                (
                    now,
                    now,
                    "failed" if int(http_status or 0) >= 500 else "completed",
                    max(0, int(http_status or 0)),
                    max(0, int(duration_ms or 0)),
                    str(error_message or "")[:1000],
                    request_id,
                ),
            )

    def record_account_attempt_start(
        self,
        *,
        access_token: str,
        endpoint: str,
        model: str,
        request_id: str | None = None,
    ) -> int:
        account_id = account_id_for_token(access_token)
        if not account_id:
            return 0
        request_id = str(request_id if request_id is not None else current_request_id()).strip()[:80]
        now = _now_epoch()
        with self._lock, self._connection() as conn:
            attempt_index = 0
            if request_id:
                self._ensure_request_row(
                    conn,
                    request_id=request_id,
                    created_at=now,
                    path=str(endpoint or ""),
                    status="running",
                )
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS total
                    FROM ops_account_events
                    WHERE request_id = ?
                    """,
                    (request_id,),
                ).fetchone()
                attempt_index = int(row["total"] or 0) + 1
            cursor = conn.execute(
                """
                INSERT INTO ops_account_events
                    (
                        created_at,
                        request_id,
                        attempt_index,
                        account_id,
                        endpoint,
                        model,
                        success,
                        latency_ms,
                        error_type,
                        error_message,
                        status,
                        completed_at
                    )
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, '', '', 'running', 0)
                """,
                (
                    now,
                    request_id,
                    attempt_index,
                    account_id,
                    str(endpoint or "unknown"),
                    str(model or "unknown"),
                ),
            )
            return int(cursor.lastrowid or 0)

    def record_account_attempt_finish(
        self,
        attempt_id: int,
        *,
        success: bool,
        latency_ms: int,
        error_message: str = "",
    ) -> None:
        if not attempt_id:
            return
        error_message = str(error_message or "")[:1000]
        now = _now_epoch()
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                UPDATE ops_account_events
                SET
                    success = ?,
                    latency_ms = ?,
                    error_type = ?,
                    error_message = ?,
                    status = 'completed',
                    completed_at = ?
                WHERE id = ?
                """,
                (
                    1 if success else 0,
                    max(0, int(latency_ms or 0)),
                    self._error_type(error_message),
                    error_message,
                    now,
                    int(attempt_id),
                ),
            )
            row = conn.execute(
                """
                SELECT request_id
                FROM ops_account_events
                WHERE id = ?
                """,
                (int(attempt_id),),
            ).fetchone()
            request_id = str(row["request_id"] or "").strip() if row else ""
            if request_id:
                conn.execute(
                    """
                    UPDATE ops_requests
                    SET updated_at = MAX(updated_at, ?)
                    WHERE request_id = ?
                    """,
                    (now, request_id),
                )

    def record_account_event(
        self,
        *,
        access_token: str,
        endpoint: str,
        model: str,
        success: bool,
        latency_ms: int,
        error_message: str = "",
        request_id: str | None = None,
    ) -> None:
        account_id = account_id_for_token(access_token)
        if not account_id:
            return
        error_message = str(error_message or "")[:1000]
        request_id = str(request_id if request_id is not None else current_request_id()).strip()[:80]
        now = _now_epoch()
        with self._lock, self._connection() as conn:
            attempt_index = 0
            if request_id:
                self._ensure_request_row(
                    conn,
                    request_id=request_id,
                    created_at=now,
                    path=str(endpoint or ""),
                    status="completed",
                )
                row = conn.execute(
                    """
                    SELECT COUNT(*) AS total
                    FROM ops_account_events
                    WHERE request_id = ?
                    """,
                    (request_id,),
                ).fetchone()
                attempt_index = int(row["total"] or 0) + 1
            conn.execute(
                """
                INSERT INTO ops_account_events
                    (
                        created_at,
                        request_id,
                        attempt_index,
                        account_id,
                        endpoint,
                        model,
                        success,
                        latency_ms,
                        error_type,
                        error_message,
                        status,
                        completed_at
                    )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
                """,
                (
                    now,
                    request_id,
                    attempt_index,
                    account_id,
                    str(endpoint or "unknown"),
                    str(model or "unknown"),
                    1 if success else 0,
                    max(0, int(latency_ms or 0)),
                    self._error_type(error_message),
                    error_message,
                    now,
                ),
            )

    def request_traces(
        self,
        *,
        range_hours: int = 24,
        endpoint: str = "",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        since = _now_epoch() - max(1, int(range_hours or 24)) * 3600
        page = max(1, int(page or 1))
        page_size = max(1, min(200, int(page_size or 50)))
        offset = (page - 1) * page_size
        endpoint = str(endpoint or "").strip()
        now = _now_epoch()
        request_where = [
            "r.created_at >= ?",
            """
            (
                r.path LIKE '/v1/%'
                OR EXISTS (
                    SELECT 1
                    FROM ops_account_events ev1
                    WHERE ev1.request_id = r.request_id AND ev1.endpoint LIKE '/v1/%'
                )
            )
            """,
        ]
        params: list[Any] = [since]
        if endpoint:
            request_where.append(
                """
                (
                    r.path = ?
                    OR EXISTS (
                        SELECT 1
                        FROM ops_account_events e2
                        WHERE e2.request_id = r.request_id AND e2.endpoint = ?
                    )
                )
                """
            )
            params.extend([endpoint, endpoint])
        request_where_sql = " AND ".join(request_where)

        with self._connection() as conn:
            total_row = conn.execute(
                f"""
                SELECT COUNT(*) AS total
                FROM ops_requests r
                WHERE {request_where_sql}
                """,
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                SELECT
                    r.request_id,
                    r.created_at AS first_at,
                    CASE
                        WHEN r.completed_at > 0 THEN r.completed_at
                        ELSE r.updated_at
                    END AS last_at,
                    r.method,
                    r.path,
                    r.status AS request_status,
                    r.http_status,
                    r.duration_ms AS request_duration_ms,
                    r.error_message AS request_error,
                    COUNT(e.id) AS attempts,
                    COALESCE(SUM(CASE WHEN e.status = 'completed' AND e.success = 1 THEN 1 ELSE 0 END), 0) AS successful_attempts,
                    COALESCE(SUM(CASE WHEN e.status = 'completed' AND e.success = 0 THEN 1 ELSE 0 END), 0) AS failed_attempts,
                    COALESCE(SUM(CASE WHEN e.status = 'running' THEN 1 ELSE 0 END), 0) AS running_attempts,
                    GROUP_CONCAT(DISTINCT e.endpoint) AS endpoints,
                    GROUP_CONCAT(DISTINCT e.model) AS models,
                    GROUP_CONCAT(DISTINCT e.account_id) AS account_ids,
                    GROUP_CONCAT(DISTINCT CASE WHEN e.error_type <> '' THEN e.error_type END) AS error_types,
                    MAX(e.latency_ms) AS max_latency_ms
                FROM ops_requests r
                LEFT JOIN ops_account_events e ON e.request_id = r.request_id
                WHERE {request_where_sql}
                GROUP BY r.request_id
                ORDER BY last_at DESC
                LIMIT ? OFFSET ?
                """,
                [*params, page_size, offset],
            ).fetchall()

        return {
            "items": [
                {
                    "request_id": item["request_id"],
                    "first_at": int(item["first_at"] or 0),
                    "last_at": int(item["last_at"] or 0),
                    "method": item["method"] or "",
                    "path": item["path"] or "",
                    "request_status": item["request_status"] or "running",
                    "http_status": int(item["http_status"] or 0),
                    "attempts": int(item["attempts"] or 0),
                    "successful_attempts": int(item["successful_attempts"] or 0),
                    "failed_attempts": int(item["failed_attempts"] or 0),
                    "running_attempts": int(item["running_attempts"] or 0),
                    "success": (
                        str(item["request_status"] or "") == "completed"
                        and 200 <= int(item["http_status"] or 0) < 400
                        and (
                            int(item["successful_attempts"] or 0) > 0
                            or int(item["attempts"] or 0) == 0
                        )
                    ),
                    "endpoints": [
                        value
                        for value in str(item["endpoints"] or "").split(",")
                        if _is_v1_endpoint(value)
                    ],
                    "models": [value for value in str(item["models"] or "").split(",") if value],
                    "account_ids": [value for value in str(item["account_ids"] or "").split(",") if value],
                    "error_types": [value for value in str(item["error_types"] or "").split(",") if value],
                    "duration_ms": (
                        max(0, int(item["request_duration_ms"] or 0))
                        if str(item["request_status"] or "") != "running"
                        else max(0, (now - int(item["first_at"] or now)) * 1000)
                    ),
                    "max_latency_ms": max(0, int(item["max_latency_ms"] or 0)),
                    "error_message": item["request_error"] or "",
                }
                for item in rows
            ],
            "total": int(total_row["total"] or 0),
            "page": page,
            "page_size": page_size,
        }

    def request_trace(self, request_id: str) -> dict[str, Any] | None:
        request_id = str(request_id or "").strip()[:80]
        if not request_id:
            return None
        now = _now_epoch()
        with self._connection() as conn:
            request_row = conn.execute(
                """
                SELECT
                    request_id,
                    created_at,
                    updated_at,
                    completed_at,
                    method,
                    path,
                    status,
                    http_status,
                    duration_ms,
                    error_message
                FROM ops_requests
                WHERE request_id = ?
                """,
                (request_id,),
            ).fetchone()
            rows = conn.execute(
                """
                SELECT
                    created_at,
                    request_id,
                    attempt_index,
                    account_id,
                    endpoint,
                    model,
                    success,
                    latency_ms,
                    error_type,
                    error_message,
                    status,
                    completed_at
                FROM ops_account_events
                WHERE request_id = ?
                ORDER BY attempt_index ASC, created_at ASC, id ASC
                """,
                (request_id,),
            ).fetchall()
        if request_row is None and not rows:
            return None
        first_at = int((request_row or rows[0])["created_at"] or 0)
        last_at = int(
            (request_row["completed_at"] if request_row and int(request_row["completed_at"] or 0) else 0)
            or (request_row["updated_at"] if request_row else 0)
            or (rows[-1]["completed_at"] if rows and int(rows[-1]["completed_at"] or 0) else 0)
            or (rows[-1]["created_at"] if rows else 0)
            or 0
        )
        return {
            "request_id": request_id,
            "first_at": first_at,
            "last_at": last_at,
            "method": request_row["method"] if request_row else "",
            "path": request_row["path"] if request_row else "",
            "request_status": request_row["status"] if request_row else "",
            "http_status": int(request_row["http_status"] or 0) if request_row else 0,
            "duration_ms": (
                int(request_row["duration_ms"] or 0)
                if request_row and request_row["status"] != "running"
                else max(0, (now - first_at) * 1000)
            ),
            "error_message": request_row["error_message"] if request_row else "",
            "attempts": [
                {
                    "created_at": int(item["created_at"] or 0),
                    "completed_at": int(item["completed_at"] or 0),
                    "attempt_index": int(item["attempt_index"] or 0),
                    "account_id": item["account_id"],
                    "endpoint": item["endpoint"],
                    "model": item["model"],
                    "status": item["status"] or "completed",
                    "success": bool(item["success"]) and str(item["status"] or "completed") == "completed",
                    "latency_ms": int(item["latency_ms"] or 0),
                    "error_type": item["error_type"] or "",
                    "error_message": item["error_message"] or "",
                }
                for item in rows
            ],
        }

    def overview(self, *, range_hours: int = 24) -> dict[str, Any]:
        since = _now_epoch() - max(1, int(range_hours or 24)) * 3600
        with self._connection() as conn:
            row = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(success), 0) AS success,
                    COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed,
                    COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
                FROM ops_account_events
                WHERE created_at >= ? AND status = 'completed'
                """,
                (since,),
            ).fetchone()
            latencies = [
                int(item["latency_ms"])
                for item in conn.execute(
                    """
                    SELECT latency_ms
                    FROM ops_account_events
                    WHERE created_at >= ? AND status = 'completed'
                    ORDER BY latency_ms
                    """,
                    (since,),
                ).fetchall()
            ]
            endpoint_rows = conn.execute(
                """
                SELECT endpoint, COUNT(*) AS total, COALESCE(SUM(success), 0) AS success
                FROM ops_account_events
                WHERE created_at >= ? AND status = 'completed'
                GROUP BY endpoint
                ORDER BY total DESC
                """,
                (since,),
            ).fetchall()
            error_rows = conn.execute(
                """
                SELECT error_type, COUNT(*) AS total
                FROM ops_account_events
                WHERE created_at >= ? AND success = 0 AND status = 'completed'
                GROUP BY error_type
                ORDER BY total DESC
                LIMIT 10
                """,
                (since,),
            ).fetchall()

        total = int(row["total"] or 0)
        success = int(row["success"] or 0)
        failed = int(row["failed"] or 0)
        p95_latency_ms = 0
        if latencies:
            p95_index = min(len(latencies) - 1, int(len(latencies) * 0.95))
            p95_latency_ms = latencies[p95_index]
        return {
            "range_hours": range_hours,
            "total": total,
            "success": success,
            "failed": failed,
            "success_rate": round(success / total, 4) if total else 0,
            "avg_latency_ms": int(row["avg_latency_ms"] or 0),
            "p95_latency_ms": p95_latency_ms,
            "endpoints": [
                {
                    "endpoint": item["endpoint"],
                    "total": int(item["total"] or 0),
                    "success": int(item["success"] or 0),
                    "success_rate": round(int(item["success"] or 0) / int(item["total"] or 1), 4),
                }
                for item in endpoint_rows
            ],
            "errors": [
                {"error_type": item["error_type"] or "unknown", "total": int(item["total"] or 0)}
                for item in error_rows
            ],
        }

    def account_stats(self, *, range_hours: int = 24) -> dict[str, dict[str, Any]]:
        since = _now_epoch() - max(1, int(range_hours or 24)) * 3600
        with self._connection() as conn:
            rows = conn.execute(
                """
                SELECT
                    account_id,
                    COUNT(*) AS total,
                    COALESCE(SUM(success), 0) AS success,
                    COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed,
                    COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
                    MAX(CASE WHEN success = 1 THEN created_at ELSE 0 END) AS last_success_at,
                    MAX(CASE WHEN success = 0 THEN created_at ELSE 0 END) AS last_failed_at
                FROM ops_account_events
                WHERE created_at >= ? AND status = 'completed'
                GROUP BY account_id
                """,
                (since,),
            ).fetchall()
            error_rows = conn.execute(
                """
                SELECT account_id, error_type, error_message, created_at
                FROM ops_account_events
                WHERE created_at >= ? AND success = 0 AND status = 'completed'
                ORDER BY created_at DESC
                """,
                (since,),
            ).fetchall()

        stats: dict[str, dict[str, Any]] = {}
        for item in rows:
            total = int(item["total"] or 0)
            success = int(item["success"] or 0)
            stats[item["account_id"]] = {
                "total": total,
                "success": success,
                "failed": int(item["failed"] or 0),
                "success_rate": round(success / total, 4) if total else 0,
                "avg_latency_ms": int(item["avg_latency_ms"] or 0),
                "last_success_at": int(item["last_success_at"] or 0),
                "last_failed_at": int(item["last_failed_at"] or 0),
                "last_error_type": "",
                "last_error": "",
            }
        for item in error_rows:
            account_id = item["account_id"]
            if account_id not in stats:
                continue
            if stats[account_id]["last_error"]:
                continue
            stats[account_id]["last_error_type"] = item["error_type"] or "unknown"
            stats[account_id]["last_error"] = item["error_message"] or ""
        return stats


ops_service = OpsService(OPS_DB_FILE)
