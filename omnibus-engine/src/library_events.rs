// omnibus-engine/src/library_events.rs
//
// Tells the Node app that the ENGINE wrote into a library, so Komga can be asked to rescan.
//
// Without this the Node side only hears about changes IT made. An engine job — a watched import, a
// ComicInfo embed, a CBR→CBZ conversion, a repack, a cover write — would change files on disk and
// Komga would not learn of it until its own periodic scan, which is exactly the delay this
// integration exists to remove.
//
// Design, and why:
//
//   * `emit` NEVER blocks and NEVER awaits. It is called from deep inside sync code, including
//     `spawn_blocking` worker threads, and those must not stall on an HTTP round trip to Node. An
//     unbounded channel send is the cheapest correct primitive here; a bounded one would need a
//     `try_send` + drop policy, and dropping a path silently is worse than a brief queue.
//   * `emit` is a NO-OP before `spawn_drain` and on empty input. That means every existing engine
//     test keeps passing untouched: no drain, no sender, nothing happens.
//   * The drain COALESCES (~3 s, or 500 paths). One engine job touches hundreds of archives; a POST
//     per file would be hundreds of requests and a hundred separate debounce windows on the Node
//     side. Coalescing also means Komga never scans a half-rewritten library.
//   * It is GATED on `komga_enabled` read from the DB (cached ~60 s). Node's `recordLibraryChange`
//     re-checks the flags anyway; this just avoids the HTTP round trip when Komga is off.
//   * Failures are logged, never propagated. A library-change hint that cannot be delivered is a
//     missed optimisation, never a failed import — Komga's periodic scan remains the backstop.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::db::Db;

/// One coalesced change: a reason, the paths that changed, and any series the engine touched.
#[derive(Clone, Debug)]
pub struct LibraryEvent {
    pub reason: String,
    pub paths: Vec<String>,
    pub series_ids: Vec<String>,
}

/// How long the drain waits for a burst to finish before sending, and the cap at which it sends
/// early. A large job (5,000 files) must not sit in the buffer for minutes.
const COALESCE_WINDOW: Duration = Duration::from_secs(3);
const MAX_BATCH_PATHS: usize = 500;

/// `komga_enabled` is read from the DB at most this often. Settings saves are rare, and the drain
/// runs per burst — a fresh query each time would hammer the same SQLite file the engine writes to.
const SETTINGS_TTL: Duration = Duration::from_secs(60);

const POST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: usize = 3;

static SENDER: OnceLock<UnboundedSender<LibraryEvent>> = OnceLock::new();

/// Record a change. No-op before `spawn_drain`, or when there is nothing to say.
///
/// Callers pass plain `&str`/String; the vectors are consumed. Nothing is awaited and nothing is
/// locked, so this is safe from a `spawn_blocking` thread.
pub fn emit(reason: &str, paths: Vec<String>, series_ids: Vec<String>) {
    let sender = match SENDER.get() {
        Some(s) => s,
        // No drain task (tests, or a build that never reached run()): nothing to do.
        None => return,
    };
    if paths.is_empty() && series_ids.is_empty() {
        return;
    }
    let _ = sender.send(LibraryEvent {
        reason: reason.to_string(),
        paths,
        series_ids,
    });
}

/// Merge a newly received event into an in-flight batch, returning the new batch.
///
/// PURE, and the unit-tested core of the coalescer. Paths are de-duplicated because a single job
/// routinely touches the same path twice (temp file + final rename). Returns `true` once the batch
/// is full enough to send without waiting for the window to close.
pub fn coalesce(batch: LibraryEvent, incoming: LibraryEvent) -> (LibraryEvent, bool) {
    let LibraryEvent { reason: batch_reason, mut paths, mut series_ids } = batch;
    let LibraryEvent { reason: incoming_reason, paths: new_paths, series_ids: new_series } = incoming;

    // Keep the first reason: a batch is one logical change, and the first caller names it best.
    let reason = if batch_reason.is_empty() { incoming_reason } else { batch_reason };

    // Owned keys: the sets must not borrow from the vectors they are also being appended to.
    let mut seen: std::collections::HashSet<String> = paths.iter().cloned().collect();
    for p in new_paths {
        if seen.insert(p.clone()) {
            paths.push(p);
        }
    }
    let mut series_seen: std::collections::HashSet<String> = series_ids.iter().cloned().collect();
    for s in new_series {
        if series_seen.insert(s.clone()) {
            series_ids.push(s);
        }
    }

    let full = paths.len() >= MAX_BATCH_PATHS;
    (LibraryEvent { reason, paths, series_ids }, full)
}

