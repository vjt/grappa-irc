# grappa walking-skeleton — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user grappa server that connects to one upstream IRC network, persists scrollback to sqlite, and exposes the minimum REST+SSE surface the cicchetto PWA will need for a round-trip `PRIVMSG`.

**Architecture:** Rust binary with `tokio`-per-user session tasks and `axum` for the HTTP/SSE surface. Upstream IRC via the `irc` crate (pure SASL + `CAP LS`, no IRCv3 extensions assumed). Scrollback in `sqlx`-managed sqlite with monotonic `server_time`-indexed rows, so that a future `CHATHISTORY` facade is a mechanical translation rather than a schema redesign. Auth is deferred to Phase 2 — this phase hardcodes one user + one network from a TOML config file.

**Tech Stack:** Rust (stable), `tokio`, `axum`, `tower-http`, `sqlx` (sqlite), `irc` crate, `serde`, `serde_json`, `tracing`, `tracing-subscriber`, `config` crate (TOML), `anyhow`/`thiserror`. Test stack: `cargo test` + `axum::test`/`tower::ServiceExt` + in-memory sqlite.

---

## Scope

**In scope (this plan):**
- Single-binary `grappa` server.
- TOML config for one hardcoded user + one upstream network (host, port, TLS on/off, nick, optional SASL password).
- One async `UserSession` task per configured user, owning the upstream IRC connection.
- sqlite-backed scrollback with a schema that supports paginated reads keyed by `(channel, server_time DESC)`.
- REST: `GET /networks`, `GET /networks/:net/channels`, `POST /networks/:net/channels` (JOIN), `DELETE /networks/:net/channels/:chan` (PART), `GET /networks/:net/channels/:chan/messages?before=<ts>&limit=N`, `POST /networks/:net/channels/:chan/messages`.
- SSE: `GET /events` streaming typed JSON for `message`, `join`, `part`, `quit`, `nick`.
- Tracing logs to stderr in structured format.
- `cargo test` covers: scrollback pagination, REST handlers (with in-memory DB), event serialisation, TOML config parsing.

**Out of scope (deferred to later phases):**
- Authentication (any). Phase 2.
- NickServ registration proxy. Phase 2.
- Multi-user isolation. Phase 2.
- The cicchetto PWA. Phase 3.
- The IRCv3 listener facade. Phase 6.
- Reconnect/backoff hardening beyond "crash loudly on disconnect". Phase 5.

---

## File Structure

```
grappa-irc/
├── Cargo.toml                  # workspace root
├── Cargo.lock
├── server/                     # the grappa binary
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs             # binary entrypoint — parse config, spin up tasks, mount axum router
│   │   ├── config.rs           # TOML parsing + validation (serde derive)
│   │   ├── db/
│   │   │   ├── mod.rs          # sqlx pool setup + migration runner
│   │   │   ├── migrations/
│   │   │   │   └── 0001_init.sql
│   │   │   └── scrollback.rs   # insert_message, fetch_messages(channel, before, limit)
│   │   ├── session/
│   │   │   ├── mod.rs          # UserSession: tokio task owning an upstream IRC connection
│   │   │   └── dispatch.rs     # parse upstream IRC frames → domain events + scrollback writes
│   │   ├── api/
│   │   │   ├── mod.rs          # axum Router assembly
│   │   │   ├── networks.rs     # /networks handlers
│   │   │   ├── channels.rs     # /networks/:net/channels handlers
│   │   │   ├── messages.rs     # /networks/:net/channels/:chan/messages handlers
│   │   │   └── events.rs       # SSE stream handler
│   │   ├── types.rs            # shared domain types (Message, Event, Network, Channel)
│   │   └── state.rs            # AppState (db pool + session handles + event broadcaster)
│   └── tests/
│       ├── config.rs
│       ├── scrollback.rs
│       ├── api_messages.rs
│       ├── api_channels.rs
│       └── events.rs
└── docs/
    ├── DESIGN_NOTES.md         # (already written)
    └── plans/
        └── 2026-04-24-walking-skeleton.md  # this file
```

Rationale for the split:

- `config` / `db` / `session` / `api` are the four concerns; each becomes a module.
- One handler file per REST resource — keeps each file ≤150 lines.
- `types.rs` + `state.rs` at the root of `server/src/` so every module can share them without a cyclic-import dance.
- `tests/` at the crate root (integration-style). Unit tests stay in-module via `#[cfg(test)]` where relevant.

---

## Task 0: Repository bootstrap

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `server/Cargo.toml`
- Create: `server/src/main.rs`
- Create: `.gitignore` (append)
- Create: `rust-toolchain.toml`

- [ ] **Step 1: Write workspace `Cargo.toml`**

```toml
[workspace]
members = ["server"]
resolver = "2"

[workspace.package]
edition = "2021"
rust-version = "1.82"
license = "MIT"
repository = "https://github.com/vjt/grappa-irc"
```

- [ ] **Step 2: Write `server/Cargo.toml`**

```toml
[package]
name = "grappa"
version = "0.0.1"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true
description = "Persistent IRC session server with REST+SSE API"

[dependencies]
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["macros"] }
tower = "0.5"
tower-http = { version = "0.5", features = ["trace", "cors"] }
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "migrate", "chrono"] }
irc = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
config = { version = "0.14", features = ["toml"] }
anyhow = "1"
thiserror = "2"
chrono = { version = "0.4", features = ["serde"] }
futures = "0.3"
async-stream = "0.3"
tokio-stream = "0.1"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
tempfile = "3"
```

