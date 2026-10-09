// Unmatched-series retry sweep + match-confidence policy (discussion #177).
//
// A big tagged-library import used to die at ComicVine's 200/hr wall: everything past the limit
// landed UNMATCHED and NOTHING ever retried it — a 2,700-series migration left 2,000+ series in a
// manual click-Accept queue. This module owns:
//   1. run_unmatched_sweep — a scheduled, budget-aware pass over UNMATCHED series: free file
//      evidence first (series.json comicid / ComicInfo ids — including files tagged AFTER the
//      original scan, or libraries scanned by builds that predate the file-evidence readers),
//      then provider name-search under the admin's confidence mode. Stops BEFORE the rate-limit
//      wall and resumes on the next scheduled run, so libraries finish matching themselves.
//   2. The confidence policy (matcher_mode): how much automation the admin trusts.
//
// matcher_mode values (SystemSetting, default "confirm"):
//   trust   — file IDs auto-apply; name-search matches auto-accept at >= matcher_auto_threshold.
//   confirm — file IDs auto-apply; name-search is left to the Smart Matcher UI (no API burn here).
//   auto    — file IDs auto-apply; name-search auto-accepts only near-exact (>= 0.97 + year agrees).
//   custom  — no automation at all; the admin matches by hand / custom ID.

use crate::db::Db;
use sqlx::Row;

/// Aggregate result of one sweep pass: the human-readable summary for the JobLog, plus the count
/// of series the sweep actually matched (drives "only notify when something happened").
pub struct SweepOutcome {
    pub summary: String,
    pub matched: usize,
}

/// Tier-2 sweep history: one JobLog row per series the sweep actually ACTED on, so "what did the
/// background sweep match, and to what?" is answerable from Job History months later. relatedItem
/// carries the series name (the column reserved for exactly this). Only outcomes are recorded —
/// applied matches and id-collisions that need an admin — never skipped/deferred series, so a
/// 100-series pass writes at most 100 rows and a quiet pass writes none.
struct SweepAudit {
    related_item: String,
    status: &'static str, // COMPLETED (match applied) | FAILED (needs admin attention)
    message: String,
}

