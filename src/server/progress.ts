import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseOmpJsonLine } from "./parse.js";

type ProgressSink = NonNullable<AdapterExecutionContext["onRuntimeProgress"]>;

const PROGRESS_MIN_INTERVAL_MS = 1000;
const SNIPPET_CHARS = 200;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function snippetOf(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > SNIPPET_CHARS ? normalized.slice(-SNIPPET_CHARS) : normalized;
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const item of content) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const block = item as Record<string, unknown>;
      if (block.type === "text") out += text(block.text);
    }
  }
  return out;
}

/** Feed OMP stdout lines to Paperclip's live run status so the UI names the running tool. */
export function createOmpProgressReporter(sink: ProgressSink | undefined): (line: string) => Promise<void> {
  if (!sink) return async () => {};

  let lastEmitMs = 0;
  let currentToolName: string | null = null;
  let lastAssistantSnippet: string | null = null;
  let streamedText = "";
  let streamedThinking = "";

  const emit = async (message: string, force: boolean): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastEmitMs < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmitMs = now;
    try {
      await sink({
        phase: "adapter_startup",
        message,
        currentToolName,
        lastAssistantSnippet,
        lastEventAt: new Date(now),
      });
    } catch {
      lastEmitMs = now;
    }
  };

  return async (line: string): Promise<void> => {
    const event = parseOmpJsonLine(line.trim());
    if (!event) return;

    switch (text(event.type)) {
      case "tool_execution_start": {
        const toolName = text(event.toolName).trim();
        if (!toolName) return;
        currentToolName = toolName;
        streamedText = "";
        await emit(`Running ${toolName}`, true);
        return;
      }
      case "tool_execution_end": {
        const toolName = text(event.toolName).trim() || currentToolName;
        currentToolName = null;
        await emit(toolName ? `Finished ${toolName}` : "Processing model output", true);
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update === null || typeof update !== "object" || Array.isArray(update)) return;
        const inner = update as Record<string, unknown>;
        const delta = text(inner.delta);
        if (!delta) return;
        if (text(inner.type) === "text_delta") {
          streamedText = snippetOf(streamedText + delta);
          lastAssistantSnippet = streamedText;
          await emit("Writing response", false);
          return;
        }
        if (text(inner.type) === "thinking_delta") {
          streamedThinking = snippetOf(streamedThinking + delta);
          lastAssistantSnippet = `Thinking: ${streamedThinking}`;
          await emit("Thinking", false);
        }
        return;
      }
      case "message_end":
      case "turn_end": {
        const message = event.message;
        if (message === null || typeof message !== "object" || Array.isArray(message)) return;
        const record = message as Record<string, unknown>;
        if (record.role !== "assistant") return;
        const body = snippetOf(assistantText(record.content));
        if (!body) return;
        streamedText = body;
        streamedThinking = "";
        lastAssistantSnippet = body;
        await emit("Writing response", true);
        return;
      }
      default:
        return;
    }
  };
}
