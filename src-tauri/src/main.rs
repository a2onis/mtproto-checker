#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopScanResult {
    status: String,
    reason: String,
    latency_ms: Option<u64>,
    resolved_ip: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileResult {
    canceled: bool,
    path: Option<String>,
}

#[derive(Deserialize)]
struct DohResponse {
    #[serde(rename = "Status", default)]
    status: u64,
    #[serde(rename = "Answer", default)]
    answer: Vec<DohAnswer>,
}

#[derive(Deserialize)]
struct DohAnswer {
    #[serde(rename = "type", default)]
    record_type: u16,
    #[serde(default)]
    data: String,
}

enum ResolveOutcome {
    Resolved(IpAddr),
    NxDomain,
    Hijacked,
    Failed,
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for &b in input.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_windows_proxy_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains('=') || trimmed.contains(';') {
        let mut https_ep: Option<&str> = None;
        let mut http_ep: Option<&str> = None;
        let mut socks_ep: Option<&str> = None;

        for entry in trimmed.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            if let Some((scheme, target)) = entry.split_once('=') {
                let target = target.trim();
                if target.is_empty() {
                    continue;
                }
                match scheme.trim().to_ascii_lowercase().as_str() {
                    "https" => https_ep = Some(target),
                    "http" => http_ep = Some(target),
                    "socks" | "socks5" | "socks4" => socks_ep = Some(target),
                    _ => {}
                }
            }
        }

        if let Some(ep) = https_ep.or(http_ep) {
            return Some(if ep.contains("://") {
                ep.to_string()
            } else {
                format!("http://{ep}")
            });
        }
        if let Some(ep) = socks_ep {
            return Some(if ep.contains("://") {
                ep.to_string()
            } else {
                format!("socks5h://{ep}")
            });
        }
        return None;
    }

    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("http://{trimmed}"))
    }
}

#[cfg(windows)]
fn read_system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let raw: String = settings.get_value("ProxyServer").ok()?;
    parse_windows_proxy_string(&raw)
}

#[cfg(not(windows))]
fn read_system_proxy() -> Option<String> {
    None
}

async fn http_get_text(url: &str, timeout_ms: u64, accept: Option<&str>) -> Result<String, String> {
    let timeout = Duration::from_millis(timeout_ms);

    if let Some(proxy_url) = read_system_proxy() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            if let Ok(client) = reqwest::Client::builder()
                .user_agent(BROWSER_USER_AGENT)
                .proxy(proxy)
                .timeout(timeout)
                .build()
            {
                let mut req = client
                    .get(url)
                    .header("Accept-Language", "en-US,en;q=0.9");
                if let Some(acc) = accept {
                    req = req.header("Accept", acc);
                }
                if let Ok(res) = req.send().await {
                    if res.status().is_success() {
                        if let Ok(body) = res.text().await {
                            return Ok(body);
                        }
                    }
                }
            }
        }
    }

    let direct_client = reqwest::Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {e}"))?;

    let mut req = direct_client
        .get(url)
        .header("Accept-Language", "en-US,en;q=0.9");
    if let Some(acc) = accept {
        req = req.header("Accept", acc);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("Request error: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }

    res.text()
        .await
        .map_err(|e| format!("Failed reading response body: {e}"))
}

fn contains_tme_markers(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.contains("tgme_widget_message")
        || lower.contains("tgme_channel_info")
        || lower.contains("tgme_page_title")
        || lower.contains("tgme_page_icon")
}

#[tauri::command]
async fn fetch_tme_page(url: String, custom_proxy: String) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Invalid URL scheme".into());
    }

    let encoded = encode_uri_component(&url);
    let mut candidates: Vec<(String, u64)> = Vec::with_capacity(9);

    let custom = custom_proxy.trim();
    if !custom.is_empty() && custom.contains("{url}") {
        candidates.push((custom.replace("{url}", &encoded), 10_000));
        candidates.push((custom.replace("{url}", &url), 10_000));
    }

    // Try direct t.me fetch first (no browser CORS restrictions in native Rust),
    // then fall back through public CORS/relay endpoints if t.me is filtered.
    candidates.push((url.clone(), 6_000));
    candidates.push((format!("https://api.allorigins.win/raw?url={encoded}"), 10_000));
    candidates.push((format!("https://corsproxy.io/?url={encoded}"), 10_000));
    candidates.push((format!("https://api.codetabs.com/v1/proxy/?quest={encoded}"), 10_000));
    candidates.push((format!("https://api.cors.lol/?url={encoded}"), 10_000));
    candidates.push((format!("https://proxy.corsfix.com/?{url}"), 10_000));
    candidates.push((format!("https://thingproxy.freeboard.io/fetch/{url}"), 10_000));

    let mut last_err = String::from("All fetch endpoints failed");
    for (target, timeout_ms) in candidates {
        match http_get_text(&target, timeout_ms, None).await {
            Ok(html) if contains_tme_markers(&html) => return Ok(html),
            Ok(_) => last_err = String::from("Upstream returned unrelated content"),
            Err(err) => last_err = err,
        }
    }

    Err(last_err)
}

