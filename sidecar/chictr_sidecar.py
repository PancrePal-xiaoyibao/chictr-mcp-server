"""ChiCTR 阿里盾过盾 sidecar。

设计要点（见 dev/browser-removal/SCRAPLING_SOLUTION.md 的实测依据）：

  1. 挑战只在 cookie 缺失/过期时解一次（约每小时一次），而不是每个请求一次。
  2. 解出的 acw_sc__v2 cookie 用纯 HTTP 客户端复用，并发亦可用（实测 5/5）。
  3. 浏览器（StealthySession）是「低频 cookie 刷新器」，不是请求主路径。

对外暴露一个极小的 HTTP JSON 接口，供 Node 侧 MCP server 调用：
    GET /health
    GET /search?title=&regno=&createyear=&page=&pages=
    GET /detail?proj=<id>
"""

from __future__ import annotations

import argparse
import html as html_mod
import json
import logging
import os
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from scrapling.fetchers import FetcherSession, StealthySession

log = logging.getLogger("chictr_sidecar")

BASE = "https://www.chictr.org.cn"
SEARCH_URL = f"{BASE}/searchproj.html"
DETAIL_URL = f"{BASE}/showproj.html"

# acw_sc__v2 的有效期约 1 小时；留 5 分钟安全余量。
COOKIE_TTL_SECONDS = 55 * 60
# 判定「拿到真实页面」的标记：挑战页一定不含这些。
REAL_PAGE_MARKERS = ("retrieve.js", "myPagination.js", "showproj")


