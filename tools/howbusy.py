#!/usr/bin/env python3
"""howbusy.py - live Qwen lane busyness on the DGX front door.

Read-only, ad-hoc status report for the GX10 HEAD node (rank 0). Safe to
run at any time: every probe is a read with a short timeout. It never
restarts, writes to, or tunes the serving stack.

Consumer throughput comes from the liteLLM spend DB (windowed SELECT, ~1 s).
Note: spend rows are written at request COMPLETION, so during a single long
generation the per-key rate reads low/0 until that request finishes; the
window is shown in the label so the number is interpretable.
"""

from __future__ import annotations

import json
import re
import socket
import subprocess
import sys
import time
import urllib.request
from collections import Counter

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

VLLM = "http://127.0.0.1:8000"
LITELLM = "http://127.0.0.1:4000"
KEY_FILE = "/etc/sparkdash/env"
CONT = "vllm-fn"
WINDOW_MIN = 15  # per-consumer token-rate window (completion-based)

console = Console(force_terminal=True, width=98)


def sh(cmd, timeout=4, sudo=False):
    """Run a shell command; return stdout stripped, '' on any failure."""
    full = f"sudo {cmd}" if sudo else cmd
    try:
        out = subprocess.run(
            full, shell=True, capture_output=True, text=True, timeout=timeout
        ).stdout
        return out.strip()
    except Exception:
        return ""


