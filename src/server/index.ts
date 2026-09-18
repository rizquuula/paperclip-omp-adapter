import type {
  AdapterRuntimeCommandSpec,
  AdapterSessionCodec,
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  agentConfigurationDoc,
  models,
  OMP_INSTALL_COMMAND,
  type,
} from "../metadata.js";
import { detectModel, getConfigSchema, resolveOmpCommand } from "./config.js";
import { execute } from "./execute.js";
import { listOmpModels, refreshOmpModels } from "./models.js";
import { listOmpSkills, syncOmpSkills } from "./skills.js";
import { testEnvironment } from "./test.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const sessionId = nonEmptyString(value.sessionId) ?? nonEmptyString(value.session_id);
    if (!sessionId) return null;
    const cwd = nonEmptyString(value.cwd);
    const sessionDir = nonEmptyString(value.sessionDir) ?? nonEmptyString(value.session_dir);
    const remoteExecution =
      typeof value.remoteExecution === "object" && value.remoteExecution !== null && !Array.isArray(value.remoteExecution)
        ? value.remoteExecution as Record<string, unknown>
        : null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  serialize(params) {
    return this.deserialize(params);
  },
  getDisplayId(params) {
    return params ? nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id) : null;
  },
};

export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = resolveOmpCommand(config);
  return {
    command,
    detectCommand: command,
    installCommand: OMP_INSTALL_COMMAND,
  };
}

export function createServerAdapter(): ServerAdapterModule {
  const advertisedModels = [...models];
  const listModels = async () => {
    const discovered = await listOmpModels();
    advertisedModels.length = 0;
    advertisedModels.push(...discovered);
    return discovered;
  };
  const refreshModels = async () => {
    const discovered = await refreshOmpModels();
    advertisedModels.length = 0;
    advertisedModels.push(...discovered);
    return discovered;
  };

  // Paperclip's adapter summary currently counts only `models`, while its picker
  // correctly calls `listModels`. Populate the shared summary asynchronously so
  // startup stays non-blocking and both views converge on OMP's live catalog.
  void listModels();

  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    listSkills: listOmpSkills,
    syncSkills: syncOmpSkills,
    models: advertisedModels,
    listModels,
    refreshModels,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema,
  };
}
