/**
 * app.js — UI wiring for MTProto Checker.
 *
 * Sections:
 *   1. Sidebar   — manage Telegram channels, select them to extract configs.
 *   2. Textarea  — extracted + manually pasted MTProto configurations.
 *   3. Results   — client-side scan output, sorted by response speed and
 *                  saved to results/YYYY-MM-DD.md in the repository.
 */

import {
  loadChannels, saveChannels, makeChannel,
  loadSettings, saveSettings,
  normalizeChannelInput, channelDisplayName, channelSubText,
} from "./store.js";
import { extractTodaysConfigs, canonicalLine, configKey } from "./extract.js";
import {
  parseConfigs, scanConfigs, sortResults,
  buildScanSection, buildDayReport, dateFileName, timestampLabel, STATUS_LABELS,
} from "./scan.js";
import { detectRepo, commitFile, readFile } from "./github.js";
import { initResizable } from "./resize.js";

/* ------------------------------- State ------------------------------- */

let channels = loadChannels();
let settings = loadSettings();
let lastResults = [];            // last scan results (sorted)
let lastSectionMd = "";          // markdown of the last scan section
let localDaySections = [];       // sections accumulated locally this session
let extractTimer = null;
let scanning = false;
let extracting = false;
const busyTasks = new Map();     // key -> label of work currently in progress

// Auto-detect the GitHub Pages repository once.
if (!settings.repoOwner || !settings.repoName) {
  const detected = detectRepo();
  if (detected.owner) {
    settings.repoOwner = settings.repoOwner || detected.owner;
    settings.repoName = settings.repoName || detected.repo;
    saveSettings(settings);
  }
}

/* ------------------------------- DOM ------------------------------- */

const $ = (id) => document.getElementById(id);

const els = {
  todayChip: $("todayChip"),
  saveStatusChip: $("saveStatusChip"),
  btnSettings: $("btnSettings"),

  channelList: $("channelList"),
  channelEmpty: $("channelEmpty"),
  channelCount: $("channelCount"),
  channelSearch: $("channelSearch"),
  btnAddChannel: $("btnAddChannel"),
  btnSelectAll: $("btnSelectAll"),
  btnSelectNone: $("btnSelectNone"),
  btnExtract: $("btnExtract"),
  btnExtractIcon: $("btnExtractIcon"),
  btnExtractSpinner: $("btnExtractSpinner"),
  btnExportChannels: $("btnExportChannels"),
  btnImportChannels: $("btnImportChannels"),
  importFile: $("importFile"),

  configInput: $("configInput"),
  configCount: $("configCount"),
  configStats: $("configStats"),
  extractStatus: $("extractStatus"),
  btnPaste: $("btnPaste"),
  btnCopy: $("btnCopy"),
  btnSortConfigs: $("btnSortConfigs"),
  btnClearConfigs: $("btnClearConfigs"),

  btnScan: $("btnScan"),
  btnScanLabel: $("btnScanLabel"),
  btnScanIcon: $("btnScanIcon"),
  btnScanSpinner: $("btnScanSpinner"),
  busyChip: $("busyChip"),
  busyText: $("busyText"),
  btnSaveRepo: $("btnSaveRepo"),
  btnDownloadResults: $("btnDownloadResults"),
  scanProgress: $("scanProgress"),
  scanProgressFill: $("scanProgressFill"),
  scanProgressText: $("scanProgressText"),
  resultsEmpty: $("resultsEmpty"),
  resultList: $("resultList"),
  resultCount: $("resultCount"),
  scanStatus: $("scanStatus"),
  scanMeta: $("scanMeta"),

  channelModal: $("channelModal"),
  channelModalTitle: $("channelModalTitle"),
  channelInput: $("channelInput"),
  channelLabel: $("channelLabel"),
  channelModalError: $("channelModalError"),
  btnSaveChannel: $("btnSaveChannel"),

  settingsModal: $("settingsModal"),
  setToken: $("setToken"),
  setOwner: $("setOwner"),
  setRepo: $("setRepo"),
  setBranch: $("setBranch"),
  setResultsPath: $("setResultsPath"),
  setAutoSave: $("setAutoSave"),
  setCorsProxy: $("setCorsProxy"),
  setTimeout: $("setTimeout"),
  setAttempts: $("setAttempts"),
  setParallel: $("setParallel"),
  setReachMs: $("setReachMs"),
  btnSaveSettings: $("btnSaveSettings"),

  toasts: $("toasts"),
};

