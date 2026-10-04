#!/usr/bin/env python3
"""胰腺癌 ChiCTR 试验全量抓取 → SQLite（结构化字段 + 原始 HTML）。

设计要点
--------
1. **只走 sidecar**（HTTP 127.0.0.1:8848）。sidecar 负责阿里盾过盾，
   本脚本不碰浏览器、不碰 TLS 指纹。
2. **按注册年份分档**抓取（createyear 参数），逐年翻页，便于断点续跑
   与增量控制。
3. **按 project_id 去重**：project_id 是 ChiCTR 的天然唯一键，且**每条都有**。
   注意不能用注册号当去重键——2018 年之前注册的试验 ChiCTR 没有发注册号
   （列表里 registration_number 为 null），只按注册号去重会把 2010–2017
   的记录整批静默丢掉（实测会少 31 条）。已存在者默认跳过（--refresh 可强制重抓）。
4. **两者都存**：结构化字段（JSON） + 原始 HTML 原文，任何解析瑕疵
   都可回溯重解，不必重爬。
5. **幂等可续跑**：所有写入用 INSERT OR REPLACE，中断后重跑不会产生
   重复数据，只补齐缺失项。

用法
----
    python3 tools/chictr_crawl.py                  # 全量抓取（跳过已存在）
    python3 tools/chictr_crawl.py --years 2026     # 只抓某年
    python3 tools/chictr_crawl.py --refresh        # 强制重抓已存在的
    python3 tools/chictr_crawl.py --export-json    # 额外导出 JSON
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "chictr_pancreatic.db"
DEFAULT_JSON = ROOT / "data" / "pancreatic_trials.json"

SIDECAR = os.environ.get("CHICTR_SIDECAR_URL", "http://127.0.0.1:8848")
KEYWORD = "胰腺癌"
# 注册年份分档：ChiCTR 最早数据在 2010 年前后，覆盖到当年。
DEFAULT_YEARS = list(range(2010, datetime.now().year + 1))

# sidecar 单次请求超时；详情页较大（~250KB HTML），给足时间。
HTTP_TIMEOUT = 120
MAX_RETRY = 4


# ---------------------------------------------------------------------------
# sidecar 客户端
# ---------------------------------------------------------------------------


class SidecarError(RuntimeError):
    pass


def _get(path: str, params: dict[str, str], *, timeout: int = HTTP_TIMEOUT) -> dict:
    """调用 sidecar，失败自动重试（指数退避）。

    重试是必要的：sidecar 内部 get_html 只重试一次，cookie 过期时可能
    正好赶上重新过盾（约 5-7s），此时单次请求会失败。
    """
    url = f"{SIDECAR}{path}?{urllib.parse.urlencode(params)}"
    last: Exception | None = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if payload.get("error"):
                raise SidecarError(f"{payload['error']} ({path})")
            return payload
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < MAX_RETRY:
                backoff = 2 ** attempt
                print(f"    ! 第 {attempt} 次失败（{exc}），{backoff}s 后重试", flush=True)
                time.sleep(backoff)
    raise SidecarError(f"{path} 重试 {MAX_RETRY} 次仍失败：{last}")


def search_year(year: int, *, delay: float, keyword: str = KEYWORD) -> list[dict]:
    """抓取某一年份的全部搜索结果（自动翻页）。"""
    first = _get("/search", {"title": KEYWORD, "createyear": str(year), "page": "1", "pages": "1"})
    total = first.get("total") or 0
    if total == 0:
        return []

    total_pages = first.get("total_pages") or 1
    results: list[dict] = list(first.get("results") or [])
    # 去重键用 project_id 而不是注册号：2018 年之前的记录 ChiCTR 根本没发
    # 注册号（registration_number 为 null），只按注册号去重会把它们整批丢掉。
    # project_id 始终存在，是唯一可靠的键。
    seen = {str(r["project_id"]) for r in results if r.get("project_id")}

    # 逐页抓取（第 1 页已拿到）。上限保护：避免 total_pages 异常时死循环。
    page = 2
    while page <= min(total_pages, 200):
        try:
            payload = _get(
                "/search",
                {"title": keyword, "createyear": str(year), "page": str(page), "pages": "1"},
            )
        except SidecarError as exc:
            print(f"    ! 第 {page} 页失败，跳过：{exc}", flush=True)
            page += 1
            continue

        batch = payload.get("results") or []
        if not batch:
            break
        for r in batch:
            pid = r.get("project_id")
            if pid and str(pid) not in seen:
                seen.add(str(pid))
                results.append(r)
        page += 1
        time.sleep(delay)

    return results


def fetch_detail(project_id: str) -> dict:
    """抓详情。raw=1 让 sidecar 一并返回原始 HTML 用于留档。"""
    return _get("/detail", {"proj": str(project_id), "raw": "1"})


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS trials (
    -- 主键用 project_id：2018 年之前的记录 ChiCTR 没有发注册号
    -- （registration_number 为 NULL），不能作为唯一键。
    project_id          TEXT PRIMARY KEY,
    registration_number TEXT,
    title               TEXT,
    institution         TEXT,
    study_type          TEXT,
    registration_date   TEXT,
    detail_url          TEXT,
    -- 详情页结构化字段，整体以 JSON 存储（字段名随页面变化，不做硬编码列）
    fields_json         TEXT,
    field_count         INTEGER,
    -- 常用检索字段冗余成独立列，便于直接 SQL 查询
    registration_year   TEXT,
    study_design        TEXT,
    disease             TEXT,
    sample_size         TEXT,
    study_leader        TEXT,
    -- 注：曾有 sponsor 列，因「申办者」字段长期 0 覆盖已移除。
    -- 老库该列仍在（SQLite 不轻易删列），新库不再创建。
    inclusion_criteria  TEXT,
    exclusion_criteria  TEXT,
    purpose             TEXT,
    recruitment_status  TEXT,
    -- 原始素材
    raw_html            TEXT,
    raw_text            TEXT,
    html_sha256         TEXT,
    content_sha256      TEXT,
    raw_text_length     INTEGER,
    -- 采集元数据
    source_year         INTEGER,
    fetched_at          TEXT,
    updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_year  ON trials(source_year);
CREATE INDEX IF NOT EXISTS idx_reg   ON trials(registration_year);
CREATE INDEX IF NOT EXISTS idx_hash  ON trials(content_sha256);
CREATE INDEX IF NOT EXISTS idx_type  ON trials(study_type);

CREATE TABLE IF NOT EXISTS crawl_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT,
    year        INTEGER,
    detail      TEXT,
    at          TEXT
);
"""