- [ ] **Step 3: Write minimal `server/src/main.rs`**

```rust
fn main() {
    println!("grappa pre-alpha");
}
```

- [ ] **Step 4: Write `rust-toolchain.toml`**

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

- [ ] **Step 5: Append to `.gitignore`**

```
target/
*.db
*.db-journal
config.toml
```

- [ ] **Step 6: Verify it builds**

Run: `cargo build`
Expected: clean build, produces `target/debug/grappa`.

Run: `cargo run -p grappa`
Expected: prints `grappa pre-alpha`.

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock server/ rust-toolchain.toml .gitignore
git commit -m "server: bootstrap grappa crate (workspace + dependencies)"
```

---

## Task 1: TOML config parser

**Files:**
- Create: `server/src/config.rs`
- Modify: `server/src/main.rs` (wire module)
- Test: `server/tests/config.rs`

- [ ] **Step 1: Write the failing integration test**

Create `server/tests/config.rs`:

```rust
use grappa::config::Config;
use tempfile::NamedTempFile;
use std::io::Write;

fn write_toml(contents: &str) -> NamedTempFile {
    let mut f = NamedTempFile::new().unwrap();
    f.write_all(contents.as_bytes()).unwrap();
    f
}

#[test]
fn parses_minimal_config() {
    let f = write_toml(r#"
[server]
listen = "127.0.0.1:8080"
database_url = "sqlite::memory:"

[[users]]
name = "vjt"

[[users.networks]]
id = "azzurra"
host = "irc.azzurra.chat"
port = 6697
tls = true
nick = "vjt-claude"
"#);

    let cfg = Config::from_path(f.path()).expect("parses");
    assert_eq!(cfg.server.listen, "127.0.0.1:8080");
    assert_eq!(cfg.users.len(), 1);
    assert_eq!(cfg.users[0].name, "vjt");
    assert_eq!(cfg.users[0].networks[0].id, "azzurra");
    assert_eq!(cfg.users[0].networks[0].port, 6697);
    assert!(cfg.users[0].networks[0].tls);
}

#[test]
fn rejects_missing_required_fields() {
    let f = write_toml(r#"
[server]
listen = "127.0.0.1:8080"
"#);
    let err = Config::from_path(f.path()).unwrap_err();
    assert!(format!("{err:#}").to_lowercase().contains("database_url")
         || format!("{err:#}").to_lowercase().contains("missing"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p grappa --test config`
Expected: FAIL (module `grappa::config` does not exist).

- [ ] **Step 3: Write `server/src/config.rs`**

```rust
use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    #[serde(default)]
    pub users: Vec<UserConfig>,
}

#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    pub listen: String,
    pub database_url: String,
}

#[derive(Debug, Deserialize)]
pub struct UserConfig {
    pub name: String,
    #[serde(default)]
    pub networks: Vec<NetworkConfig>,
}

#[derive(Debug, Deserialize)]
pub struct NetworkConfig {
    pub id: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub tls: bool,
    pub nick: String,
    #[serde(default)]
    pub sasl_password: Option<String>,
    #[serde(default)]
    pub autojoin: Vec<String>,
}

impl Config {
    pub fn from_path(path: &Path) -> Result<Self> {
        let cfg = ::config::Config::builder()
            .add_source(::config::File::from(path))
            .build()
            .with_context(|| format!("loading config from {}", path.display()))?;
        cfg.try_deserialize::<Config>()
            .with_context(|| "deserialising config")
    }
}
```

- [ ] **Step 4: Make the crate a library + binary**

Edit `server/Cargo.toml`, add under `[package]`:

```toml
[lib]
name = "grappa"
path = "src/lib.rs"

[[bin]]
name = "grappa"
path = "src/main.rs"
```

Create `server/src/lib.rs`:

```rust
pub mod config;
```

Update `server/src/main.rs`:

```rust
use anyhow::Result;
use grappa::config::Config;
use std::path::PathBuf;

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());
    let cfg = Config::from_path(&PathBuf::from(&path))?;
    println!("loaded {} users", cfg.users.len());
    Ok(())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p grappa --test config`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add server/Cargo.toml server/src/lib.rs server/src/main.rs server/src/config.rs server/tests/config.rs Cargo.lock
git commit -m "config: TOML loader with server + users + networks shape"
```

---

## Task 2: sqlite schema + migration

**Files:**
- Create: `server/src/db/mod.rs`
- Create: `server/src/db/migrations/0001_init.sql`
- Modify: `server/src/lib.rs`

- [ ] **Step 1: Write the migration**

Create `server/src/db/migrations/0001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS networks (
    id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    tls INTEGER NOT NULL,
    nick TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
    network_id TEXT NOT NULL REFERENCES networks(id),
    name TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (network_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    server_time INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_time
    ON messages(network_id, channel, server_time DESC);
```

- [ ] **Step 2: Write the failing pool test**

Create `server/tests/db_pool.rs`:

```rust
use grappa::db;

#[tokio::test]
async fn creates_schema_and_applies_migrations() {
    let pool = db::connect("sqlite::memory:").await.expect("connect");
    // Sanity check: inserting into messages must work.
    sqlx::query(
        "INSERT INTO messages (network_id, channel, server_time, kind, sender, body)
         VALUES ('azzurra', '#sniffo', 0, 'privmsg', 'vjt', 'ciao')"
    )
    .execute(&pool)
    .await
    .expect("insert");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages")
        .fetch_one(&pool)
        .await
        .expect("select");
    assert_eq!(count, 1);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test -p grappa --test db_pool`
Expected: FAIL (`grappa::db` does not exist).

- [ ] **Step 4: Implement `server/src/db/mod.rs`**

```rust
use anyhow::{Context, Result};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

pub async fn connect(url: &str) -> Result<SqlitePool> {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename_or_memory(url)?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .context("opening sqlite pool")?;
    sqlx::migrate!("src/db/migrations")
        .run(&pool)
        .await
        .context("running migrations")?;
    Ok(pool)
}

// Helper: sqlx's SqliteConnectOptions::from_str handles "sqlite::memory:"
// and file paths uniformly; wrap it so callers can pass either.
trait FilenameOrMemory {
    fn filename_or_memory(self, url: &str) -> Result<sqlx::sqlite::SqliteConnectOptions>;
}
impl FilenameOrMemory for sqlx::sqlite::SqliteConnectOptions {
    fn filename_or_memory(self, url: &str) -> Result<sqlx::sqlite::SqliteConnectOptions> {
        use std::str::FromStr;
        Ok(sqlx::sqlite::SqliteConnectOptions::from_str(url)?)
    }
}

pub mod scrollback;
```

- [ ] **Step 5: Wire module in `lib.rs`**

```rust
pub mod config;
pub mod db;
```

- [ ] **Step 6: Stub `server/src/db/scrollback.rs`**

```rust
// populated in Task 3
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cargo test -p grappa --test db_pool`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/ server/src/lib.rs server/tests/db_pool.rs Cargo.lock
git commit -m "db: sqlite schema + migrations for networks/channels/messages"
```

---

## Task 3: Scrollback insert + paginated fetch

**Files:**
- Modify: `server/src/db/scrollback.rs`
- Modify: `server/src/types.rs` (create)
- Test: `server/tests/scrollback.rs`

- [ ] **Step 1: Create `server/src/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub id: i64,
    pub network_id: String,
    pub channel: String,
    pub server_time: i64, // millis since epoch
    pub kind: String,     // "privmsg" | "notice" | "action"
    pub sender: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewMessage {
    pub network_id: String,
    pub channel: String,
    pub server_time: i64,
    pub kind: String,
    pub sender: String,
    pub body: String,
}
```

Wire it in `lib.rs`:

```rust
pub mod config;
pub mod db;
pub mod types;
```

- [ ] **Step 2: Write the failing test**

Create `server/tests/scrollback.rs`:

```rust
use grappa::db;
use grappa::db::scrollback;
use grappa::types::NewMessage;

async fn pool() -> sqlx::SqlitePool {
    db::connect("sqlite::memory:").await.unwrap()
}

fn sample(i: i64) -> NewMessage {
    NewMessage {
        network_id: "azzurra".into(),
        channel: "#sniffo".into(),
        server_time: i,
        kind: "privmsg".into(),
        sender: "vjt".into(),
        body: format!("msg {i}"),
    }
}

#[tokio::test]
async fn insert_and_fetch_latest_page() {
    let pool = pool().await;
    for i in 0..5 {
        scrollback::insert(&pool, &sample(i)).await.unwrap();
    }
    let page = scrollback::fetch(&pool, "azzurra", "#sniffo", None, 3)
        .await
        .unwrap();
    assert_eq!(page.len(), 3);
    assert_eq!(page[0].body, "msg 4");
    assert_eq!(page[2].body, "msg 2");
}

#[tokio::test]
async fn pagination_by_before_cursor() {
    let pool = pool().await;
    for i in 0..5 {
        scrollback::insert(&pool, &sample(i)).await.unwrap();
    }
    let first = scrollback::fetch(&pool, "azzurra", "#sniffo", None, 2)
        .await
        .unwrap();
    let before = first.last().unwrap().server_time;
    let second = scrollback::fetch(&pool, "azzurra", "#sniffo", Some(before), 2)
        .await
        .unwrap();
    assert_eq!(second.len(), 2);
    assert_eq!(second[0].body, "msg 2");
    assert_eq!(second[1].body, "msg 1");
}

#[tokio::test]
async fn isolates_by_channel() {
    let pool = pool().await;
    let mut a = sample(0);
    a.channel = "#a".into();
    let mut b = sample(1);
    b.channel = "#b".into();
    scrollback::insert(&pool, &a).await.unwrap();
    scrollback::insert(&pool, &b).await.unwrap();
    let page = scrollback::fetch(&pool, "azzurra", "#a", None, 10)
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].channel, "#a");
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p grappa --test scrollback`
Expected: FAIL (functions do not exist).

- [ ] **Step 4: Implement `server/src/db/scrollback.rs`**

```rust
use anyhow::Result;
use sqlx::SqlitePool;

use crate::types::{Message, NewMessage};

pub async fn insert(pool: &SqlitePool, m: &NewMessage) -> Result<i64> {
    let rec = sqlx::query!(
        r#"INSERT INTO messages (network_id, channel, server_time, kind, sender, body)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING id"#,
        m.network_id,
        m.channel,
        m.server_time,
        m.kind,
        m.sender,
        m.body,
    )
    .fetch_one(pool)
    .await?;
    Ok(rec.id)
}

pub async fn fetch(
    pool: &SqlitePool,
    network_id: &str,
    channel: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    let limit = limit.clamp(1, 500);
    let rows = match before {
        Some(cursor) => sqlx::query_as!(
            Message,
            r#"SELECT id as "id!: i64", network_id, channel, server_time as "server_time!: i64",
                      kind, sender, body
               FROM messages
               WHERE network_id = ? AND channel = ? AND server_time < ?
               ORDER BY server_time DESC, id DESC
               LIMIT ?"#,
            network_id,
            channel,
            cursor,
            limit,
        )
        .fetch_all(pool)
        .await?,
        None => sqlx::query_as!(
            Message,
            r#"SELECT id as "id!: i64", network_id, channel, server_time as "server_time!: i64",
                      kind, sender, body
               FROM messages
               WHERE network_id = ? AND channel = ?
               ORDER BY server_time DESC, id DESC
               LIMIT ?"#,
            network_id,
            channel,
            limit,
        )
        .fetch_all(pool)
        .await?,
    };
    Ok(rows)
}
```

Note: `sqlx::query!` / `query_as!` require `DATABASE_URL` at compile time for offline checks, or an online DB during compile. For this phase use `SQLX_OFFLINE=false` + a one-off `cargo sqlx prepare` against an in-memory DB; or swap to `sqlx::query` (runtime-checked) if offline mode bites. Document the choice in `server/README.md` when we get there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p grappa --test scrollback`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add server/src/db/scrollback.rs server/src/types.rs server/src/lib.rs server/tests/scrollback.rs
git commit -m "scrollback: insert + paginated fetch by (channel, server_time)"
```

---

## Task 4: AppState + axum router skeleton

**Files:**
- Create: `server/src/state.rs`
- Create: `server/src/api/mod.rs`
- Modify: `server/src/lib.rs`, `server/src/main.rs`

- [ ] **Step 1: Write the failing smoke test**

Create `server/tests/api_smoke.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use grappa::api;
use grappa::db;
use grappa::state::AppState;
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_returns_200() {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(pool);
    let app = api::router(state);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ok");
}
```

- [ ] **Step 2: Run test — verify FAIL**

Run: `cargo test -p grappa --test api_smoke`
Expected: FAIL.

- [ ] **Step 3: Implement `server/src/state.rs`**

```rust
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::types::Message;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub db: SqlitePool,
    pub events: broadcast::Sender<Event>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Message(Message),
    Join { network: String, channel: String, nick: String },
    Part { network: String, channel: String, nick: String },
    Quit { network: String, nick: String, reason: Option<String> },
    Nick { network: String, old: String, new: String },
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self(Arc::new(Inner { db, events }))
    }
}
```

- [ ] **Step 4: Implement `server/src/api/mod.rs`**

```rust
use axum::{routing::get, Router};

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
}
```

Wire in `lib.rs`:

```rust
pub mod api;
pub mod config;
pub mod db;
pub mod state;
pub mod types;
```

- [ ] **Step 5: Run test — verify PASS**

Run: `cargo test -p grappa --test api_smoke`
Expected: PASS.

- [ ] **Step 6: Bind in main.rs**

```rust
use anyhow::Result;
use grappa::{api, config::Config, db, state::AppState};
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,grappa=debug")))
        .init();

    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "config.toml".to_string());
    let cfg = Config::from_path(&PathBuf::from(&path))?;
    tracing::info!(users = cfg.users.len(), "loaded config");

    let pool = db::connect(&cfg.server.database_url).await?;
    let state = AppState::new(pool);
    let app = api::router(state);

    let listener = tokio::net::TcpListener::bind(&cfg.server.listen).await?;
    tracing::info!(listen = %cfg.server.listen, "grappa listening");
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] **Step 7: Manual smoke**