/// Split an oversized batch into POST-sized chunks, so one huge job cannot produce a body Node's
/// route validation would reject. PURE, and unit-tested.
pub fn chunk_event(event: &LibraryEvent) -> Vec<serde_json::Value> {
    if event.paths.len() <= MAX_BATCH_PATHS {
        return vec![to_payload(event)];
    }
    event
        .paths
        .chunks(MAX_BATCH_PATHS)
        .map(|slice| {
            serde_json::json!({
                "reason": event.reason,
                "paths": slice,
                "seriesIds": event.series_ids,
            })
        })
        .collect()
}

fn to_payload(event: &LibraryEvent) -> serde_json::Value {
    serde_json::json!({
        "reason": event.reason,
        "paths": event.paths,
        "seriesIds": event.series_ids,
    })
}

/// PURE: is the integration on, given the raw setting value? Unit-tested with injected values so
/// the gate is tested without a database.
///
/// Anything other than exactly "true" is off. Node writes 'true'/'false' as strings.
pub fn komga_enabled_value(value: Option<&str>) -> bool {
    matches!(value, Some("true"))
}

async fn komga_enabled(db: &Db) -> bool {
    // Identical quoting to metadata_cache::setting; valid on both Postgres and SQLite under AnyPool.
    let value = sqlx::query_scalar::<_, String>(
        r#"SELECT value FROM "SystemSetting" WHERE key = 'komga_enabled'"#,
    )
    .fetch_optional(&db.pool)
    .await
    .ok()
    .flatten();
    komga_enabled_value(value.as_deref())
}

/// POST one batch, retrying on transport failure or a non-2xx.
///
/// Returns Ok(()) on success. Retries are short and bounded: a Node restart should not lose the
/// whole burst, but an outage must not hold the task open either.
async fn post_batch(client: &reqwest::Client, endpoint: &str, secret: &str, events: &[serde_json::Value]) {
    let body = serde_json::json!({ "events": events });
    let mut delay = Duration::from_secs(2);

    for attempt in 1..=MAX_ATTEMPTS {
        let result = client
            .post(endpoint)
            .header("X-Internal-Secret", secret)
            .json(&body)
            .timeout(POST_TIMEOUT)
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => return,
            Ok(resp) => {
                let status = resp.status();
                if attempt == MAX_ATTEMPTS {
                    log::warn!(
                        "[LibraryEvents] Node /api/internal/library-changed returned {} after {} attempt(s).",
                        status,
                        attempt
                    );
                    return;
                }
                // 4xx is a contract bug, not a blip: retrying cannot fix it.
                if status.is_client_error() {
                    log::warn!("[LibraryEvents] Node rejected the batch with {}; not retrying.", status);
                    return;
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    log::warn!("[LibraryEvents] Could not reach Node after {} attempt(s): {}", attempt, e);
                    return;
                }
            }
        }
        tokio::time::sleep(delay).await;
        delay *= 2;
    }
}

/// Spawn the drain task. Call once from `run()`, after the DB connect.
///
/// Safe to call twice: the channel is created once and the second call is a no-op.
pub fn spawn_drain(db: Db) {
    let (tx, rx) = unbounded_channel::<LibraryEvent>();
    // A second call must not create a second channel: the emitters would then point at the first
    // (already-consumed) receiver and every event would be lost.
    if SENDER.set(tx).is_err() {
        return;
    }
    tokio::spawn(async move { drain_loop(db, rx).await });
}

