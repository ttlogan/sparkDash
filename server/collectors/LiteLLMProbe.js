/**
 * LiteLLMProbe — reads per-key usage from the LiteLLM admin API.
 *
 * sparkDash does not track tokens per access token natively; LiteLLM does. This
 * probe is the "Ted" fork addition: it queries the LiteLLM proxy admin endpoints
 * and surfaces, for each virtual key:
 *   - token counts (prompt / completion / total) from `/spend/logs` (aggregated
 *     per hashed api_key), and
 *   - a friendly label from `/key/info` (`metadata` on the key).
 *
 * NO SENSITIVE DETAILS ARE STORED OR COMMITTED. The LiteLLM base URL and the
 * admin master key are supplied at runtime via env (LITELLM_PROBE_URL,
 * LITELLM_PROBE_KEY), never written to a config file or repo. The probe only
 * ever returns labels + token counts + spend, never the keys themselves.
 *
 * Endpoints used (both require the master key as Bearer):
 *   GET /spend/logs?start_date=..&end_date=..&summarize=true  -> rows keyed by
 *        hashed `api_key` with prompt/completion/total_tokens + spend
 *   GET /key/info  -> key list with `metadata` (friendly label) + per-key spend
 */
import { createHash } from "node:crypto";

// ponytail: single poll loop, one fetch per endpoint per tick. If the fleet grows
// past ~10 keys or the spend table is huge, switch /spend/logs to the paginated
// /spend/logs/v2 and cache labels (they change rarely). Add when needed.

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 30000; // spend logs are slow-ish; don't hammer
// Reference MSRP in USD per 1M tokens (input / output). Used to show what the
// same token volume would cost on a paid frontier model, so the dashboard can
// express the value of running it locally for free.
// Claude Opus 4-8 (1M ctx) at MSRP: $5/M input, $25/M output (no long-context
// surcharge). Configurable via env so you can compare against any plan.
const DEFAULT_MSRP = { inputPerM: 5, outputPerM: 25, model: "claude-opus-4-8-1m" };

export function msrpFor(model = "") {
  // Read env override "name:inPerM:outPerM" e.g. claude-sonnet:3:15
  const raw = process.env.LITELLM_MSRP_MODEL || "";
  if (raw.includes(":")) {
    const [name, i, o] = raw.split(":");
    const inp = Number(i), outp = Number(o);
    if (Number.isFinite(inp) && Number.isFinite(outp)) {
      return { model: name || DEFAULT_MSRP.model, inputPerM: inp, outputPerM: outp };
    }
  }
  return DEFAULT_MSRP;
}


export class LiteLLMProbe {
  /**
   * @param {{ litellmProbeUrl?: string }} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.litellmProbeUrl || process.env.LITELLM_PROBE_URL || "").replace(/\/$/, "");
    this.masterKey = process.env.LITELLM_PROBE_KEY || "";
    this.timeoutMs = Number(process.env.LITELLM_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.pollMs = Number(process.env.LITELLM_PROBE_POLL_MS || DEFAULT_POLL_MS);
    this.enabled = Boolean(this.baseUrl && this.masterKey);
    this.error = null;
    this.lastPollAt = 0;
    this.keys = []; // [{ keyHash, label, promptTokens, completionTokens, totalTokens, spend }]
  }

  _headers() {
    return { Authorization: `Bearer ${this.masterKey}`, "Content-Type": "application/json" };
  }

  async _get(path, timeoutMs = this.timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { headers: this._headers(), signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Friendly label from a key record; falls back to the key's user_id or "unlabeled". */
  static labelFor(keyInfo) {
    const md = keyInfo?.metadata;
    if (md && typeof md === "object") {
      for (const k of ["label", "name", "user", "alias"]) {
        if (typeof md[k] === "string" && md[k].trim()) return md[k].trim();
      }
    }
    if (keyInfo?.user_id) return keyInfo.user_id;
    if (keyInfo?.key_alias) return keyInfo.key_alias;
    return "unlabeled";
  }

  /**
   * Poll LiteLLM and return the merged per-key usage array.
   * Never throws: on failure sets this.error and returns [].
   */
  async poll() {
    this.masterKey = this.masterKey || process.env.LITELLM_PROBE_KEY || "";
    this.enabled = Boolean(this.baseUrl && this.masterKey);
    if (!this.enabled) {
      this.error = "LiteLLM probe not configured (set LITELLM_PROBE_URL + LITELLM_PROBE_KEY)";
      return this.keys;
    }
    try {
      // 1) per-key token counts from spend logs (aggregated, today)
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 3600 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
      const spendRows = await this._get(
        `/spend/logs?start_date=${encodeURIComponent(fmt(start))}&end_date=${encodeURIComponent(fmt(now))}&summarize=true`
      );
      const agg = new Map(); // keyHash -> {prompt,completion,total,spend}
      const rows = Array.isArray(spendRows) ? spendRows : spendRows?.data || [];
      for (const row of rows) {
        const kh = row?.api_key;
        if (!kh) continue;
        const cur = agg.get(kh) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, spend: 0 };
        cur.promptTokens += Number(row.prompt_tokens || 0);
        cur.completionTokens += Number(row.completion_tokens || 0);
        cur.totalTokens += Number(row.total_tokens || 0);
        cur.spend += Number(row.spend || 0);
        agg.set(kh, cur);
      }

      // 2) friendly labels + per-key spend from /key/info (list)
      const keyInfoResp = await this._get("/key/info");
      const keyList = Array.isArray(keyInfoResp)
        ? keyInfoResp
        : keyInfoResp?.data || keyInfoResp?.keys || [];
      for (const k of keyList) {
        const kh = k?.token ? this.hashKey(k.token) : k?.key_hash;
        if (!kh) continue;
        const cur = agg.get(kh) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, spend: 0 };
        cur.spend = Number(k.spend ?? cur.spend);
        // /spend/logs returns hashed api_key; /key/info may return a raw token.
        // Store label on a separate map keyed by the SAME hash if possible.
        agg.set(kh, cur);
      }

      // 3) build labelled rows. Match labels to spend rows by hash where we can;
      //    /key/info without a raw token is matched by hash only if it carries one.
      this.keys = [];
      // attach labels: iterate keyList again, tracking token->hash so we can label
      const labelByHash = new Map();
      for (const k of keyList) {
        const kh = k?.token ? this.hashKey(k.token) : k?.key_hash;
        if (kh) labelByHash.set(kh, LiteLLMProbe.labelFor(k));
      }
      for (const [kh, v] of agg) {
        const label = labelByHash.get(kh) || "unlabeled";
        // Hypothetical cost if the same tokens were billed at reference MSRP.
        const m = msrpFor();
        const costAtMsrp =
          ((v.promptTokens || 0) * m.inputPerM + (v.completionTokens || 0) * m.outputPerM) / 1e6;
        this.keys.push({ keyHash: kh, label, model: m.model, ...v, costAtMsrp });
      }
      this.keys.sort((a, b) => b.totalTokens - a.totalTokens);
      this.error = null;
      this.lastPollAt = Date.now();
    } catch (e) {
      this.error = `LiteLLM probe failed: ${e.message}`;
      this.keys = [];
    }
    return this.keys;
  }

  /** Hash a raw key the way LiteLLM does (sha256, keep it 1-way; never echo it). */
  hashKey(token) {
    return createHash("sha256").update(token).digest("hex");
  }
}