```bash
cat > /tmp/grappa.toml <<EOF
[server]
listen = "127.0.0.1:8080"
database_url = "sqlite:/tmp/grappa.db"
EOF
cargo run -p grappa -- /tmp/grappa.toml &
sleep 1
curl -sS http://127.0.0.1:8080/healthz
# → ok
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add server/src/state.rs server/src/api/ server/src/lib.rs server/src/main.rs server/tests/api_smoke.rs
git commit -m "api: axum router skeleton + AppState + /healthz"
```

---

## Task 5: GET /networks/:net/channels/:chan/messages

**Files:**
- Create: `server/src/api/messages.rs`
- Modify: `server/src/api/mod.rs`
- Test: `server/tests/api_messages.rs`

- [ ] **Step 1: Write the failing test**

Create `server/tests/api_messages.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use grappa::api;
use grappa::db;
use grappa::db::scrollback;
use grappa::state::AppState;
use grappa::types::{Message, NewMessage};
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn app_with_seed() -> (axum::Router, ()) {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    for i in 0..5 {
        scrollback::insert(
            &pool,
            &NewMessage {
                network_id: "azzurra".into(),
                channel: "#sniffo".into(),
                server_time: i,
                kind: "privmsg".into(),
                sender: "vjt".into(),
                body: format!("m{i}"),
            },
        )
        .await
        .unwrap();
    }
    let state = AppState::new(pool);
    (api::router(state), ())
}

#[tokio::test]
async fn returns_latest_page_in_descending_order() {
    let (app, _) = app_with_seed().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/networks/azzurra/channels/%23sniffo/messages?limit=3")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let page: Vec<Message> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page.len(), 3);
    assert_eq!(page[0].body, "m4");
    assert_eq!(page[2].body, "m2");
}

#[tokio::test]
async fn paginates_with_before_cursor() {
    let (app, _) = app_with_seed().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/networks/azzurra/channels/%23sniffo/messages?before=3&limit=2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let page: Vec<Message> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].body, "m2");
    assert_eq!(page[1].body, "m1");
}
```

