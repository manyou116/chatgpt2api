"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleOff,
  Copy,
  Download,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  TimerReset,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteAccounts,
  fetchAccountHealth,
  fetchOpsOverview,
  fetchOpsRequestTrace,
  fetchOpsRequestTraces,
  refreshAccounts,
  updateAccount,
  type Account,
  type AccountHealth,
  type AccountStatus,
  type AccountType,
  type OpsOverview,
  type OpsRequestTraceDetail,
  type OpsRequestTraceSummary,
  type RequestTraceAccount,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import { AccountImportDialog } from "./components/account-import-dialog";

const accountTypeOptions: { label: string; value: AccountType | "all" }[] = [
  { label: "全部类型", value: "all" },
  { label: "Free", value: "Free" },
  { label: "Plus", value: "Plus" },
  { label: "ProLite", value: "ProLite" },
  { label: "Team", value: "Team" },
  { label: "Pro", value: "Pro" },
];

const accountStatusOptions: { label: string; value: AccountStatus | "all" }[] = [
  { label: "全部状态", value: "all" },
  { label: "正常", value: "正常" },
  { label: "限流", value: "限流" },
  { label: "异常", value: "异常" },
  { label: "禁用", value: "禁用" },
];

const statusMeta: Record<
  AccountStatus,
  {
    icon: typeof CheckCircle2;
    badge: ComponentProps<typeof Badge>["variant"];
  }
> = {
  正常: { icon: CheckCircle2, badge: "success" },
  限流: { icon: CircleAlert, badge: "warning" },
  异常: { icon: CircleOff, badge: "danger" },
  禁用: { icon: Ban, badge: "secondary" },
};

const runtimeMeta = {
  healthy: { label: "健康", variant: "success" as const },
  degraded: { label: "降级", variant: "warning" as const },
  cooling: { label: "冷却", variant: "info" as const },
  suspect: { label: "可疑", variant: "danger" as const },
};

const metricCards = [
  { key: "total", label: "账户总数", color: "text-stone-900", icon: UserRound },
  { key: "active", label: "正常账户", color: "text-emerald-600", icon: CheckCircle2 },
  { key: "limited", label: "限流账户", color: "text-orange-500", icon: CircleAlert },
  { key: "abnormal", label: "异常账户", color: "text-rose-500", icon: CircleOff },
  { key: "disabled", label: "禁用账户", color: "text-stone-500", icon: Ban },
  { key: "quota", label: "剩余额度", color: "text-blue-500", icon: RefreshCw },
] as const;

type AccountRow = Account & Partial<AccountHealth>;

function isUnlimitedImageQuotaAccount(account: Account) {
  return account.type === "Pro" || account.type === "ProLite";
}

