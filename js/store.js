/**
 * store.js — persistent state (channels + settings) in localStorage.
 */

const CHANNELS_KEY = "mtproto-checker.channels.v1";
const SETTINGS_KEY = "mtproto-checker.settings.v1";

export const defaultSettings = {
  githubToken: "",
  repoOwner: "",
  repoName: "",
  repoBranch: "",
  resultsPath: "results",
  autoSave: true,
  corsProxy: "",
  scanTimeout: 5000,
  scanAttempts: 2,
  scanParallel: 6,
  reachMs: 250,
};

function safeParse(raw, fallback) {
  try {
    const val = JSON.parse(raw);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------- Channels ------------------------------- */

export function loadChannels() {
  const list = safeParse(localStorage.getItem(CHANNELS_KEY), []);
  return Array.isArray(list) ? list : [];
}

export function saveChannels(channels) {
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(channels));
}

export function makeChannel({ username = null, numericId = null, label = "" }) {
  return {
    id: `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    username,
    numericId,
    label,
    selected: false,
    addedAt: new Date().toISOString(),
  };
}

/* ------------------------------- Settings ------------------------------- */

export function loadSettings() {
  const saved = safeParse(localStorage.getItem(SETTINGS_KEY), {});
  return { ...defaultSettings, ...(saved && typeof saved === "object" ? saved : {}) };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* -------------------------- Channel input parsing -------------------------- */

/**
 * Accepts: @name, name, t.me/name, https://t.me/name, https://t.me/s/name,
 * t.me/c/123/456 (numeric c-id), numeric IDs like -1001234567890.
 */
export function normalizeChannelInput(raw) {
  let s = String(raw || "").trim();
  if (!s) return { error: "Please enter a channel." };

  // Extract the path portion if it looks like a URL / t.me reference.
  const urlMatch = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|tx\.me)\/(.+)$/i);
  if (urlMatch) {
    const path = urlMatch[1].split(/[?#]/)[0].replace(/\/+$/, "");
    if (path.startsWith("+") || path.toLowerCase().startsWith("joinchat/")) {
      return { error: "Invite links cannot be used. Enter a public @username or channel ID." };
    }
    const segs = path.split("/").filter(Boolean);
    if (segs[0].toLowerCase() === "s" && segs[1]) {
      s = segs[1];
    } else if (segs[0].toLowerCase() === "c" && segs[1]) {
      // t.me/c/123456/… → internal id 123456 → full ID -100123456…
      return { numericId: `-100${segs[1]}`, username: null };
    } else {
      s = segs[0];
    }
  }

  s = s.replace(/^@+/, "").trim();

  // Numeric channel ID (e.g. -1001234567890 or 1234567890)
  if (/^-?\d{3,20}$/.test(s)) {
    return { numericId: s.startsWith("-") ? s : `-${s}`, username: null };
  }

  // Plain username
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) {
    return { username: s, numericId: null };
  }

  return { error: "That does not look like a Telegram channel. Use @username, t.me/… link or a numeric ID." };
}

export function channelDisplayName(ch) {
  if (ch.label) return ch.label;
  if (ch.username) return `@${ch.username}`;
  return `ID ${ch.numericId}`;
}

export function channelSubText(ch) {
  if (ch.username) return `t.me/${ch.username}`;
  return "numeric ID — needs @username to extract";
}