def get(url, timeout=3, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except Exception:
        return ""


def metric(text, name, label=None, lval=None):
    """Last value of a vllm:<name>{...} metric, optionally filtered by label."""
    pat = re.compile(rf"^vllm:{re.escape(name)}\{{([^}}]*)\}}\s+([0-9.eE+\-]+)", re.M)
    best = None
    for m in pat.finditer(text):
        labels, val = m.group(1), float(m.group(2))
        if label is not None:
            lm = re.search(re.escape(label) + r'="([^"]*)"', labels)
            if not lm or lm.group(1) != lval:
                continue
        best = val
    return best


def last_line(text, needle):
    for line in reversed(text.splitlines()):
        if needle in line:
            return line
    return ""


# ---- litellm DB helpers (read-only, windowed) -------------------------

def litellm_dsn():
    cfg = sh("cat /etc/litellm/config.yaml", sudo=True, timeout=3)
    m = re.search(r'^\s*database_url:\s*["\']?([^"\'\s]+)', cfg, re.M)
    return m.group(1) if m else ""


def dbq(dsn, sql, timeout=8):
    try:
        r = subprocess.run(
            ["psql", dsn, "-At", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def spend_top(dsn, window_min):
    """[(api_key_hash, total_tokens, req_count)] for the top keys in window."""
    sql = (
        'SELECT api_key, SUM(total_tokens), COUNT(*) FROM "LiteLLM_SpendLogs" '
        f'WHERE "startTime" > now() - interval \'{window_min} minutes\' '
        "GROUP BY api_key ORDER BY 2 DESC LIMIT 6;"
    )
    rows = []
    for line in dbq(dsn, sql).splitlines():
        parts = line.split("|")
        if len(parts) >= 3:
            try:
                rows.append((parts[0], float(parts[1]), int(parts[2])))
            except ValueError:
                pass
    return rows


def conn_key_map(dsn, ips):
    """Most-recent key (hash) per requester IP, for live connections."""
    if not ips:
        return {}
    inlist = ", ".join(f"'{ip}'" for ip in ips)
    sql = (
        "SELECT DISTINCT ON (requester_ip_address) requester_ip_address, api_key "
        f'FROM "LiteLLM_SpendLogs" WHERE requester_ip_address IN ({inlist}) '
        'ORDER BY requester_ip_address, "startTime" DESC;'
    )
    mapping = {}
    for line in dbq(dsn, sql).splitlines():
        if "|" in line:
            ip, key = line.split("|", 1)
            mapping[ip] = key
    return mapping


# ---- litellm key aliases ---------------------------------------------

def master_key():
    env = sh(f"cat {KEY_FILE}", sudo=True, timeout=3)
    m = re.search(r"(?m)^LITELLM_PROBE_KEY=(.+)$", env)
    return m.group(1).strip() if m else ""


def lite_key_map(token):
    """dict hash -> alias for the litellm keys."""
    raw = get(f"{LITELLM}/key/list", token=token)
    try:
        hashes = json.loads(raw).get("keys", [])
    except Exception:
        return {}
    mapping = {}
    for h in hashes[:12]:
        data = get(f"{LITELLM}/key/info?key={h}", token=token)
        try:
            info = json.loads(data)
            info = info.get("info", info)
            mapping[h] = info.get("key_alias") or info.get("key_name") or h[:8]
        except Exception:
            mapping[h] = h[:8]
    return mapping


# ---- connections / system -------------------------------------------

def active_peers(port):
    peers = Counter()
    for line in sh("ss -tn").splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0] != "ESTAB":
            continue
        local, peer = parts[3], parts[4]
        if local.rsplit(":", 1)[-1] == str(port):
            peers[peer.rsplit(":", 1)[0]] += 1
    return peers


def loadavg():
    m = re.match(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)", sh("cat /proc/loadavg"))
    return " ".join(m.groups()) if m else "?"


def dgx_temp():
    best = 0
    for path in sh("ls /sys/class/thermal/").splitlines():
        if not path.startswith("thermal_zone"):
            continue
        t = sh(f"cat /sys/class/thermal/{path}/temp", timeout=2)
        if t.isdigit() and int(t) > best:
            best = int(t)
    return f"{best // 1000}C" if best else "?"


def main():
    mt = get(f"{VLLM}/metrics")
    running = metric(mt, "num_requests_running")
    waiting = metric(mt, "num_requests_waiting")
    wait_cap = metric(mt, "num_requests_waiting_by_reason", label="reason", lval="capacity")
    wait_def = metric(mt, "num_requests_waiting_by_reason", label="reason", lval="deferred")
    ttft_count = metric(mt, "time_to_first_token_seconds_count")
    ttft_sum = metric(mt, "time_to_first_token_seconds_sum")
    q_count = metric(mt, "request_queue_time_seconds_count")
    q_sum = metric(mt, "request_queue_time_seconds_sum")
    # KV usage / prefix hit come off /metrics so they read correctly even idle.
    kv_frac = metric(mt, "kv_cache_usage_perc")
    kv_pct = f"{kv_frac * 100:.1f}" if kv_frac is not None else "?"
    p_q = metric(mt, "prefix_cache_queries_total")
    p_h = metric(mt, "prefix_cache_hits_total")
    prefix_pct = f"{p_h / p_q * 100:.1f}" if (p_q and p_h is not None) else "?"

    log = sh(f"sudo -u wfoster podman logs --tail 2000 {CONT}")
    eng = last_line(log, "Engine 000:")
    mtp = last_line(log, "SpecDecoding metrics:")
    gen_tp = re.search(r"Avg generation throughput: ([\d.]+)", eng)
    prm_tp = re.search(r"Avg prompt throughput: ([\d.]+)", eng)
    accept = re.search(r"Avg Draft acceptance rate: ([\d.]+)%", mtp)
    mlen = re.search(r"Mean acceptance length: ([\d.]+)", mtp)

    proc = sh("ps -ef | grep '[v]llm serve' | grep -v grep | head -1")
    maxseq = re.search(r"--max-num-seqs (\d+)", proc)
    maxlen = re.search(r"--max-model-len (\d+)", proc)
    model = re.search(r'model_name="([^"]+)"', mt)

    smi = sh(
        "nvidia-smi --query-gpu=index,name,utilization.gpu,"
        "temperature.gpu,power.draw --format=csv,noheader"
    )
    gpu_lines = []
    for line in smi.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 5:
            gpu_lines.append(
                f"{parts[1]} {parts[2].replace(' %', '')}% · "
                f"{parts[3]}C · {parts[4].replace(' W', '')}W"
            )
    gpu_str = " | ".join(gpu_lines) or "unavailable"

    token = master_key()
    key_map = lite_key_map(token)
    consumers = active_peers(4000)
    backend = sum(active_peers(8000).values())

    dsn = litellm_dsn()
    spend = spend_top(dsn, WINDOW_MIN) if dsn else []
    conn_map = conn_key_map(dsn, list(consumers.keys())) if dsn else {}

    table = Table(box=box.SIMPLE, show_header=False, pad_edge=False)
    table.add_column(style="bold cyan", no_wrap=True)
    table.add_column()

    table.add_row("System", f"load {loadavg()} · DGX {dgx_temp()}")
    table.add_row("GPU", gpu_str)

    table.add_row(
        "Queue",
        f"running {int(running) if running is not None else '?'}/{maxseq.group(1) if maxseq else '?'}"
        f" · ctx {maxlen.group(1) if maxlen else '?'}"
        f" · waiting {int(waiting) if waiting is not None else '?'}"
        f" (capacity {int(wait_cap) if wait_cap is not None else '?'}, "
        f"deferred {int(wait_def) if wait_def is not None else '?'})",
    )

    if ttft_count and ttft_sum and q_count and q_sum:
        table.add_row(
            "Latency",
            f"TTFT mean {ttft_sum / ttft_count:.2f}s · queue mean "
            f"{q_sum / q_count:.3f}s · {int(ttft_count)} reqs",
        )
    else:
        table.add_row("Latency", "no requests sampled")

    table.add_row(
        "Throughput",
        f"gen ~{gen_tp.group(1) if gen_tp else '?'} tok/s · "
        f"prompt ~{prm_tp.group(1) if prm_tp else '?'} tok/s · "
        f"KV {kv_pct}% · prefix {prefix_pct}%",
    )

    # No speculative decoding runs while idle, so skip the stale MTP stats too.
    if accept and (running is None or running > 0):
        table.add_row(
            "Spec-decode", f"MTP accept {accept.group(1)}% · mean len {mlen.group(1) if mlen else '?'}"
        )

    cons_lines = []
    if spend:
        cons_lines.append(f"top {WINDOW_MIN}m:")
        for h, tok, _cnt in spend[:3]:
            name = key_map.get(h, h[:8])
            cons_lines.append(f"  {name} {tok / (WINDOW_MIN * 60):.0f} tok/s")
    elif consumers:
        aliases = Counter()
        for ip, n in consumers.items():
            al = key_map.get(conn_map.get(ip, ""), conn_map.get(ip, ip))
            aliases[al] += n
        # A single live consumer owns the whole current generation throughput.
        if gen_tp and len(aliases) == 1:
            al, _n = aliases.most_common(1)[0]
            cons_lines.append(f"  {al} ~{float(gen_tp.group(1)):.0f} tok/s")
        else:
            for a, n in aliases.most_common(3):
                cons_lines.append(f"  {a}×{n}")
        cons_lines.append(f"  no completions {WINDOW_MIN}m")
    elif running is not None and running == 0 and waiting == 0:
        cons_lines.append("  idle")
    else:
        cons_lines.append("  none active")
    if backend:
        cons_lines.append(f"  vLLM backend {backend}")
    table.add_row("Consumers", "\n".join(cons_lines))

    title = f"{socket.gethostname()} · {model.group(1) if model else 'qwen lane'}"
    subtitle = f"{time.strftime('%d %b %Y %H:%M:%S')} · DGX rank 0"
    console.print(Panel(table, title=title, subtitle=subtitle, box=box.ROUNDED))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # a status tool should never traceback
        console.print(f"[red]howbusy: {exc}[/red]")
        sys.exit(1)
