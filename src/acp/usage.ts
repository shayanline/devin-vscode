import type { ContextUsage, ResponseDimension, UpdateMeta } from "./types";

export function isUsageAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function contextReports(value: unknown, role?: ContextUsage["role"]): ContextUsage[] {
  const records: unknown[] = Array.isArray(value) ? value : [value];
  return records.filter((record): record is ContextUsage => {
    const context = record as Partial<ContextUsage> | null;
    return !!context && typeof context.modelId === "string" && context.modelId.trim().length > 0
      && isUsageAmount(context.totalTokens) && isUsageAmount(context.maxTokens) && context.maxTokens > 0;
  }).map((record) => role ? { ...record, role } : record);
}

export function contextReportFromUpdate(value: unknown): ContextUsage | ContextUsage[] | undefined {
  const meta = (value as { _meta?: UpdateMeta } | null)?._meta;
  if (!meta) return undefined;
  const parent = meta["cognition.ai/subagent_context"]?.parentAgentId;
  if (parent && parent !== "sidekick") return undefined;
  const report = meta["cognition.ai/contextUsage"];
  const contexts = contextReports(report, Array.isArray(report) ? undefined : parent === "sidekick" ? "sub" : "lead");
  return Array.isArray(report) ? contexts : contexts[0];
}

export function mergeContextReports(previous: ContextUsage[], incoming: ContextUsage[]): ContextUsage[] {
  const key = (context: ContextUsage): string => context.role
    ? JSON.stringify(["role", context.role]) : JSON.stringify(["model", context.modelId]);
  return [...new Map([...previous, ...incoming].map((context) => [key(context), context])).values()];
}

export function sessionAcuUsage(value: unknown): number | undefined {
  const requests = (value as { requests?: unknown } | null)?.requests;
  if (!Array.isArray(requests)) return undefined;
  const unique = new Map<string, { responseDimensions?: ResponseDimension[] }>();
  for (const request of requests) {
    if (!request || typeof request.requestId !== "string" || !request.requestId) return undefined;
    unique.set(request.requestId, request);
  }
  let total = 0;
  let reported = requests.length === 0;
  for (const request of unique.values()) {
    const dimensions = Array.isArray(request.responseDimensions) ? request.responseDimensions : [];
    const acu = dimensions.filter((dimension) => dimension?.uid === "acu");
    if (acu.length > 1) return undefined;
    if (!acu.length) continue;
    const kind = acu[0].kind;
    if (kind?.type !== "cumulativeMetric" || !isUsageAmount(kind.value)) return undefined;
    total += kind.value;
    reported = true;
  }
  return reported && Number.isFinite(total) ? total : undefined;
}

export interface AccountAcuUsage {
  used: number;
  limit?: number;
  remaining?: number;
  overage?: number;
}

export function accountAcuUsage(used: unknown, limit?: unknown): AccountAcuUsage | undefined {
  if (!isUsageAmount(used)) return undefined;
  if (!isUsageAmount(limit)) return { used };
  return {
    used, limit,
    remaining: Math.max(0, limit - used),
    overage: Math.max(0, used - limit)
  };
}

export function acuText(value: unknown, precision: 2 | 4 = 4): string {
  if (!isUsageAmount(value)) return "Not reported";
  if (value > 0 && value < 10 ** -precision) return `<${(10 ** -precision).toFixed(precision)}`;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: precision, maximumFractionDigits: precision
  }).format(value);
}
