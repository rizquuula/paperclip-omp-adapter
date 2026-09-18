import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createServerAdapter } from "../dist/index.js";
import { prepareOmpRuntimeConfig } from "../dist/server/config.js";
import {
  applyPreparedOmpAgentEnvironment,
  rewriteRemoteConfigPaths,
} from "../dist/server/execute.js";
import { parseOmpJsonl } from "../dist/server/parse.js";
import { resolveOmpProfile } from "../dist/server/profile.js";

const adapter = createServerAdapter();
assert.equal(adapter.type, "omp_local");
assert.equal(adapter.sessionManagement?.supportsSessionResume, true);
assert.equal(adapter.supportsInstructionsBundle, true);
assert(adapter.listModels && adapter.refreshModels && adapter.detectModel);
assert(adapter.listSkills && adapter.syncSkills && adapter.getConfigSchema);

const uiParserSource = await fs.readFile(new URL("../dist/ui-parser.js", import.meta.url), "utf8");
const uiParserExports = {};
const uiParserModule = { exports: uiParserExports };
new Function("exports", "module", "self", "globalThis", uiParserSource)(
  uiParserExports,
  uiParserModule,
  undefined,
  undefined,
);
const parseStdoutLine = uiParserModule.exports.parseStdoutLine;
const transcriptTs = "2026-07-20T23:52:22Z";
assert.deepEqual(
  parseStdoutLine(JSON.stringify({
    type: "thinking_level_changed",
    thinkingLevel: "high",
    configured: "auto",
    resolved: "high",
  }), transcriptTs),
  [{ kind: "system", ts: transcriptTs, text: "OMP thinking level: high" }],
);
for (const event of [
  { type: "turn_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: " concise" },
  },
  {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    partialResult: { content: [] },
  },
]) {
  assert.deepEqual(parseStdoutLine(JSON.stringify(event), transcriptTs), []);
}
assert.deepEqual(
  parseStdoutLine(JSON.stringify({ type: "future_omp_event" }), transcriptTs),
  [{ kind: "stdout", ts: transcriptTs, text: '{"type":"future_omp_event"}' }],
);

const schema = await adapter.getConfigSchema();
const schemaKeys = new Set(schema.fields.map((field) => field.key));
for (const key of ["model", "profile", "agentDir", "modelsYaml", "tools", "extensions", "pluginDirs", "configFiles"]) {
  assert(schemaKeys.has(key), `missing config field: ${key}`);
}

assert.deepEqual(
  resolveOmpProfile({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } }, {}),
  { profile: null, specified: true },
);
assert.deepEqual(resolveOmpProfile({ profile: "default" }, {}), { profile: null, specified: true });
assert.throws(() => resolveOmpProfile({ profile: "CON" }, {}), /Invalid OMP profile/);
assert.throws(() => resolveOmpProfile({ profile: "trailing." }, {}), /Invalid OMP profile/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-test-"));
const profileAgentDir = path.join(root, "profiles", "work", "agent");
await fs.mkdir(profileAgentDir, { recursive: true });
await fs.writeFile(
  path.join(profileAgentDir, "models.yml"),
  `providers:\n  safe-provider:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: SAFE_PROVIDER_KEY\n    models:\n      - id: safe-model\n        contextWindow: 4096\n        maxTokens: 1024\n`,
);
await fs.writeFile(
  path.join(profileAgentDir, "config.yml"),
  `extensions:\n  - ~/.omp/extensions/private.ts\ndisabledExtensions: []\n`,
);

const prepared = await prepareOmpRuntimeConfig(
  {
    env: {
      PI_CONFIG_DIR: root,
      OMP_PROFILE: "work",
      SAFE_PROVIDER_KEY: "must-not-be-serialized",
    },
  },
  { forceMaterialized: true },
);
try {
  assert.equal(prepared.profile, "work");
  assert.equal(prepared.materialized, true);
  assert(prepared.agentDir);
  const yaml = await fs.readFile(path.join(prepared.agentDir, "models.yml"), "utf8");
  assert.match(yaml, /safe-provider:/);
  assert.match(yaml, /apiKey: SAFE_PROVIDER_KEY/);
  assert.doesNotMatch(yaml, /must-not-be-serialized/);
  const configYaml = await fs.readFile(path.join(prepared.agentDir, "config.yml"), "utf8");
  assert.doesNotMatch(configYaml, /^extensions:/m);
  assert(prepared.notes.some((note) => note.includes("Skipped config extensions")));

  const remoteEnv = {
    PI_CODING_AGENT_DIR: "/local/agent",
    OMP_PROFILE: "work",
    PI_PROFILE: "work",
  };
  applyPreparedOmpAgentEnvironment(remoteEnv, prepared, "/remote/assets/agent");
  assert.equal(remoteEnv.PI_CODING_AGENT_DIR, "/remote/assets/agent");
  assert.equal(remoteEnv.OMP_PROFILE, "");
  assert.equal(remoteEnv.PI_PROFILE, "");
} finally {
  await prepared.cleanup();
}
const explicitDefault = await prepareOmpRuntimeConfig({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } });
assert.equal(explicitDefault.profile, null);
assert.equal(explicitDefault.profileSpecified, true);

