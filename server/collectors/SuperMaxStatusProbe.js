/**
 * SuperMaxStatusProbe — lightweight status for the Super Max render + publish.
 *
 * sparkDash has no native notion of the Super Max video/web pipeline. This probe
 * is the "Ted" fork addition: it reads two always-lightweight signals and
 * composes a small status object for a dashboard card:
 *
 *   1. RENDER  — the render harness status served by the render box's nginx
 *                vhost (SUPERMAX_RENDER_URL, e.g. http://<render-box>:8082/
 *                render_status.json). If that box is down/not-Linux-booted, the
 *                fetch fails and we degrade to "renderer offline".
 *   2. PUBLISH  — the last-commit date baked into the live site's HTML meta
 *                (SUPERMAX_SITE_URL, e.g. https://<site>/). The site is
 *                on a CDN (always up), so this is the dependable "last publish".
 *   3. RENDERHOST — which render-host IP responds to a TCP liveness probe
 *                (SUPERMAX_RENDER_HOSTS="ip:label,ip:label"). The render box
 *                dual-boots Windows/Linux, so the card shows the OS icon for
 *                whichever boot is active.
 *
 * NO SENSITIVE DETAILS ARE STORED OR COMMITTED. URLs/hosts come from env, never a
 * config file or repo. The probe only ever returns render progress + device +
 * publish date + an active-host label, never credentials or real hostnames/IPs.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 30000; // both signals are slow-ish; don't hammer
const DEFAULT_PING_MS = 2000; // render-host liveness probe; short so the card feels live
import net from "node:net";

export class SuperMaxStatusProbe {
  /**
   * @param {{ renderUrl?: string, siteUrl?: string, renderHosts?: string[] }} [opts]
   */
  constructor(opts = {}) {
    this.renderUrl = (opts.renderUrl || process.env.SUPERMAX_RENDER_URL || "").replace(/\/$/, "");
    this.siteUrl = (opts.siteUrl || process.env.SUPERMAX_SITE_URL || "").replace(/\/$/, "");
    // Render-host liveness: the box dual-boots (Windows vs Linux). Via env
    // SUPERMAX_RENDER_HOSTS="ip:label,ip:label" or opts as an array of
    // {host, label}.
    const rawHosts = Array.isArray(opts.renderHosts)
      ? opts.renderHosts
      : (opts.renderHosts || process.env.SUPERMAX_RENDER_HOSTS || "").toString().split(",");
    this.renderHosts = rawHosts
      .map((s) => {
        const h = typeof s === "string" ? s.split(":") : [s?.host, s?.label, s?.os];
        const host = (h[0] || "").trim();
        return host ? { host, label: (h[1] || "").trim(), os: ((h[2] || "").trim() || "linux") } : null;
      })
      .filter(Boolean);
    this.pingMs = Number(process.env.SUPERMAX_PROBE_PING_MS || DEFAULT_PING_MS);
    this.timeoutMs = Number(process.env.SUPERMAX_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.pollMs = Number(process.env.SUPERMAX_PROBE_POLL_MS || DEFAULT_POLL_MS);
    this.enabled = Boolean(this.renderUrl || this.siteUrl || this.renderHosts.length);
    this.error = null;
    this.lastPollAt = 0;
  }

  /** TCP liveness probe. Host may be up but the box booted to the "other" OS, so
   *  this detects whether the host responds at all, not which OS is running.
   *  Port 22 (SSH) is the standard host-alive signal on this LAN; configurable
   *  via SUPERMAX_PROBE_PING_PORT. */
  _ping(host, port = Number(process.env.SUPERMAX_PROBE_PING_PORT || 22)) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok) => { sock.destroy(); resolve(ok); };
      sock.setTimeout(this.pingMs);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
  }

  async _renderHostStatus() {
    for (const rh of this.renderHosts) {
      if (await this._ping(rh.host)) return rh;
    }
    return null;
  }

  async _get(url, timeoutMs = this.timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse the last-commit date baked into the live site's <meta name="x-publish-date">. */
  _publishDate(html) {
    const m = /<meta\s+name="x-publish-date"\s+content="([^"]+)"/i.exec(html || "");
    return m ? m[1] : null;
  }

  /**
   * Poll both signals and compose the status object. Never throws: on failure
   * sets this.error and returns a degraded object.
   */
  async poll() {
    this.enabled = Boolean(this.renderUrl || this.siteUrl);
    if (!this.enabled) {
      this.error = "SuperMax probe not configured (set SUPERMAX_RENDER_URL or SUPERMAX_SITE_URL)";
      return { enabled: false, error: this.error, render: null, publishDate: null };
    }
    const status = {};

    // 1) Render status (best-effort; the render box may be offline).
    if (this.renderUrl) {
      try {
        const body = await this._get(`${this.renderUrl}/render_status.json`);
        status.render = JSON.parse(body);
      } catch (e) {
        status.render = null;
        status.renderError = `Renderer offline: ${e.message}`;
      }
    } else {
      status.render = null;
    }

    // 2) Publish date (dependable; the site is on a CDN).
    if (this.siteUrl) {
      try {
        const html = await this._get(this.siteUrl);
        status.publishDate = this._publishDate(html);
      } catch (e) {
        status.publishDate = null;
        status.publishError = `Site unreachable: ${e.message}`;
      }
    } else {
      status.publishDate = null;
    }

    // 3) Render-host liveness. If the render status fetch succeeded, the renderer
    //    is known-up; report it as the active host (so "Rendering" and the host
    //    line never contradict). Otherwise ping each configured host.
    if (this.renderHosts.length) {
      if (status.render?.ok) {
        // The render box served render_status.json -> it's up. Match the host
        // in renderUrl against the configured renderHosts; otherwise the first.
        const urlHost = this.renderUrl ? new URL(this.renderUrl).hostname : "";
        const active = this.renderHosts.find((rh) => rh.host === urlHost) || this.renderHosts[0];
        status.renderHost = active || null;
      } else {
        status.renderHost = await this._renderHostStatus();
      }
    } else {
      status.renderHost = null;
    }

    this.error = null;
    this.lastPollAt = Date.now();
    return status;
  }
}