fn is_poisoned_public_ip(ip: IpAddr, host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_unspecified()
                || v4.is_loopback()
                || (octets[0] == 10 && octets[1] == 10 && octets[2] == 34)
        }
        IpAddr::V6(v6) => v6.is_unspecified() || v6.is_loopback(),
    }
}

async fn resolve_hostname(host: &str, port: u16) -> ResolveOutcome {
    let encoded = encode_uri_component(host);
    let doh_endpoints = [
        format!("https://dns.google/resolve?name={encoded}&type=A"),
        format!("https://cloudflare-dns.com/dns-query?name={encoded}&type=A"),
    ];

    for endpoint in &doh_endpoints {
        if let Ok(text) = http_get_text(endpoint, 3_000, Some("application/dns-json")).await {
            if let Ok(parsed) = serde_json::from_str::<DohResponse>(&text) {
                if parsed.status == 3 {
                    return ResolveOutcome::NxDomain;
                }
                for ans in parsed.answer {
                    if ans.record_type == 1 {
                        if let Ok(v4) = ans.data.trim().parse::<Ipv4Addr>() {
                            let ip = IpAddr::V4(v4);
                            if !is_poisoned_public_ip(ip, host) {
                                return ResolveOutcome::Resolved(ip);
                            }
                        }
                    }
                }
            }
        }
    }

    match tokio::time::timeout(
        Duration::from_millis(3_000),
        tokio::net::lookup_host((host, port)),
    )
    .await
    {
        Ok(Ok(addrs)) => {
            let collected: Vec<IpAddr> = addrs.map(|s| s.ip()).collect();
            if collected.is_empty() {
                return ResolveOutcome::Failed;
            }
            if let Some(&v4) = collected
                .iter()
                .find(|&&ip| ip.is_ipv4() && !is_poisoned_public_ip(ip, host))
            {
                return ResolveOutcome::Resolved(v4);
            }
            if let Some(&any_clean) = collected
                .iter()
                .find(|&&ip| !is_poisoned_public_ip(ip, host))
            {
                return ResolveOutcome::Resolved(any_clean);
            }
            ResolveOutcome::Hijacked
        }
        _ => ResolveOutcome::Failed,
    }
}

#[tauri::command]
async fn scan_endpoint(
    server: String,
    port: u16,
    timeout_ms: u64,
    attempts: u32,
) -> Result<DesktopScanResult, String> {
    let timeout_ms = timeout_ms.clamp(500, 30_000);
    let attempts = attempts.clamp(1, 5);
    let trimmed = server.trim();

    let ip: IpAddr = if let Ok(direct_ip) = trimmed.parse::<IpAddr>() {
        direct_ip
    } else {
        match resolve_hostname(trimmed, port).await {
            ResolveOutcome::Resolved(ip) => ip,
            ResolveOutcome::NxDomain => {
                return Ok(DesktopScanResult {
                    status: "invalid".into(),
                    reason: "hostname does not resolve (NXDOMAIN)".into(),
                    latency_ms: None,
                    resolved_ip: None,
                });
            }
            ResolveOutcome::Hijacked => {
                return Ok(DesktopScanResult {
                    status: "unreachable".into(),
                    reason: "DNS response hijacked by network filter".into(),
                    latency_ms: None,
                    resolved_ip: None,
                });
            }
            ResolveOutcome::Failed => {
                return Ok(DesktopScanResult {
                    status: "unreachable".into(),
                    reason: "could not resolve hostname".into(),
                    latency_ms: None,
                    resolved_ip: None,
                });
            }
        }
    };

    let target = SocketAddr::new(ip, port);
    let resolved_str = ip.to_string();

    let mut best_ok_ms: Option<f64> = None;
    let mut best_err_ms: Option<f64> = None;
    let mut saw_refusal_or_net_err = false;

    for _ in 0..attempts {
        let t0 = Instant::now();
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            tokio::net::TcpStream::connect(target),
        )
        .await
        {
            Ok(Ok(stream)) => {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                drop(stream);
                best_ok_ms = Some(best_ok_ms.map_or(ms, |prev| prev.min(ms)));
            }
            Ok(Err(err)) => {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                if err.kind() != ErrorKind::TimedOut {
                    saw_refusal_or_net_err = true;
                }
                best_err_ms = Some(best_err_ms.map_or(ms, |prev| prev.min(ms)));
            }
            Err(_) => {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                best_err_ms = Some(best_err_ms.map_or(ms, |prev| prev.min(ms)));
            }
        }
    }

    if let Some(ms) = best_ok_ms {
        let latency = ms.round() as u64;
        let status = if latency <= 400 { "valid" } else { "slow" };
        Ok(DesktopScanResult {
            status: status.into(),
            reason: "TCP connection established".into(),
            latency_ms: Some(latency),
            resolved_ip: Some(resolved_str),
        })
    } else {
        let latency = best_err_ms.unwrap_or(timeout_ms as f64).round() as u64;
        if saw_refusal_or_net_err {
            Ok(DesktopScanResult {
                status: "unreachable".into(),
                reason: "connection refused or host unreachable".into(),
                latency_ms: Some(latency),
                resolved_ip: Some(resolved_str),
            })
        } else {
            Ok(DesktopScanResult {
                status: "timeout".into(),
                reason: format!("no response within {timeout_ms} ms"),
                latency_ms: Some(latency),
                resolved_ip: Some(resolved_str),
            })
        }
    }
}

