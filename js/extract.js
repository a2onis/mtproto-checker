/**
 * extract.js — extract MTProto configurations published today in a
 * Telegram channel, using the public t.me/s/<channel> web preview through
 * CORS proxies (the app is fully static and runs on GitHub Pages).
 */

/** Built-in public CORS proxies, tried in order. */
const BUILTIN_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
  (u) => `https://proxy.corsfix.com/?${u}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
];

const REQUEST_TIMEOUT = 12000;
const MAX_PAGES = 3;

/* --------------------------- Config extraction --------------------------- */

const PROXY_LINK_RE = /(?:tg:\/\/proxy|https?:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/proxy)\?([^\s"'<>)\]]+)/gi;
const HOST_PORT_SECRET_RE = /(?:^|\s)((?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)):(\d{2,5}):([A-Za-z0-9_\-]{16,}={0,2})(?=\s|$)/g;

/**
 * Build one canonical config object from a link query string
 * (`server=…&port=…&secret=…` in any order).
 */
export function configFromParams(search) {
  const params = new URLSearchParams(search);
  const server = (params.get("server") || "").trim();
  const port = parseInt(params.get("port") || "", 10);
  const secret = (params.get("secret") || "").trim();
  if (!server || !port || !secret) return null;
  return { server, port, secret };
}

export function canonicalLine(cfg) {
  return `tg://proxy?server=${cfg.server}&port=${cfg.port}&secret=${cfg.secret}`;
}

export function configKey(cfg) {
  return `${cfg.server.toLowerCase()}|${cfg.port}|${cfg.secret.toLowerCase()}`;
}

/** Extract every MTProto config from a blob of text (HTML or plain). */
export function extractConfigsFromText(text) {
  const out = new Map();
  if (!text) return [];

  for (const m of text.matchAll(PROXY_LINK_RE)) {
    const cfg = configFromParams(m[1]);
    if (cfg) out.set(configKey(cfg), cfg);
  }
  for (const m of text.matchAll(HOST_PORT_SECRET_RE)) {
    const cfg = { server: m[1], port: parseInt(m[2], 10), secret: m[3] };
    out.set(configKey(cfg), cfg);
  }
  return [...out.values()];
}

/* ------------------------------ Fetch layer ------------------------------ */

function proxyUrlTemplates(custom) {
  const templates = [];
  if (custom && custom.includes("{url}")) {
    templates.push((u) => custom.replace("{url}", encodeURIComponent(u)));
    templates.push((u) => custom.replace("{url}", u));
  }
  templates.push((u) => u); // direct attempt first (works if CORS is open)
  return [...templates, ...BUILTIN_PROXIES];
}