/// Flushes the audit rows in one short transaction per chunk (scan-write invariant from issue
/// #183: no I/O between begin and commit; never let audit bookkeeping starve the Node app's
/// writes). Best-effort — the sweep's real work is already committed by this point.
async fn flush_sweep_audit(db: &Db, rows: &[SweepAudit]) {
    for chunk in rows.chunks(100) {
        let mut tx = match db.pool.begin().await {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[Matcher] Could not open the sweep-audit transaction: {:?}", e);
                return;
            }
        };
        for r in chunk {
            if let Err(e) = sqlx::query(&format!(
                r#"INSERT INTO "JobLog" (id, "jobType", status, "durationMs", message, "relatedItem", "createdAt", attempts)
                   VALUES ($1, 'SWEEP_MATCH', $2, 0, $3, $4, {now}, 1)"#,
                now = db.now_expr()
            ))
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(r.status)
            .bind(&r.message)
            .bind(&r.related_item)
            .execute(&mut *tx)
            .await
            {
                log::warn!("[Matcher] Could not write a sweep-audit row for \"{}\": {:?}", r.related_item, e);
            }
        }
        if let Err(e) = tx.commit().await {
            log::warn!("[Matcher] Sweep-audit commit failed ({} row(s) lost): {:?}", chunk.len(), e);
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Persists the structured result of the latest sweep (SystemSetting `last_unmatched_sweep_result`)
/// so the Smart Matcher UI can show what the background sweep did without parsing JobLog messages.
/// Best-effort — a write failure never fails the sweep itself.
pub async fn record_sweep_result(db: &Db, value: serde_json::Value) {
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "SystemSetting" (key, value) VALUES ('last_unmatched_sweep_result', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#,
    )
    .bind(value.to_string())
    .execute(&db.pool)
    .await
    {
        log::warn!("[Matcher] Could not persist the sweep result: {:?}", e);
    }
}

/// One scheduled pass over UNMATCHED series. Returns the human-readable summary for the job log.
/// Budget-aware: free file evidence always runs; API work (issue-id resolution, name search) stops
/// once ComicVine's hourly window nears the wall and RESUMES on the next scheduled run — the fix
/// for "matching just gives up after the rate limit" (discussion #177).
/// The series the automatic sweep is allowed to touch.
///
/// The three OR'd conditions are the historical definition of "not matched yet" — a state of
/// UNMATCHED, no provider id at all, or a placeholder `unmatched_*` id (rows born from a scan).
/// The IGNORED exclusion is the one that needs stating: an admin who marks a series ignored has
/// said "I curated this by hand, stop offering to match it" — but such a series still has a null or
/// placeholder metadataId, so without this clause the very next sweep would pick it up and
/// auto-match it anyway, which is precisely the nagging the state exists to end.
///
/// Stable ordering plus a persisted keyset cursor gives unresolved rows behind the first 100
/// a turn. Cursor values use the same text cast as ordering on both supported DB backends.
pub(crate) fn unmatched_candidates_sql() -> &'static str {
    r#"SELECT id, name, year, "folderPath", CAST("updatedAt" AS TEXT) AS sweep_updated_at FROM "Series"
       WHERE ("matchState" IS NULL OR "matchState" <> 'IGNORED')
         AND ("matchState" = 'UNMATCHED' OR "metadataId" IS NULL OR "metadataId" LIKE 'unmatched%')
       ORDER BY CAST("updatedAt" AS TEXT) ASC, "id" ASC LIMIT 100"#
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SweepCursor {
    updated_at: String,
    id: String,
}

async fn sweep_candidates(db: &Db) -> anyhow::Result<Vec<sqlx::any::AnyRow>> {
    let cursor = sqlx::query_scalar::<_, String>(
        r#"SELECT value FROM "SystemSetting" WHERE key = 'unmatched_sweep_cursor'"#,
    ).fetch_optional(&db.pool).await?.and_then(|s| serde_json::from_str::<SweepCursor>(&s).ok());
    if let Some(cursor) = cursor {
        let sql = unmatched_candidates_sql().replace("ORDER BY", r#"AND (
            CAST("updatedAt" AS TEXT) > $1 OR
            (CAST("updatedAt" AS TEXT) = $1 AND id > $2)) ORDER BY"#);
        let rows = sqlx::query(&sql).bind(cursor.updated_at).bind(cursor.id)
            .fetch_all(&db.pool).await?;
        if !rows.is_empty() { return Ok(rows); }
    }
    // At the end (or after deletions), wrap so earlier unresolved/new rows are retried too.
    Ok(sqlx::query(unmatched_candidates_sql()).fetch_all(&db.pool).await?)
}

pub async fn run_unmatched_sweep(db: Db) -> anyhow::Result<SweepOutcome> {
    let service = std::env::var("OMNIBUS_NODE_URL").or_else(|_| std::env::var("NEXTAUTH_URL")).ok()
        .zip(std::env::var("NEXTAUTH_SECRET").ok())
        .filter(|(_, secret)| !secret.is_empty())
        .map(|(url, secret)| MatchService { url, secret });
    run_unmatched_sweep_at(db, service.as_ref()).await
}

async fn run_unmatched_sweep_at(db: Db, service: Option<&MatchService>) -> anyhow::Result<SweepOutcome> {
    let get_setting = |key: &'static str| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(r#"SELECT value FROM "SystemSetting" WHERE key = $1"#)
                .bind(key)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
        }
    };

    let mode = get_setting("matcher_mode").await.unwrap_or_else(|| "confirm".to_string());
    if mode == "custom" {
        let msg = "[Matcher] matcher_mode=custom — automatic matching disabled; sweep skipped.".to_string();
        log::info!("{}", msg);
        record_sweep_result(&db, serde_json::json!({
            "status": "SKIPPED", "mode": mode, "finishedAt": now_ms(),
        })).await;
        return Ok(SweepOutcome { summary: msg, matched: 0 });
    }


    let rows = sweep_candidates(&db).await?;

    let total = rows.len();
    if total == 0 {
        let msg = "[Matcher] Unmatched sweep: nothing to do.".to_string();
        log::info!("{}", msg);
        record_sweep_result(&db, serde_json::json!({
            "status": "COMPLETED", "mode": mode, "total": 0, "byFile": 0, "bySearch": 0,
            "forAdmin": 0, "deferred": 0, "searches": 0, "finishedAt": now_ms(),
        })).await;
        return Ok(SweepOutcome { summary: msg, matched: 0 });
    }
    log::info!("[Matcher] Unmatched sweep starting: {} series (mode: {}).", total, mode);

    let client = reqwest::Client::new();
    let mut by_file = 0usize;
    let mut by_search = 0usize;
    let mut for_admin = 0usize;
    let mut deferred = 0usize; // budget hit — retried automatically next run
    let mut searches_this_run = 0usize;
    let mut audit: Vec<SweepAudit> = Vec::new(); // Tier-2 history, flushed after the pass

    let mut last_attempted = None;

    for (index, row) in rows.iter().enumerate() {
        if searches_this_run >= 30 {
            // Budget spent before this row was examined: the cursor stays on the previous row so
            // the next run resumes exactly here, and every remaining row counts as deferred.
            deferred += total - index;
            break;
        }
        let sid: String = row.get("id");
        last_attempted = Some(SweepCursor {
            updated_at: row.get("sweep_updated_at"), id: sid.clone(),
        });
        let name: String = row.get("name");
        let remaining = 30 - searches_this_run;
        let response = request_decision(&client, &sid, remaining.min(16), None, service).await;
        match response {
            Ok(decision) => {
                searches_this_run += decision.requests;
                if matches!(decision.status.as_str(), "rate_limited" | "deferred") {
                    deferred += 1;
                    break;
                }
                if let Some((source, id)) = accepted_identity(&decision, remaining) {
                    // Re-read server-owned source/settings fingerprints immediately before apply.
                    let fresh = request_decision(&client, &sid, 0, Some(&decision.fingerprint), service).await;
                    if !matches!(fresh, Ok(ref d) if d.fingerprint == decision.fingerprint && accepted_identity(d, remaining).is_some()) {
                        for_admin += 1;
                        continue;
                    }
                    let embedded = decision.candidates.iter().any(|c| c.exact);
                    let cv_id = if source == "COMICVINE" { id.parse().ok() } else { None };
                    let metron_id = if source == "METRON" { id.parse().ok() } else { None };
                    if apply_match(&db, &sid, &name, &source, &id, cv_id, metron_id, &row.get::<String, _>("sweep_updated_at")).await {
                        if embedded { by_file += 1; } else { by_search += 1; }
                        audit.push(SweepAudit { related_item: name, status: "COMPLETED",
                            message: format!("Matched by shared evidence pipeline → {source} id {id}: {}", decision.reasons.join("; ")) });
                    } else {
                        for_admin += 1;
                        audit.push(SweepAudit { related_item: name, status: "FAILED",
                            message: "Validated match could not be applied (collision or changed/locked source); left for admin review.".to_string() });
                    }
                } else { for_admin += 1; }
            }
            Err(e) => {
                log::warn!("[Matcher] Shared matching service unavailable: {e}; leaving series unchanged.");
                deferred += 1;
                break;
            }
        }
    }

    // Advance only to the last row examined, never past rows skipped by a rate-limit break.
    if let Some(cursor) = last_attempted {
        sqlx::query(r#"INSERT INTO "SystemSetting" (key, value) VALUES ('unmatched_sweep_cursor', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"#)
            .bind(serde_json::to_string(&cursor)?).execute(&db.pool).await?;
    }

    // Tier-2 history lands before the summary so Job History shows the per-series rows the
    // moment the run's own COMPLETED row appears.
    flush_sweep_audit(&db, &audit).await;

    let processed = by_file + by_search + for_admin + deferred;
    let unprocessed = total.saturating_sub(processed);
    let summary = format!(
        "[Matcher] Unmatched sweep complete: {} matched from file metadata, {} auto-matched by search, {} left for the Smart Matcher, {} deferred to the next run (budget){}.",
        by_file, by_search, for_admin, deferred + unprocessed,
        if searches_this_run > 0 { format!(" — {} CV searches used", searches_this_run) } else { String::new() }
    );
    log::info!("{}", summary);
    record_sweep_result(&db, serde_json::json!({
        "status": "COMPLETED", "mode": mode, "total": total, "byFile": by_file, "bySearch": by_search,
        "forAdmin": for_admin, "deferred": deferred + unprocessed, "searches": searches_this_run,
        "finishedAt": now_ms(),
    })).await;
    Ok(SweepOutcome { summary, matched: by_file + by_search })
}

/// Applies a match, guarding the (metadataSource, metadataId) unique — a second series already
/// holding the id is a duplicate the admin must merge, not something to clobber.
#[allow(clippy::too_many_arguments)]
async fn apply_match(db: &Db, series_id: &str, series_name: &str, source: &str, id: &str, cv_id: Option<i32>, metron_id: Option<i32>, updated_at: &str) -> bool {
    let taken: Option<String> = sqlx::query_scalar(
        r#"SELECT id FROM "Series" WHERE "metadataSource" = $1 AND "metadataId" = $2 AND id <> $3"#,
    )
    .bind(source).bind(id).bind(series_id)
    .fetch_optional(&db.pool)
    .await
    .ok()
    .flatten();
    if taken.is_some() {
        log::warn!("[Matcher] \"{}\" resolves to {} id {}, but another series already holds it — leaving unmatched for admin review.", series_name, source, id);
        return false;
    }
    match sqlx::query(
        r#"UPDATE "Series" SET "metadataId" = $1, "metadataSource" = $2, "matchState" = 'MATCHED',
           "cvId" = COALESCE($3, "cvId"), "metronId" = COALESCE($4, "metronId") WHERE id = $5
           AND CAST("updatedAt" AS TEXT) = $6 AND "hasCustomMetadata" = false
           AND ("matchState" IS NULL OR "matchState" <> 'IGNORED')
           AND ("matchState" = 'UNMATCHED' OR "metadataId" IS NULL OR "metadataId" LIKE 'unmatched%')"#,
    )
    .bind(id).bind(source).bind(cv_id).bind(metron_id).bind(series_id).bind(updated_at)
    .execute(&db.pool)
    .await
    {
        Ok(result) if result.rows_affected() == 1 => {
            log::info!("[Matcher] Matched \"{}\" -> {} id {} from embedded file metadata.", series_name, source, id);
            true
        }
        Ok(_) => false,
        Err(e) => {
            log::error!("[Matcher] Failed to apply match for \"{}\": {:?}", series_name, e);
            false
        }
    }
}

// Matching algorithms live in Node's pure smart-match modules. Rust only transports the
// versioned contract and applies a fresh, server-authorized identity without moving files.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchDecision {
    status: String,
    confidence: String,
    safe_to_accept: bool,
    auto_accept: bool,
    fingerprint: String,
    algorithm_version: String,
    #[serde(default)]
    requests: usize,
    selected: Option<MatchIdentity>,
    #[serde(default)]
    candidates: Vec<MatchCandidate>,
    #[serde(default)]
    reasons: Vec<String>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchIdentity { id: String, metadata_source: String }
#[derive(serde::Deserialize)]
struct MatchCandidate { #[serde(default)] exact: bool }

fn accepted_identity(decision: &MatchDecision, remaining: usize) -> Option<(String, String)> {
    if !decision.safe_to_accept || !decision.auto_accept || decision.status != "high"
        || decision.confidence != "high" || decision.algorithm_version != "evidence-1"
        || decision.fingerprint.len() != 64 || decision.requests > remaining || decision.requests > 16 {
        return None;
    }
    let selected = decision.selected.as_ref()?;
    if !matches!(selected.metadata_source.as_str(), "COMICVINE" | "METRON")
        || selected.id.parse::<i32>().ok().filter(|id| *id > 0).is_none() { return None; }
    Some((selected.metadata_source.clone(), selected.id.clone()))
}

struct MatchService { url: String, secret: String }

async fn request_decision(client: &reqwest::Client, series_id: &str, max_requests: usize, expected: Option<&str>, service: Option<&MatchService>) -> anyhow::Result<MatchDecision> {
    // Respect the shared deployment boundary; never guess a localhost service in pure tests.
    let service = service.ok_or_else(|| anyhow::anyhow!("Shared matching URL/secret is not configured"))?;
    let url = format!("{}/api/internal/smart-match", service.url.trim_end_matches('/'));
    let response = client.post(url).header("X-Internal-Secret", &service.secret)
        .timeout(std::time::Duration::from_secs(60))
        .json(&serde_json::json!({ "itemId": series_id, "maxRequests": max_requests, "expectedFingerprint": expected }))
        .send().await?.error_for_status()?;
    Ok(response.json().await?)
}

/// True when the sweep should stop searching to protect the ComicVine budget: calls made in the
/// rolling window have reached `limit - reserve`. Counting is shared with the health check's
/// cv_api_usage accounting.
#[allow(dead_code)] // only the test module calls this after the fork reworked the sweep flow
pub(crate) fn budget_exhausted(calls_last_window: usize, limit: usize, reserve: usize) -> bool {
    calls_last_window + reserve >= limit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unresolved_sweep_advances_through_tied_backlog_and_wraps() {
        sqlx::any::install_default_drivers();
        let pool = sqlx::any::AnyPoolOptions::new().max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };
        sqlx::query(r#"CREATE TABLE "SystemSetting" (key TEXT PRIMARY KEY, value TEXT NOT NULL)"#)
            .execute(&db.pool).await.unwrap();
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, year INTEGER,
            "folderPath" TEXT, "matchState" TEXT, "metadataId" TEXT, "updatedAt" INTEGER)"#)
            .execute(&db.pool).await.unwrap();
        for i in 1..=150 {
            sqlx::query(r#"INSERT INTO "Series" VALUES ($1, 'Unmatched', 2024, '', 'UNMATCHED', NULL, 1000)"#)
                .bind(format!("s{i:03}")).execute(&db.pool).await.unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let service = MatchService { url: format!("http://{}", listener.local_addr().unwrap()), secret: "fixture-secret".to_string() };
        let router = axum::Router::new().route("/api/internal/smart-match", axum::routing::post(|| async {
            axum::Json(serde_json::json!({ "status": "medium", "confidence": "medium", "autoAccept": false,
                "safeToAccept": false, "fingerprint": "a".repeat(64), "algorithmVersion": "evidence-1", "requests": 0, "selected": null }))
        }));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let first = run_unmatched_sweep_at(db.clone(), Some(&service)).await.unwrap();
        assert_eq!(first.matched, 0);
        assert!(first.summary.contains("100 left for the Smart Matcher"));
        let next = sweep_candidates(&db).await.unwrap();
        assert_eq!(next.len(), 50);
        assert_eq!(next[0].get::<String, _>("id"), "s101");
        run_unmatched_sweep_at(db.clone(), Some(&service)).await.unwrap();
        let wrapped = sweep_candidates(&db).await.unwrap();
        assert_eq!(wrapped[0].get::<String, _>("id"), "s001");
        // A malformed cursor from an older build must not prevent a fresh pass.
        sqlx::query(r#"UPDATE "SystemSetting" SET value = 'invalid' WHERE key = 'unmatched_sweep_cursor'"#)
            .execute(&db.pool).await.unwrap();
        assert_eq!(sweep_candidates(&db).await.unwrap().len(), 100);
        server.abort();
    }

    #[tokio::test]
    async fn applying_shared_decision_guards_changed_ignored_locked_and_colliding_rows() {
        sqlx::any::install_default_drivers();
        let pool = sqlx::any::AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };
        sqlx::query(r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, "metadataSource" TEXT, "metadataId" TEXT,
            "matchState" TEXT, "cvId" INTEGER, "metronId" INTEGER, "updatedAt" TEXT, "hasCustomMetadata" BOOLEAN)"#)
            .execute(&db.pool).await.unwrap();
        for (sid, state, locked, metadata) in [("ok", "UNMATCHED", false, None), ("ignored", "IGNORED", false, None),
            ("locked", "UNMATCHED", true, None), ("changed", "UNMATCHED", false, None), ("taken", "MATCHED", false, Some("99"))] {
            sqlx::query(r#"INSERT INTO "Series" VALUES ($1,'COMICVINE',$2,$3,NULL,NULL,'1000',$4)"#)
                .bind(sid).bind(metadata).bind(state).bind(locked).execute(&db.pool).await.unwrap();
        }
        for (sid, stamp, target) in [("ignored", "1000", "1"), ("locked", "1000", "1"), ("changed", "999", "1"), ("ok", "1000", "99")] {
            assert!(!apply_match(&db, sid, "Batman", "COMICVINE", target, Some(1), None, stamp).await);
        }
        assert!(apply_match(&db, "ok", "Batman", "METRON", "7", None, Some(7), "1000").await);
        let row = sqlx::query(r#"SELECT "metadataSource", "metadataId", "matchState" FROM "Series" WHERE id='ok'"#).fetch_one(&db.pool).await.unwrap();
        assert_eq!(row.get::<String, _>("metadataSource"), "METRON");
        assert_eq!(row.get::<String, _>("metadataId"), "7");
        assert_eq!(row.get::<String, _>("matchState"), "MATCHED");
        assert!(!apply_match(&db, "ok", "Batman", "METRON", "8", None, Some(8), "1000").await);
    }

    /// The sweep must leave IGNORED series alone — they still carry a null/placeholder metadataId,
    /// so the pre-IGNORED query would have re-offered them on every run (field report from
    /// robotshavehearts2: hand-curated TPBs ComicVine simply doesn't have).
    #[tokio::test]
    async fn sweep_candidates_skip_ignored_but_keep_every_other_unmatched_shape() {
        let base = std::env::temp_dir().join(format!("omnibus_matchsweep_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("create fixture dir");
        let db_file = base.join("sweep.db");
        std::fs::File::create(&db_file).expect("pre-create sqlite file");
        let db_url = format!("file:{}", db_file.to_string_lossy().replace('\\', "/"));
        let db = crate::db::Db::connect(&db_url, 2).await.expect("connect file-backed sqlite");

        sqlx::query(
            r#"CREATE TABLE "Series" (id TEXT PRIMARY KEY, name TEXT, year INTEGER, "folderPath" TEXT,
               "matchState" TEXT, "metadataId" TEXT, "updatedAt" TEXT)"#,
        )
        .execute(&db.pool).await.expect("create schema");

        for (id, state, meta) in [
            ("s_unmatched", Some("UNMATCHED"), None),
            ("s_null_id", Some("MATCHED"), None),                       // no id yet = still a candidate
            ("s_placeholder", Some("MATCHED"), Some("unmatched_abc")),  // scan-born placeholder id
            ("s_ignored", Some("IGNORED"), None),                       // hand-curated: leave it alone
            ("s_matched", Some("MATCHED"), Some("42821")),
        ] {
            sqlx::query(r#"INSERT INTO "Series" (id, name, year, "folderPath", "matchState", "metadataId", "updatedAt") VALUES ($1, $1, 2024, '/c', $2, $3, '2026-08-27')"#)
                .bind(id).bind(state).bind(meta)
                .execute(&db.pool).await.expect("seed series");
        }

        let rows = sqlx::query(unmatched_candidates_sql()).fetch_all(&db.pool).await.expect("candidates");
        let mut ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        ids.sort();
        assert_eq!(ids, vec!["s_null_id", "s_placeholder", "s_unmatched"]);
        assert!(!ids.contains(&"s_ignored".to_string()), "an ignored series must never be swept");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn shared_contract_refuses_unsafe_old_and_over_budget_decisions() {
        let valid = serde_json::json!({ "status": "high", "confidence": "high", "safeToAccept": true,
            "autoAccept": true, "fingerprint": "a".repeat(64), "algorithmVersion": "evidence-1", "requests": 2,
            "selected": { "id": "123", "metadataSource": "METRON" } });
        let parse = |v| serde_json::from_value::<MatchDecision>(v).unwrap();
        assert_eq!(accepted_identity(&parse(valid.clone()), 30), Some(("METRON".to_string(), "123".to_string())));
        for (field, value) in [("status", serde_json::json!("ambiguous")), ("safeToAccept", serde_json::json!(false)),
            ("algorithmVersion", serde_json::json!("legacy")), ("requests", serde_json::json!(31))] {
            let mut invalid = valid.clone(); invalid[field] = value;
            assert!(accepted_identity(&parse(invalid), 30).is_none());
        }
        assert!(accepted_identity(&parse(valid), 1).is_none());
    }

    #[test]
    fn budget_gate_stops_before_the_wall() {
        // CV allows 200/hr; with a reserve of 30 the sweep stops at 170 calls.
        assert!(!budget_exhausted(0, 200, 30));
        assert!(!budget_exhausted(169, 200, 30));
        assert!(budget_exhausted(170, 200, 30));
        assert!(budget_exhausted(200, 200, 30));
    }

    // ==== Tier-2 sweep history: per-series outcomes must land in JobLog with relatedItem. ====

    #[tokio::test]
    async fn sweep_audit_rows_land_in_joblog_with_related_item() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1) // each :memory: connection is its own DB — keep exactly one
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "JobLog" (id TEXT PRIMARY KEY, "jobType" TEXT, status TEXT, "durationMs" INTEGER, message TEXT, "relatedItem" TEXT, "createdAt" INTEGER, attempts INTEGER)"#)
            .execute(&pool).await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };

        flush_sweep_audit(&db, &[
            SweepAudit {
                related_item: "Saga (2012)".to_string(),
                status: "COMPLETED",
                message: "Matched from embedded file metadata → COMICVINE id 12345 (zero API cost).".to_string(),
            },
            SweepAudit {
                related_item: "Hack/Slash".to_string(),
                status: "FAILED",
                message: "id collision — left for the Smart Matcher.".to_string(),
            },
        ]).await;

        let rows = sqlx::query(r#"SELECT "jobType", status, "relatedItem", message FROM "JobLog" ORDER BY "relatedItem""#)
            .fetch_all(&db.pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        // Alphabetical: "Hack/Slash" sorts before "Saga (2012)".
        assert_eq!(rows[0].get::<String, _>("jobType"), "SWEEP_MATCH");
        assert_eq!(rows[0].get::<String, _>("status"), "FAILED");
        assert_eq!(rows[0].get::<String, _>("relatedItem"), "Hack/Slash");
        assert_eq!(rows[1].get::<String, _>("jobType"), "SWEEP_MATCH");
        assert_eq!(rows[1].get::<String, _>("status"), "COMPLETED");
        assert_eq!(rows[1].get::<String, _>("relatedItem"), "Saga (2012)");
        assert!(rows[1].get::<String, _>("message").contains("COMICVINE id 12345"));
    }

    #[tokio::test]
    async fn sweep_audit_flush_with_no_rows_writes_nothing() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(sqlx::any::install_default_drivers);
        let pool = sqlx::any::AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:").await.unwrap();
        sqlx::query(r#"CREATE TABLE "JobLog" (id TEXT PRIMARY KEY, "jobType" TEXT, status TEXT, "durationMs" INTEGER, message TEXT, "relatedItem" TEXT, "createdAt" INTEGER, attempts INTEGER)"#)
            .execute(&pool).await.unwrap();
        let db = Db { pool, dialect: crate::db::Dialect::Sqlite };

        flush_sweep_audit(&db, &[]).await;

        let n: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM "JobLog""#)
            .fetch_one(&db.pool).await.unwrap();
        assert_eq!(n, 0, "a quiet sweep must not write audit rows");
    }
}
