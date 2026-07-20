const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

type Env = Record<string, unknown>;

export interface OmpProfileSelection {
  profile: string | null;
  specified: boolean;
}

export function normalizeOmpProfile(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return null;
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    !PROFILE_NAME_RE.test(normalized) ||
    WINDOWS_RESERVED_BASENAME_RE.test(normalized)
  ) {
    throw new Error(
      `Invalid OMP profile "${value}". Profile names must match ${PROFILE_NAME_RE.source}, cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name.`,
    );
  }
  return normalized;
}

function envProfile(env: Env): OmpProfileSelection | null {
  if (typeof env.OMP_PROFILE === "string") {
    return { profile: normalizeOmpProfile(env.OMP_PROFILE), specified: true };
  }
  if (typeof env.PI_PROFILE === "string") {
    return { profile: normalizeOmpProfile(env.PI_PROFILE), specified: true };
  }
  return null;
}

export function resolveOmpProfile(
  config: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv = process.env,
): OmpProfileSelection {
  if (typeof config.profile === "string" && config.profile.trim()) {
    return { profile: normalizeOmpProfile(config.profile), specified: true };
  }

  const configuredEnv = config.env !== null && typeof config.env === "object" && !Array.isArray(config.env)
    ? config.env as Env
    : {};
  const configured = envProfile(configuredEnv);
  if (configured) return configured;

  if (processEnv.PAPERCLIP_OMP_PROFILE !== undefined) {
    return { profile: normalizeOmpProfile(processEnv.PAPERCLIP_OMP_PROFILE), specified: true };
  }
  return envProfile(processEnv) ?? { profile: null, specified: false };
}
