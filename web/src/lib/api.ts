import { httpRequest } from "@/lib/request";

export type AccountType = "Free" | "Plus" | "ProLite" | "Pro" | "Team";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "auto" | "gpt-image-1" | "gpt-image-2";

export type Account = {
  id: string;
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  imageQuotaUnknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
  consecutiveFailures?: number;
  cooldownUntil?: string | null;
  runtimeStatus?: "healthy" | "degraded" | "cooling" | "suspect";
  lastSuccessAt?: string | null;
  lastFailedAt?: string | null;
  lastError?: string | null;
  healthScore?: number;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  "auth-key"?: string;
  refresh_account_interval_minute?: number | string;
  [key: string]: unknown;
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<{ ok: boolean }>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(prompt: string, model?: ImageModel, size?: string) {
  return httpRequest<{ created: number; data: Array<{ b64_json: string; revised_prompt?: string }> }>(
    "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        n: 1,
        response_format: "b64_json",
      },
    },
  );
}

export async function editImage(files: File | File[], prompt: string, model?: ImageModel, size?: string) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  formData.append("n", "1");

  return httpRequest<{ created: number; data: Array<{ b64_json: string; revised_prompt?: string }> }>(
    "/v1/images/edits",
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`);
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`);
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers");
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
  });
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
  });
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
  });
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`);
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}

// ── Ops monitoring ────────────────────────────────────────────────

export type OpsOverview = {
  metrics: {
    range_hours: number;
    total: number;
    success: number;
    failed: number;
    success_rate: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    endpoints: Array<{
      endpoint: string;
      total: number;
      success: number;
      success_rate: number;
    }>;
    errors: Array<{ error_type: string; total: number }>;
  };
  accounts: {
    total: number;
    normal: number;
    limited: number;
    abnormal: number;
    disabled: number;
    cooling: number;
    suspect: number;
    degraded: number;
  };
};

export type AccountHealth = Account & {
  total24h: number;
  success24h: number;
  failed24h: number;
  successRate24h: number;
  avgLatencyMs24h: number;
  lastErrorType24h: string;
  lastError24h: string;
};

export type RequestTraceAccount = {
  id: string;
  email?: string | null;
  type?: AccountType;
  status?: AccountStatus;
  quota?: number;
  runtimeStatus?: Account["runtimeStatus"];
  healthScore?: number;
  access_token?: string;
};

export type OpsRequestTraceSummary = {
  request_id: string;
  first_at: number;
  last_at: number;
  method: string;
  path: string;
  request_status: "running" | "completed" | "failed" | string;
  http_status: number;
  attempts: number;
  successful_attempts: number;
  failed_attempts: number;
  running_attempts: number;
  success: boolean;
  endpoints: string[];
  models: string[];
  account_ids: string[];
  accounts: RequestTraceAccount[];
  error_types: string[];
  duration_ms: number;
  max_latency_ms: number;
  error_message: string;
};

export type OpsRequestTraceAttempt = {
  created_at: number;
  completed_at: number;
  attempt_index: number;
  account_id: string;
  endpoint: string;
  model: string;
  status: "running" | "completed" | string;
  success: boolean;
  latency_ms: number;
  error_type: string;
  error_message: string;
  account: RequestTraceAccount;
};

export type OpsRequestTraceDetail = {
  request_id: string;
  first_at: number;
  last_at: number;
  method: string;
  path: string;
  request_status: "running" | "completed" | "failed" | string;
  http_status: number;
  duration_ms: number;
  error_message: string;
  attempts: OpsRequestTraceAttempt[];
};

export async function fetchOpsOverview(rangeHours = 24) {
  return httpRequest<OpsOverview>(`/api/ops/overview?range_hours=${rangeHours}`);
}

export async function fetchAccountHealth(params: {
  rangeHours?: number;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: "asc" | "desc";
} = {}) {
  const search = new URLSearchParams({
    range_hours: String(params.rangeHours ?? 24),
    page: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 100),
    sort: params.sort ?? "health_score",
    order: params.order ?? "asc",
  });
  return httpRequest<{ items: AccountHealth[]; total: number; page: number; page_size: number }>(
    `/api/ops/accounts/health?${search.toString()}`,
  );
}

export async function fetchOpsRequestTraces(params: {
  rangeHours?: number;
  endpoint?: string;
  page?: number;
  pageSize?: number;
} = {}) {
  const search = new URLSearchParams({
    range_hours: String(params.rangeHours ?? 24),
    endpoint: params.endpoint ?? "",
    page: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 50),
  });
  return httpRequest<{ items: OpsRequestTraceSummary[]; total: number; page: number; page_size: number }>(
    `/api/ops/requests?${search.toString()}`,
  );
}

export async function fetchOpsRequestTrace(requestId: string) {
  return httpRequest<OpsRequestTraceDetail>(`/api/ops/requests/${encodeURIComponent(requestId)}`);
}

export async function cooldownAccount(accountId: string, minutes = 30, reason = "manual cooldown") {
  return httpRequest<{ ok: boolean; account_id: string }>(`/api/ops/accounts/${accountId}/cooldown`, {
    method: "POST",
    body: { minutes, reason },
  });
}

export async function restoreAccountRuntime(accountId: string) {
  return httpRequest<{ ok: boolean; account_id: string }>(`/api/ops/accounts/${accountId}/restore`, {
    method: "POST",
  });
}