/* ---------------------------- Busy indicator ---------------------------- */

/** Mark a background task as running (label) or finished (no label). */
function setBusy(key, label) {
  if (label) busyTasks.set(key, label);
  else busyTasks.delete(key);
  const current = [...busyTasks.values()].pop();
  els.busyChip.hidden = !current;
  els.busyText.textContent = current || "";
}

/* ------------------------------- Toasts ------------------------------- */

function toast(message, type = "info", ms = 3800) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.textContent = message;
  node.append(dot, msg);
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 250);
  }, ms);
}

/* ----------------------------- Channels UI ----------------------------- */

function renderChannels() {
  const q = els.channelSearch.value.trim().toLowerCase();
  const visible = channels.filter((ch) => {
    if (!q) return true;
    return (
      channelDisplayName(ch).toLowerCase().includes(q) ||
      (ch.username || "").toLowerCase().includes(q) ||
      (ch.numericId || "").includes(q)
    );
  });

  els.channelList.textContent = "";
  for (const ch of visible) {
    const row = document.createElement("div");
    row.className = `channel-row${ch.selected ? " selected" : ""}`;
    row.setAttribute("role", "listitem");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "channel-check";
    check.checked = !!ch.selected;
    check.title = "Select to extract today's configurations";
    check.addEventListener("change", () => {
      ch.selected = check.checked;
      saveChannels(channels);
      renderChannels();
      scheduleExtraction();
    });

    const info = document.createElement("div");
    info.className = "channel-info";
    info.title = "Toggle selection";
    const name = document.createElement("div");
    name.className = "channel-name";
    name.textContent = channelDisplayName(ch);
    const sub = document.createElement("div");
    sub.className = `channel-sub${ch.username ? "" : " warn"}`;
    sub.textContent = channelSubText(ch);
    info.append(name, sub);
    info.addEventListener("click", () => {
      ch.selected = !ch.selected;
      saveChannels(channels);
      renderChannels();
      scheduleExtraction();
    });

    const actions = document.createElement("div");
    actions.className = "channel-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.title = "Edit channel";
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
    editBtn.addEventListener("click", () => openChannelModal(ch));

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.title = "Delete channel";
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>`;
    delBtn.addEventListener("click", () => {
      if (!confirm(`Delete ${channelDisplayName(ch)}?`)) return;
      channels = channels.filter((c) => c.id !== ch.id);
      saveChannels(channels);
      renderChannels();
      updateExtractButton();
      toast(`Removed ${channelDisplayName(ch)}`, "success");
    });

    actions.append(editBtn, delBtn);
    row.append(check, info, actions);
    els.channelList.appendChild(row);
  }

  els.channelCount.textContent = String(channels.length);
  els.channelEmpty.classList.toggle("show", channels.length === 0);
  updateExtractButton();
}

function updateExtractButton() {
  els.btnExtract.disabled = extracting || !channels.some((c) => c.selected);
}

/* --------------------------- Channel modal --------------------------- */

let editingChannelId = null;

function openChannelModal(channel = null) {
  editingChannelId = channel ? channel.id : null;
  els.channelModalTitle.textContent = channel ? "Edit Channel" : "Add Channel";
  els.btnSaveChannel.textContent = channel ? "Save changes" : "Add channel";
  els.channelInput.value = channel
    ? channel.username ? `@${channel.username}` : channel.numericId
    : "";
  els.channelLabel.value = channel?.label || "";
  els.channelModalError.hidden = true;
  els.channelModal.hidden = false;
  setTimeout(() => els.channelInput.focus(), 30);
}

function closeModals() {
  els.channelModal.hidden = true;
  els.settingsModal.hidden = true;
}

function saveChannelFromModal() {
  const parsed = normalizeChannelInput(els.channelInput.value);
  const errEl = els.channelModalError;

  if (parsed.error) {
    errEl.textContent = parsed.error;
    errEl.hidden = false;
    return;
  }

  const label = els.channelLabel.value.trim();
  const dupe = channels.find(
    (c) =>
      c.id !== editingChannelId &&
      ((parsed.username && c.username === parsed.username) ||
        (parsed.numericId && c.numericId === parsed.numericId))
  );
  if (dupe) {
    errEl.textContent = "This channel is already in your list.";
    errEl.hidden = false;
    return;
  }

  if (editingChannelId) {
    const ch = channels.find((c) => c.id === editingChannelId);
    if (ch) {
      ch.username = parsed.username;
      ch.numericId = parsed.numericId;
      ch.label = label;
    }
    toast("Channel updated", "success");
  } else {
    channels.push(makeChannel({ username: parsed.username, numericId: parsed.numericId, label }));
    toast(`Added ${label || (parsed.username ? `@${parsed.username}` : parsed.numericId)}`, "success");
    if (parsed.numericId && !parsed.username) {
      toast("Numeric IDs cannot be extracted from the web preview — edit the channel and set its public @username.", "warn", 6000);
    }
  }

  saveChannels(channels);
  renderChannels();
  closeModals();
}

/* --------------------------- Extraction flow --------------------------- */

function todayStr() {
  return dateFileName();
}

function scheduleExtraction() {
  clearTimeout(extractTimer);
  updateExtractButton();
  const selected = channels.filter((c) => c.selected);
  if (!selected.length) return;
  extractTimer = setTimeout(() => extractSelected(), 450);
}

function mergeConfigsIntoTextarea(configs) {
  const existing = new Set(parseConfigs(els.configInput.value).map(configKey));
  const fresh = [];
  for (const cfg of configs) {
    if (existing.has(configKey(cfg))) continue;
    existing.add(configKey(cfg));
    fresh.push(cfg);
  }
  if (fresh.length) {
    const current = els.configInput.value.trim();
    const block = fresh.map(canonicalLine).join("\n");
    els.configInput.value = current ? `${current}\n${block}` : block;
    updateConfigStats();
  }
  return fresh.length;
}

async function extractSelected() {
  if (extracting || !channels.some((c) => c.selected)) return;
  extracting = true;
  els.btnExtractSpinner.hidden = false;
  els.btnExtractIcon.hidden = true;
  setBusy("extract", "Extracting configs…");
  updateExtractButton();
  try {
    await extractSelectedChannels();
  } finally {
    extracting = false;
    els.btnExtractSpinner.hidden = true;
    els.btnExtractIcon.hidden = false;
    setBusy("extract");
    updateExtractButton();
  }
}

async function extractSelectedChannels() {
  const selected = channels.filter((c) => c.selected);
  if (!selected.length) return;

  const day = todayStr();
  let total = 0;
  let newCount = 0;
  let okChannels = 0;
  let fail = 0;

  for (const ch of selected) {
    if (!ch.username) {
      els.extractStatus.textContent = `Skipping ${channelDisplayName(ch)} — a public @username is required for extraction.`;
      fail++;
      continue;
    }
    els.extractStatus.textContent = `Extracting today's configs from @${ch.username}…`;
    try {
      const res = await extractTodaysConfigs(ch.username, day, { customProxy: settings.corsProxy });
      const added = mergeConfigsIntoTextarea(res.configs);
      total += res.configs.length;
      newCount += added;
      okChannels++;
      els.extractStatus.textContent =
        `@${ch.username}: ${res.configs.length} config(s) from ${res.messagesToday} message(s) today.`;
    } catch (err) {
      fail++;
      els.extractStatus.textContent = `Extraction failed for @${ch.username}: ${err.message}`;
    }
  }

  if (okChannels) {
    toast(
      `Extracted ${total} config(s) from ${okChannels} channel(s) — ${newCount} new added to the textarea.`,
      "success"
    );
    els.extractStatus.textContent =
      `Extracted ${total} config(s) from ${okChannels} channel(s) for ${day}. ${newCount} new added.`;
  }
  if (fail && !okChannels) {
    toast("Extraction failed for the selected channels. Check their @usernames or try again.", "error");
  }
  updateConfigStats();
}