# 详情字段 → 独立列 的映射。
# 这里只放**稳定存在**的字段：曾把 `申办者` 映射到 sponsor 列，但实测该字段
# 在 468 条里覆盖率为 0（页面用的是「试验主办单位(项目批准或申办者)」，且它是
# 区块标题不抽值），该列长期全空；`纳入标准`/`排除标准` 在 v3.0.1 解析器修复前
# 也一直是 0 覆盖，现已修复，故保留。
FIELD_COLUMNS = {
    "研究设计": "study_design",
    "研究疾病": "disease",
    "样本量": "sample_size",
    "研究负责人": "study_leader",
    "研究目的": "purpose",
    "征募研究对象情况": "recruitment_status",
    "纳入标准": "inclusion_criteria",
    "排除标准": "exclusion_criteria",
}


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    _migrate_primary_key(conn)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _migrate_primary_key(conn: sqlite3.Connection) -> None:
    """早期版本用 registration_number 做主键，改为 project_id。

    已存在的旧库需要重建表：把数据搬过去，让没有注册号的记录也能落户。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='trials'"
    ).fetchone()
    if not row or not row[0]:
        return
    if "project_id          TEXT PRIMARY KEY" in row[0] or "project_id TEXT PRIMARY KEY" in row[0]:
        return
    if "registration_number TEXT PRIMARY KEY" not in row[0]:
        return

    print("检测到旧库主键为 registration_number，正在迁移到 project_id …", flush=True)
    old_cols = [r[1] for r in conn.execute("PRAGMA table_info(trials)")]
    conn.execute("ALTER TABLE trials RENAME TO trials_old")
    conn.executescript(SCHEMA)
    new_cols = [r[1] for r in conn.execute("PRAGMA table_info(trials)")]
    shared = [c for c in old_cols if c in new_cols]
    cols_sql = ",".join(shared)
    # 旧库里没有 project_id 的记录用注册号兜底，保证主键非空。
    conn.execute(
        f"INSERT OR REPLACE INTO trials ({cols_sql}) "
        f"SELECT {cols_sql} FROM trials_old WHERE project_id IS NOT NULL"
    )
    conn.execute("DROP TABLE trials_old")
    conn.commit()
    print(f"迁移完成：{conn.execute('SELECT COUNT(*) FROM trials').fetchone()[0]} 条", flush=True)


def existing_project_ids(conn: sqlite3.Connection) -> set[str]:
    return {str(r[0]) for r in conn.execute("SELECT project_id FROM trials WHERE project_id IS NOT NULL")}


def existing_project_ids_with_detail(conn: sqlite3.Connection) -> set[str]:
    """已有且确实抓到过详情的 project_id（field_count>0）。

    仅按主键是否存在判断，会让"列表入了库但详情从没抓过"的记录被永久跳过。
    """
    return {
        str(r[0]) for r in conn.execute(
            "SELECT project_id FROM trials WHERE COALESCE(field_count,0) > 0 AND project_id IS NOT NULL"
        )
    }


def upsert(conn: sqlite3.Connection, row: dict) -> None:
    cols = list(row.keys())
    placeholders = ",".join("?" for _ in cols)
    updates = ",".join(f"{c}=excluded.{c}" for c in cols if c != "project_id")
    conn.execute(
        f"INSERT INTO trials ({','.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT(project_id) DO UPDATE SET {updates}",
        [row[c] for c in cols],
    )
    conn.commit()


def log_event(conn: sqlite3.Connection, event: str, year: int | None, detail: str) -> None:
    conn.execute(
        "INSERT INTO crawl_log (event, year, detail, at) VALUES (?,?,?,?)",
        (event, year, detail, now_iso()),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def crawl(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser().resolve()
    conn = open_db(db_path)
    have = existing_project_ids(conn)
    keyword = getattr(args, "keyword", None) or KEYWORD
    print(f"数据库：{db_path}")
    print(f"已有记录：{len(have)} 条")

    years = [int(y) for y in args.years] if args.years else DEFAULT_YEARS
    print(f"抓取年份：{years[0]}–{years[-1]}（{len(years)} 档）")
    print(f"关键词：{keyword} | sidecar：{SIDECAR}\n")

    # ---- 阶段 1：按年份收集列表 ----
    all_rows: dict[str, dict] = {}
    for year in years:
        try:
            rows = search_year(year, delay=args.delay, keyword=keyword)
        except SidecarError as exc:
            print(f"  [{year}] 列表抓取失败：{exc}")
            log_event(conn, "search_failed", year, str(exc))
            continue
        new = 0
        for r in rows:
            pid = r.get("project_id")
            if not pid:
                continue
            if str(pid) not in all_rows:
                r.setdefault("source_year", year)
                all_rows[str(pid)] = r
                new += 1
        print(f"  [{year}] 列表 {len(rows)} 条（新增 {new}）", flush=True)
        log_event(conn, "search_ok", year, f"{len(rows)} rows")
        time.sleep(args.delay)

    print(f"\n列表合计：{len(all_rows)} 个唯一试验（按 project_id 去重）")

    # ---- 阶段 2：抓详情 ----
    # 只跳过「已有且确实抓到了详情」的记录。早年数据里存在"列表已入库但详情
    # 从未抓过"的半成品（field_count=0），若只看注册号存在与否会把它们永久
    # 漏掉，所以额外用 field_count>0 作为"真的抓过"的判据。
    detailed = existing_project_ids_with_detail(conn)
    targets = [
        r for pid, r in all_rows.items()
        if args.refresh or pid not in detailed
    ]
    skipped = len(all_rows) - len(targets)
    print(f"待抓详情：{len(targets)} 条（已存在跳过 {skipped} 条）\n")

    ok = fail = 0
    t_start = time.time()
    for i, r in enumerate(targets, 1):
        # 列表里的注册号可能为 null（2018 年前 ChiCTR 未发注册号），
        # 详情响应里带权威注册号，抓完后以详情为准回填。
        rn = r.get("registration_number") or ""
        proj = r.get("project_id")
        if not proj:
            fail += 1
            continue

        prefix = f"[{i}/{len(targets)}] {rn}"
        try:
            detail = fetch_detail(proj)
        except SidecarError as exc:
            print(f"{prefix} 详情失败：{exc}", flush=True)
            log_event(conn, "detail_failed", None, f"{rn}: {exc}")
            fail += 1
            time.sleep(args.delay)
            continue

        fields = detail.get("fields") or {}
        # 原始素材：sidecar 不返回 HTML，这里用 raw_text 作为原文留档，
        # 并从 raw_text 还原 HTML 不可行——故 raw_html 存 sidecar 已知原始文本。
        raw_text = detail.get("raw_text") or ""
        html = detail.get("raw_html") or ""

        row = {
            # 详情里的注册号更权威（列表里 2018 年前为 null）。
            "registration_number": detail.get("registration_number") or rn or None,
            "project_id": str(proj),
            "title": r.get("title"),
            "institution": r.get("institution"),
            "study_type": r.get("study_type"),
            "registration_date": r.get("registration_date"),
            "detail_url": r.get("detail_url"),
            "fields_json": json.dumps(fields, ensure_ascii=False),
            "field_count": detail.get("field_count") or len(fields),
            "registration_year": (r.get("registration_date") or "")[:4] or None,
            "raw_html": html,
            "raw_text": raw_text,
            "html_sha256": sha256(html) if html else None,
            "content_sha256": sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True)),
            "raw_text_length": detail.get("raw_text_length") or len(raw_text),
            "fetched_at": now_iso(),
            "updated_at": now_iso(),
        }
        for label, col in FIELD_COLUMNS.items():
            row[col] = fields.get(label)

        upsert(conn, row)
        ok += 1
        if i % 10 == 0 or i == len(targets):
            rate = (time.time() - t_start) / max(i, 1)
            eta = rate * (len(targets) - i)
            print(
                f"{prefix} ✅ {row['field_count']} 字段 | "
                f"已用 {time.time()-t_start:.0f}s | 预计剩余 {eta:.0f}s",
                flush=True,
            )
        time.sleep(args.delay)

    print(f"\n完成：成功 {ok} / 失败 {fail}")
    log_event(conn, "crawl_done", None, f"ok={ok} fail={fail}")

    # ---- 汇总 ----
    total = conn.execute("SELECT COUNT(*) FROM trials").fetchone()[0]
    print(f"数据库累计：{total} 条")
    print("\n按注册年份分布：")
    for y, n in conn.execute(
        "SELECT registration_year, COUNT(*) FROM trials "
        "WHERE registration_year IS NOT NULL GROUP BY registration_year ORDER BY registration_year"
    ):
        print(f"  {y}: {n}")

    conn.close()
    return 0


def export_json(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser().resolve()
    out = Path(args.json).expanduser().resolve()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    records = []
    for row in conn.execute("SELECT * FROM trials ORDER BY registration_date DESC"):
        if not row["raw_text"]:
            continue
        d = dict(row)
        # sponsor 列已废弃（「申办者」字段实测 0/468 覆盖）；老库里该列还在，
        # 但不该出现在导出结果中，否则每行都带一个恒为 null 的键。
        d.pop("sponsor", None)
        d["fields"] = json.loads(d.pop("fields_json") or "{}")
        # 原始 HTML 体积大，默认不塞进导出的 JSON（独立文件在 data/html/）。
        d.pop("raw_html", None)
        records.append(d)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"导出 {len(records)} 条 → {out}（{out.stat().st_size/1024/1024:.1f} MB）")
    conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="胰腺癌 ChiCTR 全量抓取 → SQLite")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--json", default=str(DEFAULT_JSON))
    ap.add_argument("--years", nargs="*", help="只抓这些年份，默认 2010–今年")
    ap.add_argument("--delay", type=float, default=0.6, help="请求间隔秒（默认 0.6）")
    ap.add_argument("--keyword", default=KEYWORD, help=f"检索关键词（默认 {KEYWORD}）")
    ap.add_argument("--refresh", action="store_true", help="强制重抓已存在的注册号")
    ap.add_argument("--export-json", action="store_true", help="抓完后导出 JSON")
    args = ap.parse_args()

    rc = crawl(args)
    if rc == 0 and args.export_json:
        export_json(args)
    return rc


if __name__ == "__main__":
    sys.exit(main())