- [ ] **Step 2: Run — FAIL**

Run: `cargo test -p grappa --test api_messages`
Expected: FAIL (route not mounted).

- [ ] **Step 3: Implement `server/src/api/messages.rs`**

```rust
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::{db::scrollback, state::AppState};

#[derive(Deserialize)]
pub struct Pagination {
    pub before: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    Path((network, channel)): Path<(String, String)>,
    Query(q): Query<Pagination>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(50);
    match scrollback::fetch(&state.0.db, &network, &channel, q.before, limit).await {
        Ok(page) => Json(page).into_response(),
        Err(e) => {
            tracing::error!(?e, "scrollback fetch failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}
```

- [ ] **Step 4: Mount in `api/mod.rs`**

```rust
use axum::{routing::get, Router};

use crate::state::AppState;

pub mod messages;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/networks/:network/channels/:channel/messages",
            get(messages::list),
        )
        .with_state(state)
}
```

- [ ] **Step 5: Run — PASS**

Run: `cargo test -p grappa --test api_messages`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add server/src/api/ server/tests/api_messages.rs
git commit -m "api: GET /networks/:net/channels/:chan/messages (paginated)"
```

---

## Task 6: POST /networks/:net/channels/:chan/messages (stub — writes to scrollback, no upstream yet)

**Files:**
- Modify: `server/src/api/messages.rs`, `server/src/api/mod.rs`
- Test: `server/tests/api_messages.rs` (append)

- [ ] **Step 1: Append test to `server/tests/api_messages.rs`**

```rust
#[tokio::test]
async fn post_stores_message_and_echoes_back() {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(pool);
    let app = api::router(state);

    let payload = serde_json::json!({ "body": "ciao raga" });
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/networks/azzurra/channels/%23sniffo/messages")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let stored: Message = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(stored.body, "ciao raga");
    assert_eq!(stored.channel, "#sniffo");
    assert_eq!(stored.kind, "privmsg");
}
```

- [ ] **Step 2: Run — FAIL**

Run: `cargo test -p grappa --test api_messages post_stores_message_and_echoes_back`
Expected: FAIL (405 or 404).

- [ ] **Step 3: Add handler in `server/src/api/messages.rs`**

```rust
#[derive(serde::Deserialize)]
pub struct PostBody {
    pub body: String,
}

