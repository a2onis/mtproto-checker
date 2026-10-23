/**
 * resize.js — drag-to-resize for the app's sections.
 *
 * Every element marked with `data-resize-key="<name>"` gets three handles:
 *   - right edge   → change width
 *   - bottom edge  → change height
 *   - bottom-right → change both
 *
 * Sizes are remembered per section in localStorage. Double-click a handle to
 * restore the section's default size.
 */

const STORAGE_KEY = "mtproto-checker.sizes.v1";

const LIMITS = {
  sidebar: { minW: 220, maxW: 720, minH: 240, maxH: 2000 },
  configs: { minW: 280, maxW: 2400, minH: 150, maxH: 2000 },
  results: { minW: 280, maxW: 2400, minH: 180, maxH: 2400 },
};
const DEFAULT_LIMITS = { minW: 200, maxW: 2400, minH: 120, maxH: 2400 };

function loadSizes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSizes(sizes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    /* storage unavailable (private mode / quota) — sizes just won't persist */
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function makeHandle(kind) {
  const h = document.createElement("div");
  h.className = `rz-handle rz-${kind}`;
  h.setAttribute("role", "separator");
  h.setAttribute("aria-orientation", kind === "s" ? "horizontal" : "vertical");
  h.title = kind === "e"
    ? "Drag to change width · double-click to reset"
    : kind === "s"
      ? "Drag to change height · double-click to reset"
      : "Drag to change width and height · double-click to reset";
  return h;
}

function applySize(el, sizes, key) {
  const s = sizes[key];
  if (!s) return;
  if (s.w) el.style.width = `${s.w}px`;
  if (s.h) {
    el.style.height = `${s.h}px`;
    el.style.flex = "none";
  }
  el.classList.toggle("is-sized", !!s.h);
}

function resetSize(el, sizes, key) {
  el.style.width = "";
  el.style.height = "";
  el.style.flex = "";
  el.classList.remove("is-sized");
  delete sizes[key];
  saveSizes(sizes);
}

function attach(el, key, sizes, kind) {
  const handle = makeHandle(kind);
  const lim = { ...DEFAULT_LIMITS, ...(LIMITS[key] || {}) };
  const wantsW = kind === "e" || kind === "se";
  const wantsH = kind === "s" || kind === "se";

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
    el.classList.add("resizing");

    const onMove = (ev) => {
      const next = { ...(sizes[key] || {}) };
      if (wantsW) {
        const w = clamp(Math.round(start.w + ev.clientX - start.x), lim.minW, lim.maxW);
        el.style.width = `${w}px`;
        next.w = w;
      }
      if (wantsH) {
        const h = clamp(Math.round(start.h + ev.clientY - start.y), lim.minH, lim.maxH);
        el.style.height = `${h}px`;
        el.style.flex = "none";
        el.classList.add("is-sized");
        next.h = h;
      }
      sizes[key] = next;
    };

    const finish = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing");
      el.classList.remove("resizing");
      if (sizes[key]) saveSizes(sizes);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });

  handle.addEventListener("dblclick", () => resetSize(el, sizes, key));
  el.appendChild(handle);
}

/** Make every [data-resize-key] section resizable and restore saved sizes. */
export function initResizable() {
  const sizes = loadSizes();
  for (const el of document.querySelectorAll("[data-resize-key]")) {
    const key = el.dataset.resizeKey;
    applySize(el, sizes, key);
    el.classList.add("resizable");
    attach(el, key, sizes, "e");
    attach(el, key, sizes, "s");
    attach(el, key, sizes, "se");
  }
}