async fn drain_loop(db: Db, mut rx: UnboundedReceiver<LibraryEvent>) {
    // notify_node semantics: an unset secret means we are not paired with a Node app, so every
    // attempt would be a wasted connection. Warn once at startup rather than per event.
    let secret = std::env::var("NEXTAUTH_SECRET").unwrap_or_default();
    if secret.is_empty() {
        log::warn!("[LibraryEvents] NEXTAUTH_SECRET unset; engine library changes will not reach Node.");
        return;
    }
    let node_url =
        std::env::var("OMNIBUS_NODE_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let endpoint = format!("{}/api/internal/library-changed", node_url.trim_end_matches('/'));

    let client = match reqwest::Client::builder().timeout(POST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[LibraryEvents] Could not build the HTTP client; library changes will not be sent: {}", e);
            return;
        }
    };

    // Settings are cached locally to the drain so a burst of 50 batches does not run 50 queries.
    let mut enabled_cache: Option<(bool, std::time::Instant)> = None;

    while let Some(first) = rx.recv().await {
        // Block on the first event, then keep collecting until the window closes or the batch is
        // full. An engine job that rewrote 300 archives becomes one POST, not 300.
        let mut batch = first;
        let deadline = tokio::time::Instant::now() + COALESCE_WINDOW;
        while !batch.paths.is_empty() && batch.paths.len() < MAX_BATCH_PATHS {
            let next = tokio::time::timeout_at(deadline, rx.recv()).await;
            match next {
                Ok(Some(ev)) => {
                    let (merged, full) = coalesce(batch, ev);
                    batch = merged;
                    if full {
                        break;
                    }
                }
                // Window closed, or the sender is gone (shutdown).
                Ok(None) | Err(_) => break,
            }
        }

        let still_enabled = match enabled_cache {
            Some((value, at)) if at.elapsed() < SETTINGS_TTL => value,
            _ => {
                let value = komga_enabled(&db).await;
                enabled_cache = Some((value, std::time::Instant::now()));
                value
            }
        };

        if !still_enabled {
            log::debug!("[LibraryEvents] komga_enabled is off; dropping {} path(s).", batch.paths.len());
            continue;
        }

        let events = chunk_event(&batch);
        post_batch(&client, &endpoint, &secret, &events).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(reason: &str, paths: &[&str], series: &[&str]) -> LibraryEvent {
        LibraryEvent {
            reason: reason.to_string(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            series_ids: series.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn coalesce_merges_paths_and_dedupes() {
        let (batch, full) = coalesce(
            ev("import", &["/a/1.cbz", "/a/2.cbz"], &["s1"]),
            ev("import", &["/a/2.cbz", "/a/3.cbz"], &["s1", "s2"]),
        );
        assert_eq!(batch.paths, vec!["/a/1.cbz", "/a/2.cbz", "/a/3.cbz"]);
        assert_eq!(batch.series_ids, vec!["s1", "s2"]);
        assert!(!full);
    }

    #[test]
    fn coalesce_keeps_the_first_reason() {
        let (batch, _) = coalesce(ev("watched-import", &[], &[]), ev("metadata-embed", &[], &[]));
        assert_eq!(batch.reason, "watched-import");
    }

    #[test]
    fn coalesce_reports_full_at_the_cap() {
        let many: Vec<String> = (0..MAX_BATCH_PATHS).map(|i| format!("/a/{}.cbz", i)).collect();
        let (_, full) = coalesce(
            ev("import", &[], &[]),
            LibraryEvent { reason: "import".into(), paths: many, series_ids: vec![] },
        );
        assert!(full, "a batch at the cap must be sent without waiting for the window");
    }

    #[test]
    fn coalesce_does_not_mutate_its_input_order() {
        let (batch, _) = coalesce(ev("x", &["/first"], &[]), ev("y", &["/second"], &[]));
        assert_eq!(batch.paths.first().map(String::as_str), Some("/first"));
    }

    #[test]
    fn chunk_event_leaves_a_small_batch_alone() {
        let chunks = chunk_event(&ev("import", &["/a", "/b"], &["s"]));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["paths"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn chunk_event_splits_an_oversized_batch() {
        let many: Vec<String> = (0..MAX_BATCH_PATHS + 7).map(|i| format!("/a/{}.cbz", i)).collect();
        let chunks = chunk_event(&LibraryEvent {
            reason: "cbr-convert".into(),
            paths: many,
            series_ids: vec!["s1".into()],
        });
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0]["paths"].as_array().map(Vec::len), Some(MAX_BATCH_PATHS));
        assert_eq!(chunks[1]["paths"].as_array().map(Vec::len), Some(7));
    }

    #[test]
    fn komga_enabled_gate_accepts_only_the_exact_true_string() {
        assert!(komga_enabled_value(Some("true")));
        assert!(!komga_enabled_value(Some("false")));
        assert!(!komga_enabled_value(None));
        // Node writes the string; a truthy-looking value must not slip through.
        assert!(!komga_enabled_value(Some("TRUE")));
        assert!(!komga_enabled_value(Some("1")));
        assert!(!komga_enabled_value(Some("")));
    }

    #[test]
    fn payload_shape_matches_the_node_route() {
        let payload = to_payload(&ev("repack", &["/a/1.cbz"], &["s1"]));
        assert_eq!(payload["reason"], "repack");
        assert_eq!(payload["paths"][0], "/a/1.cbz");
        assert_eq!(payload["seriesIds"][0], "s1");
    }

    /// The real HTTP path, against a local stub: proves the endpoint, the secret header and the
    /// body shape are what Node actually receives, and that 202 is treated as success.
    #[tokio::test]
    async fn post_batch_sends_the_expected_request_and_accepts_202() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
        let addr = listener.local_addr().expect("local addr");
        let seen: Arc<OnceLock<String>> = Arc::new(OnceLock::new());

        let server = tokio::spawn({
            let seen = Arc::clone(&seen);
            async move {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                seen.set(String::from_utf8_lossy(&buf[..n]).to_string()).ok();
                socket
                    .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .ok();
            }
        });

        let client = reqwest::Client::builder().timeout(POST_TIMEOUT).build().expect("client");
        post_batch(
            &client,
            &format!("http://{}/api/internal/library-changed", addr),
            "s3cret",
            &[to_payload(&ev("metadata-embed", &["/lib/Series/1.cbz"], &["s1"]))],
        )
        .await;

        server.await.expect("server task");
        // HTTP/1.1 header names are case-insensitive and hyper lowercases them on the wire.
        let request = seen.get().expect("captured request").to_lowercase();
        assert!(request.contains("post /api/internal/library-changed"), "got: {}", request);
        assert!(request.contains("x-internal-secret: s3cret"), "got: {}", request);
        assert!(request.contains("metadata-embed"), "got: {}", request);
        assert!(request.contains("/lib/series/1.cbz"), "got: {}", request);
        // Node's route reads `seriesIds` (camelCase) in the JSON body — not the snake_case the
        // Rust struct field uses.
        assert!(request.contains("\"seriesids\":[\"s1\"]"), "got: {}", request);
    }

    /// A non-2xx must not panic and must not retry a 4xx (a contract bug cannot be fixed by waiting).
    #[tokio::test]
    async fn post_batch_does_not_retry_a_client_error() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind stub");
        let addr = listener.local_addr().expect("local addr");
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let server = tokio::spawn({
            let hits = Arc::clone(&hits);
            async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    let accepted = listener.accept().await;
                    let (mut socket, _) = match accepted { Ok(v) => v, Err(_) => break };
                    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = socket.read(&mut buf).await;
                    let _ = socket
                        .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                        .await;
                }
            }
        });

        let client = reqwest::Client::builder().timeout(POST_TIMEOUT).build().expect("client");
        post_batch(
            &client,
            &format!("http://{}/api/internal/library-changed", addr),
            "s3cret",
            &[to_payload(&ev("repack", &["/a"], &[]))],
        )
        .await;

        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "a 4xx must be attempted exactly once"
        );
        server.abort();
    }
}
