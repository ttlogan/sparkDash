import { test } from "node:test";
import assert from "node:assert/strict";
import { LiteLLMProbe } from "../LiteLLMProbe.js";
import { createHash } from "node:crypto";

// Fake a LiteLLM admin API with 2 keys. One carries a friendly label in
// key_alias, the other does not (should fall back to "unlabeled"). Mirrors the
// real litellm layout: /key/list -> hashes, /key/info?key=<hash> -> key_alias,
// /spend/logs?summarize=true -> per-row api_key hash + token counts.
function fakeLiteLLM(url) {
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const hashA = sha("sk-aaaa");
  const hashB = sha("sk-bbbb");
  const keyInfo = {
    [hashA]: { key_name: "sk-...aaaa", key_alias: "bill laptop", spend: 0.12, metadata: { label: "bill laptop" } },
    [hashB]: { key_name: "sk-...bbbb", key_alias: null, spend: 0.0, metadata: {} },
  };
  // spend/logs.api_key = sha256(token). Use real hashes so label matching works.
  const spendLogs = [
    { api_key: hashA, prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, spend: 0.1 },
    { api_key: hashA, prompt_tokens: 200, completion_tokens: 60, total_tokens: 260, spend: 0.02 },
    { api_key: hashB, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, spend: 0.0 },
  ];
  globalThis.fetch = async (u, opts) => {
    const parsed = new URL(u);
    const path = parsed.pathname;
    assert.equal(opts.headers.Authorization, "Bearer sk-master", "probe must send master key");
    if (path === "/key/list") {
      return { ok: true, json: async () => ({ keys: [hashA, hashB] }) };
    }
    if (path === "/key/info") {
      const kh = parsed.searchParams.get("key");
      return { ok: true, json: async () => ({ key: kh, info: keyInfo[kh] ?? {} }) };
    }
    if (path === "/spend/logs") {
      return { ok: true, json: async () => spendLogs };
    }
    throw new Error("unexpected path " + path);
  };
}

test("LiteLLMProbe aggregates per-key tokens and labels from metadata", async () => {
  fakeLiteLLM("http://litellm:4000");
  process.env.LITELLM_PROBE_KEY = "sk-master";
  const probe = new LiteLLMProbe({ litellmProbeUrl: "http://litellm:4000" });
  const keys = await probe.poll();

  // Two keys. First labeled; second unlabeled.
  const labeled = keys.find((k) => k.label === "bill laptop");
  const unlabeled = keys.find((k) => k.label === "unlabeled");
  assert.ok(labeled, "labeled key present");
  assert.ok(unlabeled, "unlabeled key present");

  // Aggregated tokens for the labeled key across its two spend rows.
  assert.equal(labeled.promptTokens, 300);
  assert.equal(labeled.completionTokens, 100);
  assert.equal(labeled.totalTokens, 400);
  assert.ok(Math.abs(labeled.spend - 0.12) < 1e-9, "spend from /key/info used");

  // Sort is descending by total tokens (labeled 400 > unlabeled 15).
  assert.equal(keys[0].label, "bill laptop");
  assert.equal(keys[0].totalTokens, 400);

  // Hypothetical cost at reference MSRP (Opus 4-8 1M: $5/$25 per M).
  // labeled: 300 prompt * 5 + 100 completion * 25 = (1500 + 2500)/1e6 = 0.004
  assert.ok(Math.abs(labeled.costAtMsrp - 0.004) < 1e-9, "costAtMsrp for labeled");
  assert.equal(labeled.model, "claude-opus-4-8-1m");

  assert.equal(probe.error, null);
});

test("LiteLLMProbe disabled when not configured", async () => {
  delete process.env.LITELLM_PROBE_KEY;
  const probe = new LiteLLMProbe({ litellmProbeUrl: "" });
  assert.equal(probe.enabled, false);
  const keys = await probe.poll();
  assert.deepEqual(keys, []);
  assert.match(probe.error, /not configured/);
});