await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers:\n  unsafe:\n    api: openai-completions\n    apiKey: literal-secret\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
  }),
  /credential-bearing fields/,
);
await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers: { unsafe: { api: openai-completions, apiKey: literal-secret, models: [{ id: unsafe, contextWindow: 4096, maxTokens: 1024 }] } }`,
  }),
  /credential-bearing fields/,
);

for (const baseUrl of [
  "https://api.example/v1?api_key=literal",
  "https://TOKEN@api.example/v1",
]) {
  await assert.rejects(
    () => prepareOmpRuntimeConfig({
      modelsYaml: `providers:\n  unsafe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    }),
    /credential-bearing fields/,
  );
}

const fakeOmp = path.join(root, "fake-omp.mjs");
await fs.writeFile(fakeOmp, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [{ provider: "fake-provider", id: "fake-model", selector: "fake-provider/fake-model", name: "Fake model" }] }));
  process.exit(0);
}
const resumeIndex = args.indexOf("--resume");
const noSession = args.includes("--no-session");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "fake-session-1";
const prompt = args.at(-1) ?? "";
if (!noSession) console.log(JSON.stringify({ type: "session", id: sessionId }));
const message = {
  id: "fake-message-1",
  role: "assistant",
  provider: "fake-provider",
  model: "fake-model",
  content: [{
    type: "text",
    text: prompt +
      "|OMP_PROFILE=" + (process.env.OMP_PROFILE ?? "") +
      "|PI_PROFILE=" + (process.env.PI_PROFILE ?? "") +
      "|AGENT_DIR=" + (process.env.PI_CODING_AGENT_DIR ?? "") +
      "|PAPERCLIP_API_KEY=" + (process.env.PAPERCLIP_API_KEY ? "set" : ""),
  }],
  stopReason: "stop",
  usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
};
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
`);
await fs.chmod(fakeOmp, 0o755);
const previousOmpCommand = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
const advertisedAdapter = createServerAdapter();
assert.equal((await advertisedAdapter.listModels()).length, 1);
assert.equal(advertisedAdapter.models.length, 1, "dynamic model discovery must update the static model summary");
if (previousOmpCommand === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
else process.env.PAPERCLIP_OMP_COMMAND = previousOmpCommand;

const executionCwd = path.join(root, "workspace");
await fs.mkdir(executionCwd);
assert.equal(
  rewriteRemoteConfigPaths({ extensions: ["extensions/provider.ts"] }, executionCwd, "/remote/workspace").extensions[0],
  "/remote/workspace/extensions/provider.ts",
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["../outside.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["~/.omp/provider.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  name: "OMP adapter test",
  adapterType: "omp_local",
  adapterConfig: {},
};
const emptyRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};
const baseConfig = {
  command: fakeOmp,
  cwd: executionCwd,
  promptTemplate: "{{context.expected}}",
  timeoutSec: 10,
  graceSec: 1,
  noExtensions: true,
  noSkills: true,
  noRules: true,
  noLsp: true,
  noPty: true,
  noTitle: true,
  advisor: false,
  extraArgs: ["--no-tools"],
};
const metas = [];
const run = (runId, runtime, expected, config = baseConfig) => adapter.execute({
  runId,
  agent,
  runtime,
  config,
  context: { expected },
  onLog: async () => {},
  onMeta: async (meta) => metas.push(meta),
});

const fresh = await run("00000000-0000-4000-8000-000000000011", emptyRuntime, "FRESH_OK");
assert.equal(fresh.exitCode, 0, fresh.errorMessage ?? "fresh execution failed");
assert.equal(fresh.sessionId, "fake-session-1");
assert.match(fresh.summary ?? "", /FRESH_OK/);
assert.deepEqual(fresh.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 });
assert.equal(fresh.usageBasis, "per_run");

const resumed = await run(
  "00000000-0000-4000-8000-000000000012",
  {
    sessionId: fresh.sessionId,
    sessionParams: fresh.sessionParams,
    sessionDisplayId: fresh.sessionDisplayId,
    taskKey: null,
  },
  "RESUME_OK",
);
assert.equal(resumed.exitCode, 0, resumed.errorMessage ?? "resumed execution failed");
assert.equal(resumed.sessionId, fresh.sessionId);
assert.match(resumed.summary ?? "", /RESUME_OK/);
assert.equal(resumed.usageBasis, "per_run");

const ephemeralRunId = "00000000-0000-4000-8000-000000000013";
const ephemeral = await run(ephemeralRunId, emptyRuntime, "EPHEMERAL_OK", {
  ...baseConfig,
  noSession: true,
  env: {
    OPENROUTER_API_KEY: "unused-openrouter-key",
    PAPERCLIP_API_KEY: "configured-paperclip-key",
    PAPERCLIP_AGENT_ID: "attacker",
    PAPERCLIP_RUN_ID: "attacker",
  },
});
assert.equal(ephemeral.exitCode, 0, ephemeral.errorMessage ?? "ephemeral execution failed");
assert.equal(ephemeral.sessionId, null);
assert.equal(ephemeral.sessionParams, null);
assert.match(ephemeral.summary ?? "", /EPHEMERAL_OK/);
assert.equal(ephemeral.usageBasis, "per_run");
assert.equal(ephemeral.biller, "fake-provider");
assert.match(ephemeral.summary ?? "", /PAPERCLIP_API_KEY=set/);
const ephemeralMeta = metas.at(-1);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_AGENT_ID, agent.id);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_RUN_ID, ephemeralRunId);

const savedOmpProfile = process.env.OMP_PROFILE;
const savedPiProfile = process.env.PI_PROFILE;
process.env.OMP_PROFILE = "host-profile";
process.env.PI_PROFILE = "legacy-host-profile";
try {
  const materialized = await run(
    "00000000-0000-4000-8000-000000000014",
    emptyRuntime,
    "MATERIALIZED_OK",
    {
      ...baseConfig,
      noSession: true,
      modelsYaml: `providers:\n  smoke:\n    api: openai-completions\n    auth: none\n    models:\n      - id: smoke\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    },
  );
  assert.equal(materialized.exitCode, 0, materialized.errorMessage ?? "materialized execution failed");
  assert.match(materialized.summary ?? "", /MATERIALIZED_OK/);
  assert.match(materialized.summary ?? "", /OMP_PROFILE=\|PI_PROFILE=\|/);
  assert.match(materialized.summary ?? "", /AGENT_DIR=.*paperclip-omp-agent-/);
} finally {
  if (savedOmpProfile === undefined) delete process.env.OMP_PROFILE;
  else process.env.OMP_PROFILE = savedOmpProfile;
  if (savedPiProfile === undefined) delete process.env.PI_PROFILE;
  else process.env.PI_PROFILE = savedPiProfile;
}

