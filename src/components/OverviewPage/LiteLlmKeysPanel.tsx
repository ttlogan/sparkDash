import { useEffect, useState } from "react";
import { fetchLiteLlmKeys } from "../../api/client";
import type { LiteLlmKeysResponse, LiteLlmKey } from "../../api/types";

function num(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

/** Friendly short hash for a key (never the full key). */
function shortHash(h: string): string {
  if (!h) return "—";
  return h.length <= 10 ? h : `${h.slice(0, 8)}…`;
}

export function LiteLlmKeysPanel() {
  const [data, setData] = useState<LiteLlmKeysResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLiteLlmKeys()
        .then((next) => {
          if (!cancelled) {
            setData(next);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    void load();
    const timer = window.setInterval(load, 30_000); // spend logs are slow; don't hammer
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const keys = data?.keys ?? [];
  const state = error
    ? `LiteLLM usage unavailable: ${error}`
    : data && !data.enabled
      ? "LiteLLM probe not configured (set LITELLM_PROBE_URL + LITELLM_PROBE_KEY)."
      : !data
        ? "Loading LiteLLM key usage…"
        : null;
  const model = data?.model;

  return (
    <section className="panel p-4" aria-labelledby="litellm-keys-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="litellm-keys-title" className="text-sm font-semibold text-text-strong">
            LiteLLM Key Usage
          </h2>
          <p className="text-[10px] text-muted">
            Tokens + spend per access key · {keys.length} key{keys.length === 1 ? "" : "s"}
            {model ? ` · cost at ${model} MSRP` : ""}
          </p>
        </div>
      </div>

      {state && (
        <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
          {state}
        </p>
      )}

      {keys.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3 font-medium">Label</th>
                <th className="py-1 pr-3 font-medium">Key</th>
                <th className="py-1 pr-3 font-medium text-right">Prompt</th>
                <th className="py-1 pr-3 font-medium text-right">Completion</th>
                <th className="py-1 pr-3 font-medium text-right">Total</th>
                <th className="py-1 pr-3 font-medium text-right">Spend</th>
                <th className="py-1 font-medium text-right">At MSRP</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k: LiteLlmKey) => (
                <tr key={k.keyHash} className="border-t border-border/60">
                  <td className="py-1.5 pr-3 text-text-strong">{k.label}</td>
                  <td className="py-1.5 pr-3 font-mono text-muted">{shortHash(k.keyHash)}</td>
                  <td className="py-1.5 pr-3 text-right font-tabular">{num(k.promptTokens, 0)}</td>
                  <td className="py-1.5 pr-3 text-right font-tabular">{num(k.completionTokens, 0)}</td>
                  <td className="py-1.5 pr-3 text-right font-tabular text-text-strong">{num(k.totalTokens, 0)}</td>
                  <td className="py-1.5 pr-3 text-right font-tabular">${num(k.spend)}</td>
                  <td className="py-1.5 text-right font-tabular">${num(k.costAtMsrp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
