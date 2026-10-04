# ChiCTR MCP Server

[![npm version](https://img.shields.io/npm/v/chictr-mcp-server.svg)](https://www.npmjs.com/package/chictr-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) service for querying the Chinese Clinical Trial Registry (ChiCTR).

The site protects `/searchproj.html` (search) and `/showproj.html` (detail) with Alibaba Shield
(Alibaba Cloud WAF): a direct request returns **405**, and switching the egress IP turns that into a
**challenge page** that only passes after JavaScript executes. This project solves it with a
two-stage architecture — a **Node MCP server plus a Python sidecar subprocess**. The sidecar solves
the challenge once to obtain cookies, after which every request is plain HTTP.

**Current version**: v3.0.0 · **MCP tools**: 10 · **Default data channel**: ChiCTR origin, direct

[简体中文](./README.md) | English

---

## 📍 Table of Contents

- [What Scrapling is (and which two components actually solve the problem)](#-what-scrapling-is)
- [Architecture and deployment shapes](#-architecture-and-deployment-shapes)
- [sidecar design](#-sidecar-design)
- [Deployment](#-deployment)
- [Use cases](#-use-cases)
- [Available tools](#-available-tools)
- [MCP configuration guide](#-mcp-configuration-guide)
- [CLI](#-cli-command-line-tool)
- [Performance comparison](#-performance-comparison)
- [Known limitations](#-known-limitations)
- [Compliance notes](#-compliance-notes)

---

## 🧩 What Scrapling is

**Scrapling is a third-party Python scraping library** (`pip install scrapling`; this project uses
`scrapling[fetchers]`, measured at version 0.4.15). It exposes a convenient set of scraping APIs —
`Fetcher` / `StealthyFetcher` / `StealthySession` — that collapse "impersonate a TLS fingerprint",
"drive a headless browser", and "pass a challenge" into a few lines.

### ⚠️ Key conclusion: Scrapling the *framework* is not what defeats Alibaba Shield 405

This is the single most important thing to understand about the project, and the source of the
"works out of the box" cost:

> **What actually passes the shield are the two low-level components bundled with Scrapling —
> `curl_cffi` and `patchright`. Scrapling only wraps them into a convenient API.**

| Component | Role | What it actually does against the shield |
|---|---|---|
| **curl_cffi** | TLS fingerprint impersonation | Makes a Python HTTP request's TLS fingerprint (JA3/JA4) look like real Chrome. **It only downgrades the "hard 405" into a "challenge page"; by itself it does not solve the challenge.** |
| **patchright** | Chromium anti-automation patch (a Playwright fork) | Lets the Alibaba Shield challenge script **actually run to completion** and compute the `acw_sc__v2` cookie. **This is the step that yields the real page.** |
| Scrapling (`Fetcher` / `StealthyFetcher`) | The wrapper layer calling those two | Provides the API. Its bundled Cloudflare solver (`solve_cloudflare=True`) **does nothing** against Alibaba Shield and only prints `No Cloudflare challenge found.` |

Three layers of evidence (`dev/browser-removal/SCRAPLING_SOLUTION.md`, measured on this machine on
2026-10-04):

| Layer | Method | Result |
|---|---|---|
| 0 | Bare curl / bare Node direct request | ❌ **405 hard block** |
| 1 | `Fetcher` (curl_cffi TLS impersonation) | ⚠️ 200, but only the **17,136-byte challenge page** (contains `acw_sc__v2` / `aliyunwaf`) |
| 2 | `StealthyFetcher` (patchright + real navigation) | ✅ 200, the **42,178-byte real page** (`共 13125`, `retrieve.js`), challenge passed |
| 2' | Same job given to **native Playwright + `page.setContent()`** | ❌ challenge script loops forever, never completes |

**Inference**: the difference between `StealthyFetcher` and native Playwright is exactly patchright's
fingerprint patch; that patch is what lets the challenge script finish. The Cloudflare solver is
irrelevant to this case.

### The cost: heavy dependencies (~1 GB)

The flip side of "powerful framework" is **dependency size**, because it drags in both a TLS
impersonation library and a patched Chromium build:

| Item | Measured size |
|---|---|
| `.venv` (Python dependencies; playwright 134 MB + patchright 134 MB) | **325 MB** |
| `~/Library/Caches/ms-playwright` (browser binaries) | **557 MB** |
| Node-side `node_modules` | several hundred MB |
| **Total** | **≈ 1 GB** |

There are also **two Chromium builds**: Node-side Playwright wants `chromium-1234`, while Python-side
patchright wants `chromium-1243`. This is precisely why the project cannot ship as "one installer that
does everything" and why the Python side must be **bootstrapped on demand at runtime** (see
[Deployment](#-deployment)).

---

## 🏗️ Architecture and deployment shapes

### Runtime architecture

```
MCP client (Cherry Studio / Claude Desktop / …)
   │  stdio (MCP protocol; stdout is a dedicated channel)
   ▼
Node MCP server (dist/index.js)          ← external contract, cache, state machine, tool orchestration
   │  preferred path when CHICTR_USE_SIDECAR=1
   │  HTTP JSON → 127.0.0.1:8848
   ▼
Python sidecar (sidecar/chictr_sidecar.py) ← shield solving + fetching + parsing
   ├─ curl_cffi plain HTTP + TLS impersonation ── normal request path (~1.5s/page)
   └─ patchright StealthySession headless browser ── shield solving only when cookies expire (~once/hour)
   ▼
https://www.chictr.org.cn
```

The boundary is clear: **the sidecar only "fetches HTML and parses it into JSON"; the Node side owns
every external contract.**

### Three deployment shapes

| Shape | Composition | Browser dependency | Suited to |
|---|---|---|---|
| **A. sidecar shape (recommended)** | Node MCP server + Python sidecar | Chromium only pulled once for shield solving | Local development, desktop apps, long-running services |
| **B. Pure Playwright shape (default/fallback)** | Node MCP server only | Chromium on every query | Environments that already have a browser; fallback when the sidecar is unavailable |
| **C. ICTRP shape (planned)** | Node MCP server only, via WHO ICTRP | None | Lightweight deployments, bulk search; see `dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` |

The current implementation covers **A + B**: if the sidecar is usable it takes path A, and if any step
fails it **automatically falls back** to B with an unchanged external contract. Shape C is still a
design document and is not implemented.

**Packaged shape** (shape A built into a dmg/exe):

```
YourApp.app / your-app.exe
├── node_modules/              # Node dependencies, collected by the packager (tens of MB)
├── dist/                      # TypeScript build output
├── sidecar/chictr_sidecar.py  # shipped in the package (package.json "files" already includes "sidecar")
└── (created in the user directory on first run)
    └── .venv/                 # 325 MB, created by setup, never inside the installer
```

Key constraint: **once packaged as dmg/exe, the installer does not run `package.json`'s `postinstall`**
(the packager only collects files; lifecycle hooks are dropped). Dependency preparation therefore has
to be **driven at runtime by the main program** — that is why `env-probe.ts` + `bootstrap.ts` exist.

---

## ⚙️ sidecar design

### Interface (a minimal HTTP JSON surface)

The sidecar exposes three read-only endpoints with the standard-library `ThreadingHTTPServer` and no
framework dependency:

| Method | Path | Parameters | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, solver:{fresh, age_seconds, solve_count, last_error, cookie_names}}` |
| GET | `/search` | `title`, `regno`, `createyear`, `page`, `pages` | `{ok, source, query, total, total_pages, returned, pages_fetched, results[]}` |
| GET | `/detail` | `proj` (project id) | `{ok, source, project_id, url, registration_number, fields{}, field_count}` |

Error semantics: still getting a challenge page after shield solving → **503
`{"error":"challenge_unsolved"}`**; missing `proj` → 400; any other exception → 502. It listens on
`127.0.0.1:8848` by default (`--host` / `--port` / `CHICTR_SIDECAR_HOST` / `CHICTR_SIDECAR_PORT`
override it, and `CHICTR_SIDECAR_LOG` controls the log level).

A `/search` `results[]` element:

```json
{
  "project_id": "245719",
  "registration_number": "ChiCTR2600133371",
  "title": "阿得贝利单抗联合NALIRIFOX用于可切除胰腺癌新辅助治疗",
  "institution": "浙江大学医学院附属第一医院",
  "study_type": "干预性研究",
  "registration_date": "2026/09/24",
  "detail_url": "https://www.chictr.org.cn/showproj.html?proj=245719"
}
```

### Core mechanism: cookie reuse, with the browser demoted to a low-frequency refresher

This is the foundation of the whole design — **the cookie produced by solving the challenge can be
reused outside the browser**.

1. **Solve the challenge once**: `ChallengeSolver._solve()` starts
   `StealthySession(headless=True)`, navigates to `/searchproj.html`, and pulls the four cookies
   **`acw_sc__v2` / `acw_tc` / `ssxmod_itna` / `ssxmod_itna2`** out of `session.context.cookies()`.
2. **Reuse over plain HTTP**: `ChictrClient.get_html()` requests with
   `FetcherSession(impersonate="chrome")` carrying that cookie set, **never touching the browser again**.
3. **Measured amortization**: **`solve_count = 1` supported ≥ 13 requests** (including 3 concurrent
   and 10 concurrent paginated calls) without triggering another shield solve. One solve costs about
   **4.7–6.0s**; afterwards it is about **1.5s/page**.

Several design details matter:

| Mechanism | Implementation | Why |
|---|---|---|
| **Double-checked locking** | `ensure()` first checks `is_fresh()` without the lock, then re-checks inside `threading.Lock` before calling `_solve()` | With concurrent first requests from multiple threads, the browser runs exactly once |
| **Long-lived HTTP session** | `FetcherSession` is a factory-style context manager: entered once at construction and kept resident, exited via `close()` | Avoids rebuilding the connection pool per request |
| **Underlying serialization** | `self._lock` wraps `self._http.get(...)` | **curl_cffi's underlying session is not thread-safe**, so concurrency is queuing, not true parallelism |
| **Content-detection safety net** | `_is_challenge()` checks whether the response contains only `acw_sc__v2` and lacks `retrieve.js`/`myPagination.js`/`showproj` | **Trust the response content, not the TTL** |
| **One retry** | Hitting a challenge page or an exception → `solver.invalidate(reason)` → retry once (`_retry=False` prevents recursion) | The recovery path is short and cannot spin |

### ⚠️ Important finding: the cookie really lives about 37.5 minutes, not 1 hour

The code sets `COOKIE_TTL_SECONDS = 55 * 60` (55 minutes, leaving a 5-minute margin under
`acw_sc__v2`'s 1-hour `expires`). **But in practice the cookie lives about 37.5 minutes, so the TTL
check is optimistic.**

This discrepancy **does not cause failures**, because the safety net is **content detection**, not the
TTL: when the cookie expires early, the request returns a challenge page rather than an error,
`_is_challenge()` recognizes it immediately → `invalidate()` clears the cookie → the shield is solved
again → the request is retried. **Measured recovery is about 5.7s**, and the caller only sees one
slightly slower request.

Conclusion: `fresh` is only an optimization signal for early refresh; **correctness is guaranteed by
response-content detection**. Operationally, `solver.fresh == false` should not be treated as a
failure (see [Monitoring and troubleshooting](#monitoring-and-troubleshooting)).

### Node-side client (`src/runtime/sidecar-client.ts`)

| Behavior | Implementation |
|---|---|
| **Off by default** | `isSidecarEnabled()` returns true only when `CHICTR_USE_SIDECAR` is `1`/`true`/`yes`/`on` |
| **Fail means fall back** | Any failure (unreachable, non-JSON, non-2xx, `payload.error`, zero valid results) returns `null`, and `src/index.ts` falls back to Playwright |
| **Fail fast** | Requests carry an `AbortController` plus `CHICTR_SIDECAR_TIMEOUT_MS` (default 30000 ms) |
| **Visible status** | `getSidecarStatus()` → `{enabled, available, baseUrl, lastError}`, exposed through `get_runtime_metrics` |

`get_trial_detail` needs a `project_id` first: the client looks up the cached "registration number →
project_id" mapping; if missing, it calls `/search?regno=` once to obtain the `project_id`, then calls
`/detail?proj=`.

### Lazy browser initialization (a critical fix)

The original `CallToolRequestSchema` handler in `src/index.ts` unconditionally ran
`new BrowserManager()` + `initialize()` **before** the `switch` — with the consequence that **Chromium
was launched even on a sidecar hit**, cancelling out the entire value of the sidecar.

It is now a lazy `ensureBrowser()` function, so **Chromium is initialized only on branches that
actually go through Playwright (including sidecar fallback)**. The decisive verification: on a machine
**deliberately left without Playwright browser binaries**
(`Executable doesn't exist at .../chromium_headless_shell-1234/...`), `search_trials` threw before the
fix and returned real data after it — proving the browser was never touched.

---

## 🚀 Deployment

### User perspective: three steps

```bash
# 1. Health check (read-only, changes nothing; exit code 1 = action needed)
chictr-mcp-server doctor

# 2. One-command repair (creates venv + installs dependencies; network needed, ~40s to 3min first time)
chictr-mcp-server setup

# 3. Start the sidecar (runs in the foreground; solves the shield once on first run)
chictr-mcp-server sidecar
```

Then point the MCP client at the HTTP path:

```bash
export CHICTR_USE_SIDECAR=1
chictr-mcp-server --transport=stdio
```

> `setup` **does not download browser binaries by default** (saving 560 MB). The sidecar's normal plain
> HTTP path does not need them; only the first shield solve needs Chromium. Add `--browser` to
> explicitly authorize the download.
>
> You can also hand these three steps to an AI — the MCP tool `check_environment` returns the same
> health-check conclusions and repair suggestions.

### Exit code convention

| Code | Meaning | Caller action |
|---|---|---|
| 0 | Environment ready / operation succeeded | Continue |
| 1 | Not ready, user action required | Tell the user to run `setup` |
| 2 | Bootstrap failed (network, disk, permissions) | Show the error; retry is allowed |

### Three levels of automation

1. **Startup self-check** (implemented, zero configuration): the MCP service runs a health check on
   every startup whose result is **written only to stderr (stdout is the MCP protocol channel, and
   writing there would break the protocol)**. The check **never blocks startup and never throws** —
   the service starts regardless of environment quality, only with different capabilities.
   ```
   [chictr-mcp-server] 环境未就绪：未找到 Python 虚拟环境
   [chictr-mcp-server] 运行 "chictr-mcp-server setup" 自动修复
   ```
2. **First-run automatic download** (optional, explicit authorization required): `setup --browser` or,
   in code, `bootstrapEnvironment({ installBrowser: true, onProgress })`.
   **Silent automatic downloads are deliberately avoided** — pulling 560 MB without the user's
   knowledge is an imposition.
3. **Bootstrap robustness**: `bootstrapEnvironment()` is **idempotent** (an existing venv is not
   recreated, installed dependencies are not reinstalled, and an interrupted run resumes from where it
   stopped); pip mirrors **fall back automatically** in the order
   `preferred → others → official` (Alibaba Cloud by default; the Tsinghua mirror returns 403 for
   pip 26's new User-Agent and disguises the error as
   `Could not find a version that satisfies the requirement scrapling[fetchers] (from versions: none)`,
   which is highly misleading — hence mirror fallback is a necessity, not an optimization).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CHICTR_HOME` | inferred | Project root (required when the packaged location is non-standard) |
| `CHICTR_VENV` | `<root>/.venv` | Virtual environment directory |
| `CHICTR_USE_SIDECAR` | unset (off) | Set to `1`/`true`/`yes`/`on` to prefer the sidecar path |
| `CHICTR_SIDECAR_URL` | `http://127.0.0.1:8848` | sidecar address |
| `CHICTR_SIDECAR_TIMEOUT_MS` | `30000` | Per-call sidecar timeout |
| `CHICTR_SIDECAR_HOST` / `CHICTR_SIDECAR_PORT` | `127.0.0.1` / `8848` | sidecar listen address (Python side) |
| `CHICTR_SIDECAR_LOG` | `INFO` | sidecar log level |
| `HTTP_PROXY` / `HTTPS_PROXY` | unset | Proxy (optional) |

### User environment requirements

| Requirement | Notes |
|---|---|
| Node.js | ≥ 20 (bundled in packaged builds; can be ignored) |
| Python | ≥ 3.10 (`setup` auto-discovers `python3.13/3.12/3.11/3.10/python3`) |
| Disk | ~400 MB for the plain HTTP path; ~1 GB including the browser |
| Network | First `setup` needs network (~40s to 3min) |

**If the user has no Python**: `doctor` reports `venv: missing` and suggests installing Python. This
is the only dependency `setup` cannot resolve on its own.

> ⚠️ `pip install --user` fails with a permission error on some macOS setups
> (`OSError: [Errno 1] Operation not permitted: .../site-packages/w3lib`), so **a venv is mandatory**.
>
> ⚠️ `.venv` is created in the project root by default. If the install directory is read-only
> (macOS `/Applications`, Windows `Program Files`), you must set `CHICTR_HOME` to a writable
> directory; `isWritable()` flags this in the health report.

### Monitoring and troubleshooting

```bash
curl -sS http://127.0.0.1:8848/health
# {"ok": true, "solver": {"fresh": true, "age_seconds": 57.0, "solve_count": 1, "last_error": null,
#  "cookie_names": ["acw_sc__v2","acw_tc","ssxmod_itna","ssxmod_itna2"]}}
```

- `solver.solve_count`: cumulative shield solves. In steady state it should stay at 1 (about +1 per
  hour). **A rapid rise means the cookie is being repeatedly invalidated — check whether you are being
  rate-limited.**
- `solver.last_error`: reason for the most recent failed solve; normally `null`.
- On the MCP side, `get_runtime_metrics` exposes `sidecar: { enabled, available, baseUrl, lastError }`.

| Symptom | Cause | Handling |
|---|---|---|
| `/health` unreachable | sidecar not started | `chictr-mcp-server sidecar` |
| Log line `ERROR: No Cloudflare challenge found.` | **normal noise** | ChiCTR uses Alibaba Shield, not CF; ignore it. The success marker is the immediately following `INFO 过盾成功，耗时 X.Xs` |
| `{"error":"challenge_unsolved"}` (503) | Still getting a challenge page after solving | Usually IP rate limiting; retry later |
| MCP returns a Playwright error | sidecar disabled or unreachable | Confirm `CHICTR_USE_SIDECAR=1` and that `curl /health` works |
| `from versions: none` | pip mirror 403 | Already auto-fallback; or `setup --mirror=aliyun` |
| Health check says venv missing but the directory exists | Corrupt venv | `setup` detects and rebuilds it; or `clean --yes` and start over |
| Immediate crash `Could not locate the bindings file` | `better-sqlite3` not built for the current Node ABI | See below |

```bash
# better-sqlite3 native binding (Node 22 / ABI v127); npm rebuild fails in restricted sandboxes
# because it cannot write ~/Library/Caches/node-gyp, so use a prebuilt binary instead
cd node_modules/better-sqlite3 && npx prebuild-install -r node -t 22.19.0
```

### Fresh-install measurement record

Verified in an isolated "empty" directory containing only `package.json` + `dist/` +
`sidecar/chictr_sidecar.py`, **592 KB** in total:

| Step | Result |
|---|---|
| `doctor` | ✅ Correctly reported not-ready, exit code 1, with actions |
| `setup --mirror=tsinghua` | ✅ Tsinghua failed → **automatic fallback to Alibaba Cloud succeeded** (2m35s) |
| `doctor` | ✅ Everything ready (venv 3.13.14 / dependencies / browser binaries / script) |
| Start sidecar | ✅ Shield solved in **6.7s** |
| Real search for "胰腺癌" | ✅ `total 469` / `total_pages 47` / 10 results returned |
| MCP tool `check_environment` | ✅ 22 ms (cache hit) |

In other words: **on a clean machine, a 592 KB package plus one `setup` command equals a working
service.**

---

## 🎯 Use cases

| Scenario | How to use it | Why it fits |
|---|---|---|
| **Clinical trial intelligence monitoring** | Schedule `search_trials` by target/disease keyword, then batch `get_trial_detail` for new registration numbers | The origin serves **live** data (WHO ICTRP syncs weekly and lags); at ~1.5s/page, daily polling costs next to nothing |
| **RAG / knowledge-base ingestion** | `search_trials` for the list → `get_trial_detail` for 14+ structured fields → write into a vector store | Detail pages are parsed into **bilingual** structured fields, far better for chunking and retrieval than raw HTML |
| **Patient matching and eligibility screening** | Search by disease name or gene mutation (e.g. `KRAS G12D`, `胰腺癌`), then filter against inclusion/exclusion criteria | `get_trial_detail` returns "inclusion criteria", "exclusion criteria", "study sites", and "recruitment status" directly |
| **An evidence tool for AI agents** | Mount as an MCP server in Cherry Studio / Claude Desktop and similar clients | Chinese clinical trial data is a general gap for AI assistants; 5 of the 10 tools exist for agent self-diagnosis |
| **Research retrospectives and trend analysis** | Query year by year with the `year` parameter and count registrations for a target or institution | Supports year, registration number, and keyword combinations, with a `max_results` cap of 100 |
| **Deployment self-check (agent self-service debugging)** | `check_environment` → decide from the returned `actions` whether to call `setup` | Lets an AI work out on the user's machine whether Python is missing, dependencies are missing, or the sidecar is not running |

---

## 📋 Available tools

**10** MCP tools in total (`check_environment` was added in v3.0.0).

| # | Tool | Purpose |
|---|---|---|
| 1 | `search_trials` | Search by keyword / registration number / year |
| 2 | `get_trial_detail` | Fetch full details by registration number |
| 3 | `get_cache_stats` | Single-layer cache statistics (hit rate, etc.) |
| 4 | `clear_cache` | Clear all caches |
| 5 | `get_cache_stats_v2` | Dual-layer cache statistics (L1 memory + L2 SQLite) |
| 6 | `get_runtime_metrics` | Runtime orchestration metrics + **sidecar status** |
| 7 | `get_access_state` | Access state machine (NORMAL/SUSPECTED/CHALLENGED/COOLDOWN/RECOVERY) |
| 8 | `check_environment` | Local environment health check (Python venv / dependencies / browser binaries / sidecar); read-only, downloads nothing and changes no files |
| 9 | `prepare_verification_session` | Create a manual verification session |
| 10 | `resume_after_verification` | Restore access state after manual verification |

### search_trials

```json
// By keyword
{ "name": "search_trials", "arguments": { "keyword": "KRAS", "max_results": 20 } }

// By registration number
{ "name": "search_trials", "arguments": { "registration_number": "ChiCTR2500111173" } }

// By year
{ "name": "search_trials", "arguments": { "year": 2024, "max_results": 20 } }

// Combined
{ "name": "search_trials", "arguments": { "keyword": "KRAS", "year": 2024, "max_results": 10 } }
```

**Parameters**:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keyword` | string | No | Registration title keyword, max 200, e.g. `KRAS G12C`, `胰腺癌` |
| `registration_number` | string | No | Registration number matching `^ChiCTR\d{8,}$`, max 32 |
| `year` | integer | No | Registration year, minimum 2000, maximum current year + 1 |
| `max_results` | integer | No | Maximum results, default 20, range 1–100 |

### get_trial_detail

```json
{ "name": "get_trial_detail", "arguments": { "registration_number": "ChiCTR2500108082" } }
```

### check_environment

```json
{ "name": "check_environment", "arguments": { "refresh": false } }
```

`refresh: true` ignores the 30-second cache and forces a fresh probe. It returns
`root / node / venv / pythonDeps / browser / playwrightBrowser / sidecarScript / sidecar / summary / actions / canRunBrowserless`.
`canRunBrowserless` is the key signal for "can search run without a browser".

### Cache and state tools

```json
{ "name": "get_cache_stats",  "arguments": {} }
{ "name": "clear_cache",      "arguments": {} }
{ "name": "get_cache_stats_v2","arguments": {} }
{ "name": "get_runtime_metrics","arguments": {} }
{ "name": "get_access_state", "arguments": {} }
```

### Manual verification session

```json
{ "name": "prepare_verification_session",
  "arguments": { "target_url": "https://www.chictr.org.cn/searchproj.html", "timeout_ms": 300000 } }

{ "name": "resume_after_verification", "arguments": { "verification_id": "verify_xxx" } }
```

---

## 📡 MCP configuration guide

### Minimal configuration (npx)

```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server@latest"]
    }
  }
}
```

### After a global install

```bash
npm install -g chictr-mcp-server
```

```json
{ "mcpServers": { "chictr": { "command": "chictr-mcp-server" } } }
```

### Enabling the sidecar (recommended)

```json
{
  "mcpServers": {
    "chictr": {
      "command": "node",
      "args": ["/Users/you/chictr_trials/dist/index.js"],
      "env": { "CHICTR_USE_SIDECAR": "1" }
    }
  }
}
```

Prerequisite: start `chictr-mcp-server sidecar` in a separate process first.

### With a proxy

```json
{
  "mcpServers": {
    "chictr": {
      "command": "npx",
      "args": ["-y", "chictr-mcp-server"],
      "env": { "HTTP_PROXY": "http://your-proxy-server:port" }
    }
  }
}
```

### Transport methods

| Method | Status | Description |
|---|---|---|
| **stdio** | ✅ Supported (default) | Standard input/output |
| http | Planned | `http://localhost:3000/mcp` |
| sse | Planned | `http://localhost:3000/mcp` |

### Testing the MCP service

```bash
npx @modelcontextprotocol/inspector npx -y chictr-mcp-server
```

---

## 🛠️ CLI command line tool

`package.json` exposes two bins: `chictr-mcp-server` (`dist/index.js`) and `chictr-setup`
(`dist/cli/setup-cli.js`).

```bash
npm install -g chictr-mcp-server   # global install
npx -y chictr-mcp-server           # or run directly via npx (recommended)
```

| Command | Description |
|---|---|
| `chictr-mcp-server` | Start the STDIO MCP service |
| `chictr-mcp-server doctor` | Environment health check (read-only; modifies no files) |
| `chictr-mcp-server setup` | Install missing dependencies (idempotent, safe to re-run) |
| `chictr-mcp-server setup --browser` | Also download browser binaries (~560 MB, network required) |
| `chictr-mcp-server setup --mirror=aliyun` | Choose the PyPI mirror (`aliyun` default / `tencent` / `official` / `tsinghua`) |
| `chictr-mcp-server setup --timeout=1800` | Per-step timeout (seconds, default 1800) |
| `chictr-mcp-server sidecar [--port=8848]` | Start the sidecar in the foreground (adds `--warmup` automatically, passes through `--` arguments) |
| `chictr-mcp-server clean [--yes]` | Delete the virtual environment so it can be reinstalled |

Equivalent npm scripts: `npm run doctor` / `npm run setup` / `npm run sidecar`.

---

## 📈 Performance comparison

| Path | Search latency | Notes |
|---|---|---|
| **Old Playwright path** (fallback shape) | 45s timeout ceiling + **5–10s artificial delay per page** (plus 3–6s between pages and 2–4s before pagination) | Original `src/services/search.ts` logic |
| **sidecar path** (recommended shape) | **~1.5s/page**; end-to-end search ~1.5–2.1s, detail ~2s | Plain HTTP with cookie reuse, no browser |

**End-to-end response time drops by roughly an order of magnitude**, and the old random-delay evasion
logic is gone.

Other measured baselines:

| Metric | Value |
|---|---|
| Cold-start shield solve | 4.7 / 5.9 / 6.0 / 6.7s (multiple cold starts) |
| Warm single-page lookup (`regno`) | 1.46s |
| Warm single-page lookup (`title`) | ~1.5s |
| Detail page | ~2s |
| Requests supported by one shield solve | **≥ 13** (`solve_count` stays 1) |
| Concurrency | 3 concurrent 3/3 succeeded; **10 concurrent 10/10 succeeded** (100 records total), no re-solve during the run |
| Actual cookie lifetime | **about 37.5 minutes** (the configured 55-minute TTL is optimistic; content detection is the safety net, **5.7s recovery**) |
| Cache | search results 5 minutes, details 10 minutes; dual layer L1 memory + L2 SQLite |

### Example server response

```json
{
  "results": [
    {
      "registration_number": "ChiCTR2500108082",
      "title": "谷氨酰胺联合奥沙利铂、卡培他滨（XELOX）和贝伐珠单抗一线治疗KRAS G12D基因突变型晚期结直肠癌的单臂Ⅱ期探索性研究",
      "study_type": "干预性研究",
      "registration_date": "2025/08/25",
      "institution": "浙江大学医学院附属第二医院"
    }
  ]
}
```

---

## 🔔 Release notes

### v3.0.0 (2026-04-10)
- ✅ Added the Python sidecar channel: solves the Alibaba Shield challenge once with `curl_cffi` +
  `patchright`, then reuses the cookie over plain HTTP (**~1.5s/page** instead of 5–10s per page plus
  artificial delays). Controlled by `CHICTR_USE_SIDECAR=1`, off by default, silent fallback to
  Playwright on any failure
- ✅ Added environment bootstrap: `doctor` (read-only health check) / `setup` (idempotent dependency
  install with pip mirror fallback) / `clean`, with exit codes 0/1/2
- ✅ Added the `check_environment` MCP tool (10th tool): returns the local environment report
  (Python venv / dependencies / browser binaries / sidecar online) plus prioritized `actions`, and
  reports to stderr on startup
- ✅ Lazy browser initialization: Chromium is no longer launched when the sidecar serves the request
- ✅ Shipping `sidecar/chictr_sidecar.py` in the package (`package.json` `files` includes `sidecar`)
- ✅ Removed the old random-delay evasion logic from the search path

### v2.0.2 (2026-04-09)
- ✅ Fixed stale empty-detail cache hit issue (auto-invalidate and refetch)
- ✅ Improved detail query robustness to prioritize effective content retrieval

### v2.0.1 (2026-04-09)
- ✅ Fixed Cherry Studio startup `ENOENT` for `./cache` in GUI cwd context
- ✅ Default cache path changed to `~/.chictr/cache/chictr_cache.db`
- ✅ Added fallback path `/tmp/chictr/cache/chictr_cache.db`

### v2.0.0 (2026-04-09)
- ✅ Added request orchestrator (rate-limit/retry/circuit-breaker)
- ✅ Added session pooling with lifecycle recycling
- ✅ Added challenge state machine and recovery tools (`get_access_state` / `prepare_verification_session` / `resume_after_verification`)
- ✅ Added dual-layer cache (L1 memory + L2 SQLite) and `get_cache_stats_v2`

### v1.2.1 (2025-01-17)
- ✅ Updated README with multi-dimensional search examples
- ✅ Added version upgrade guide
- ✅ Provided Cherrystudio cache clearing solutions

### v1.2.0 (2025-01-17)
- ✅ Added search by registration number (registration_number parameter)
- ✅ Added search by year (year parameter, defaults to current year)
- ✅ All search parameters are now optional
- ✅ Fixed detail query 400 error (using correct project_id)

### v1.1.0 (2025-01-17)
- ✅ Fixed pagination feature, supporting multi-page results
- ✅ Added proxy configuration support (HTTP_PROXY/HTTPS_PROXY)
- ✅ Added verification code detection with friendly error messages

---

## 🛠️ Technology stack

| Layer | Technology |
|---|---|
| Node side | TypeScript, MCP SDK, Cheerio, node-cache, better-sqlite3, Playwright |
| Python sidecar | Python ≥ 3.10, Scrapling (`scrapling[fetchers]`), curl_cffi, patchright, standard-library `ThreadingHTTPServer` |

---

## ⚠️ Known limitations

Recorded honestly; unresolved or unverified items:

1. **The Node-side Playwright fallback path is unusable on this machine**: Node playwright 1.62.1
   needs `chromium-1234`, while the cache only has `chromium-1243` (used by Python-side patchright).
   Today this is masked only because the sidecar plain HTTP path is used; if the sidecar fails and
   falls back to Playwright, it throws `Executable doesn't exist`.
   **Recommendation: treat the sidecar as the only path, or install the Node-side browser binaries.**
2. **Cookie expiry boundary**: measured lifetime is about 37.5 minutes < the configured 55-minute TTL.
   Recovery relies on content detection plus a retry (measured at 5.7s), but the TTL is only an
   optimistic early-refresh signal.
3. **Concurrency ceiling unknown**: only 10 concurrent requests were tested (10/10 succeeded).
   `ChictrClient._lock` serializes the underlying HTTP session (the curl_cffi session is not
   thread-safe), so concurrency is queuing rather than true parallelism. **Do not increase it blindly.**
4. **Long-running stability unverified**: the stability of `StealthySession` over long periods has not
   been tested (currently a new browser context is created and torn down for each shield solve).
5. **Request rate ceiling untested**: whether Alibaba Shield intervenes again at higher QPS is unknown.
6. **Slight field bleed in `研究实施时间`**: the value contains the next label. This is a known parsing
   blemish and does not affect the main fields.
7. **The ICTRP dual channel is not implemented**: `dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` is
   a design document; there is currently **no** WHO ICTRP channel and no `source=` parameter.
8. **Verification codes cannot be handled manually in headless mode**: frequent requests may still
   trigger a slider CAPTCHA.

---

## ⚖️ Compliance notes

- ChiCTR is **registered in re3data as data access `restricted`**, and the site footer reads
  **`All rights reserved.`**
- **There is no official API and no bulk download channel.**
- Therefore: **"available ≠ redistributable."** This project is positioned for personal research and
  intelligence use in a controlled environment and does not redistribute data. If you intend to depend
  on direct ChiCTR access long term, consider also pursuing a formal authorization inquiry to
  `chictr-s7@wchscu.cn`.
- Circumventing the WAF is a confrontation with the site's access decisions and is a **policy judgment,
  not a technical one** — the technical conclusion is "access is feasible"; confirm compliance
  yourself. Background: `dev/browser-removal/SCRAPLING_SOLUTION.md` §6 and `SIDECAR_RUNBOOK.md`.

---

## 📄 License

MIT License

## 🙏 Acknowledgements

This project uses public data from the Chinese Clinical Trial Registry (ChiCTR). We thank ChiCTR for
their contributions to medical research.
Special thanks to [Xiaoyibao](http://www.xiaoyibao.com.cn) and the
[xiao-x-bao community](https://info.xiao-x-bao.com.cn) for their ❤️ contribution and effort, supporting
cancer and rare disease patients and their families with love and AI.

## 📞 Related documents

| File | Description |
|---|---|
| `dev/browser-removal/SCRAPLING_SOLUTION.md` | Three-layer measured evidence for shield feasibility (with reproduction commands) |
| `dev/browser-removal/SIDECAR_RUNBOOK.md` | sidecar operations runbook |
| `dev/browser-removal/SIDECAR_VERIFICATION.md` | sidecar end-to-end verification report and measurements |
| `dev/browser-removal/DEPLOYMENT.md` | Out-of-the-box deployment guide (dmg / exe) |
| `dev/browser-removal/DUAL_CHANNEL_ARCHITECTURE.md` | Dual-channel degradation architecture (design document) |
| `sidecar/chictr_sidecar.py` | sidecar implementation (shield solving + parsing + HTTP service) |
| `src/runtime/sidecar-client.ts` | Node-side client (off by default, automatic fallback on failure) |

If you have any issues, please submit a GitHub Issue.
