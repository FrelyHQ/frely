import { performance } from "node:perf_hooks";
import { encodeRequestCapture, reconstructEffectiveCapture } from "./request-capture-codec.js";

const samples: Array<[string, unknown, unknown]> = [
  ["small", { input: "hi", instructions: "a" }, { input: "hi", instructions: "b" }],
  ["large-instructions", { input: "x".repeat(10_000), instructions: "a".repeat(10_000) }, { input: "x".repeat(10_000), instructions: "b".repeat(10_000) }],
  ["tools", { tools: tools(), instructions: "a" }, { tools: tools(), instructions: "b" }],
  ["array-edits", { items: Array.from({ length: 1_000 }, (_, index) => index) }, { items: Array.from({ length: 1_000 }, (_, index) => index % 10 ? index : -index) }]
];

for (const [name, original, effective] of samples) {
  const iterations = 100;
  const start = performance.now();
  let encoding = encodeRequestCapture(original, effective);
  for (let index = 0; index < iterations; index += 1) {
    encoding = encodeRequestCapture(original, effective);
    reconstructEffectiveCapture(encoding);
  }
  const payload = encoding.effectivePatch ?? encoding.effectivePayload;
  console.log(JSON.stringify({ sample: name, averageMs: Number(((performance.now() - start) / iterations).toFixed(3)), representation: encoding.effectiveRepresentation, representationBytes: Buffer.byteLength(JSON.stringify(payload), "utf8") }));
}

function tools() {
  return Array.from({ length: 100 }, (_, index) => ({ name: `tool-${index}`, schema: { type: "object", description: "x".repeat(200) } }));
}
