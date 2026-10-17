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
 * Endpoints used (all require the master key as Bearer):
 *   GET /spend/logs?summarize=true  -> rows keyed by hashed `api_key` with
 *        prompt/completion/total_tokens + spend (no date filters; this LiteLLM
 *        returns 0 rows when start_date/end_date are passed)
 *   GET /key/list                  -> hashed key ids
 *   GET /key/info?key=<hash>        -> per-key `key_alias` (friendly label) + spend
 */
import { createHash } from "node:crypto";

// ponytail: single poll loop, one fetch per endpoint per tick. If the fleet grows
// past ~10 keys or the spend table is huge, switch /spend/logs to the paginated
// /spend/logs/v2 and cache labels (they change rarely). Add when needed.
//
// CUMULATIVE TOTALS: litellm caps /spend/logs?summarize=true at the 10,000 most
// recent rows, so "lifetime" per-key totals recomputed from it ROLL OFF as the
// table grows and the displayed sum creeps DOWNWARD even while new work is
// logged. To keep the panel monotonic we read the per-key cumulative directly
// from litellm's own daily rollup (LiteLLM_DailyTeamSpend) via a read-only
// psql query when LITELLM_DB_URL is set; otherwise we fall back to the capped
// /spend/logs window. The rollup is authoritative (its totals exactly match the
// raw spend log) and small, so it also cuts the churn of re-pulling the full
// spend log every poll.

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 30000; // spend logs are slow-ish; don't hammer
// Reference MSRP in USD per 1M tokens (input / output). Used to show what the
// same token volume would cost on a paid frontier model, so the dashboard can
// express the value of running it locally for free.
// Claude Sonnet (1M ctx) at MSRP: $3/M input, $15/M output (no long-context
// surcharge). Configurable via env so you can compare against any plan.
const DEFAULT_MSRP = { inputPerM: 3, outputPerM: 15, model: "claude-sonnet-4-5" };

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
    this.dbUrl = opts.litellmDbUrl || process.env.LITELLM_DB_URL || "";
    this.dbEnabled = Boolean(this.dbUrl);
    // test seam: inject a psql runner; default is real child_process.execFile
    this._execFile = opts.execFile || null;
    this.timeoutMs = Number(process.env.LITELLM_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.pollMs = Number(process.env.LITELLM_PROBE_POLL_MS || DEFAULT_POLL_MS);
    this.enabled = Boolean(this.baseUrl && this.masterKey);
    this.error = null;
    this.lastPollAt = 0;
    this.keys = []; // [{ keyHash, label, promptTokens, completionTokens, totalTokens, spend }]
    // Monotonic clamp: track the highest cumulative total seen per key so a
    // transient rollup-query error (which falls back to the capped /spend/logs
    // window) can never make the displayed total go DOWN. Map<keyHash, totalTokens>.
    this._maxTotals = new Map();
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

  /**
   * Read per-key cumulative token totals from litellm's daily rollup.
   * Returns a Map<api_key_hash, {promptTokens, completionTokens, totalTokens}>.
   *
   * Read-only, uncapped, monotonic. Uses psql subprocess (no new dependency);
   * LITELLM_DB_URL is supplied at runtime via env, never committed. The password
   * is passed via PGPASSWORD (not argv) so it never shows in `ps aux`. Returns an
   * empty Map (so the caller falls back to /spend/logs) when disabled or on error.
   */
  async _spendFromDb() {
    if (!this.dbEnabled) return new Map();
    const { execFile } = this._execFile
      ? { execFile: this._execFile }
      : await import("node:child_process");
    // Split the connection URI so the password goes via PGPASSWORD, not argv.
    // postgresql://user:pass@host:port/db
    const url = new URL(this.dbUrl);
    const pw = url.password ? decodeURIComponent(url.password) : "";
    url.password = ""; // strip from the argv connection string
    const conn = url.toString().replace(/\/$/, "");
    const env = { ...process.env };
    if (pw) env.PGPASSWORD = pw;
    const sql =
      "SELECT api_key, sum(prompt_tokens) AS p, sum(completion_tokens) AS c " +
      "FROM \"LiteLLM_DailyTeamSpend\" GROUP BY api_key";
    return new Promise((resolve) => {
      execFile(
        "psql",
        [conn, "-tAc", sql],
        { timeout: this.timeoutMs, maxBuffer: 1 << 20, env },
        (err, stdout) => {
          if (err) return resolve(new Map());
          const agg = new Map();
          for (const line of stdout.trim().split("\n")) {
            if (!line.trim()) continue;
            const [api_key, p, c] = line.split("|");
            const promptTokens = Number(p || 0);
            const completionTokens = Number(c || 0);
            if (!api_key) continue;
            agg.set(api_key, {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            });
          }
          resolve(agg);
        }
      );
    });
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
      // 1) per-key cumulative token counts. When LITELLM_DB_URL is set, read the
      //    authoritative monotonic daily rollup (uncapped). Otherwise fall back to
      //    /spend/logs?summarize=true, which litellm caps at the newest 10k rows
      //    (a sliding window: old large rows roll off and cumulative totals creep
      //    DOWN even while new work is logged).
      const dbAgg = await this._spendFromDb();
      let agg = dbAgg; // Map<keyHash, {promptTokens, completionTokens, totalTokens}>
      if (dbAgg.size === 0) {
        const spendRows = await this._get(`/spend/logs?summarize=true`);
        agg = new Map(); // keyHash -> {prompt,completion,total,spend}
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
      }

      // 2) friendly labels + per-key spend. This LiteLLM has no list /key/info,
      //    so enumerate hashes via /key/list and look up each with
      //    /key/info?key=<hash> to read key_alias for the label. Only a few keys.
      const keyListResp = await this._get("/key/list");
      const hashes = Array.isArray(keyListResp) ? keyListResp : keyListResp?.keys || [];
      const keyList = [];
      for (const kh of hashes) {
        let info = {};
        try {
          info = (await this._get(`/key/info?key=${encodeURIComponent(kh)}`))?.info || {};
        } catch {
          // ignore per-key lookup errors; the hash still contributes spend rows
        }
        keyList.push({ ...info, key_hash: kh });
        const cur = agg.get(kh) || { promptTokens: 0, completionTokens: 0, totalTokens: 0, spend: 0 };
        cur.spend = Number(info.spend ?? cur.spend);
        agg.set(kh, cur);
      }

      // 3) build labelled rows. Match labels to spend rows by hash where we can.
      this.keys = [];
      const labelByHash = new Map();
      for (const k of keyList) {
        const kh = k?.key_hash;
        if (kh) labelByHash.set(kh, LiteLLMProbe.labelFor(k));
      }
      // Only surface hashes that correspond to a live key (skip stale spend
      // rows from re-minted/removed keys, otherwise they appear as unlabeled).
      const liveHashes = new Set(labelByHash.keys());
      for (const [kh, v] of agg) {
        if (!liveHashes.has(kh)) continue;
        const label = labelByHash.get(kh) || "unlabeled";
        // Monotonic clamp: never report a lower cumulative than a prior poll.
        const prevMax = this._maxTotals.get(kh) || 0;
        const totalTokens = Math.max(v.totalTokens || 0, prevMax);
        this._maxTotals.set(kh, totalTokens);
        // If clamped, scale prompt/completion to the clamped total (keep ratio).
        const scale = (v.totalTokens || 0) > 0 ? totalTokens / (v.totalTokens || 0) : 1;
        const promptTokens = Math.round((v.promptTokens || 0) * scale);
        const completionTokens = Math.round((v.completionTokens || 0) * scale);
        // Hypothetical cost if the same tokens were billed at reference MSRP.
        const m = msrpFor();
        const costAtMsrp =
          (promptTokens * m.inputPerM + completionTokens * m.outputPerM) / 1e6;
        this.keys.push({ keyHash: kh, label, model: m.model, promptTokens, completionTokens, totalTokens, spend: v.spend ?? 0, costAtMsrp });
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