function updateConfigStats() {
  const configs = parseConfigs(els.configInput.value);
  const lines = els.configInput.value.split("\n").filter((l) => l.trim()).length;
  els.configCount.textContent = String(configs.length);
  els.configStats.textContent = configs.length
    ? `${configs.length} unique config(s) · ${lines} non-empty line(s)`
    : "";
}

/* ----------------------------- Scan flow ----------------------------- */

function setSaveChip(state, text) {
  els.saveStatusChip.dataset.state = state;
  els.saveStatusChip.textContent = text;
}

async function runScan() {
  if (scanning) return;
  const text = els.configInput.value;
  const configs = parseConfigs(text);
  if (!configs.length) {
    toast("Nothing to scan — extract or paste MTProto configurations first.", "warn");
    els.configInput.focus();
    return;
  }

  scanning = true;
  els.btnScan.disabled = true;
  els.btnScanLabel.textContent = "Scanning…";
  els.btnScanSpinner.hidden = false;
  els.btnScanIcon.hidden = true;
  setBusy("scan", "Scanning configs…");
  els.scanProgress.hidden = false;
  els.scanProgressFill.style.width = "0%";
  els.scanProgressText.textContent = `Scanning 0 / ${configs.length}…`;
  els.scanStatus.textContent = "Scan in progress — testing from your own connection…";

  const t0 = performance.now();
  try {
    const results = await scanConfigs(configs, settings, (done, total) => {
      const pct = Math.round((done / total) * 100);
      els.scanProgressFill.style.width = `${pct}%`;
      els.scanProgressText.textContent = `Scanning ${done} / ${total}…`;
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    lastResults = results;
    lastSectionMd = buildScanSection(results);
    localDaySections.push({ day: todayStr(), section: lastSectionMd });

    renderResults(results);
    const alive = results.filter((r) => r.status === "valid" || r.status === "slow").length;
    els.scanStatus.textContent = `Scan finished in ${secs}s — ${alive} reachable of ${results.length}. Sorted by response speed.`;
    els.scanMeta.textContent = timestampLabel();
    els.btnSaveRepo.disabled = false;
    els.btnDownloadResults.disabled = false;
    toast(`Scan complete: ${alive}/${results.length} reachable.`, "success");

    if (settings.autoSave && settings.githubToken && settings.repoOwner && settings.repoName) {
      await saveResultsToRepo();
    } else if (settings.autoSave) {
      setSaveChip("skipped", "Repo save: not configured");
      els.scanStatus.textContent += " Configure a GitHub token in Settings to save results into the repository.";
    }
  } catch (err) {
    toast(`Scan failed: ${err.message}`, "error");
    els.scanStatus.textContent = `Scan failed: ${err.message}`;
  } finally {
    scanning = false;
    els.btnScan.disabled = false;
    els.btnScanLabel.textContent = "Scan";
    els.btnScanSpinner.hidden = true;
    els.btnScanIcon.hidden = false;
    setBusy("scan");
    setTimeout(() => { els.scanProgress.hidden = true; }, 900);
  }
}

function resultClass(r, rank) {
  const cls = ["result-item"];
  if (rank === 1 && (r.status === "valid" || r.status === "slow")) cls.push("top");
  if (r.status === "slow") cls.push("slow");
  if (r.status === "timeout" || r.status === "unreachable" || r.status === "blocked" || r.status === "invalid") cls.push("dead");
  return cls.join(" ");
}

function renderResults(results) {
  els.resultList.textContent = "";
  els.resultCount.textContent = String(results.length);
  els.resultsEmpty.classList.toggle("show", results.length === 0);

  const alive = results.filter((r) => r.latencyMs != null);
  const minLat = alive.length ? Math.min(...alive.map((r) => r.latencyMs)) : 1;

  results.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = resultClass(r, i + 1);
    li.style.animationDelay = `${Math.min(i * 35, 500)}ms`;

    const rank = document.createElement("div");
    rank.className = "result-rank";
    rank.textContent = String(i + 1);

    const main = document.createElement("div");
    main.className = "result-main";

    const endpoint = document.createElement("div");
    endpoint.className = "result-endpoint";
    const ep = document.createElement("span");
    ep.className = "mono";
    ep.textContent = `${r.server}:${r.port}`;
    const pill = document.createElement("span");
    pill.className = `status-pill ${r.status}`;
    pill.textContent = STATUS_LABELS[r.status] || r.status;
    endpoint.append(ep, pill);

    const bar = document.createElement("div");
    bar.className = "result-bar";
    const fill = document.createElement("div");
    fill.className = "result-bar-fill";
    let width = 8;
    if (r.latencyMs != null && (r.status === "valid" || r.status === "slow")) {
      width = Math.max(10, Math.round((minLat / Math.max(r.latencyMs, 1)) * 100));
    }
    fill.style.width = `${width}%`;
    bar.appendChild(fill);

    const sub = document.createElement("div");
    sub.className = "result-sub";
    const secretShort =
      r.secret.length > 16 ? `${r.secret.slice(0, 10)}…${r.secret.slice(-4)}` : r.secret;
    sub.textContent = [
      `secret ${secretShort}`,
      r.resolvedIp ? `→ ${r.resolvedIp}` : null,
      r.reason,
    ].filter(Boolean).join(" · ");

    main.append(endpoint, bar, sub);

    const latency = document.createElement("div");
    latency.className = "result-latency";
    const msWrap = document.createElement("div");
    if (r.latencyMs != null) {
      const ms = document.createElement("span");
      ms.className = "ms";
      ms.textContent = String(r.latencyMs);
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = "ms";
      msWrap.append(ms, unit);
    } else {
      const ms = document.createElement("span");
      ms.className = "ms";
      ms.textContent = "—";
      msWrap.append(ms);
    }
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = r.status === "invalid" ? r.reason || "bad syntax" : "browser probe";
    latency.append(msWrap, note);

    li.append(rank, main, latency);
    els.resultList.appendChild(li);
  });
}

