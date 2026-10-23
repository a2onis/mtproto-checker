/**
 * scan.js — client-side scanning of MTProto configurations.
 *
 * The scan runs entirely in the visitor's browser over their own internet
 * connection:
 *   1. syntax validation (server / port / secret format),
 *   2. optional DNS resolution over DoH (helps flag dead hostnames),
 *   3. an HTTPS reachability probe against server:port measuring the time to
 *      first network outcome (browsers cannot speak raw TCP, so the probe
 *      times the TCP+TLS handshake the endpoint answers to).
 *
 * Results are sorted by response speed (fastest first).
 */

import { extractConfigsFromText, canonicalLine, configKey } from "./extract.js";

/* ------------------------------ Validation ------------------------------ */

export function isValidIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => +o >= 0 && +o <= 255);
}

export function isValidHostname(host) {
  if (host.length > 253) return false;
  return /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/.test(host);
}

export function isValidSecret(secret) {
  if (!secret) return false;
  const s = secret.trim();
  if (/^[0-9a-fA-F]+$/.test(s)) {
    // Plain 16-byte or 32-byte secret.
    if (s.length === 32 || s.length === 64) return true;
    // "dd" = padded intermediate secret: prefix byte + 16 (or 32) key bytes.
    if (/^dd/i.test(s) && (s.length === 34 || s.length === 66)) return true;
    // "ee" = FakeTLS secret: prefix byte + key bytes + hex-encoded fake domain.
    if (/^ee/i.test(s) && s.length >= 34 && s.length % 2 === 0) return true;
    return false;
  }
  // Base64url: 16 or 32 bytes, with optional padding.
  if (/^[A-Za-z0-9_\-]+={0,2}$/.test(s)) {
    const body = s.replace(/=+$/, "");
    if (body.length === 22 || body.length === 43) return true;
  }
  return false;
}

/**
 * Ports that browsers refuse to open with fetch() (the Fetch spec's "bad
 * ports" list, e.g. 22/SSH). A web page can never reach these, so probing
 * them would always report a false "unreachable".
 */
const BROWSER_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export function isBrowserBlockedPort(port) {
  return BROWSER_BLOCKED_PORTS.has(port);
}

/** Full syntax check. Returns { ok, reason? } */
export function validateConfig(cfg) {
  if (!cfg.server || !isValidIPv4(cfg.server) && !isValidHostname(cfg.server)) {
    return { ok: false, reason: "invalid server address" };
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    return { ok: false, reason: "invalid port" };
  }
  if (!isValidSecret(cfg.secret)) {
    return { ok: false, reason: "invalid secret (expected 16/32-byte hex or base64url)" };
  }
  return { ok: true };
}

/**
 * Parse free text (the textarea) into unique configs. Understands
 * tg://proxy links, https://t.me/proxy links and server:port:secret lines.
 */
export function parseConfigs(text) {
  const found = extractConfigsFromText(text);
  // Keep only entries that at least look structurally complete (extractConfigsFromText already does),
  // dedupe preserving order.
  const seen = new Set();
  const out = [];
  for (const cfg of found) {
    const key = configKey(cfg);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cfg);
  }
  return out;
}

/* -------------------------------- Probing -------------------------------- */