// Regression test 1: modelProfiles removed in 2026.916.0
assert.equal("modelProfiles" in adapter, false, "modelProfiles must be removed from adapter definition");

// Regression test 2: UI parser handles tool_execution_update with progress
const progressLine = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: { details: { progress: "Building project..." } }
});
const progressEntries = parseStdoutLine(progressLine);
assert.equal(progressEntries.length, 1);
assert.equal(progressEntries[0].kind, "tool_result");
assert.equal(progressEntries[0].toolUseId, "call-123");
assert.equal(progressEntries[0].content, "Building project...");
assert.equal(progressEntries[0].delta, true);

// Regression test 3: UI parser drops empty tool_execution_update
const emptyToolUpdate = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: {}
});
assert.deepEqual(parseStdoutLine(emptyToolUpdate), []);

// Regression test 4: --add-dir and --print-thoughts argument generation
const addDirRunId = "00000000-0000-4000-8000-000000000015";
await run(
  addDirRunId,
  emptyRuntime,
  "ADD_DIR_OK",
  {
    ...baseConfig,
    noSession: true,
    printThoughts: true,
    addDirs: "/tmp/custom-workspace-2",
  },
  {
    paperclipWorkspaces: [
      { cwd: "/tmp/custom-workspace-1" },
    ],
  },
);
const addDirMeta = metas.at(-1);
assert.ok(addDirMeta?.commandArgs?.includes("--print-thoughts"), "commandArgs must include --print-thoughts");
assert.ok(addDirMeta?.commandArgs?.some(arg => arg.startsWith("--add-dir=")), "commandArgs must include --add-dir");

