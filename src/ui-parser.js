/** @typedef {Record<string, unknown>} JsonRecord */

/**
 * @param {unknown} value
 * @returns {JsonRecord | null}
 */
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return /** @type {JsonRecord} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify(value) {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/**
 * @param {unknown} content
 * @returns {{ text: string, thinking: string }}
 */
function extractContent(content) {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };

  let text = "";
  let thinking = "";
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block.type === "text") text += asString(block.text);
    if (block.type === "thinking") thinking += asString(block.thinking);
  }
  return { text, thinking };
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function extractToolResult(result) {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  const content = record ? record.content : result;
  const extracted = extractContent(content);
  if (extracted.text) return extracted.text;
  return stringify(result);
}

/**
 * @param {JsonRecord} message
 * @returns {boolean}
 */
function isAssistantError(message) {
  return message.stopReason === "error"
    || message.stopReason === "aborted"
    || asString(message.errorMessage).length > 0;
}

/**
 * @param {unknown[]} messages
 * @returns {JsonRecord | null}
 */
function lastAssistant(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message && message.role === "assistant") return message;
  }
  return null;
}

/**
 * @param {unknown[]} messages
 * @returns {{ inputTokens: number, outputTokens: number, cachedTokens: number, costUsd: number }}
 */
function totalUsage(messages) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;

  for (const value of messages) {
    const message = asRecord(value);
    if (!message || message.role !== "assistant") continue;
    const usage = asRecord(message.usage);
    if (!usage) continue;
    inputTokens += asNumber(usage.input) || asNumber(usage.inputTokens);
    outputTokens += asNumber(usage.output) || asNumber(usage.outputTokens);
    cachedTokens += asNumber(usage.cacheRead) || asNumber(usage.cachedInputTokens);
    const cost = asRecord(usage.cost);
    costUsd += cost ? asNumber(cost.total) : asNumber(usage.costUsd);
  }

  return { inputTokens, outputTokens, cachedTokens, costUsd };
}

/**
 * @param {JsonRecord} parsed
 * @param {string} ts
 * @returns {Array<Record<string, unknown>>}
 */
function parseAgentEnd(parsed, ts) {
  if (parsed.willContinue === true) return [];
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const assistant = lastAssistant(messages);
  const usage = totalUsage(messages);
  const content = assistant ? extractContent(assistant.content) : { text: "", thinking: "" };
  const errorMessage = assistant ? asString(assistant.errorMessage) : "";
  const isError = assistant ? isAssistantError(assistant) : false;
  const subtype = assistant ? asString(assistant.stopReason, isError ? "error" : "end") : "end";

  return [{
    kind: "result",
    ts,
    text: errorMessage || content.text,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
    subtype,
    isError,
    errors: errorMessage ? [errorMessage] : [],
  }];
}

/**
 * Parse one OMP 17.0.5 JSONL stdout line into Paperclip transcript entries.
 * The parser is deliberately stateless so replaying a line always returns the
 * same entries, regardless of which surrounding lines Paperclip retained.
 *
 * @param {string} line
 * @param {string} ts
 * @returns {Array<Record<string, unknown>>}
 */
