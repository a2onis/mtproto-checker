/**
 * github.js — commit sorted scan results into the repository that serves
 * this GitHub Pages site (one file per day: results/YYYY-MM-DD.md), using
 * the GitHub Contents API and a user-provided token.
 */

import { isDesktopApp } from "./desktop.js";

/** Best-effort guess of owner/repo from the GitHub Pages URL. */
export function detectRepo() {
  // Packaged desktop builds run on tauri.localhost rather than GitHub Pages.
  if (isDesktopApp()) {
    return { owner: "a2onis", repo: "mtproto-checker" };
  }
  try {
    const host = location.hostname; // e.g. "alice.github.io"
    const segs = location.pathname.split("/").filter(Boolean);
    if (/\.github\.io$/i.test(host)) {
      const owner = host.split(".")[0];
      // Project pages: alice.github.io/mtproto-checker/ → repo = mtproto-checker
      const repo = segs[0] && !/index\.html?$/i.test(segs[0]) ? segs[0] : `${owner}.github.io`;
      return { owner, repo };
    }
  } catch { /* ignore */ }
  return { owner: "", repo: "" };
}

export function defaultBranch() {
  return "main";
}

function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function githubHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * Save `content` to `path` in the repository (create or update).
 * @returns {Promise<{ok: boolean, url?: string, commit?: string, error?: string}>}
 */
export async function commitFile({ token, owner, repo, branch, path, content, message, _attempt = 0 }) {
  if (!token) return { ok: false, error: "No GitHub token configured." };
  if (!owner || !repo) return { ok: false, error: "Repository owner/name is not configured." };

  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const ref = branch || defaultBranch();

  // Fetch the current file (if any) to learn its SHA — required for updates.
  let sha = null;
  try {
    const res = await fetch(`${apiBase}?ref=${encodeURIComponent(ref)}`, {
      headers: githubHeaders(token),
    });
    if (res.status === 404) {
      sha = null;
    } else if (res.ok) {
      const data = await res.json();
      sha = data.sha || null;
    } else if (res.status === 401 || res.status === 403) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.message || `GitHub rejected the token (HTTP ${res.status}).` };
    } else {
      // Non-fatal: attempt the write anyway (create path).
      sha = null;
    }
  } catch (err) {
    return { ok: false, error: `Could not reach GitHub API: ${err.message}` };
  }

  const body = {
    message,
    content: base64Utf8(content),
    branch: ref,
  };
  if (sha) body.sha = sha;

  try {
    const res = await fetch(apiBase, {
      method: "PUT",
      headers: githubHeaders(token),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        ok: true,
        url: data.content?.html_url || `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
        commit: data.commit?.sha,
      };
    }
    // Conflict: SHA mismatch — retry once with a fresh SHA.
    if (res.status === 409 && _attempt < 2) {
      const retry = await commitFile({ token, owner, repo, branch: ref, path, content, message, _attempt: _attempt + 1 });
      return retry;
    }
    return { ok: false, error: data.message || `GitHub API error (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, error: `Could not write to GitHub: ${err.message}` };
  }
}

/** Read a file's current text from the repo ("" when missing). */
export async function readFile({ token, owner, repo, branch, path }) {
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const ref = branch || defaultBranch();
  try {
    const res = await fetch(`${apiBase}?ref=${encodeURIComponent(ref)}`, {
      headers: githubHeaders(token),
    });
    if (res.status === 404) return { ok: true, content: "" };
    if (!res.ok) return { ok: false, content: "" };
    const data = await res.json();
    if (typeof data.content === "string") {
      const bin = atob(data.content.replace(/\n/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return { ok: true, content: new TextDecoder().decode(bytes) };
    }
    return { ok: true, content: "" };
  } catch {
    return { ok: false, content: "" };
  }
}
