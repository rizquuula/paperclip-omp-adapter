import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { ensurePathInEnv, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { resolveOmpCommand } from "./config.js";
import { detectModel } from "./config.js";

const QUOTA_TIMEOUT_SEC = 45;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function envelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  for (const candidate of [trimmed, ...trimmed.split(/\r?\n/).reverse().map((line) => line.trim())]) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = record(JSON.parse(candidate) as unknown);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function usedPercent(amount: Record<string, unknown>): number | null {
  const usedFraction = finite(amount.usedFraction);
  if (usedFraction !== null) return Math.round(usedFraction * 1000) / 10;
  const remainingFraction = finite(amount.remainingFraction);
  if (remainingFraction !== null) return Math.round((1 - remainingFraction) * 1000) / 10;
  const used = finite(amount.used);
  const limit = finite(amount.limit);
  if (used !== null && limit !== null && limit > 0) return Math.round((used / limit) * 1000) / 10;
  return null;
}

function valueLabel(amount: Record<string, unknown>): string | null {
  const unit = text(amount.unit);
  const remaining = finite(amount.remaining);
  if (remaining !== null) return `${remaining}${unit ? ` ${unit}` : ""} remaining`;
  const used = finite(amount.used);
  const limit = finite(amount.limit);
  if (used !== null && limit !== null) return `${used} / ${limit}${unit ? ` ${unit}` : ""}`;
  return null;
}

function toWindow(limit: Record<string, unknown>): QuotaWindow {
  const window = record(limit.window);
  const amount = record(limit.amount) ?? {};
  const resetsAt = finite(window?.resetsAt);
  const notes = Array.isArray(limit.notes) ? limit.notes.filter((n): n is string => typeof n === "string") : [];
  const status = text(limit.status);
  const detail = [status, ...notes].filter(Boolean).join(" \u00b7 ");
  return {
    label: text(window?.label) || text(limit.label) || text(limit.id) || "window",
    usedPercent: usedPercent(amount),
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
    valueLabel: valueLabel(amount),
    ...(detail ? { detail } : {}),
  };
}

/** Project `omp usage --json` onto Paperclip's provider quota contract. */
export async function getOmpQuotaWindows(): Promise<ProviderQuotaResult> {
  const command = resolveOmpCommand({});
  const detected = await detectModel().catch(() => null);
  const preferred = detected?.provider ?? "";
  try {
    const result = await runChildProcess(
      `omp-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["usage", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...ensurePathInEnv({ ...process.env }) } as Record<string, string>,
        timeoutSec: QUOTA_TIMEOUT_SEC,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    if (result.timedOut) {
      return { provider: preferred || "omp", ok: false, error: `\`omp usage --json\` timed out after ${QUOTA_TIMEOUT_SEC}s.`, windows: [] };
    }
    if ((result.exitCode ?? 1) !== 0) {
      return { provider: preferred || "omp", ok: false, error: "`omp usage --json` failed.", windows: [] };
    }
    const payload = envelope(result.stdout);
    const reports = Array.isArray(payload?.reports) ? payload.reports : [];
    if (reports.length === 0) {
      return {
        provider: preferred || "omp",
        source: "omp usage --json",
        ok: false,
        error: "No authenticated OMP account reports provider usage limits.",
        windows: [],
      };
    }
    const chosen = reports
      .map((entry) => record(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .find((entry) => text(entry.provider) === preferred)
      ?? record(reports[0]);
    if (!chosen) {
      return { provider: preferred || "omp", ok: false, error: "`omp usage --json` returned an unreadable report.", windows: [] };
    }
    const limits = Array.isArray(chosen.limits) ? chosen.limits : [];
    const windows = limits
      .map((entry) => record(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map(toWindow);
    return {
      provider: text(chosen.provider) || preferred || "omp",
      source: "omp usage --json",
      ok: windows.length > 0,
      ...(windows.length > 0 ? {} : { error: "The provider report carried no usage windows." }),
      windows,
    };
  } catch (error) {
    return {
      provider: preferred || "omp",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      windows: [],
    };
  }
}
