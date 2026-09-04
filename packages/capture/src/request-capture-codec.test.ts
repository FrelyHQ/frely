import { describe, expect, it } from "vitest";
import { applyRequestCapturePatch, canonicalSha256, encodeRequestCapture, reconstructEffectiveCapture, toSafeJsonTree } from "./request-capture-codec.js";

describe("request capture codec", () => {
  it("creates a verified patch without mutating original", () => {
    const input = [{ text: "hello".repeat(100) }];
    const original = { instructions: "secret", input };
    const effective = { instructions: "guard", input, enabled: true };
    const encoded = encodeRequestCapture(original, effective);
    expect(encoded.effectiveRepresentation).toBe("rfc6902");
    expect(reconstructEffectiveCapture(encoded)).toEqual({ status: "verified", representation: "rfc6902", body: effective });
    expect(original).toEqual({ instructions: "secret", input });
  });

  it("uses identity and full fallback representations", () => {
    expect(encodeRequestCapture({ a: 1 }, { a: 1 }).effectiveRepresentation).toBe("identity");
    expect(encodeRequestCapture([], [1]).effectiveRepresentation).toBe("full");
  });

  it("supports root replacement, arrays, escaped pointers and prototype-looking keys", () => {
    expect(applyRequestCapturePatch({ a: 1 }, [{ op: "replace", path: "", value: [] }])).toEqual([]);
    const original = JSON.parse('{"a/b":{"~key":1},"__proto__":"safe"}');
    const effective = JSON.parse('{"a/b":{"~key":2},"__proto__":"still-safe","constructor":true}');
    const encoded = encodeRequestCapture(original, effective);
    expect(reconstructEffectiveCapture(encoded)).toMatchObject({ status: "verified", body: effective });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("uses RFC 8785 canonical hashes and rejects invalid JSON values", () => {
    expect(canonicalSha256(toSafeJsonTree({}))).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(canonicalSha256(toSafeJsonTree({ b: 1, a: 2 }))).toBe(canonicalSha256(toSafeJsonTree({ a: 2, b: 1 })));
    expect(() => toSafeJsonTree({ bad: Number.NaN })).toThrowError(/capture_encoding_failed/);
    expect(() => toSafeJsonTree({ bad: undefined })).toThrowError(/capture_encoding_failed/);
  });

  it("fails closed for unsupported operations and malformed pointers", () => {
    expect(() => applyRequestCapturePatch({}, [{ op: "move", path: "/a", from: "/b" } as never])).toThrowError(/integrity/i);
    expect(() => applyRequestCapturePatch({}, [{ op: "add", path: "/bad~2", value: 1 }])).toThrowError(/integrity/i);
  });

  it("round-trips a deterministic property corpus", () => {
    const random = seededRandom(0x6902);
    for (let index = 0; index < 200; index += 1) {
      const original = randomJson(random, 0);
      const effective = randomJson(random, 0);
      const reconstructed = reconstructEffectiveCapture(encodeRequestCapture(original, effective));
      expect(reconstructed.status).toBe("verified");
      if (reconstructed.status === "verified") expect(reconstructed.body).toEqual(effective);
    }
  });
});

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0) / 0x1_0000_0000);
}

function randomJson(random: () => number, depth: number): unknown {
  if (depth >= 4 || random() < 0.45) {
    const primitive = Math.floor(random() * 5);
    if (primitive === 0) return null;
    if (primitive === 1) return random() < 0.5;
    if (primitive === 2) return Math.floor(random() * 10_000) / 10;
    return `${["text", "~", "/", "", "__proto__"][Math.floor(random() * 5)]}${Math.floor(random() * 100)}`;
  }
  if (random() < 0.5) return Array.from({ length: Math.floor(random() * 5) }, () => randomJson(random, depth + 1));
  const object = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < Math.floor(random() * 5); index += 1) object[["key", "a/b", "~key", "constructor", ""][Math.floor(random() * 5)]! + index] = randomJson(random, depth + 1);
  return object;
}