async function probeOnce(server, port, timeoutMs) {
  const url = `https://${server}:${port}/?_=${Date.now().toString(36)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    // no-cors: any HTTP-ish answer resolves opaque; TLS/TCP failures reject.
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal, redirect: "manual" });
    return { outcome: "answered", ms: performance.now() - t0 };
  } catch (err) {
    const ms = performance.now() - t0;
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return { outcome: "timeout", ms };
    }
    return { outcome: "handshake-error", ms };
  } finally {
    clearTimeout(timer);
  }
}

/** Optional DNS-over-HTTPS lookup — best effort, never throws. */
export async function resolveHost(hostname) {
  if (isValidIPv4(hostname)) return { ip: hostname, skipped: true };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch(
        `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`,
        { signal: ctrl.signal, cache: "no-store" }
      );
      if (!res.ok) return { skipped: true };
      const data = await res.json();
      const answer = (data.Answer || []).find((a) => a.type === 1);
      if (data.Status === 3) return { nxdomain: true };
      return answer ? { ip: answer.data } : { skipped: true };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { skipped: true };
  }
}

/**
 * Probe a single configuration. Takes the fastest of `attempts` tries and
 * classifies reachability.
 *
 * Statuses: 'valid' | 'slow' | 'timeout' | 'unreachable' | 'blocked' | 'invalid'
 */
export async function scanConfig(cfg, opts, onTick) {
  const timeoutMs = opts.scanTimeout || 5000;
  const attempts = Math.max(1, opts.scanAttempts || 1);
  const reachMs = opts.reachMs || 250;

  const syntax = validateConfig(cfg);
  const base = {
    server: cfg.server,
    port: cfg.port,
    secret: cfg.secret,
    raw: canonicalLine(cfg),
  };

  if (!syntax.ok) {
    onTick?.();
    return { ...base, status: "invalid", reason: syntax.reason, latencyMs: null, resolvedIp: null };
  }

  if (isBrowserBlockedPort(cfg.port)) {
    onTick?.();
    return {
      ...base,
      status: "blocked",
      reason: `port ${cfg.port} is blocked by browsers — cannot be tested from a web page`,
      latencyMs: null,
      resolvedIp: null,
    };
  }

  const dns = await resolveHost(cfg.server);
  if (dns.nxdomain) {
    onTick?.();
    return { ...base, status: "invalid", reason: "hostname does not resolve (NXDOMAIN)", latencyMs: null, resolvedIp: null };
  }

  let best = null;
  for (let i = 0; i < attempts; i++) {
    const r = await probeOnce(cfg.server, cfg.port, timeoutMs);
    if (!best || r.ms < best.ms) best = r;
    // Early exit: a real answer cannot be improved by waiting.
    if (best.outcome === "answered") break;
    onTick?.(i < attempts - 1 ? 0.5 : 1);
  }
  onTick?.();

  const latencyMs = Math.round(best.ms);
  let status;
  let reason;

  if (best.outcome === "answered") {
    status = latencyMs <= 400 ? "valid" : "slow";
    reason = "endpoint responded to the TLS probe";
  } else if (best.outcome === "timeout") {
    status = "timeout";
    reason = `no response within ${timeoutMs} ms`;
  } else {
    // TLS/TCP-level rejection. Live MTProto endpoints reject browser TLS
    // quickly (a couple of RTTs); flat refusals fail faster than reachMs.
    if (best.ms >= reachMs) {
      status = latencyMs <= 400 ? "valid" : "slow";
      reason = "endpoint reached (handshake rejected as expected for MTProto)";
    } else {
      status = "unreachable";
      reason = "connection refused or host unreachable";
    }
  }

  return {
    ...base,
    status,
    reason,
    latencyMs,
    resolvedIp: dns.ip || null,
  };
}

/**
 * Scan many configurations with bounded concurrency.
 * Calls onProgress(done, total) after each config completes.
 * Returns results sorted: valid/slow first by latency, then dead ones.
 */
export async function scanConfigs(configs, opts, onProgress) {
  const results = new Array(configs.length);
  let done = 0;

  const queue = configs.map((cfg, index) => ({ cfg, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(opts.scanParallel || 6, 16)) }, async () => {
    while (queue.length) {
      const { cfg, index } = queue.shift();
      results[index] = await scanConfig(cfg, opts);
      done++;
      onProgress?.(done, configs.length);
    }
  });
  await Promise.all(workers);

  return sortResults(results.filter(Boolean));
}

/** Sort: alive configs fastest-first, dead ones last (stable within groups). */
export function sortResults(results) {
  const rank = (r) => {
    if (r.status === "valid" || r.status === "slow") return 0;
    return 1;
  };
  return [...results].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const la = a.latencyMs ?? Number.POSITIVE_INFINITY;
    const lb = b.latencyMs ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.server.localeCompare(b.server);
  });
}

/* ------------------------------ Reporting ------------------------------ */

export const STATUS_LABELS = {
  valid: "Valid",
  slow: "Slow",
  timeout: "Timeout",
  unreachable: "Unreachable",
  blocked: "Blocked port",
  invalid: "Invalid",
};

export function timestampLabel(d = new Date()) {
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function dateFileName(d = new Date()) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function escapeMd(s) {
  return String(s).replace(/\|/g, "\\|").replace(/`/g, "'");
}

function shortSecret(secret) {
  return secret.length > 14 ? `${secret.slice(0, 8)}…${secret.slice(-4)}` : secret;
}

/**
 * Build the per-day markdown report for one scan (already sorted).
 * The file accumulates one section per scan of the day, each sorted by speed.
 */
export function buildScanSection(results, opts = {}) {
  const now = opts.now || new Date();
  const alive = results.filter((r) => r.status === "valid" || r.status === "slow").length;
  const lines = [];

  lines.push(`## Scan at ${now.toLocaleTimeString()} — ${timestampLabel(now)}`);
  lines.push("");
  lines.push(`Scanned **${results.length}** configuration(s); **${alive}** reachable. Sorted by response speed (fastest first).`);
  lines.push("");
  lines.push("| # | Server | Port | Secret | Status | Latency (ms) | Resolved IP |");
  lines.push("|--:|--------|-----:|--------|--------|-------------:|-------------|");

  results.forEach((r, i) => {
    const mark =
      r.status === "valid" ? "✅ Valid" :
      r.status === "slow" ? "🟡 Slow" :
      r.status === "timeout" ? "⏱ Timeout" :
      r.status === "unreachable" ? "❌ Unreachable" :
      r.status === "blocked" ? "⛔ Blocked port" : "❌ Invalid";
    lines.push(
      `| ${i + 1} | \`${escapeMd(r.server)}\` | ${r.port} | \`${escapeMd(shortSecret(r.secret))}\` | ${mark} | ${r.latencyMs ?? "—"} | ${r.resolvedIp ? `\`${escapeMd(r.resolvedIp)}\`` : "—"} |`
    );
  });

  lines.push("");
  lines.push("<details><summary>Full configuration links</summary>");
  lines.push("");
  lines.push("```");
  results.forEach((r) => {
    lines.push(r.raw);
  });
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}

/** Wrap one or more scan sections in the full day-file document. */
export function buildDayReport(existingContent, dayStr, newSection) {
  const header = `# Scan Results — ${dayStr}\n\n`;
  if (!existingContent || !existingContent.trim()) {
    return `${header}_Automatically saved by MTProto Checker._\n\n---\n\n${newSection}`;
  }
  // Append the newest scan section at the end of the existing day file.
  return `${existingContent.replace(/\s*$/, "\n")}\n---\n\n${newSection}`;
}