function parseStdoutLine(line, ts) {
  const raw = () => [{ kind: "stdout", ts, text: line }];

  try {
    const parsed = asRecord(JSON.parse(line));
    if (!parsed) return raw();
    const type = asString(parsed.type);

    if (type === "session" || type === "init") {
      const sessionId = asString(parsed.id) || asString(parsed.sessionId) || asString(parsed.session_id);
      if (!sessionId) return raw();
      const provider = asString(parsed.provider);
      const modelId = asString(parsed.model);
      const model = provider && modelId && !modelId.startsWith(`${provider}/`)
        ? `${provider}/${modelId}`
        : modelId;
      return [{ kind: "init", ts, model, sessionId }];
    }

    if (type === "thinking_level_changed") {
      const level = asString(parsed.thinkingLevel) || asString(parsed.resolved);
      return level ? [{ kind: "system", ts, text: `OMP thinking level: ${level}` }] : [];
    }

    if (type === "session_start") {
      return [{ kind: "system", ts, text: "OMP session started" }];
    }

    if (type === "agent_start") {
      return [{ kind: "system", ts, text: "OMP agent started" }];
    }

    if (type === "agent_end") {
      if (!Array.isArray(parsed.messages)) return raw();
      if (parsed.willContinue !== undefined && typeof parsed.willContinue !== "boolean") return raw();
      return parseAgentEnd(parsed, ts);
    }

    if (type === "message_update") {
      const event = asRecord(parsed.assistantMessageEvent);
      if (!event) return raw();
      const eventType = asString(event.type);
      if (eventType === "text_delta") {
        if (typeof event.delta !== "string") return raw();
        return event.delta ? [{ kind: "assistant", ts, text: event.delta, delta: true }] : [];
      }
      if (eventType === "thinking_delta") {
        if (typeof event.delta !== "string") return raw();
        return event.delta ? [{ kind: "thinking", ts, text: event.delta, delta: true }] : [];
      }
      if (eventType === "error") {
        const reason = asString(event.reason);
        return reason ? [{ kind: "stderr", ts, text: `OMP request ${reason}` }] : raw();
      }
      if (eventType === "start") return [];
      if (eventType === "text_start" || eventType === "thinking_start" || eventType === "toolcall_start") {
        return typeof event.contentIndex === "number" ? [] : raw();
      }
      if (eventType === "text_end" || eventType === "thinking_end") {
        return typeof event.contentIndex === "number" && typeof event.content === "string" ? [] : raw();
      }
      if (eventType === "image_end") {
        return typeof event.contentIndex === "number" && asRecord(event.content) ? [] : raw();
      }
      if (eventType === "toolcall_delta") {
        return typeof event.contentIndex === "number" && typeof event.delta === "string" ? [] : raw();
      }
      if (eventType === "toolcall_end") {
        return typeof event.contentIndex === "number" && asRecord(event.toolCall) ? [] : raw();
      }
      if (eventType === "done") return asString(event.reason) ? [] : raw();
      return raw();
    }

    if (type === "tool_execution_start") {
      const toolUseId = asString(parsed.toolCallId);
      const name = asString(parsed.toolName);
      if (!toolUseId || !name || !Object.prototype.hasOwnProperty.call(parsed, "args")) return raw();
      return [{ kind: "tool_call", ts, name, input: parsed.args, toolUseId }];
    }

    if (type === "tool_execution_end") {
      const toolUseId = asString(parsed.toolCallId);
      const toolName = asString(parsed.toolName);
      if (
        !toolUseId
        || !toolName
        || !Object.prototype.hasOwnProperty.call(parsed, "result")
        || typeof parsed.isError !== "boolean"
      ) return raw();
      return [{
        kind: "tool_result",
        ts,
        toolUseId,
        toolName,
        content: extractToolResult(parsed.result),
        isError: parsed.isError,
      }];
    }

    if (type === "result") {
      const hasPayload = [
        "text", "result", "subtype", "isError", "errors",
        "inputTokens", "outputTokens", "cachedTokens", "costUsd",
      ].some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
      if (!hasPayload) return raw();
      const errors = Array.isArray(parsed.errors)
        ? parsed.errors.filter((error) => typeof error === "string")
        : [];
      return [{
        kind: "result",
        ts,
        text: asString(parsed.text) || asString(parsed.result),
        inputTokens: asNumber(parsed.inputTokens),
        outputTokens: asNumber(parsed.outputTokens),
        cachedTokens: asNumber(parsed.cachedTokens),
        costUsd: asNumber(parsed.costUsd),
        subtype: asString(parsed.subtype, parsed.isError === true ? "error" : "end"),
        isError: parsed.isError === true,
        errors,
      }];
    }

    if (type === "message_end" || type === "turn_end") {
      const message = asRecord(parsed.message);
      if (!message) return raw();
      if (message.role === "assistant" && isAssistantError(message)) {
        const reason = asString(message.errorMessage) || `OMP request ${asString(message.stopReason, "error")}`;
        return [{ kind: "stderr", ts, text: reason }];
      }
      return [];
    }

    if (type === "notice") {
      const text = asString(parsed.message);
      if (!text || (parsed.level !== "info" && parsed.level !== "warning" && parsed.level !== "error")) return raw();
      return parsed.level === "error"
        ? [{ kind: "stderr", ts, text }]
        : [{ kind: "system", ts, text }];
    }

    if (type === "auto_retry_start") {
      const message = asString(parsed.errorMessage);
      return message ? [{ kind: "system", ts, text: message }] : raw();
    }

    if (type === "auto_retry_end") {
      if (typeof parsed.success !== "boolean") return raw();
      if (parsed.success) return [];
      return [{ kind: "stderr", ts, text: asString(parsed.finalError, "OMP request retry failed") }];
    }

    if (type === "error" || type === "extension_error") {
      const text = asString(parsed.error)
        || asString(parsed.message)
        || asString(parsed.reason);
      return text ? [{ kind: "stderr", ts, text }] : raw();
    }

    if (type === "session_shutdown") {
      return [{ kind: "system", ts, text: "OMP session stopped" }];
    }

    if (type === "turn_start") return [];
    if (type === "message_start") return asRecord(parsed.message) ? [] : raw();
    if (type === "tool_execution_update") {
      return asString(parsed.toolCallId)
        && asString(parsed.toolName)
        && Object.prototype.hasOwnProperty.call(parsed, "partialResult")
        ? []
        : raw();
    }
    if (type === "session_stop") {
      return Array.isArray(parsed.messages) && asString(parsed.session_id) ? [] : raw();
    }

    return raw();
  } catch {
    return raw();
  }
}

module.exports = { parseStdoutLine };