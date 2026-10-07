import { useEffect, useState } from "react";
import { fetchSuperMaxStatus } from "../../api/client";
import type { SuperMaxStatus } from "../../api/types";

/** Format an ISO 8601 publish date into a compact relative string. */
function publishLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return `${d.toLocaleString()} (just now)`;
  if (mins < 60) return `${d.toLocaleString()} (${mins}m ago)`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${d.toLocaleString()} (${hrs}h ago)`;
  const days = Math.round(hrs / 24);
  return `${d.toLocaleString()} (${days}d ago)`;
}

/** Friendly beat label: "20-village" -> "20 · village". */
function beatLabel(beat: string | null | undefined): string {
  if (!beat) return "—";
  return beat.replace(/-/g, " · ");
}

export function SuperMaxPanel() {
  const [data, setData] = useState<SuperMaxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchSuperMaxStatus()
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
    const timer = window.setInterval(load, 30_000); // render/site signals are slow; don't hammer
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const render = data?.render;
  const rendering = Boolean(render?.rendering);
  const completed = render?.completed ?? 0;
  const total = render?.total ?? 9;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const publish = data?.publishDate;

  const state = error
    ? `Super Max status unavailable: ${error}`
    : data && !data.enabled
      ? "Super Max probe not configured (set SUPERMAX_RENDER_URL / SUPERMAX_SITE_URL)."
      : !data
        ? "Loading Super Max status…"
        : null;

  return (
    <section className="panel p-4" aria-labelledby="supermax-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="supermax-title" className="text-sm font-semibold text-text-strong">
            Render Pipeline
          </h2>
          <p className="text-[10px] text-muted">Render + publish status</p>
        </div>
        {rendering ? (
          <span className="rounded bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
            Rendering
          </span>
        ) : (
          <span className="rounded bg-muted/15 px-2 py-0.5 text-[10px] font-semibold text-muted">
            Idle
          </span>
        )}
      </div>

      {state && (
        <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
          {state}
        </p>
      )}

      {data?.enabled && (
        <div className="mt-3 space-y-3">
          {data.renderError || data.publishError ? (
            <p className="text-xs text-muted" role="status">
              {data.renderError || data.publishError}
            </p>
          ) : (
            render && (
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-strong">
                    {rendering ? `Rendering ${beatLabel(render.currentBeat)}` : "Render complete"}
                  </span>
                  <span className="font-tabular text-muted">
                    {completed}/{total} · {pct}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-elevated">
                  <div
                    className={`h-full rounded ${rendering ? "bg-accent" : "bg-success/70"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {render.device && (
                  <p className="mt-1 truncate text-[10px] text-muted" title={render.device}>
                    {render.device}
                    {render.loopStrength != null ? ` · LoRA ${render.loopStrength}` : ""}
                  </p>
                )}
              </div>
            )
          )}

          <div className="flex items-center justify-between border-t border-border/60 pt-2 text-xs">
            <span className="text-muted">Last published</span>
            <span className="font-tabular text-text-strong">{publishLabel(publish)}</span>
          </div>
          {data.publishError && (
            <p className="text-[10px] text-muted" role="status">
              {data.publishError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