/* --------------------------- Save to repository --------------------------- */

async function saveResultsToRepo() {
  if (!lastResults.length) {
    toast("No scan results to save yet.", "warn");
    return;
  }
  const dayStr = todayStr();
  const path = `${(settings.resultsPath || "results").replace(/^\/+|\/+$/g, "")}/${dayStr}.md`;

  if (!settings.githubToken || !settings.repoOwner || !settings.repoName) {
    setSaveChip("skipped", "Repo save: not configured");
    toast("Set a GitHub token and repository in Settings to save results.", "warn");
    openSettingsModal();
    return;
  }

  setSaveChip("saving", "Repo save: saving…");
  setBusy("save", "Saving results to repository…");
  try {
    const existing = await readFile({
      token: settings.githubToken,
      owner: settings.repoOwner,
      repo: settings.repoName,
      branch: settings.repoBranch,
      path,
    });
    if (!existing.ok) {
      throw new Error("Could not read the existing results file (check token/repository settings).");
    }
    const full = buildDayReport(existing.content, dayStr, lastSectionMd);
    const res = await commitFile({
      token: settings.githubToken,
      owner: settings.repoOwner,
      repo: settings.repoName,
      branch: settings.repoBranch,
      path,
      content: full,
      message: `Add scan results for ${dayStr} (${new Date().toISOString()})`,
    });
    if (!res.ok) throw new Error(res.error || "Unknown GitHub error");
    setSaveChip("saved", `Repo save: ${dayStr}.md`);
    toast(`Results saved to ${path}`, "success");
  } catch (err) {
    setSaveChip("error", "Repo save: failed");
    toast(`Could not save results: ${err.message}`, "error");
  } finally {
    setBusy("save");
  }
}

