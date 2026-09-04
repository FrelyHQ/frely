import type {
  IngressPlugin,
  IngressPluginContext,
  PluginConfigField,
  StrictConfigSchema,
} from "./types.js";

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type ReasoningInstructionsGuardConfig = Readonly<{
  reasoningEfforts: readonly ReasoningEffort[];
}>;

export const REASONING_GUARD = `[reasoning-guard]
For complex tasks using high or xhigh reasoning effort, extended reasoning is always justified.

Do not curtail reasoning early. Continue until the reasoning is complete.

Before producing the final answer or issuing consequential tool calls,
perform an independent verification pass over assumptions, calculations,
planned changes, and implementation correctness.`;

const effortOrder = new Map<string, number>(REASONING_EFFORTS.map((effort, index) => [effort, index]));

export const reasoningInstructionsGuardConfigSchema: StrictConfigSchema<ReasoningInstructionsGuardConfig> = {
  parse(input: unknown): ReasoningInstructionsGuardConfig {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("reasoning-instructions-guard config must be an object");
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !("reasoningEfforts" in record)) {
      throw new TypeError("reasoning-instructions-guard config contains unknown or missing fields");
    }
    const values = record.reasoningEfforts;
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError("reasoningEfforts must be a non-empty array");
    }
    const unique = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !effortOrder.has(value)) {
        throw new TypeError("reasoningEfforts contains an unsupported value");
      }
      if (unique.has(value)) {
        throw new TypeError("reasoningEfforts contains a duplicate value");
      }
      unique.add(value);
    }
    return Object.freeze({
      reasoningEfforts: Object.freeze(
        [...unique].sort((left, right) => effortOrder.get(left)! - effortOrder.get(right)!) as ReasoningEffort[],
      ),
    });
  },
};

function headingLevelAndText(line: string): { level: number; text: string } | undefined {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
  if (!match) return undefined;
  const text = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1]!.length, text };
}

type DeletionRange = Readonly<{ start: number; end: number }>;

function stripIntermediaryUpdatesSections(input: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let precedingBlankStart: number | undefined;
  let deletionStart: number | undefined;
  const deletions: DeletionRange[] = [];

  let lineStart = 0;
  while (lineStart <= input.length) {
    const newline = input.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? input.length : newline;
    const contentEnd = lineEnd > lineStart && input.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const line = input.slice(lineStart, contentEnd);
    const blank = line.trim().length === 0;
    if (blank && precedingBlankStart === undefined) precedingBlankStart = lineStart;

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open && (open[1]![0] === "~" || !open[2]!.includes("`"))) {
        fence = { marker: open[1]![0] as "`" | "~", length: open[1]!.length };
      } else {
        const heading = headingLevelAndText(line);
        if (heading?.level === 2 && heading.text === "Intermediary updates") {
          deletionStart ??= precedingBlankStart ?? lineStart;
        } else if (deletionStart !== undefined && heading && heading.level <= 2) {
          deletions.push({ start: deletionStart, end: lineStart });
          deletionStart = undefined;
        }
      }
    }

    if (!blank) precedingBlankStart = undefined;
    if (newline < 0) break;
    lineStart = newline + 1;
  }

  if (deletionStart !== undefined) deletions.push({ start: deletionStart, end: input.length });
  if (deletions.length === 0) return input;

  const parts: string[] = [];
  let cursor = 0;
  for (const deletion of deletions) {
    parts.push(normalizePreservedSegment(input.slice(cursor, deletion.start)));
    cursor = deletion.end;
  }
  parts.push(normalizePreservedSegment(input.slice(cursor)));
  return parts.join("").trimEnd();
}

function normalizePreservedSegment(segment: string): string {
  return segment.includes("\r\n") ? segment.replace(/\r\n/g, "\n") : segment;
}

function selectedEffort(payload: Readonly<Record<string, unknown>>): ReasoningEffort | undefined {
  const reasoning = payload.reasoning;
  if (typeof reasoning !== "object" || reasoning === null || Array.isArray(reasoning)) return undefined;
  const effort = (reasoning as Record<string, unknown>).effort;
  return typeof effort === "string" && effortOrder.has(effort) ? effort as ReasoningEffort : undefined;
}

const configUi: readonly PluginConfigField[] = Object.freeze([{
  type: "multi-select",
  key: "reasoningEfforts",
  label: "启用的推理层级",
  description: "只有选中的 Responses reasoning effort 才会调用插件。",
  required: true,
  options: Object.freeze(REASONING_EFFORTS.map((effort) => Object.freeze({ label: effort, value: effort }))),
}]);

const plugin: IngressPlugin<ReasoningInstructionsGuardConfig> = {
  id: "reasoning-instructions-guard",
  desc: "按配置的 reasoning effort 删除 Intermediary updates 章节并追加固定 reasoning guard。",
  version: 2,
  defaultConfig: Object.freeze({ reasoningEfforts: Object.freeze(["high", "xhigh"] as const) }),
  configSchema: reasoningInstructionsGuardConfigSchema,
  configUi,
  isApplicable(
    context: IngressPluginContext,
    payload: Readonly<Record<string, unknown>>,
    config: ReasoningInstructionsGuardConfig,
  ) {
    if (context.kind !== "responses") return false;
    const effort = selectedEffort(payload);
    return effort !== undefined && config.reasoningEfforts.includes(effort);
  },
  transformIngressRequest(
    _context: IngressPluginContext,
    payload: Readonly<Record<string, unknown>>,
    _config: ReasoningInstructionsGuardConfig,
  ) {
    if ("instructions" in payload && typeof payload.instructions !== "string") {
      return { payload: { ...payload }, matched: false };
    }
    const original = typeof payload.instructions === "string" ? payload.instructions : "";
    const stripped = stripIntermediaryUpdatesSections(original);
    const instructions = stripped.endsWith(REASONING_GUARD)
      ? stripped
      : stripped.trimEnd().length === 0
        ? REASONING_GUARD
        : `${stripped.trimEnd()}\n\n${REASONING_GUARD}`;
    if (instructions === original || !instructions.endsWith(REASONING_GUARD)) {
      return { payload: { ...payload }, matched: false };
    }
    return { payload: { ...payload, instructions }, matched: true };
  },
};

export const reasoningInstructionsGuardPlugin = Object.freeze(plugin);
