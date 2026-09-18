export const REDACTED_LOG_MARKER = "***REDACTED***";

/** Repair a JSON line whose escapes Paperclip's log redaction swallowed. */
export function repairRedactedJsonLine(line: string): string {
  if (!line.includes(REDACTED_LOG_MARKER)) return line;
  let out = "";
  let index = 0;
  for (;;) {
    const marker = line.indexOf(REDACTED_LOG_MARKER, index);
    if (marker < 0) {
      out += line.slice(index);
      break;
    }
    out += line.slice(index, marker) + REDACTED_LOG_MARKER;
    let next = marker + REDACTED_LOG_MARKER.length;
    const char = line[next];
    if (char === "\"") {
      out += "\\\"";
      next += 1;
    } else if (char === "}" || char === "]" || char === ",") {
      out += "\"";
    }
    index = next;
  }
  return out;
}
