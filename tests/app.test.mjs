import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isDesktopApp, invokeDesktop } from "../js/desktop.js";
import { detectRepo } from "../js/github.js";
import { extractConfigsFromText, canonicalLine, fetchTmePage } from "../js/extract.js";
import {
  validateConfig,
  parseConfigs,
  scanConfig,
  sortResults,
  buildScanSection,
} from "../js/scan.js";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

test("stage-web copies only static UI files and excludes repository artifacts", async () => {
  await execFileAsync(process.execPath, [resolve(root, "scripts/stage-web.mjs")], {
    cwd: root,
  });

  const entries = (await readdir(resolve(root, "src-tauri/web"))).sort();
  assert.deepEqual(entries, ["css", "index.html", "js"]);

  await access(resolve(root, "src-tauri/web/js/app.js"));
  await access(resolve(root, "src-tauri/web/js/desktop.js"));
  await access(resolve(root, "src-tauri/web/css/style.css"));
});

test("validates plain, dd-padded, ee-FakeTLS, and base64url secrets", () => {
  const plain = { server: "149.154.167.50", port: 443, secret: "0123456789abcdef0123456789abcdef" };
  const dd = { server: "149.154.167.50", port: 8443, secret: "dd0123456789abcdef0123456789abcdef" };
  const ee = {
    server: "proxy.example.com",
    port: 443,
    secret: "ee0123456789abcdef0123456789abcdef676f6f676c652e636f6d",
  };

  assert.equal(validateConfig(plain).ok, true);
  assert.equal(validateConfig(dd).ok, true);
  assert.equal(validateConfig(ee).ok, true);
});

test("decodes HTML-escaped links and deduplicates parsed configurations", () => {
  const sample = [
    "https://t.me/proxy?server=1.2.3.4&amp;port=443&amp;secret=dd0123456789abcdef0123456789abcdef",
    "tg://proxy?server=1.2.3.4&port=443&secret=dd0123456789abcdef0123456789abcdef",
    "5.6.7.8:22:0123456789abcdef0123456789abcdef",
  ].join("\n");

  const parsed = parseConfigs(sample);
  assert.equal(parsed.length, 2);
  assert.equal(
    canonicalLine(parsed[0]),
    "tg://proxy?server=1.2.3.4&port=443&secret=dd0123456789abcdef0123456789abcdef"
  );
  assert.equal(extractConfigsFromText(sample).length, 2);
});

test("web mode vs desktop IPC bridge behavior", async (t) => {
  assert.equal(isDesktopApp(), false);
  assert.deepEqual(detectRepo(), { owner: "", repo: "" });

  // In web mode, port 22 is blocked by browser fetch spec
  const webBlocked = await scanConfig(
    { server: "1.2.3.4", port: 22, secret: "dd0123456789abcdef0123456789abcdef" },
    { scanTimeout: 1000, scanAttempts: 1 }
  );
  assert.equal(webBlocked.status, "blocked");

  // Simulate Windows desktop Tauri WebView2 environment
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          calls.push({ cmd, args });
          if (cmd === "scan_endpoint") {
            return {
              status: "valid",
              reason: "TCP connection established",
              latencyMs: 64,
              resolvedIp: "1.2.3.4",
            };
          }
          if (cmd === "fetch_tme_page") {
            return '<div class="tgme_widget_message">ok</div>';
          }
          throw new Error(`Unexpected command: ${cmd}`);
        },
      },
    },
  };
  t.after(() => {
    delete globalThis.window;
  });

  assert.equal(isDesktopApp(), true);
  assert.deepEqual(detectRepo(), { owner: "a2onis", repo: "mtproto-checker" });

  // In desktop .exe mode, port 22 scans natively over raw TCP without browser block
  const desktopScan = await scanConfig(
    { server: "1.2.3.4", port: 22, secret: "dd0123456789abcdef0123456789abcdef" },
    { scanTimeout: 2000, scanAttempts: 2 }
  );
  assert.equal(desktopScan.status, "valid");
  assert.equal(desktopScan.latencyMs, 64);
  assert.equal(desktopScan.probeKind, "tcp probe");

  const html = await fetchTmePage("https://t.me/s/testchannel", "");
  assert.match(html, /tgme_widget_message/);
  assert.equal(calls.length, 2);

  // Verify sorting & markdown report formatting
  const sorted = sortResults([webBlocked, desktopScan]);
  assert.equal(sorted[0].status, "valid");
  const md = buildScanSection(sorted);
  assert.match(md, /`1\.2\.3\.4`/);
});
