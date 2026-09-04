import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  REASONING_GUARD,
  executeIngressPlugins,
  ingressPluginRegistry,
  reasoningInstructionsGuardConfigSchema,
  reasoningInstructionsGuardPlugin,
  validateIngressPluginConfig,
} from "./index.js";

const enabled = [{ id: reasoningInstructionsGuardPlugin.id, enabled: true, config: { reasoningEfforts: ["high", "xhigh"] } }] as const;
const context = { kind: "responses" } as const;

describe("reasoning-instructions-guard config and registry", () => {
  it("exposes stable metadata and normalized strict configuration", () => {
    expect(ingressPluginRegistry.map(({ id, version }) => ({ id, version }))).toEqual([{ id: "reasoning-instructions-guard", version: 2 }]);
    expect(reasoningInstructionsGuardConfigSchema.parse({ reasoningEfforts: ["xhigh", "none"] })).toEqual({ reasoningEfforts: ["none", "xhigh"] });
    expect(() => validateIngressPluginConfig("missing", {})).toThrow(/Unknown/);
    expect(() => reasoningInstructionsGuardConfigSchema.parse({ reasoningEfforts: ["high"], extra: true })).toThrow(/unknown/);
    expect(() => reasoningInstructionsGuardConfigSchema.parse({ reasoningEfforts: [] })).toThrow(/non-empty/);
    expect(() => reasoningInstructionsGuardConfigSchema.parse({ reasoningEfforts: ["high", "high"] })).toThrow(/duplicate/);
    expect(reasoningInstructionsGuardPlugin.configUi[0]?.options.map(({ value }) => value)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("reasoning-instructions-guard execution", () => {
  it("does not invoke disabled, non-responses, missing, invalid, or unselected efforts", () => {
    const payload = { reasoning: { effort: "high" }, instructions: "hello" };
    expect(executeIngressPlugins(context, payload, [{ ...enabled[0], enabled: false }]).invokedPlugins).toEqual([]);
    expect(executeIngressPlugins({ kind: "chat.completions" }, payload, enabled).invokedPlugins).toEqual([]);
    expect(executeIngressPlugins(context, { instructions: "hello" }, enabled).invokedPlugins).toEqual([]);
    expect(executeIngressPlugins(context, { reasoning: { effort: "medium" }, instructions: "hello" }, enabled).invokedPlugins).toEqual([]);
    expect(executeIngressPlugins(context, { reasoning: { effort: 1 }, instructions: "hello" }, enabled).invokedPlugins).toEqual([]);
  });

  it("fails closed and preserves the false invocation outcome when a built-in transform throws", () => {
    const throwingPlugin = {
      ...reasoningInstructionsGuardPlugin,
      id: "throwing-test-plugin",
      isApplicable: () => true,
      transformIngressRequest: () => { throw new Error("test-only failure"); }
    };
    expect(() => executeIngressPlugins(context, { instructions: "hello" }, [{ id: throwingPlugin.id, enabled: true, config: throwingPlugin.defaultConfig }], [throwingPlugin])).toThrow(expect.objectContaining({
      invokedPlugins: [{ id: throwingPlugin.id, version: 2, success: false }]
    }));
  });

  it("removes only a final H2 section outside fences and appends the exact guard", () => {
    const instructions = "# Rules\r\n\r\n```md\r\n## Intermediary updates\r\n```\r\n\r\n## Intermediary updates   ##\r\nremove me";
    const input = { reasoning: { effort: "high" }, instructions };
    const result = executeIngressPlugins(context, input, enabled);
    expect(result.payload.instructions).toBe(`# Rules\n\n\`\`\`md\n## Intermediary updates\n\`\`\`\n\n${REASONING_GUARD}`);
    expect(result.invokedPlugins).toEqual([{ id: "reasoning-instructions-guard", version: 2, success: true }]);
    expect(input.instructions).toBe(instructions);
  });

  it("removes the last matching section while preserving later H1/H2 sections", () => {
    const result = executeIngressPlugins(context, {
      reasoning: { effort: "xhigh" },
      instructions: "## Intermediary updates\nkeep\n# Later\nbody",
    }, enabled);
    expect(result.payload.instructions).toBe(`# Later\nbody\n\n${REASONING_GUARD}`);
    expect(result.invokedPlugins).toEqual([{ id: "reasoning-instructions-guard", version: 2, success: true }]);
  });

  it("creates missing instructions, ignores non-string instructions, and is idempotent", () => {
    const missing = executeIngressPlugins(context, { reasoning: { effort: "high" } }, enabled);
    expect(missing.payload.instructions).toBe(REASONING_GUARD);
    const repeated = executeIngressPlugins(context, missing.payload, enabled);
    expect(repeated.payload.instructions).toBe(REASONING_GUARD);
    expect(repeated.invokedPlugins[0]?.success).toBeNull();
    const nonString = executeIngressPlugins(context, { reasoning: { effort: "high" }, instructions: ["x"] }, enabled);
    expect(nonString.payload.instructions).toEqual(["x"]);
    expect(nonString.invokedPlugins[0]?.success).toBeNull();
  });

  it("does not treat a marker, partial text, or non-suffix guard as canonical", () => {
    for (const instructions of ["[reasoning-guard]", REASONING_GUARD.slice(0, -1), `${REASONING_GUARD}\nmore`]) {
      const result = executeIngressPlugins(context, { reasoning: { effort: "high" }, instructions }, enabled);
      expect(result.payload.instructions).toBe(`${instructions}\n\n${REASONING_GUARD}`);
      expect(result.invokedPlugins[0]?.success).toBe(true);
    }
  });

  it("removes duplicate target sections", () => {
    const result = executeIngressPlugins(context, {
      reasoning: { effort: "high" },
      instructions: "## Intermediary updates\nfirst\n### Detail\nkeep\n\n## Intermediary updates\nlast",
    }, enabled);
    expect(result.payload.instructions).toBe(REASONING_GUARD);
  });

  it("preserves every v2 byte-level result across fixed and generated Markdown inputs", () => {
    const fixed = [
      "",
      "plain",
      "plain\r\n",
      "\r\n\r\n## Intermediary updates\r\nremove\r\n# Next\r\nkeep\r\n",
      "## Intermediary updates\nfirst\n## Intermediary updates\nsecond\n# Next\nkeep",
      "~~~md\n## Intermediary updates\n~~~\n\n## Intermediary updates ##\nremove",
      "````md\n```\n## Intermediary updates\n````\n\n## Intermediary updates\nremove",
      "## Intermediary updates\n```\n# not a boundary\n```\n# boundary\nkeep",
      `body\n\n${REASONING_GUARD}`,
      `${REASONING_GUARD}\nmore`,
      "   ## Intermediary updates ###   \nremove\n  ## Later ##\nkeep",
      "#### Intermediary updates\nkeep",
      "    ## Intermediary updates\nkeep"
    ];
    const generated = generatedMarkdownInputs(250);
    for (const instructions of [...fixed, ...generated]) {
      const expected = referenceTransform(instructions);
      const result = reasoningInstructionsGuardPlugin.transformIngressRequest(
        context,
        { reasoning: { effort: "high" }, instructions },
        reasoningInstructionsGuardPlugin.defaultConfig
      );
      expect(result.payload.instructions, JSON.stringify(instructions)).toBe(expected.instructions);
      expect(result.matched, JSON.stringify(instructions)).toBe(expected.matched);
    }
  });

  it("shares every unchanged payload value and leaves the input graph untouched", () => {
    const reasoning = { effort: "high" };
    const input = [{ role: "user", content: "hello" }];
    const tools = [{ type: "function", function: { name: "lookup" } }];
    const payload = { reasoning, input, tools, instructions: "## Intermediary updates\nremove" };
    const result = reasoningInstructionsGuardPlugin.transformIngressRequest(context, payload, reasoningInstructionsGuardPlugin.defaultConfig);

    expect(result.payload).not.toBe(payload);
    expect(result.payload.reasoning).toBe(reasoning);
    expect(result.payload.input).toBe(input);
    expect(result.payload.tools).toBe(tools);
    expect(payload.instructions).toBe("## Intermediary updates\nremove");
    expect(input).toEqual([{ role: "user", content: "hello" }]);
    expect(tools).toEqual([{ type: "function", function: { name: "lookup" } }]);
  });

  it("processes 4,000 target sections without quadratic rescans", () => {
    const instructions = "## Intermediary updates\nintermediary text\n\n".repeat(4_000);
    const startedAt = performance.now();
    const result = reasoningInstructionsGuardPlugin.transformIngressRequest(
      context,
      { reasoning: { effort: "high" }, instructions },
      reasoningInstructionsGuardPlugin.defaultConfig
    );
    const elapsedMs = performance.now() - startedAt;

    expect(result.payload.instructions).toBe(REASONING_GUARD);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("keeps normal instructions larger than 8 MiB free of plugin-specific limits", () => {
    const instructions = "x".repeat(8 * 1024 * 1024 + 1);
    const result = reasoningInstructionsGuardPlugin.transformIngressRequest(
      context,
      { reasoning: { effort: "high" }, instructions },
      reasoningInstructionsGuardPlugin.defaultConfig
    );
    expect(result.payload.instructions).toBe(`${instructions}\n\n${REASONING_GUARD}`);
  });
});

function referenceTransform(original: string): { instructions: string; matched: boolean } {
  let stripped = original;
  while (true) {
    const next = referenceStripLastSection(stripped);
    if (next === stripped) break;
    stripped = next;
  }
  const instructions = stripped.endsWith(REASONING_GUARD)
    ? stripped
    : stripped.trimEnd().length === 0
      ? REASONING_GUARD
      : `${stripped.trimEnd()}\n\n${REASONING_GUARD}`;
  return { instructions, matched: instructions !== original && instructions.endsWith(REASONING_GUARD) };
}

function referenceStripLastSection(input: string): string {
  const lines = input.split(/\r?\n/);
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let candidateStart = -1;
  let candidateEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && (open[1]![0] === "~" || !open[2]!.includes("`"))) {
      fence = { marker: open[1]![0] as "`" | "~", length: open[1]!.length };
      continue;
    }
    const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
    if (!match) continue;
    const level = match[1]!.length;
    const text = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (level === 2 && text === "Intermediary updates") {
      candidateStart = index;
      candidateEnd = lines.length;
    } else if (candidateStart >= 0 && candidateEnd === lines.length && level <= 2) {
      candidateEnd = index;
    }
  }
  if (candidateStart < 0) return input;
  while (candidateStart > 0 && lines[candidateStart - 1]!.trim() === "") candidateStart -= 1;
  while (candidateEnd < lines.length && lines[candidateEnd]!.trim() === "") candidateEnd += 1;
  return [...lines.slice(0, candidateStart), ...lines.slice(candidateEnd)].join("\n").trimEnd();
}

function generatedMarkdownInputs(count: number): string[] {
  const lines = [
    "plain",
    "",
    "   ",
    "# H1",
    "## H2",
    "### H3",
    "## Intermediary updates",
    "## Intermediary updates ##",
    "```md",
    "```",
    "~~~~",
    "~~~~",
    "    ## Intermediary updates",
    "text with ` inline"
  ];
  let state = 0x4f1bbcdc;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () => {
    const length = 1 + (next() % 40);
    const sample = Array.from({ length }, () => lines[next() % lines.length]!);
    const delimiter = next() % 2 === 0 ? "\n" : "\r\n";
    const suffix = next() % 3 === 0 ? delimiter : "";
    return sample.join(delimiter) + suffix;
  });
}
