/**
 * SuperMaxStatusProbe — lightweight status for the Super Max render + publish.
 *
 * sparkDash has no native notion of the Super Max video/web pipeline. This probe
 * is the "Ted" fork addition: it reads two always-lightweight signals and
 * composes a small status object for a dashboard card:
 *
 *   1. RENDER  — the render harness status served by the render box's nginx
 *                vhost (SUPERMAX_RENDER_URL, e.g. http://192.168.0.188:8082/
 *                render_status.json). If that box is down/not-Linux-booted, the
 *                fetch fails and we degrade to "renderer offline".
 *   2. PUBLISH  — the last-commit date baked into the live site's HTML meta
 *                (SUPERMAX_SITE_URL, e.g. https://supermax.quest/). The site is
 *                on a CDN (always up), so this is the dependable "last publish".
 *
 * NO SENSITIVE DETAILS ARE STORED OR COMMITTED. Both URLs come from env, never a
 * config file or repo. The probe only ever returns render progress + device +
 * publish date, never credentials or hostnames that don't belong in the repo.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 30000; // both signals are slow-ish; don't hammer

export class SuperMaxStatusProbe {
  /**
   * @param {{ renderUrl?: string, siteUrl?: string }} [opts]
   */
  constructor(opts = {}) {
    this.renderUrl = (opts.renderUrl || process.env.SUPERMAX_RENDER_URL || "").replace(/\/$/, "");
    this.siteUrl = (opts.siteUrl || process.env.SUPERMAX_SITE_URL || "").replace(/\/$/, "");
    this.timeoutMs = Number(process.env.SUPERMAX_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.pollMs = Number(process.env.SUPERMAX_PROBE_POLL_MS || DEFAULT_POLL_MS);
    this.enabled = Boolean(this.renderUrl || this.siteUrl);
    this.error = null;
    this.lastPollAt = 0;
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

    this.error = null;
    this.lastPollAt = Date.now();
    return status;
  }
}