pub async fn post(
    State(state): State<AppState>,
    Path((network, channel)): Path<(String, String)>,
    Json(req): Json<PostBody>,
) -> impl IntoResponse {
    let server_time = chrono::Utc::now().timestamp_millis();
    let nm = crate::types::NewMessage {
        network_id: network.clone(),
        channel: channel.clone(),
        server_time,
        kind: "privmsg".into(),
        sender: "<local>".into(), // Phase 2 replaces with authenticated user's nick
        body: req.body,
    };
    match scrollback::insert(&state.0.db, &nm).await {
        Ok(id) => {
            let stored = crate::types::Message {
                id,
                network_id: nm.network_id,
                channel: nm.channel,
                server_time: nm.server_time,
                kind: nm.kind,
                sender: nm.sender,
                body: nm.body,
            };
            let _ = state.0.events.send(crate::state::Event::Message(stored.clone()));
            (StatusCode::CREATED, Json(stored)).into_response()
        }
        Err(e) => {
            tracing::error!(?e, "scrollback insert failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}
```

- [ ] **Step 4: Wire route**

In `api/mod.rs`:

```rust
.route(
    "/networks/:network/channels/:channel/messages",
    get(messages::list).post(messages::post),
)
```

- [ ] **Step 5: Run — PASS**

Run: `cargo test -p grappa --test api_messages`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add server/src/api/ server/tests/api_messages.rs
git commit -m "api: POST /networks/:net/channels/:chan/messages (local echo, no upstream)"
```

---

## Task 7: SSE /events

**Files:**
- Create: `server/src/api/events.rs`
- Modify: `server/src/api/mod.rs`
- Test: `server/tests/api_events.rs`

- [ ] **Step 1: Write the failing test**

Create `server/tests/api_events.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use grappa::{api, db, state::{AppState, Event}, types::{Message, NewMessage}};
use http_body_util::BodyExt;
use tower::ServiceExt;
use tokio::time::{sleep, Duration};

#[tokio::test]
async fn events_stream_receives_broadcast_message() {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(pool);
    let sender = state.0.events.clone();

    let app = api::router(state);

    // Fire the event shortly after subscription.
    tokio::spawn(async move {
        sleep(Duration::from_millis(50)).await;
        let _ = sender.send(Event::Message(Message {
            id: 1,
            network_id: "azzurra".into(),
            channel: "#sniffo".into(),
            server_time: 1,
            kind: "privmsg".into(),
            sender: "vjt".into(),
            body: "hello".into(),
        }));
    });

    let res = app
        .oneshot(
            Request::builder()
                .uri("/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let content_type = res.headers().get("content-type").unwrap().to_str().unwrap();
    assert!(content_type.contains("text/event-stream"));

    // Read until we see one data frame, then drop.
    let mut body = res.into_body();
    let mut buf = Vec::new();
    while buf.len() < 64 {
        let chunk = body.frame().await.expect("frame").unwrap();
        if let Some(data) = chunk.data_ref() {
            buf.extend_from_slice(data);
        }
        if std::str::from_utf8(&buf).unwrap_or("").contains("\"body\":\"hello\"") {
            return;
        }
    }
    panic!("did not receive expected event: {}", String::from_utf8_lossy(&buf));
}
```

- [ ] **Step 2: Run — FAIL**

Run: `cargo test -p grappa --test api_events`
Expected: FAIL (route not present).

- [ ] **Step 3: Implement `server/src/api/events.rs`**

```rust
use axum::{
    extract::State,
    response::sse::{Event as SseEvent, KeepAlive, Sse},
};
use futures::stream::Stream;
use std::{convert::Infallible, time::Duration};
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

use crate::state::AppState;

pub async fn stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = state.0.events.subscribe();
    let s = BroadcastStream::new(rx).filter_map(|res| match res {
        Ok(evt) => {
            let json = serde_json::to_string(&evt).ok()?;
            Some(Ok(SseEvent::default().data(json)))
        }
        // Lagged receiver — client too slow. Skip; client will catch up via /messages.
        Err(_) => None,
    });
    Sse::new(s).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
```

- [ ] **Step 4: Wire in `api/mod.rs`**

```rust
pub mod events;
// ...
.route("/events", get(events::stream))
```

- [ ] **Step 5: Run — PASS**

Run: `cargo test -p grappa --test api_events`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/ server/tests/api_events.rs
git commit -m "api: GET /events SSE stream of typed domain events"
```

---

## Task 8: UserSession task — upstream IRC round-trip

**Files:**
- Create: `server/src/session/mod.rs`, `server/src/session/dispatch.rs`
- Modify: `server/src/main.rs`, `server/src/lib.rs`
- Test: `server/tests/session_dispatch.rs`

This task wires upstream IRC. The unit test covers the *dispatch* logic (parsed IRC → domain events + scrollback writes) using constructed `irc::proto::Message` values; it does **not** start a real TCP connection. An end-to-end test against a real ircd is a separate, manual smoke in Step 8.

- [ ] **Step 1: Write failing dispatch test**

Create `server/tests/session_dispatch.rs`:

```rust
use grappa::{db, session::dispatch, state::{AppState, Event}};
use grappa::db::scrollback;
use irc::proto::{Command, Message as IrcMessage, Prefix};
use tokio::sync::broadcast;

#[tokio::test]
async fn privmsg_persisted_and_broadcast() {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(pool.clone());
    let mut rx = state.0.events.subscribe();

    let msg = IrcMessage {
        tags: None,
        prefix: Some(Prefix::Nickname("vjt".into(), "~vjt".into(), "host".into())),
        command: Command::PRIVMSG("#sniffo".into(), "ciao raga".into()),
    };

    dispatch::handle(&state, "azzurra", &msg).await.unwrap();

    let page = scrollback::fetch(&pool, "azzurra", "#sniffo", None, 10).await.unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].sender, "vjt");
    assert_eq!(page[0].body, "ciao raga");
    assert_eq!(page[0].kind, "privmsg");

    let evt = tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv())
        .await
        .unwrap()
        .unwrap();
    matches!(evt, Event::Message(_));
}

#[tokio::test]
async fn join_emits_event() {
    let pool = db::connect("sqlite::memory:").await.unwrap();
    let state = AppState::new(pool);
    let mut rx = state.0.events.subscribe();

    let msg = IrcMessage {
        tags: None,
        prefix: Some(Prefix::Nickname("nex".into(), "~nex".into(), "host".into())),
        command: Command::JOIN("#sniffo".into(), None, None),
    };
    dispatch::handle(&state, "azzurra", &msg).await.unwrap();

    let evt = rx.recv().await.unwrap();
    match evt {
        Event::Join { network, channel, nick } => {
            assert_eq!(network, "azzurra");
            assert_eq!(channel, "#sniffo");
            assert_eq!(nick, "nex");
        }
        _ => panic!("expected Join"),
    }
}
```

- [ ] **Step 2: Run — FAIL**

Run: `cargo test -p grappa --test session_dispatch`
Expected: FAIL (`session::dispatch` does not exist).

- [ ] **Step 3: Implement `server/src/session/mod.rs` (shell)**

```rust
pub mod dispatch;

use anyhow::Result;
use irc::client::prelude::*;
use tokio::task::JoinHandle;

use crate::{config::NetworkConfig, state::AppState};

pub fn spawn(state: AppState, net: NetworkConfig) -> JoinHandle<Result<()>> {
    tokio::spawn(async move {
        let cfg = Config {
            nickname: Some(net.nick.clone()),
            server: Some(net.host.clone()),
            port: Some(net.port),
            use_tls: Some(net.tls),
            password: net.sasl_password.clone(),
            channels: net.autojoin.clone(),
            ..Default::default()
        };
        let mut client = Client::from_config(cfg).await?;
        client.identify()?;
        let mut stream = client.stream()?;
        while let Some(msg) = stream.next().await.transpose()? {
            if let Err(e) = dispatch::handle(&state, &net.id, &msg).await {
                tracing::warn!(?e, "dispatch error");
            }
        }
        Ok(())
    })
}
```

- [ ] **Step 4: Implement `server/src/session/dispatch.rs`**

```rust
use anyhow::Result;
use irc::proto::{Command, Message, Prefix};

use crate::{
    db::scrollback,
    state::{AppState, Event},
    types::NewMessage,
};

fn nick_of(prefix: &Option<Prefix>) -> String {
    match prefix {
        Some(Prefix::Nickname(n, _, _)) => n.clone(),
        Some(Prefix::ServerName(s)) => s.clone(),
        None => "*".into(),
    }
}

pub async fn handle(state: &AppState, network: &str, msg: &Message) -> Result<()> {
    match &msg.command {
        Command::PRIVMSG(target, body) => {
            let sender = nick_of(&msg.prefix);
            let nm = NewMessage {
                network_id: network.into(),
                channel: target.clone(),
                server_time: chrono::Utc::now().timestamp_millis(),
                kind: "privmsg".into(),
                sender,
                body: body.clone(),
            };
            let id = scrollback::insert(&state.0.db, &nm).await?;
            let stored = crate::types::Message {
                id,
                network_id: nm.network_id,
                channel: nm.channel,
                server_time: nm.server_time,
                kind: nm.kind,
                sender: nm.sender,
                body: nm.body,
            };
            let _ = state.0.events.send(Event::Message(stored));
        }
        Command::JOIN(chan, _, _) => {
            let _ = state.0.events.send(Event::Join {
                network: network.into(),
                channel: chan.clone(),
                nick: nick_of(&msg.prefix),
            });
        }
        Command::PART(chan, _) => {
            let _ = state.0.events.send(Event::Part {
                network: network.into(),
                channel: chan.clone(),
                nick: nick_of(&msg.prefix),
            });
        }
        Command::QUIT(reason) => {
            let _ = state.0.events.send(Event::Quit {
                network: network.into(),
                nick: nick_of(&msg.prefix),
                reason: reason.clone(),
            });
        }
        Command::NICK(new) => {
            let _ = state.0.events.send(Event::Nick {
                network: network.into(),
                old: nick_of(&msg.prefix),
                new: new.clone(),
            });
        }
        _ => {}
    }
    Ok(())
}
```

- [ ] **Step 5: Wire `session` module**

`lib.rs`:

```rust
pub mod session;
```

- [ ] **Step 6: Run — PASS**

Run: `cargo test -p grappa --test session_dispatch`
Expected: PASS (2 passed).

- [ ] **Step 7: Spawn sessions in `main.rs`**

Before the `axum::serve(...)` call:

```rust
for user in &cfg.users {
    for net in &user.networks {
        session::spawn(state.clone(), net.clone());
        tracing::info!(user = %user.name, network = %net.id, "session spawned");
    }
}
```

(`NetworkConfig` must derive `Clone`. Add `#[derive(Clone, Debug, Deserialize)]` in `config.rs`.)

- [ ] **Step 8: Manual end-to-end smoke**

```bash
# Point at a throwaway IRC net (e.g. a local ergo), or a real one with a scratch nick.
cat > /tmp/grappa.toml <<EOF
[server]
listen = "127.0.0.1:8080"
database_url = "sqlite:/tmp/grappa.db"

[[users]]
name = "tester"

[[users.networks]]
id = "local"
host = "127.0.0.1"
port = 6667
tls = false
nick = "grappa-test"
autojoin = ["#test"]
EOF
cargo run -p grappa -- /tmp/grappa.toml &
# In another terminal, join #test with a real client, say "oi" — observe it land in sqlite:
sqlite3 /tmp/grappa.db "SELECT sender, body FROM messages;"
# And stream via:
curl -N http://127.0.0.1:8080/events
```

Expected: the PRIVMSG you typed shows up as a row in `messages` and as an SSE data frame on `/events`.

- [ ] **Step 9: Commit**

```bash
git add server/src/session/ server/src/main.rs server/src/lib.rs server/src/config.rs server/tests/session_dispatch.rs
git commit -m "session: tokio-per-user upstream IRC task + dispatch to scrollback+events"
```

---

## Task 9: POST JOIN/PART + outbound PRIVMSG through the session

**Files:**
- Create: `server/src/api/channels.rs`
- Modify: `server/src/api/mod.rs`, `server/src/api/messages.rs`, `server/src/session/mod.rs`, `server/src/state.rs`

Until now the POST handler only writes to local scrollback. To actually *send* to upstream we need a per-network outbound channel from the API into the session task.

- [ ] **Step 1: Extend `state.rs` with a send-handle registry**

```rust
use tokio::sync::{broadcast, mpsc, RwLock};
use std::collections::HashMap;

pub enum Outbound {
    Privmsg { channel: String, body: String },
    Join { channel: String },
    Part { channel: String },
}

pub struct Inner {
    pub db: SqlitePool,
    pub events: broadcast::Sender<Event>,
    pub sessions: RwLock<HashMap<String, mpsc::Sender<Outbound>>>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self(Arc::new(Inner {
            db,
            events,
            sessions: RwLock::new(HashMap::new()),
        }))
    }
}
```

- [ ] **Step 2: Update `session::spawn` to register an outbound mpsc and bridge it to `client.send_privmsg` / `send_join` / `send_part`**

```rust
pub fn spawn(state: AppState, net: NetworkConfig) -> JoinHandle<Result<()>> {
    let net_id = net.id.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<Outbound>(64);
        state.0.sessions.write().await.insert(net_id.clone(), tx);

        let cfg = Config { /* as before */ };
        let mut client = Client::from_config(cfg).await?;
        client.identify()?;
        let sender = client.sender();

        let out_task = tokio::spawn(async move {
            while let Some(out) = rx.recv().await {
                let r = match out {
                    Outbound::Privmsg { channel, body } => sender.send_privmsg(channel, body),
                    Outbound::Join { channel } => sender.send_join(channel),
                    Outbound::Part { channel } => sender.send_part(channel),
                };
                if let Err(e) = r { tracing::warn!(?e, "send failed"); }
            }
        });

        let mut stream = client.stream()?;
        while let Some(msg) = stream.next().await.transpose()? {
            if let Err(e) = dispatch::handle(&state, &net_id, &msg).await {
                tracing::warn!(?e, "dispatch error");
            }
        }
        drop(out_task);
        Ok(())
    })
}
```

- [ ] **Step 3: Update POST messages to route through Outbound**

In `api/messages.rs`, after `scrollback::insert`, look up the session sender and forward:

```rust
if let Some(tx) = state.0.sessions.read().await.get(&network).cloned() {
    let _ = tx.send(crate::state::Outbound::Privmsg {
        channel: channel.clone(),
        body: stored.body.clone(),
    }).await;
}
```

- [ ] **Step 4: New `api/channels.rs` for JOIN / PART**

```rust
use axum::{extract::{Path, State}, http::StatusCode};
use serde::Deserialize;

use crate::state::{AppState, Outbound};

#[derive(Deserialize)]
pub struct JoinReq { pub name: String }

pub async fn post_join(
    State(state): State<AppState>,
    Path(network): Path<String>,
    axum::Json(req): axum::Json<JoinReq>,
) -> StatusCode {
    if let Some(tx) = state.0.sessions.read().await.get(&network).cloned() {
        let _ = tx.send(Outbound::Join { channel: req.name }).await;
        StatusCode::ACCEPTED
    } else {
        StatusCode::NOT_FOUND
    }
}

pub async fn delete_part(
    State(state): State<AppState>,
    Path((network, channel)): Path<(String, String)>,
) -> StatusCode {
    if let Some(tx) = state.0.sessions.read().await.get(&network).cloned() {
        let _ = tx.send(Outbound::Part { channel }).await;
        StatusCode::ACCEPTED
    } else {
        StatusCode::NOT_FOUND
    }
}
```

- [ ] **Step 5: Mount routes**

```rust
.route("/networks/:network/channels", axum::routing::post(channels::post_join))
.route("/networks/:network/channels/:channel", axum::routing::delete(channels::delete_part))
```

- [ ] **Step 6: Add tests**

Create `server/tests/api_channels.rs` — mount the router with a fake session sender (install one manually into `state.0.sessions` before calling the router), assert that posting to `/networks/:id/channels` pushes an `Outbound::Join` to the fake receiver. Same shape as existing tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/api/ server/src/session/ server/src/state.rs server/tests/api_channels.rs
git commit -m "api+session: POST join / DELETE part / PRIVMSG round-trip to upstream"
```

---

## Task 10: CI + clippy + fmt

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - run: cargo fmt --all -- --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test --all
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fmt + clippy + test on push/PR"
```

---

## Exit criteria for Phase 1

All of the following must hold before declaring Phase 1 done:

- [ ] `cargo test --all` green locally and on CI.
- [ ] `cargo clippy --all-targets -- -D warnings` clean.
- [ ] Running `grappa` against a test ircd, sending a `PRIVMSG` upstream, the message is persisted in sqlite and delivered as an SSE event on `/events`.
- [ ] `curl` against `/networks/:net/channels/:chan/messages?limit=N&before=<ts>` returns correctly paginated scrollback in descending `server_time` order.
- [ ] A `POST` to `/networks/:net/channels/:chan/messages` results in a `PRIVMSG` delivered upstream and a local scrollback row.
- [ ] `POST /networks/:net/channels` + `DELETE /networks/:net/channels/:chan` JOIN and PART upstream.

## What comes next (not this plan)

- Phase 2: SASL login + session tokens + multi-user isolation. Drops the hardcoded single-user config in favour of dynamic login.
- Phase 3: cicchetto walking skeleton — a Svelte/SolidJS PWA that consumes the API above.
- Phase 5: reconnect/backoff, scrollback eviction policy, allowlist enforcement.
- Phase 6: the IRCv3 listener facade — map paginated scrollback to `CHATHISTORY` + expose `CAP LS` + SASL downstream.
