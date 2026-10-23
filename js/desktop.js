/**
 * desktop.js — progressive bridge for the portable Windows desktop build
 * (Tauri v2 / WebView2). In regular browsers (such as GitHub Pages),
 * isDesktopApp() returns false and the web app runs purely client-side.
 */

function getTauriInvoke() {
  if (typeof window === "undefined") return null;
  if (typeof window.__TAURI__?.core?.invoke === "function") {
    return window.__TAURI__.core.invoke;
  }
  if (typeof window.__TAURI_INTERNALS__?.invoke === "function") {
    return window.__TAURI_INTERNALS__.invoke;
  }
  return null;
}

export function isDesktopApp() {
  return Boolean(getTauriInvoke());
}

export async function invokeDesktop(cmd, args = {}) {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error("Desktop IPC unavailable outside the desktop application.");
  }
  return invoke(cmd, args);
}