#[tauri::command]
async fn save_text_file(
    default_name: String,
    content: String,
    filter_name: String,
    filter_ext: String,
) -> Result<SaveFileResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter(&filter_name, &[filter_ext.as_str()]);

        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let downloads = std::path::PathBuf::from(home).join("Downloads");
            if downloads.is_dir() {
                dialog = dialog.set_directory(downloads);
            }
        }

        match dialog.save_file() {
            Some(path) => {
                std::fs::write(&path, content.as_bytes())
                    .map_err(|e| format!("Failed writing file: {e}"))?;
                Ok(SaveFileResult {
                    canceled: false,
                    path: Some(path.display().to_string()),
                })
            }
            None => Ok(SaveFileResult {
                canceled: true,
                path: None,
            }),
        }
    })
    .await
    .map_err(|e| format!("Dialog worker failed: {e}"))?
}

#[tauri::command]
async fn read_clipboard() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
        clipboard
            .get_text()
            .map_err(|e| format!("Could not read clipboard text: {e}"))
    })
    .await
    .map_err(|e| format!("Clipboard task failed: {e}"))?
}

#[tauri::command]
async fn write_clipboard(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
        clipboard
            .set_text(text)
            .map_err(|e| format!("Could not write clipboard text: {e}"))
    })
    .await
    .map_err(|e| format!("Clipboard task failed: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_tme_page,
            scan_endpoint,
            save_text_file,
            read_clipboard,
            write_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MTProto Checker");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn parses_windows_proxy_formats() {
        assert_eq!(
            parse_windows_proxy_string("127.0.0.1:10809").as_deref(),
            Some("http://127.0.0.1:10809")
        );
        assert_eq!(
            parse_windows_proxy_string(
                "http=127.0.0.1:10809;https=127.0.0.1:10809;socks=127.0.0.1:10808"
            )
            .as_deref(),
            Some("http://127.0.0.1:10809")
        );
        assert_eq!(
            parse_windows_proxy_string("socks=127.0.0.1:10808").as_deref(),
            Some("socks5h://127.0.0.1:10808")
        );
        assert_eq!(parse_windows_proxy_string(""), None);
    }

    #[test]
    fn flags_poisoned_public_dns_ips() {
        let poison: IpAddr = "10.10.34.35".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let valid: IpAddr = "149.154.167.50".parse().unwrap();

        assert!(is_poisoned_public_ip(poison, "proxy.example.com"));
        assert!(is_poisoned_public_ip(loopback, "proxy.example.com"));
        assert!(!is_poisoned_public_ip(loopback, "localhost"));
        assert!(!is_poisoned_public_ip(valid, "proxy.example.com"));
    }

    #[tokio::test]
    async fn scans_open_and_closed_local_tcp_ports() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open_port = listener.local_addr().unwrap().port();
        let accept_task = tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let open_res = scan_endpoint("127.0.0.1".into(), open_port, 1_500, 1)
            .await
            .unwrap();
        assert_eq!(open_res.status, "valid");
        assert!(open_res.latency_ms.is_some());
        assert_eq!(open_res.resolved_ip.as_deref(), Some("127.0.0.1"));
        let _ = accept_task.await;

        // Closed ephemeral port after dropping listener: on Windows Winsock,
        // SYN retries take ~2s before WSAECONNREFUSED is surfaced.
        let closed_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);

        let closed_res = scan_endpoint("127.0.0.1".into(), closed_port, 3_500, 1)
            .await
            .unwrap();
        assert_eq!(closed_res.status, "unreachable");
    }
}