class ChallengeSolver:
    """负责在必要时过一次阿里盾挑战，并缓存 acw_sc__v2 cookie。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cookies: dict[str, str] = {}
        self._solved_at: float = 0.0
        self._solve_count = 0
        self._last_error: str | None = None

    # ---- cookie 生命周期 -------------------------------------------------

    def is_fresh(self) -> bool:
        return bool(self._cookies.get("acw_sc__v2")) and (
            time.time() - self._solved_at < COOKIE_TTL_SECONDS
        )

    def cookies(self) -> dict[str, str]:
        return dict(self._cookies)

    def invalidate(self, reason: str) -> None:
        log.warning("cookie 失效，下次请求将重新过盾：%s", reason)
        self._cookies = {}
        self._solved_at = 0.0

    def stats(self) -> dict[str, Any]:
        return {
            "fresh": self.is_fresh(),
            "age_seconds": round(time.time() - self._solved_at, 1) if self._solved_at else None,
            "solve_count": self._solve_count,
            "last_error": self._last_error,
            "cookie_names": sorted(self._cookies),
        }

    # ---- 过盾 ------------------------------------------------------------

    def ensure(self) -> dict[str, str]:
        """返回一组可用的 cookie；必要时先跑一次浏览器挑战。"""
        if self.is_fresh():
            return self.cookies()
        with self._lock:
            # 双重检查：等锁期间可能已被其他线程刷新。
            if self.is_fresh():
                return self.cookies()
            self._solve()
            return self.cookies()

    def _solve(self) -> None:
        log.info("启动无头浏览器过一次阿里盾挑战 …")
        started = time.time()
        try:
            with StealthySession(headless=True, solve_cloudflare=True) as session:
                page = session.fetch(SEARCH_URL, google_search=False, timeout=90000)
                body = _text(page)
                if "acw_sc__v2" in body and "retrieve.js" not in body:
                    raise RuntimeError("挑战未通过：仍返回挑战页")
                raw = session.context.cookies()
        except Exception as exc:  # noqa: BLE001 - 需要把失败原因上报给调用方
            self._last_error = f"{type(exc).__name__}: {exc}"
            log.error("过盾失败：%s", self._last_error)
            raise

        cookies = {c["name"]: c["value"] for c in raw if c.get("name")}
        if "acw_sc__v2" not in cookies:
            self._last_error = "浏览器未产出 acw_sc__v2 cookie"
            raise RuntimeError(self._last_error)

        self._cookies = cookies
        self._solved_at = time.time()
        self._solve_count += 1
        self._last_error = None
        log.info(
            "过盾成功，耗时 %.1fs，cookie=%s", time.time() - started, sorted(cookies)
        )


class ChictrClient:
    """纯 HTTP 抓取；发现挑战页就通知 solver 刷新 cookie 并重试一次。"""

    def __init__(self, solver: ChallengeSolver) -> None:
        self.solver = solver
        self._session = FetcherSession(
            impersonate="chrome", stealthy_headers=True, retries=2, timeout=45
        )
        # FetcherSession 是工厂式 context manager：必须在 with 内才会构造
        # _SyncSessionLogic（真正带 get() 的对象）。这里进入一次并保持常驻，
        # 由 close() 负责退出，避免每个请求重建连接池。
        self._http = self._session.__enter__()
        self._lock = threading.Lock()

    def close(self) -> None:
        try:
            self._session.__exit__(None, None, None)
        except Exception:  # noqa: BLE001
            log.debug("关闭 HTTP 会话时出错", exc_info=True)

    def get_html(self, url: str, *, _retry: bool = True) -> tuple[int, str]:
        cookies = self.solver.ensure()
        try:
            # curl_cffi 的底层 session 并非线程安全，串行化访问。
            with self._lock:
                page = self._http.get(url, cookies=cookies)
            status, body = page.status, _text(page)
        except Exception as exc:  # noqa: BLE001
            log.warning("请求异常 %s：%s", url, exc)
            if _retry:
                self.solver.invalidate(f"request error: {exc}")
                return self.get_html(url, _retry=False)
            raise

        if _is_challenge(body) and _retry:
            self.solver.invalidate(f"挑战页返回 (status={status})")
            return self.get_html(url, _retry=False)

        return status, body


# ---------------------------------------------------------------------------
# HTML 解析
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _text(page: Any) -> str:
    body = getattr(page, "body", None)
    if body is None:
        body = str(page)
    if isinstance(body, bytes):
        return body.decode("utf-8", "replace")
    return str(body)


def _is_challenge(html: str) -> bool:
    if "acw_sc__v2" in html and not any(m in html for m in REAL_PAGE_MARKERS):
        return True
    return "<title>405</title>" in html or "acw_sc__v2" in html


def _clean(text: str) -> str:
    text = html_mod.unescape(text)
    text = text.replace("\u00a0", " ").replace("\r", " ").replace("\n", " ")
    return _WS_RE.sub(" ", text).strip()


def parse_search(html: str) -> dict[str, Any]:
    """从搜索结果页解析出试验列表。

    结果表结构（实测）：
      <tr> 历史版本 | 注册号 | 注册题目 | 注册机构 | 研究类型 | 注册时间 </tr>
    """
    total = None
    total_pages = None
    # 实测（静态 HTML 内）：共检索到 <span id="data-total">469</span> 个符合检索条件的试验。
    m = re.search(r'id="data-total"[^>]*>\s*([\d,]+)', html)
    if m:
        total = int(m.group(1).replace(",", ""))
    # 分页栏由 js/myPagination.js 客户端渲染，静态 HTML 中没有总页数，
    # 因此按「每页 10 条」推算，供调用方决定是否需要继续翻页。
    if total:
        total_pages = (total + 9) // 10

    results: list[dict[str, Any]] = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        proj = re.search(r"showproj\.html\?proj=(\d+)", row)
        if not proj:
            continue

        # 实测列序：[0]历史版本 [1]注册号 [2]题目(<a>)+机构(<p>) [3]研究类型 [4]注册时间
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        flat = [_clean(_TAG_RE.sub(" ", td)) for td in tds]

        regno = next((c for c in flat if re.match(r"^ChiCTR\d+", c)), None)

        # 题目取 <a> 的 title 属性（最干净），退回 <a> 内文本
        title = None
        cell2 = tds[2] if len(tds) > 2 else row
        a = re.search(r"<a[^>]*>", cell2, re.I)
        if a and re.search(r'\btitle="([^"]*)"', a.group(0)):
            title = _clean(re.search(r'\btitle="([^"]*)"', a.group(0)).group(1))
        else:
            am = re.search(r"<a[^>]*>(.*?)</a>", cell2, re.S | re.I)
            if am:
                title = _clean(_TAG_RE.sub(" ", am.group(1)))

        # 机构取该单元格里的 <p>
        institution = None
        pm = re.search(r"<p[^>]*>(.*?)</p>", cell2, re.S | re.I)
        if pm:
            institution = _clean(_TAG_RE.sub(" ", pm.group(1)))

        tail = [c for c in flat[3:] if c]
        results.append(
            {
                "project_id": proj.group(1),
                "registration_number": regno,
                "title": title,
                "institution": institution,
                "study_type": tail[0] if len(tail) > 0 else None,
                "registration_date": tail[1] if len(tail) > 1 else None,
                "detail_url": f"{BASE}/showproj.html?proj={proj.group(1)}",
            }
        )
    return {
        "total": total,
        "total_pages": total_pages,
        "returned": len(results),
        "results": results,
    }


# 详情页常见字段（中英并列，实测标签）
DETAIL_LABELS = [
    "注册号", "注册时间", "最近更新日期", "注册号状态", "注册题目",
    "研究疾病", "研究类型", "研究分期", "研究设计", "干预措施",
    "主要研究目的", "次要研究目的", "纳入标准", "排除标准", "研究实施时间",
    "申办者", "主要研究者", "研究负责人", "伦理委员会", "样本量",
    "目标样本量", "招募状态", "注册机构", "研究实施地点", "经费来源",
]

# 详情页在中文字段后紧跟英文标签（同一行中英对照），这些英文串同样构成
# 字段边界，否则「注册题目」会把后面的 Public title 一并吞掉。
DETAIL_LABELS_EN = [
    "Registration number", "Date of Registration", "Date of Last Refreshed on",
    "Registration Status", "Public title", "Acronym", "Scientific title",
    "Target disease", "Target disease code", "Study type", "Study phase",
    "Study design", "Interventions", "Inclusion criteria", "Exclusion criteria",
    "Study execute time", "Recruitment status", "Sample size", "Sponsor",
    "Study leader", "Applicant", "Ethics Committee", "Study implementing site",
    "Funding source", "Primary sponsor", "Secondary sponsor", "Primary outcome(s)",
    "Key outcome(s)", "Study purpose", "Objectives",
]

# 所有字段边界（中+英），用于值截断的前瞻断言。
_ALL_BOUNDARIES = DETAIL_LABELS + DETAIL_LABELS_EN
_BOUNDARY_RE = "|".join(re.escape(x) for x in sorted(_ALL_BOUNDARIES, key=len, reverse=True))
_EN_BOUNDARY_RE = "|".join(
    re.escape(x) for x in sorted(DETAIL_LABELS_EN, key=len, reverse=True)
)


def parse_detail(html: str) -> dict[str, Any]:
    """把详情页的「字段：值」对提取为 dict。

    详情页每一行的真实形态是「中文标签：英文标签：值」，例如：

        注册时间： Date of Registration： 2026-09-20 00:00:00
        注册题目： <标题> Public title： <title>

    因此不能在中文标签后立刻把英文标签当边界，否则会截断成空值。
    做法：先跳过紧跟的中文/英文标签对，再从真实值开始，遇到下一个标签结束。
    """
    plain = _clean(
        _TAG_RE.sub(" ", re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I))
    )

    # 值开头允许出现 1~2 个「英文标签：」前缀，逐一剥掉。
    en_lead = r"(?:(?:" + _EN_BOUNDARY_RE + r")\s*[：:]\s*)*"

    fields: dict[str, str] = {}
    for label in DETAIL_LABELS:
        m = re.search(
            re.escape(label) + r"\s*[：:]\s*" + en_lead +
            r"(.{0,900}?)(?=(?:" + _BOUNDARY_RE + r")\s*[：:]|$)",
            plain,
        )
        if m:
            val = m.group(1).strip(" ：:;；")
            if val:
                fields[label] = val

    regno = None
    m = re.search(r"ChiCTR\d{6,}", plain)
    if m:
        regno = m.group(0)

    return {
        "registration_number": regno,
        "fields": fields,
        "field_count": len(fields),
        "raw_text_length": len(plain),
    }


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


def make_handler(solver: ChallengeSolver, client: ChictrClient):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: A003
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, payload: dict[str, Any], status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            one = lambda k, d=None: (qs.get(k) or [d])[0]  # noqa: E731

            try:
                if parsed.path == "/health":
                    return self._send({"ok": True, "solver": solver.stats()})

                if parsed.path == "/search":
                    return self._handle_search(one)
                if parsed.path == "/detail":
                    return self._handle_detail(one)

                return self._send({"error": "not found", "path": parsed.path}, 404)
            except Exception as exc:  # noqa: BLE001
                log.exception("处理 %s 失败", self.path)
                return self._send(
                    {"error": f"{type(exc).__name__}: {exc}", "path": self.path}, 502
                )

        def _handle_search(self, one) -> None:
            page = int(one("page", "1") or 1)
            pages = max(1, min(int(one("pages", "1") or 1), 50))
            params: dict[str, str] = {"btngo": "btn"}
            if one("title"):
                params["title"] = one("title")
            if one("regno"):
                params["regno"] = one("regno")
            if one("createyear"):
                params["createyear"] = one("createyear")
            # 副本用于回显，避免被下面的翻页循环改写。
            echo_query = dict(params, page=page, pages=pages)

            collected: list[dict[str, Any]] = []
            total = None
            total_pages = None
            fetched_pages = 0
            for offset in range(pages):
                params["page"] = str(page + offset)
                url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"
                status, body = client.get_html(url)
                if _is_challenge(body):
                    return self._send(
                        {"error": "challenge_unsolved", "status": status}, 503
                    )
                parsed = parse_search(body)
                if total is None:
                    total = parsed["total"]
                    total_pages = parsed["total_pages"]
                if not parsed["results"]:
                    break
                collected.extend(parsed["results"])
                fetched_pages += 1
                # 已到最后一页则提前结束
                if parsed["total_pages"] and page + offset >= parsed["total_pages"]:
                    break

            return self._send(
                {
                    "ok": True,
                    "source": "chictr_direct",
                    "query": echo_query,
                    "total": total,
                    "total_pages": total_pages,
                    "returned": len(collected),
                    "pages_fetched": fetched_pages,
                    "results": collected,
                }
            )

        def _handle_detail(self, one) -> None:
            proj = one("proj")
            if not proj:
                return self._send({"error": "missing proj"}, 400)
            url = f"{DETAIL_URL}?proj={urllib.parse.quote(str(proj))}"
            status, body = client.get_html(url)
            if _is_challenge(body):
                return self._send({"error": "challenge_unsolved", "status": status}, 503)
            data = parse_detail(body)
            data.update({"ok": True, "source": "chictr_direct", "project_id": proj, "url": url})
            return self._send(data)

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description="ChiCTR 阿里盾过盾 sidecar")
    ap.add_argument("--host", default=os.environ.get("CHICTR_SIDECAR_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("CHICTR_SIDECAR_PORT", "8848")))
    ap.add_argument("--warmup", action="store_true", help="启动时先过一次挑战")
    ap.add_argument("--log-level", default=os.environ.get("CHICTR_SIDECAR_LOG", "INFO"))
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    solver = ChallengeSolver()
    client = ChictrClient(solver)

    if args.warmup:
        try:
            solver.ensure()
        except Exception:  # noqa: BLE001
            log.exception("预热失败，服务仍将启动（首次请求时会重试）")

    server = ThreadingHTTPServer((args.host, args.port), make_handler(solver, client))
    log.info("ChiCTR sidecar 监听 http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("收到中断，退出")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
