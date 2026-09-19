import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export interface OmpFailureClassification {
  errorCode: string | null;
  errorFamily: AdapterExecutionErrorFamily | null;
  retryNotBefore: string | null;
}

const QUOTA_RE = /\b(rate[_ -]?limit|quota|too many requests|429|usage limit|insufficient[_ -]?quota|credit balance|out of credits)\b/i;
const TRANSIENT_RE = /\b(overloaded|server error|internal error|service unavailable|bad gateway|gateway timeout|50[0234]|econnreset|etimedout|econnrefused|enotfound|socket hang up|stream (?:closed|error)|temporarily unavailable)\b/i;
const REFUSAL_RE = /\b(refus(?:al|ed)|cannot assist|can't assist|content policy|safety (?:policy|filter)|blocked by (?:the )?provider)\b/i;
const REFRESH_REUSED_RE = /\brefresh token (?:was )?(?:already used|reused|rotation)\b/i;
const REFRESH_EXPIRED_RE = /\brefresh token (?:has )?expired\b/i;
const REFRESH_INVALID_RE = /\brefresh token (?:is )?(?:invalid|revoked|invalidated)\b/i;

const RETRY_AFTER_SECONDS_RE = /\bretry[- ]?after["':\s]+(\d+(?:\.\d+)?)\b/i;
const RETRY_IN_RE = /\btry again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b/i;
const RETRY_AT_RE = /\bresets? at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\b/i;

function retryDelayMs(text: string): number | null {
  const after = RETRY_AFTER_SECONDS_RE.exec(text)?.[1];
  if (after) return Number(after) * 1000;
  const relative = RETRY_IN_RE.exec(text);
  const amount = relative?.[1];
  const rawUnit = relative?.[2];
  if (!amount || !rawUnit) return null;
  const value = Number(amount);
  const unit = rawUnit.toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("milli")) return value;
  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60_000;
  return value * 3_600_000;
}

function retryNotBefore(text: string): string | null {
  const absolute = RETRY_AT_RE.exec(text);
  const stamp = absolute?.[1];
  if (stamp) {
    const parsed = new Date(stamp);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const delay = retryDelayMs(text);
  if (delay === null || !Number.isFinite(delay) || delay <= 0) return null;
  return new Date(Date.now() + Math.min(delay, 24 * 3_600_000)).toISOString();
}

/** Map OMP failure text onto Paperclip's retry vocabulary. */
export function classifyOmpFailure(input: {
  parsedError: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number;
  signal: string | null;
}): OmpFailureClassification {
  if (input.timedOut) {
    return { errorCode: "omp_timeout", errorFamily: null, retryNotBefore: null };
  }
  const text = `${input.parsedError}\n${input.stderr}`;
  if (REFRESH_REUSED_RE.test(text)) {
    return { errorCode: "omp_refresh_token_reused", errorFamily: "refresh_token_reused", retryNotBefore: null };
  }
  if (REFRESH_EXPIRED_RE.test(text)) {
    return { errorCode: "omp_refresh_token_expired", errorFamily: "refresh_token_expired", retryNotBefore: null };
  }
  if (REFRESH_INVALID_RE.test(text)) {
    return { errorCode: "omp_refresh_token_invalidated", errorFamily: "refresh_token_invalidated", retryNotBefore: null };
  }
  if (QUOTA_RE.test(text)) {
    return { errorCode: "omp_provider_quota", errorFamily: "provider_quota", retryNotBefore: retryNotBefore(text) };
  }
  if (TRANSIENT_RE.test(text)) {
    return { errorCode: "omp_transient_upstream", errorFamily: "transient_upstream", retryNotBefore: retryNotBefore(text) };
  }
  if (REFUSAL_RE.test(text)) {
    return { errorCode: "omp_model_refusal", errorFamily: "model_refusal", retryNotBefore: null };
  }
  if (input.signal) {
    return { errorCode: `omp_signal_${input.signal.toLowerCase()}`, errorFamily: null, retryNotBefore: null };
  }
  if (input.exitCode !== 0) {
    return { errorCode: `omp_exit_${input.exitCode}`, errorFamily: null, retryNotBefore: null };
  }
  return { errorCode: null, errorFamily: null, retryNotBefore: null };
}