function formatCompact(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function formatPercent(value: number) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatEpochTime(value?: number | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function formatQuota(account: AccountRow) {
  if (isUnlimitedImageQuotaAccount(account)) {
    return "∞";
  }
  if (account.imageQuotaUnknown) {
    return "未知";
  }
  return String(Math.max(0, account.quota));
}

function formatRestoreAt(value?: string | null) {
  if (!value) {
    return { absolute: "—", relative: "" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: value, relative: "" };
  }

  const diffMs = Math.max(0, date.getTime() - Date.now());
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const relative = diffMs > 0 ? `剩余 ${days}d ${hours}h` : "已到恢复时间";

  const pad = (num: number) => String(num).padStart(2, "0");
  const absolute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return { absolute, relative };
}

function formatQuotaSummary(accounts: AccountRow[]) {
  const availableAccounts = accounts.filter((account) => account.status === "正常");
  if (availableAccounts.some(isUnlimitedImageQuotaAccount)) {
    return "∞";
  }
  if (availableAccounts.some((account) => account.imageQuotaUnknown)) {
    return "未知";
  }
  return formatCompact(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function maskToken(token?: string) {
  if (!token) return "—";
  if (token.length <= 18) return token;
  return `${token.slice(0, 16)}...${token.slice(-8)}`;
}

function downloadTokens(accounts: AccountRow[]) {
  const content = `${accounts.map((account) => account.access_token).join("\n")}\n`;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `accounts-${Date.now()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function normalizeAccounts<T extends Account>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    type:
      item.type === "Plus" ||
      item.type === "ProLite" ||
      item.type === "Team" ||
      item.type === "Pro" ||
      item.type === "Free"
        ? item.type
        : "Free",
  })) as T[];
}

function accountLabel(account?: RequestTraceAccount | null) {
  if (!account) {
    return "--";
  }
  return account.email || account.id || "--";
}

function traceStatusMeta(item: OpsRequestTraceSummary) {
  if (item.request_status === "running" || item.running_attempts > 0) {
    return { label: "运行中", variant: "info" as const };
  }
  if (item.error_types?.includes("text_response")) {
    return { label: "文本响应", variant: "warning" as const };
  }
  if (item.success) {
    return { label: "成功", variant: "success" as const };
  }
  return { label: "失败", variant: "danger" as const };
}

function attemptStatusMeta(attempt: OpsRequestTraceDetail["attempts"][number]) {
  if (attempt.status === "running") {
    return { label: "运行中", variant: "info" as const };
  }
  if (attempt.error_type === "text_response") {
    return { label: "文本响应", variant: "warning" as const };
  }
  if (attempt.success) {
    return { label: "成功", variant: "success" as const };
  }
  return { label: "失败", variant: "danger" as const };
}

export default function AccountsPage() {
  const didLoadRef = useRef(false);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<AccountType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("10");
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editType, setEditType] = useState<AccountType>("Free");
  const [editStatus, setEditStatus] = useState<AccountStatus>("正常");
  const [editQuota, setEditQuota] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [requestTraces, setRequestTraces] = useState<OpsRequestTraceSummary[]>([]);
  const [requestTotal, setRequestTotal] = useState(0);
  const [requestPage, setRequestPage] = useState(1);
  const [requestPageSize, setRequestPageSize] = useState("20");
  const [requestEndpoint, setRequestEndpoint] = useState("");
  const [selectedRequest, setSelectedRequest] = useState<OpsRequestTraceDetail | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [isOpsLoading, setIsOpsLoading] = useState(true);
  const [isTraceLoading, setIsTraceLoading] = useState(true);
  const [isRequestLoading, setIsRequestLoading] = useState(false);

  const loadAccounts = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchAccountHealth({
        rangeHours: 24,
        pageSize: 5000,
        sort: "last_used",
        order: "desc",
      });
      setAccounts(normalizeAccounts(data.items));
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.id === id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载账户失败";
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const loadOpsOverview = async () => {
    setIsOpsLoading(true);
    try {
      setOverview(await fetchOpsOverview(24));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载运维统计失败";
      toast.error(message);
    } finally {
      setIsOpsLoading(false);
    }
  };

  const loadRequestTraces = useCallback(async () => {
    setIsTraceLoading(true);
    try {
      const data = await fetchOpsRequestTraces({
        rangeHours: 24,
        endpoint: requestEndpoint,
        page: requestPage,
        pageSize: Number(requestPageSize),
      });
      setRequestTraces(data.items);
      setRequestTotal(data.total);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载请求追踪失败";
      toast.error(message);
    } finally {
      setIsTraceLoading(false);
    }
  }, [requestEndpoint, requestPage, requestPageSize]);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadAccounts();
    void loadOpsOverview();
  }, []);

  useEffect(() => {
    void loadRequestTraces();
  }, [loadRequestTraces]);

  const filteredAccounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return accounts.filter((account) => {
      const searchMatched =
        normalizedQuery.length === 0 || (account.email ?? "").toLowerCase().includes(normalizedQuery);
      const typeMatched = typeFilter === "all" || account.type === typeFilter;
      const statusMatched = statusFilter === "all" || account.status === statusFilter;
      return searchMatched && typeMatched && statusMatched;
    });
  }, [accounts, query, statusFilter, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredAccounts.length / Number(pageSize)));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * Number(pageSize);
  const currentRows = filteredAccounts.slice(startIndex, startIndex + Number(pageSize));
  const allCurrentSelected =
    currentRows.length > 0 && currentRows.every((row) => selectedIds.includes(row.id));

  const summary = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter((item) => item.status === "正常").length;
    const limited = accounts.filter((item) => item.status === "限流").length;
    const abnormal = accounts.filter((item) => item.status === "异常").length;
    const disabled = accounts.filter((item) => item.status === "禁用").length;
    const quota = formatQuotaSummary(accounts);

    return { total, active, limited, abnormal, disabled, quota };
  }, [accounts]);

  const metrics = overview?.metrics;
  const accountCounts = overview?.accounts;
  const dashboardCards = useMemo(
    () => [
      ...metricCards.map((item) => ({
        label: item.label,
        value: summary[item.key],
        icon: item.icon,
        color: item.color,
      })),
      {
        label: "24h 调用量",
        value: formatNumber(metrics?.total || 0),
        icon: Activity,
        color: "text-stone-900",
      },
      {
        label: "24h 成功率",
        value: formatPercent(metrics?.success_rate || 0),
        icon: CheckCircle2,
        color: "text-emerald-600",
      },
      {
        label: "24h 失败",
        value: formatNumber(metrics?.failed || 0),
        icon: ShieldAlert,
        color: "text-rose-600",
      },
      {
        label: "P95 耗时",
        value: `${formatNumber(metrics?.p95_latency_ms || 0)} ms`,
        icon: TimerReset,
        color: "text-blue-600",
      },
      {
        label: "冷却账号",
        value: formatNumber(accountCounts?.cooling || 0),
        icon: RefreshCw,
        color: "text-sky-600",
      },
      {
        label: "可疑账号",
        value: formatNumber(accountCounts?.suspect || 0),
        icon: ShieldAlert,
        color: "text-orange-600",
      },
    ],
    [accountCounts, metrics, summary],
  );

  const requestPageCount = Math.max(1, Math.ceil(requestTotal / Number(requestPageSize)));

  const selectedTokens = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    return accounts.filter((item) => selectedSet.has(item.id)).map((item) => item.access_token);
  }, [accounts, selectedIds]);

  const abnormalTokens = useMemo(() => {
    return accounts.filter((item) => item.status === "异常").map((item) => item.access_token);
  }, [accounts]);

  const paginationItems = useMemo(() => {
    const items: (number | "...")[] = [];
    const start = Math.max(1, safePage - 1);
    const end = Math.min(pageCount, safePage + 1);

    if (start > 1) items.push(1);
    if (start > 2) items.push("...");
    for (let current = start; current <= end; current += 1) items.push(current);
    if (end < pageCount - 1) items.push("...");
    if (end < pageCount) items.push(pageCount);

    return items;
  }, [pageCount, safePage]);

  const handleDeleteTokens = async (tokens: string[]) => {
    if (tokens.length === 0) {
      toast.error("请先选择要删除的账户");
      return;
    }

    setIsDeleting(true);
    try {
      const data = await deleteAccounts(tokens);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.id === id)));
      await loadAccounts(true);
      void loadOpsOverview();
      toast.success(`删除 ${data.removed ?? 0} 个账户`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除账户失败";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRefreshAccounts = async (accessTokens: string[]) => {
    if (accessTokens.length === 0) {
      toast.error("没有需要刷新的账户");
      return;
    }

    setIsRefreshing(true);
    try {
      const data = await refreshAccounts(accessTokens);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.id === id)));
      await loadAccounts(true);
      void loadOpsOverview();
      if (data.errors.length > 0) {
        const firstError = data.errors[0]?.error;
        toast.error(
          `刷新成功 ${data.refreshed} 个，失败 ${data.errors.length} 个${firstError ? `，首个错误：${firstError}` : ""}`,
        );
      } else {
        toast.success(`刷新成功 ${data.refreshed} 个账户`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新账户失败";
      toast.error(message);
    } finally {
      setIsRefreshing(false);
    }
  };

  const openEditDialog = (account: Account) => {
    setEditingAccount(account);
    setEditType(account.type);
    setEditStatus(account.status);
    setEditQuota(String(account.quota));
  };

  const handleUpdateAccount = async () => {
    if (!editingAccount) {
      return;
    }

    setIsUpdating(true);
    try {
      const data = await updateAccount(editingAccount.access_token, {
        type: editType,
        status: editStatus,
        quota: Number(editQuota || 0),
      });
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.id === id)));
      await loadAccounts(true);
      void loadOpsOverview();
      setEditingAccount(null);
      toast.success("账号信息已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新账号失败";
      toast.error(message);
    } finally {
      setIsUpdating(false);
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...currentRows.map((item) => item.id)])));
      return;
    }
    setSelectedIds((prev) => prev.filter((id) => !currentRows.some((row) => row.id === id)));
  };

  const handleSelectRequest = async (requestId: string) => {
    setSelectedRequestId(requestId);
    setIsRequestLoading(true);
    try {
      setSelectedRequest(await fetchOpsRequestTrace(requestId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载请求明细失败";
      toast.error(message);
    } finally {
      setIsRequestLoading(false);
    }
  };

  const handleCopyRequestId = async (requestId: string) => {
    try {
      await window.navigator.clipboard.writeText(requestId);
      toast.success("已复制 request_id");
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">
            Account Pool
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">号池管理</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => {
              void loadAccounts();
              void loadOpsOverview();
              void loadRequestTraces();
            }}
            disabled={isLoading || isRefreshing || isDeleting || isTraceLoading || isOpsLoading}
          >
            <RefreshCw className={cn("size-4", isLoading || isTraceLoading || isOpsLoading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => void handleRefreshAccounts(accounts.map((item) => item.access_token))}
            disabled={isLoading || isRefreshing || isDeleting || accounts.length === 0}
          >
            <RefreshCw className={cn("size-4", isRefreshing ? "animate-spin" : "")} />
            一键刷新所有账号信息和额度
          </Button>
          <AccountImportDialog
            disabled={isLoading || isRefreshing || isDeleting}
            onImported={(items) => {
              setAccounts(normalizeAccounts(items));
              setSelectedIds([]);
              setPage(1);
              void loadAccounts(true);
              void loadOpsOverview();
            }}
          />
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white/80 px-4 text-stone-700 hover:bg-white"
            onClick={() => downloadTokens(accounts)}
            disabled={accounts.length === 0}
          >
            <Download className="size-4" />
            导出全部 Token
          </Button>
        </div>
      </section>

      <Dialog open={Boolean(editingAccount)} onOpenChange={(open) => (!open ? setEditingAccount(null) : null)}>
        <DialogContent showCloseButton={false} className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑账户</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              手动修改账号状态、类型和额度。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">状态</label>
              <Select value={editStatus} onValueChange={(value) => setEditStatus(value as AccountStatus)}>
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountStatusOptions
                    .filter((option) => option.value !== "all")
                    .map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">类型</label>
              <Select value={editType} onValueChange={(value) => setEditType(value as AccountType)}>
                <SelectTrigger className="h-11 rounded-xl border-stone-200 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accountTypeOptions
                    .filter((option) => option.value !== "all")
                    .map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">额度</label>
              <Input
                value={editQuota}
                onChange={(event) => setEditQuota(event.target.value)}
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setEditingAccount(null)}
              disabled={isUpdating}
            >
              取消
            </Button>
            <Button
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleUpdateAccount()}
              disabled={isUpdating}
            >
              {isUpdating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <section className="space-y-4">
        <div className="space-y-4">
          <section className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {dashboardCards.map((item) => {
            const Icon = item.icon;
            const value = item.value;
            return (
              <Card key={item.label} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
                <CardContent className="p-4">
                  <div className="mb-4 flex items-start justify-between">
                    <span className="text-xs font-medium text-stone-400">{item.label}</span>
                    <Icon className="size-4 text-stone-400" />
                  </div>
                  <div className={cn("text-[1.75rem] font-semibold tracking-tight", item.color)}>
                    <span className={typeof value === "number" ? "" : "text-[1.1rem]"}>
                      {typeof value === "number" ? formatCompact(value) : value}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">账户列表</h2>
            <Badge variant="secondary" className="rounded-lg bg-stone-200 px-2 py-0.5 text-stone-700">
              {filteredAccounts.length}
            </Badge>
          </div>

          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-[260px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索邮箱"
                className="h-10 rounded-xl border-stone-200 bg-white/85 pl-10"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) => {
                setTypeFilter(value as AccountType | "all");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value as AccountStatus | "all");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-full rounded-xl border-stone-200 bg-white/85 lg:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accountStatusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {isLoading && accounts.length === 0 ? (
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
              <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                <LoaderCircle className="size-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-stone-700">正在加载账户</p>
                <p className="text-sm text-stone-500">从后端同步账号列表和状态。</p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card
          className={cn(
            "overflow-hidden rounded-2xl border-white/80 bg-white/90 shadow-sm",
            isLoading && accounts.length === 0 ? "hidden" : "",
          )}
        >
          <CardContent className="space-y-0 p-0">
            <div className="flex flex-col gap-3 border-b border-stone-100 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-sm text-stone-500">
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-stone-500 hover:bg-stone-100"
                  onClick={() => void handleRefreshAccounts(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isRefreshing}
                >
                  {isRefreshing ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  刷新选中账号信息和额度
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                  onClick={() => void handleDeleteTokens(abnormalTokens)}
                  disabled={abnormalTokens.length === 0 || isDeleting}
                >
                  {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  移除异常账号
                </Button>
                <Button
                  variant="ghost"
                  className="h-8 rounded-lg px-3 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                  onClick={() => void handleDeleteTokens(selectedTokens)}
                  disabled={selectedTokens.length === 0 || isDeleting}
                >
                  {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  删除所选
                </Button>
                {selectedIds.length > 0 ? (
                  <span className="rounded-lg bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                    已选择 {selectedIds.length} 项
                  </span>
                ) : null}
              </div>
            </div>

            <div className="max-h-[640px] overflow-auto">
              <table className="w-full min-w-[1520px] text-left">
                <thead className="sticky top-0 z-10 border-b border-stone-100 bg-white/95 text-[11px] text-stone-400 uppercase tracking-[0.18em] backdrop-blur">
                  <tr>
                    <th className="w-12 px-4 py-3">
                      <Checkbox
                        checked={allCurrentSelected}
                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                      />
                    </th>
                    <th className="w-56 px-4 py-3">token</th>
                    <th className="w-28 px-4 py-3">类型</th>
                    <th className="w-24 px-4 py-3">状态</th>
                    <th className="w-24 px-4 py-3">运行态</th>
                    <th className="w-24 px-4 py-3">健康分</th>
                    <th className="w-28 px-4 py-3">24h 成功率</th>
                    <th className="w-24 px-4 py-3">24h 成功</th>
                    <th className="w-24 px-4 py-3">24h 失败</th>
                    <th className="w-24 px-4 py-3">连续失败</th>
                    <th className="w-56 px-4 py-3">账号信息</th>
                    <th className="w-24 px-4 py-3">额度</th>
                    <th className="w-40 px-4 py-3">恢复时间</th>
                    <th className="w-72 px-4 py-3">最近错误</th>
                    <th className="w-24 px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {currentRows.map((account) => {
                    const status = statusMeta[account.status];
                    const StatusIcon = status.icon;
                    const runtime = runtimeMeta[account.runtimeStatus || "healthy"] || runtimeMeta.healthy;

                    return (
                      <tr
                        key={account.id}
                        className="border-b border-stone-100/80 text-sm text-stone-600 transition-colors hover:bg-stone-50/70"
                      >
                        <td className="px-4 py-3">
                          <Checkbox
                            checked={selectedIds.includes(account.id)}
                            onCheckedChange={(checked) => {
                              setSelectedIds((prev) =>
                                checked
                                  ? Array.from(new Set([...prev, account.id]))
                                  : prev.filter((item) => item !== account.id),
                              );
                            }}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium tracking-tight text-stone-700">
                              {maskToken(account.access_token)}
                            </span>
                            <button
                              type="button"
                              className="rounded-lg p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => {
                                void navigator.clipboard.writeText(account.access_token);
                                toast.success("token 已复制");
                              }}
                            >
                              <Copy className="size-4" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="rounded-md bg-stone-100 text-stone-700">
                            {account.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={status.badge}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1"
                          >
                            <StatusIcon className="size-3.5" />
                            {account.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={runtime.variant} className="rounded-md">
                            {runtime.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-medium text-stone-800">{account.healthScore ?? 0}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-stone-800">{formatPercent(account.successRate24h || 0)}</div>
                          <div className="text-xs text-stone-400">
                            {formatNumber(account.success24h || 0)} / {formatNumber(account.total24h || 0)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-stone-600">{formatNumber(account.success24h || 0)}</td>
                        <td className="px-4 py-3 text-stone-600">{formatNumber(account.failed24h || 0)}</td>
                        <td className="px-4 py-3 text-stone-600">{formatNumber(account.consecutiveFailures || 0)}</td>
                        <td className="px-4 py-3">
                          <div className="text-xs leading-5 text-stone-500">{account.email ?? "—"}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="info" className="rounded-md">
                            {formatQuota(account)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-xs leading-5 text-stone-500">
                          {(() => {
                            const restore = formatRestoreAt(account.restoreAt);
                            return (
                              <div className="space-y-0.5">
                                {restore.relative ? <div className="font-medium text-stone-700">{restore.relative}</div> : null}
                                <div>{restore.absolute}</div>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="line-clamp-2 text-xs leading-5 text-stone-600">
                            {account.lastError24h || account.lastError || "—"}
                          </div>
                          <div className="font-mono text-xs text-stone-400">{account.lastErrorType24h || ""}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 text-stone-400">
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => openEditDialog(account)}
                              disabled={isUpdating}
                            >
                              <Pencil className="size-4" />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-stone-100 hover:text-stone-700"
                              onClick={() => void handleRefreshAccounts([account.access_token])}
                              disabled={isRefreshing}
                            >
                              <RefreshCw className={cn("size-4", isRefreshing ? "animate-spin" : "")} />
                            </button>
                            <button
                              type="button"
                              className="rounded-lg p-2 transition hover:bg-rose-50 hover:text-rose-500"
                              onClick={() => void handleDeleteTokens([account.access_token])}
                              disabled={isDeleting}
                            >
                              <Trash2 className="size-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {!isLoading && currentRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <div className="rounded-xl bg-stone-100 p-3 text-stone-500">
                    <Search className="size-5" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-stone-700">没有匹配的账户</p>
                    <p className="text-sm text-stone-500">调整筛选条件或搜索关键字后重试。</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-stone-100 px-4 py-4">
              <div className="flex items-center justify-center gap-3 overflow-x-auto whitespace-nowrap">
                <div className="shrink-0 text-sm text-stone-500">
                显示第 {filteredAccounts.length === 0 ? 0 : startIndex + 1} -{" "}
                {Math.min(startIndex + Number(pageSize), filteredAccounts.length)} 条，共{" "}
                {filteredAccounts.length} 条
                </div>

                <span className="shrink-0 text-sm leading-none text-stone-500">
                  {safePage} / {pageCount} 页
                </span>
                <Select
                  value={pageSize}
                  onValueChange={(value) => {
                    setPageSize(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-[108px] shrink-0 rounded-lg border-stone-200 bg-white text-sm leading-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 / 页</SelectItem>
                    <SelectItem value="20">20 / 页</SelectItem>
                    <SelectItem value="50">50 / 页</SelectItem>
                    <SelectItem value="100">100 / 页</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {paginationItems.map((item, index) =>
                  item === "..." ? (
                    <span key={`ellipsis-${index}`} className="px-1 text-sm text-stone-400">
                      ...
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === safePage ? "default" : "outline"}
                      className={cn(
                        "h-10 min-w-10 shrink-0 rounded-lg px-3",
                        item === safePage
                          ? "bg-stone-950 text-white hover:bg-stone-800"
                          : "border-stone-200 bg-white text-stone-700",
                      )}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 rounded-lg border-stone-200 bg-white"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                >
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
          </section>
        <section className="grid gap-4 lg:grid-cols-2">
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold text-stone-900">接口分布</h2>
              {(metrics?.endpoints || []).map((item) => (
                <div key={item.endpoint} className="space-y-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-stone-500">{item.endpoint}</span>
                    <span className="shrink-0 text-stone-700">
                      {formatNumber(item.total)} · {formatPercent(item.success_rate)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${Math.max(2, Math.round(item.success_rate * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
              {metrics?.endpoints.length === 0 ? <div className="text-sm text-stone-400">暂无接口调用数据</div> : null}
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold text-stone-900">错误类型</h2>
              {(metrics?.errors || []).map((item) => (
                <div key={item.error_type} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-stone-500">{item.error_type}</span>
                  <span className="font-medium text-stone-800">{formatNumber(item.total)}</span>
                </div>
              ))}
              {metrics?.errors.length === 0 ? <div className="text-sm text-stone-400">暂无错误数据</div> : null}
            </CardContent>
          </Card>
        </section>
          <section className="space-y-4">
            <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-center gap-2">
                    <Route className="size-4 text-stone-500" />
                    <h2 className="text-lg font-semibold tracking-tight">请求追踪</h2>
                    {isTraceLoading ? <LoaderCircle className="size-4 animate-spin text-stone-400" /> : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <select
                      value={requestEndpoint}
                      onChange={(event) => {
                        setRequestEndpoint(event.target.value);
                        setRequestPage(1);
                        setSelectedRequest(null);
                        setSelectedRequestId("");
                      }}
                      className="h-10 rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-700"
                    >
                      <option value="">全部接口</option>
                      <option value="/v1/chat/completions">/v1/chat/completions</option>
                      <option value="/v1/images/generations">/v1/images/generations</option>
                      <option value="/v1/images/edits">/v1/images/edits</option>
                      <option value="/v1/responses">/v1/responses</option>
                    </select>
                    <Select
                      value={requestPageSize}
                      onValueChange={(value) => {
                        setRequestPageSize(value);
                        setRequestPage(1);
                      }}
                    >
                      <SelectTrigger className="h-10 w-[112px] rounded-xl border-stone-200 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10 / 页</SelectItem>
                        <SelectItem value="20">20 / 页</SelectItem>
                        <SelectItem value="50">50 / 页</SelectItem>
                        <SelectItem value="100">100 / 页</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
                  <div className="overflow-x-auto rounded-xl border border-stone-100">
                    <table className="w-full min-w-[980px] border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-stone-100 bg-stone-50 text-left text-xs text-stone-500">
                          <th className="px-3 py-2 font-medium">request_id</th>
                          <th className="px-3 py-2 font-medium">结果</th>
                          <th className="px-3 py-2 font-medium">账号</th>
                          <th className="px-3 py-2 font-medium">尝试</th>
                          <th className="px-3 py-2 font-medium">耗时</th>
                          <th className="px-3 py-2 font-medium">时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {requestTraces.map((item) => {
                          const selected = selectedRequestId === item.request_id;
                          const status = traceStatusMeta(item);
                          return (
                            <tr
                              key={item.request_id}
                              className={cn(
                                "cursor-pointer border-b border-stone-100 last:border-0",
                                selected ? "bg-stone-100" : "hover:bg-stone-50",
                              )}
                              onClick={() => void handleSelectRequest(item.request_id)}
                            >
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className="max-w-[220px] truncate font-mono text-xs text-stone-700">
                                    {item.request_id}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    className="size-7 rounded-md p-0 text-stone-400 hover:text-stone-900"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleCopyRequestId(item.request_id);
                                    }}
                                    aria-label="复制 request_id"
                                  >
                                    <Copy className="size-3.5" />
                                  </Button>
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <Badge variant={status.variant} className="rounded-md">
                                  {status.label}
                                </Badge>
                                {item.http_status ? (
                                  <div className="mt-1 text-xs text-stone-400">HTTP {item.http_status}</div>
                                ) : null}
                              </td>
                              <td className="px-3 py-2">
                                <div className="max-w-[260px] truncate text-stone-700">
                                  {item.accounts.map((account) => accountLabel(account)).join(" / ") || "--"}
                                </div>
                                <div className="font-mono text-xs text-stone-400">
                                  {item.account_ids.slice(0, 3).join(" / ")}
                                  {item.account_ids.length > 3 ? " ..." : ""}
                                </div>
                              </td>
                              <td className="px-3 py-2 text-stone-700">
                                {item.successful_attempts} / {item.attempts}
                                {item.running_attempts ? (
                                  <span className="ml-1 text-sky-600">运行 {item.running_attempts}</span>
                                ) : null}
                                {item.failed_attempts ? (
                                  <span className="ml-1 text-rose-500">失败 {item.failed_attempts}</span>
                                ) : null}
                                {item.error_types.length ? (
                                  <div className="font-mono text-xs text-stone-400">{item.error_types.join(" / ")}</div>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 text-stone-700">{formatNumber(item.duration_ms)} ms</td>
                              <td className="px-3 py-2 text-stone-500">{formatEpochTime(item.last_at)}</td>
                            </tr>
                          );
                        })}
                        {requestTraces.length === 0 ? (
                          <tr>
                            <td className="px-3 py-10 text-center text-stone-400" colSpan={6}>
                              暂无请求追踪记录
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  <div className="rounded-xl border border-stone-100 bg-stone-50/70 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-stone-500">请求明细</div>
                        <div className="truncate font-mono text-xs text-stone-800">{selectedRequestId || "--"}</div>
                      </div>
                      {isRequestLoading ? <LoaderCircle className="size-4 animate-spin text-stone-400" /> : null}
                    </div>

                    {selectedRequest ? (
                      <div className="space-y-2">
                        <div className="rounded-lg bg-white p-3 text-xs text-stone-500">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="truncate font-mono">{selectedRequest.path || "--"}</div>
                            <div>HTTP {selectedRequest.http_status || "--"}</div>
                            <div>{formatNumber(selectedRequest.duration_ms)} ms</div>
                            <div>{formatEpochTime(selectedRequest.last_at)}</div>
                          </div>
                          {selectedRequest.error_message ? (
                            <div className="mt-2 line-clamp-3 break-words text-rose-700">
                              {selectedRequest.error_message}
                            </div>
                          ) : null}
                        </div>
                        {selectedRequest.attempts.map((attempt) => {
                          const status = attemptStatusMeta(attempt);
                          return (
                            <div key={`${attempt.attempt_index}-${attempt.account_id}`} className="rounded-lg bg-white p-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-stone-900">
                                    #{attempt.attempt_index || 1} {accountLabel(attempt.account)}
                                  </div>
                                  <div className="font-mono text-xs text-stone-400">
                                    {attempt.account_id} · {maskToken(attempt.account?.access_token)}
                                  </div>
                                </div>
                                <Badge variant={status.variant} className="rounded-md">
                                  {status.label}
                                </Badge>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-stone-500">
                                <div>{formatNumber(attempt.latency_ms)} ms</div>
                                <div>{formatEpochTime(attempt.completed_at || attempt.created_at)}</div>
                                <div className="truncate font-mono">{attempt.endpoint}</div>
                                <div className="truncate font-mono">{attempt.model}</div>
                              </div>
                              {attempt.error_message ? (
                                <div className="mt-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
                                  <div className="font-mono">{attempt.error_type || "upstream_error"}</div>
                                  <div className="mt-1 line-clamp-3 break-words">{attempt.error_message}</div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {selectedRequest.attempts.length === 0 ? (
                          <div className="flex h-24 items-center justify-center rounded-lg bg-white text-sm text-stone-400">
                            请求已记录，暂未打到账号
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex h-48 items-center justify-center text-sm text-stone-400">
                        选择一条请求查看账号尝试
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3 border-t border-stone-100 pt-4">
                  <span className="text-sm text-stone-500">
                    第 {requestPage} / {requestPageCount} 页，共 {formatNumber(requestTotal)} 条
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-10 rounded-lg border-stone-200 bg-white"
                    disabled={requestPage <= 1}
                    onClick={() => {
                      setRequestPage((prev) => Math.max(1, prev - 1));
                      setSelectedRequest(null);
                      setSelectedRequestId("");
                    }}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-10 rounded-lg border-stone-200 bg-white"
                    disabled={requestPage >= requestPageCount}
                    onClick={() => {
                      setRequestPage((prev) => Math.min(requestPageCount, prev + 1));
                      setSelectedRequest(null);
                      setSelectedRequestId("");
                    }}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>


      </section>
    </>
  );
}
