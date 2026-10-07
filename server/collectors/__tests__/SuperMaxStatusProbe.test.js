import test from "node:test";
import assert from "node:assert/strict";
import { SuperMaxStatusProbe } from "../SuperMaxStatusProbe.js";

test("SuperMaxStatusProbe parses render status + publish date from fetch stubs", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("render_status.json")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true, rendering: true, loopStrength: 0.8,
          device: "cuda:0 NVIDIA GeForce RTX 3090 Ti",
          done: ["10-portal", "20-village"], completed: 2, total: 9,
          currentBeat: "30-soothsayer", queue: 0,
        }),
      };
    }
    if (u.startsWith("https://example-site.test")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<html><head><meta name="x-publish-date" content="2026-10-07T13:48:28+02:00"></head><body/></html>`,
      };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };

  try {
    const probe = new SuperMaxStatusProbe({
      renderUrl: "http://10.0.0.10:8082",
      siteUrl: "https://example-site.test/",
    });
    const s = await probe.poll();
    assert.equal(s.render.ok, true);
    assert.equal(s.render.rendering, true);
    assert.equal(s.render.currentBeat, "30-soothsayer");
    assert.equal(s.render.completed, 2);
    assert.equal(s.render.loopStrength, 0.8);
    assert.equal(s.publishDate, "2026-10-07T13:48:28+02:00");
    assert.equal(s.renderError, undefined);
    assert.equal(s.publishError, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("SuperMaxStatusProbe degrades when renderer is unreachable", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("render_status.json")) {
      throw new Error("fetch failed");
    }
    if (u.startsWith("https://example-site.test")) {
      return {
        ok: true, status: 200,
        text: async () => `<meta name="x-publish-date" content="2026-10-07T13:48:28+02:00">`,
      };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };

  try {
    const probe = new SuperMaxStatusProbe({
      renderUrl: "http://10.0.0.10:8082",
      siteUrl: "https://example-site.test/",
    });
    const s = await probe.poll();
    assert.equal(s.render, null);
    assert.match(s.renderError, /Renderer offline/);
    // publish date still resolves even when the renderer is down (the safeguard)
    assert.equal(s.publishDate, "2026-10-07T13:48:28+02:00");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("SuperMaxStatusProbe not enabled without any URL", async () => {
  const probe = new SuperMaxStatusProbe({});
  const s = await probe.poll();
  assert.equal(s.enabled, false);
  assert.match(s.error, /not configured/);
});

test("SuperMaxStatusProbe reports the active render host (stubbed ping)", async () => {
  const probe = new SuperMaxStatusProbe({
    renderHosts: [
      { host: "10.0.0.10", label: "windows", os: "windows" },
      { host: "10.0.0.11", label: "linux", os: "linux" },
    ],
  });
  // stub the TCP ping: .10 down, .11 up -> linux host active
  probe._ping = async (host) => host === "10.0.0.11";
  const rh = await probe._renderHostStatus();
  assert.deepEqual(rh, { host: "10.0.0.11", label: "linux", os: "linux" });
});

test("SuperMaxStatusProbe reports null when no render host responds", async () => {
  const probe = new SuperMaxStatusProbe({
    renderHosts: [
      { host: "10.0.0.10", label: "windows", os: "windows" },
      { host: "10.0.0.11", label: "linux", os: "linux" },
    ],
  });
  probe._ping = async () => false;
  const rh = await probe._renderHostStatus();
  assert.equal(rh, null);
});