function downloadResults() {
  if (!lastResults.length) return;
  const dayStr = todayStr();
  const header = `# Scan Results — ${dayStr}\n\n_Automatically saved by MTProto Checker._\n\n`;
  const body = localDaySections
    .filter((s) => s.day === dayStr)
    .map((s) => s.section)
    .join("\n---\n\n");
  const content = `${header}---\n\n${body}\n`;

  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${dayStr}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Downloaded ${dayStr}.md`, "success");
}

/* --------------------------- Settings modal --------------------------- */

function openSettingsModal() {
  els.setToken.value = settings.githubToken || "";
  els.setOwner.value = settings.repoOwner || "";
  els.setRepo.value = settings.repoName || "";
  els.setBranch.value = settings.repoBranch || "";
  els.setResultsPath.value = settings.resultsPath || "results";
  els.setAutoSave.checked = settings.autoSave !== false;
  els.setCorsProxy.value = settings.corsProxy || "";
  els.setTimeout.value = settings.scanTimeout || 5000;
  els.setAttempts.value = settings.scanAttempts || 2;
  els.setParallel.value = settings.scanParallel || 6;
  els.setReachMs.value = settings.reachMs || 250;
  els.settingsModal.hidden = false;
}

function saveSettingsFromModal() {
  settings = {
    ...settings,
    githubToken: els.setToken.value.trim(),
    repoOwner: els.setOwner.value.trim(),
    repoName: els.setRepo.value.trim(),
    repoBranch: els.setBranch.value.trim(),
    resultsPath: els.setResultsPath.value.trim() || "results",
    autoSave: els.setAutoSave.checked,
    corsProxy: els.setCorsProxy.value.trim(),
    scanTimeout: Math.max(500, parseInt(els.setTimeout.value, 10) || 5000),
    scanAttempts: Math.min(5, Math.max(1, parseInt(els.setAttempts.value, 10) || 1)),
    scanParallel: Math.min(16, Math.max(1, parseInt(els.setParallel.value, 10) || 6)),
    reachMs: Math.min(5000, Math.max(50, parseInt(els.setReachMs.value, 10) || 250)),
  };
  saveSettings(settings);
  closeModals();
  toast("Settings saved", "success");
  setSaveChip("idle", "Repo save: idle");
}

/* ------------------------------ Wiring ------------------------------ */

function init() {
  // Top bar
  els.todayChip.textContent = `Today · ${todayStr()}`;
  setSaveChip("idle", "Repo save: idle");

  renderChannels();
  updateConfigStats();
  initResizable();

  // Channels
  els.btnAddChannel.addEventListener("click", () => openChannelModal());
  els.channelSearch.addEventListener("input", renderChannels);
  els.btnSaveChannel.addEventListener("click", saveChannelFromModal);
  els.channelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveChannelFromModal();
  });
  els.btnSelectAll.addEventListener("click", () => {
    channels.forEach((c) => (c.selected = true));
    saveChannels(channels);
    renderChannels();
    scheduleExtraction();
  });
  els.btnSelectNone.addEventListener("click", () => {
    channels.forEach((c) => (c.selected = false));
    saveChannels(channels);
    renderChannels();
    updateExtractButton();
  });
  els.btnExtract.addEventListener("click", extractSelected);

  els.btnExportChannels.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(channels, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mtproto-checker-channels-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Channel list exported", "success");
  });
  els.btnImportChannels.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error("Not an array");
      let added = 0;
      for (const item of data) {
        const parsed = normalizeChannelInput(item.username ? `@${item.username}` : item.numericId || "");
        if (parsed.error) continue;
        const dupe = channels.some(
          (c) =>
            (parsed.username && c.username === parsed.username) ||
            (parsed.numericId && c.numericId === parsed.numericId)
        );
        if (dupe) continue;
        channels.push(
          makeChannel({ username: parsed.username, numericId: parsed.numericId, label: item.label || "" })
        );
        added++;
      }
      saveChannels(channels);
      renderChannels();
      toast(`Imported ${added} new channel(s)`, "success");
    } catch {
      toast("Could not import that file — expected the exported JSON list.", "error");
    } finally {
      els.importFile.value = "";
    }
  });

  // Textarea
  els.configInput.addEventListener("input", updateConfigStats);
  els.btnClearConfigs.addEventListener("click", () => {
    if (!els.configInput.value || confirm("Clear all configurations from the textarea?")) {
      els.configInput.value = "";
      updateConfigStats();
    }
  });
  els.btnCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.configInput.value);
      toast("Configurations copied to clipboard", "success");
    } catch {
      toast("Clipboard access was denied by the browser.", "error");
    }
  });
  els.btnPaste.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const current = els.configInput.value.trim();
      els.configInput.value = current ? `${current}\n${text.trim()}` : text.trim();
      updateConfigStats();
      toast("Pasted from clipboard", "success");
    } catch {
      toast("Clipboard access was denied — paste into the textarea manually.", "warn");
    }
  });
  els.btnSortConfigs.addEventListener("click", () => {
    const configs = parseConfigs(els.configInput.value);
    if (!configs.length) return;
    configs.sort((a, b) => canonicalLine(a).localeCompare(canonicalLine(b)));
    els.configInput.value = configs.map(canonicalLine).join("\n");
    updateConfigStats();
  });

  // Scan
  els.btnScan.addEventListener("click", runScan);
  els.btnSaveRepo.addEventListener("click", saveResultsToRepo);
  els.btnDownloadResults.addEventListener("click", downloadResults);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runScan();
    }
    if (e.key === "Escape") closeModals();
  });

  // Modals
  els.btnSettings.addEventListener("click", openSettingsModal);
  els.btnSaveSettings.addEventListener("click", saveSettingsFromModal);
  for (const btn of document.querySelectorAll("[data-close-modal]")) {
    btn.addEventListener("click", closeModals);
  }
  for (const backdrop of [els.channelModal, els.settingsModal]) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModals();
    });
  }

  // Hint about extraction on first load
  if (channels.some((c) => c.selected)) scheduleExtraction();
}

init();