async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { signal: ctrl.signal, cache: "no-store", redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a t.me URL through the first proxy that answers with usable HTML. */
export async function fetchTmePage(tmeUrl, customProxy) {
  const templates = proxyUrlTemplates(customProxy);
  let lastError = null;

  for (const template of templates) {
    const target = template(tmeUrl);
    try {
      const res = await fetchWithTimeout(target);
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      // The real t.me page, or an error page — anything else is a proxy failure.
      if (/tgme_widget_message|tgme_channel_info|tgme_page_title|tgme_page_icon/i.test(html)) {
        return html;
      }
      lastError = new Error("Proxy returned unrelated content");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("All CORS proxies failed");
}

/* ------------------------------ HTML parsing ----------------------------- */

function sameLocalDay(d, dayStr) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}` === dayStr;
}

function pageNotFound(html) {
  return /tgme_page_icon\s+unregistered|Channel\s+not\s+found|tgme_page_title/i.test(html) &&
    !/tgme_widget_message/i.test(html);
}

/**
 * Parse a t.me/s/<channel> page for messages posted on `dayStr`
 * (local date, "YYYY-MM-DD") and extract their MTProto configs.
 *
 * Returns { title, configs, messagesToday, scannedMessages, oldest, nextBefore }
 */
export function parseChannelPage(html, dayStr) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const title =
    doc.querySelector(".tgme_channel_info_header_title")?.textContent?.trim() ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    "";

  const configs = new Map();
  let messagesToday = 0;
  let scanned = 0;
  let oldest = null;

  for (const msg of doc.querySelectorAll(".tgme_widget_message")) {
    scanned++;
    const timeEl = msg.querySelector("time[datetime]");
    const dt = timeEl ? new Date(timeEl.getAttribute("datetime")) : null;
    if (!dt || isNaN(dt)) continue;
    if (!oldest || dt < oldest) oldest = dt;
    if (!sameLocalDay(dt, dayStr)) continue;

    messagesToday++;
    const parts = [];

    // Links inside the message (t.me/s/ turns tg://proxy into real hrefs too).
    for (const a of msg.querySelectorAll("a[href]")) {
      parts.push(a.getAttribute("href") || "");
    }
    // Raw text as fallback (for configs that are not linked).
    const textEl = msg.querySelector(".tgme_widget_message_text");
    parts.push(textEl ? textEl.textContent : msg.textContent || "");

    for (const cfg of extractConfigsFromText(parts.join("\n"))) {
      configs.set(configKey(cfg), cfg);
    }
  }

  // "Load more" link: ?before=<message_id>
  let nextBefore = null;
  const more = doc.querySelector("a.tme_messages_more, a.tgme_widget_message_more");
  const href = more?.getAttribute("href") || "";
  const beforeMatch = href.match(/[?&]before=(\d+)/);
  if (beforeMatch) nextBefore = beforeMatch[1];

  return {
    title,
    configs: [...configs.values()],
    messagesToday,
    scannedMessages: scanned,
    oldest,
    nextBefore,
  };
}

/* ---------------------------- Public interface ---------------------------- */

/**
 * Extract today's MTProto configurations from a public Telegram channel.
 *
 * @param {string} username  Public @username of the channel
 * @param {string} dayStr    Local date "YYYY-MM-DD" to filter messages
 * @param {object} opts      { customProxy }
 * @returns {Promise<{configs: object[], messagesToday: number, scannedMessages: number, title: string, pages: number}>}
 */
export async function extractTodaysConfigs(username, dayStr, opts = {}) {
  const customProxy = opts.customProxy || "";
  const all = new Map();
  let messagesToday = 0;
  let scanned = 0;
  let title = "";
  let pages = 0;
  let before = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = `https://t.me/s/${encodeURIComponent(username)}${before ? `?before=${before}` : ""}`;
    const html = await fetchTmePage(url, customProxy);
    pages++;

    if (pageNotFound(html)) {
      const err = new Error(
        `Channel "${username}" was not found or is not public. Extraction needs a public @username.`
      );
      err.code = "notfound";
      throw err;
    }

    const page = parseChannelPage(html, dayStr);
    if (i === 0) {
      title = page.title;
      // Empty channel / preview without messages
      if (page.scannedMessages === 0 && !page.nextBefore) {
        const err = new Error(`No public posts found for "${username}".`);
        err.code = "empty";
        throw err;
      }
    }

    messagesToday += page.messagesToday;
    scanned += page.scannedMessages;
    for (const cfg of page.configs) all.set(configKey(cfg), cfg);

    // Stop when older messages are no longer from today, or no more pages.
    const reachedOlder =
      page.oldest && !sameLocalDay(page.oldest, dayStr) && page.oldest < new Date(`${dayStr}T23:59:59`);
    if (!page.nextBefore || (page.scannedMessages > 0 && reachedOlder)) break;
    if (page.scannedMessages > 0 && !reachedOlder && page.messagesToday === 0 && i > 0) break;
    before = page.nextBefore;
    if (!before) break;
  }

  return {
    configs: [...all.values()],
    messagesToday,
    scannedMessages: scanned,
    title,
    pages,
  };
}
