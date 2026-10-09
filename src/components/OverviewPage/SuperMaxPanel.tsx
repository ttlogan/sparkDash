import { useEffect, useState } from "react";
import { fetchSuperMaxStatus } from "../../api/client";
import type { SuperMaxStatus, SuperMaxRenderHost } from "../../api/types";
import { WindowsIcon, TuxIcon } from "../ui/icons";

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

/** Map the active render host to an OS icon + label. The render box dual-boots
 *  (Windows vs Linux); the probe reports which host is up plus its os type.
 *  The hostname/label comes from runtime env config, not the repo. */
function renderHostRow(host: SuperMaxRenderHost | null | undefined) {
  if (!host) {
    return (
      <p className="text-xs text-muted" role="status">
        No Render Host Active
      </p>
    );
  }
  const isWindows = host.os === "windows";
  const icon = isWindows ? <WindowsIcon className="h-5 w-5" /> : <TuxIcon className="h-5 w-5" />;
  const name = host.label || "render host";
  // renderer mapping: Linux render box runs ComfyUI; Windows boot runs sd1111 (A1111)
  const acc = isWindows ? "sd 1111" : "ComfyUI";
  return (
    <p className="flex items-center gap-2 text-xs text-text-strong">
      <span className="shrink-0 text-accent">{icon}</span>
      {name} is active ({acc})
    </p>
  );
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
  const finished = total > 0 && completed >= total;
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
        ) : finished ? (
          <span className="rounded bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">
            Complete
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
          {renderHostRow(data.renderHost)}
          {data.renderError || data.publishError ? (
            <p className="text-xs text-muted" role="status">
              {data.renderError || data.publishError}
            </p>
          ) : (
            render && (
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-strong">
                    {finished
                      ? "Render complete"
                      : rendering
                        ? `Rendering ${beatLabel(render.currentBeat)}`
                        : "Render pending"}
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