// Regression test 5: Paperclip log redaction corrupts JSONL; the parsers repair it
const redactedLines = (await fs.readFile(new URL("./fixtures/redacted-lines.txt", import.meta.url), "utf8"))
  .split("\n")
  .filter(Boolean);
assert.equal(redactedLines.length, 3);
for (const [index, redactedLine] of redactedLines.entries()) {
  assert.throws(() => JSON.parse(redactedLine), "fixture must stay corrupted");
  const entries = parseStdoutLine(redactedLine, transcriptTs);
  assert.equal(entries.length, 1, `fixture ${index} must produce one entry`);
  assert.equal(entries[0].kind, "tool_result", `fixture ${index} must be repaired`);
  assert.equal(entries[0].toolName, "bash");
  if (index < 2) assert.match(entries[0].content, /\*\*\*REDACTED\*\*\*/);
}

// Regression test 6: an unrepairable JSON line collapses into one short notice
const truncatedLine = '{"type":"tool_execution_end","toolCallId":"c3","result":{"content":"';
const truncatedEntries = parseStdoutLine(truncatedLine, transcriptTs);
assert.equal(truncatedEntries.length, 1);
assert.equal(truncatedEntries[0].kind, "system");
assert.ok(truncatedEntries[0].text.length < 200);
assert.match(truncatedEntries[0].text, /tool_execution_end/);

// Regression test 7: parseOmpJsonl repairs redacted lines and bounds unknownLines
const repairedStdout = Array.from(
  { length: 120 },
  (_value, index) => redactedLines[0].replace('"toolCallId":"c1"', `"toolCallId":"c1-${index}"`),
).join("\n");
const repairedParse = parseOmpJsonl(repairedStdout);
assert.equal(repairedParse.toolCalls.length, 120);
assert.equal(repairedParse.unknownLines.length, 0);

const unreadableParse = parseOmpJsonl(Array.from({ length: 120 }, () => truncatedLine).join("\n"));
assert.equal(unreadableParse.unknownLines.length, 51);
assert.match(unreadableParse.unknownLines.at(-1), /^… 70 more unparsed lines \(\d+ bytes\)$/);
for (const entry of unreadableParse.unknownLines.slice(0, -1)) {
  assert.ok(entry.length <= 240);
}

// Regression test 8: adapter defaults are applied when the config leaves fields empty
await run(
  "00000000-0000-4000-8000-000000000016",
  emptyRuntime,
  "DEFAULTS_OK",
  { command: fakeOmp, cwd: executionCwd, noSession: true },
);
const defaultsMeta = metas.at(-1);
const defaultArgs = defaultsMeta?.commandArgs ?? [];
assert.ok(defaultArgs.includes("--no-title"), "default commandArgs must include --no-title");
assert.ok(defaultArgs.includes("--print-thoughts"), "default commandArgs must include --print-thoughts");
assert.equal(defaultArgs[defaultArgs.indexOf("--approval-mode") + 1], "yolo");
assert.ok(!defaultArgs.includes("--auto-approve"), "--auto-approve must no longer be emitted");

await fs.rm(root, { recursive: true, force: true });
console.log("adapter smoke passed");
