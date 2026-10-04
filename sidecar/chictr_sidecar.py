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

        # 注册号有两种形态：新式 ChiCTR2300077564，老式 ChiCTR-IIR-17013424
        regno = next((c for c in flat if REGNO_RE.match(c)), None)

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


# 注册号有两种形态：
#   新式（2018 起）  ChiCTR2300077564
#   老式（2018 前）  ChiCTR-IIR-17013424 / ChiCTR-IPR-... / ChiCTR-ONC-... 等
# 老式编号只出现在详情页，搜索结果列表里 registration_number 为 null。
REGNO_RE = re.compile(r"ChiCTR(?:-[A-Z]{2,4})?-?\d{4,}")

# 详情页字段标签。
# 这份清单是对 468 个真实详情页做标签聚合后得到的（每条记录出现一次的
# 高频标签即页面固定表单字段），不再靠人工猜测——早期版本只列了 29 个，
# 导致联络人/电话/邮箱/伦理委员会联系方式等大量字段根本没被抽取。
DETAIL_LABELS = [
    # ---- 注册信息 ----
    "注册号", "注册号状态", "注册时间", "最近更新日期",
    "注册题目", "注册题目简写", "研究课题的正式科学名称", "研究课题代号(代码)",
    "在二级注册机构或其它机构的注册号",
    # ---- 联系人（申请注册联系人 / 研究负责人 各一套）----
    "申请注册联系人", "申请注册联系人电话", "申请注册联系人传真",
    "申请注册联系人电子邮件", "申请注册联系人通讯地址", "申请注册联系人邮政编码",
    "研究负责人", "研究负责人电话", "研究负责人传真", "研究负责人电子邮件",
    "研究负责人通讯地址", "研究负责人邮政编码",
    "申请单位网址(自愿提供)", "研究负责人网址(自愿提供)",
    "申请人所在单位", "研究负责人所在单位",
    # ---- 伦理委员会 ----
    "是否获伦理委员会批准", "伦理委员会批件文号", "伦理委员会批件附件",
    "批准本研究的伦理委员会名称", "伦理委员会批准日期", "伦理委员会联系人",
    "伦理委员会联系地址", "伦理委员会联系人电话", "伦理委员会联系人邮箱",
    # ---- 单位与来源 ----
    "研究实施负责（组长）单位", "研究实施负责（组长）单位地址",
    "试验主办单位(项目批准或申办者)", "申办者",
    "经费或物资来源", "研究经费来源", "研究疾病", "研究疾病代码",
    # ---- 设计与目的 ----
    "研究类型", "研究所处阶段", "研究设计", "研究目的",
    "药物成份或治疗方案详述", "研究实施时间", "征募观察对象时间",
    # ---- 干预与样本 ----
    "干预措施", "组别", "样本量", "干预措施代码",
    "研究实施地点", "单位级别", "国家", "省(直辖市)", "市(区县)",
    "单位(医院)", "具体地址",
    # ---- 结局指标（复合块）----
    "测量指标", "指标中文名", "指标类型", "测量时间点", "测量方法",
    "主要终点", "次要终点", "主要研究终点", "次要研究终点",
    # ---- 标本 ----
    "采集人体标本", "标本中文名", "标本去向", "说明",
    # ---- 招募与共享 ----
    "征募研究对象情况", "年龄范围", "性别",
    "随机方法（请说明由何人用什么方法产生随机序列）",
    "是否公开试验完成后的统计结果", "盲法", "是否共享原始数据",
    "共享原始数据的方式（说明", "数据采集和管理（说明",
    "数据与安全监察委员会", "注册人",
]

# 这几个是**区块标题**而非字段：它们的值单元格里放的是嵌套子表格，
# 「标题行 + 下一行标签」的朴素配对会把子表格里的第一个标签当成它们的值。
# 因此不抽取它们本身，只把子表格里的真实字段抽出来。
SECTION_ONLY_LABELS = {
    "测量指标", "采集人体标本", "试验主办单位(项目批准或申办者)",
    "研究实施地点", "申办者", "干预措施",
}

# 标签在 HTML 纯文本化后可能带上的尾部噪音（如 "申办者)"、"申请人所在单位"），
# 匹配时允许标签与冒号之间夹这些字符。
_LABEL_TAIL_NOISE = r"[)\s（(）]*"

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
# 除字段名本身，还有些**子标签**只出现在复合块内部，不单独作为字段抽取，
# 但必须能终止前一个字段。实测「结局指标」块形态：
#   结局指标： 指标中文名： 手术转化率 指标类型： 主要指标 Outcome： … 测量方法： 主要终点： …
# 若不把它们计入边界，前一个字段的值会一路吞掉后面的子标签与内容。
_SUB_BOUNDARIES = [
    "指标中文名", "指标类型", "测量时间点", "测量方法", "评估时间节点",
    "Measure time point of outcome", "Assessment time points", "Measure method",
    "Outcome", "Type", "Primary indicator", "Secondary indicator",
]
_ALL_BOUNDARIES = DETAIL_LABELS + DETAIL_LABELS_EN + _SUB_BOUNDARIES
_BOUNDARY_RE = "|".join(re.escape(x) for x in sorted(_ALL_BOUNDARIES, key=len, reverse=True))
_EN_BOUNDARY_RE = "|".join(
    re.escape(x) for x in sorted(DETAIL_LABELS_EN + _SUB_BOUNDARIES, key=len, reverse=True)
)

# 值可能非常长：实测「纳入标准」2242 字、「排除标准」1410 字、
# 「研究实施地点」6964 字。早期实现用 (.{0,900}?) 截断，导致这些字段
# 被静默丢弃（正则匹配不到 → 字段整个消失）。这里放宽到 60K，
# 足够覆盖任何真实字段，同时仍能防止正则回溯失控。
_MAX_FIELD_LEN = 60000


def _td_cells(html: str) -> list[str]:
    """按表格结构切出所有 <td> 的纯文本（保留单元格边界）。

    详情页是标准表格：每个字段的标签在 <td class="left_title"> 里（含
    <p class="cn">中文：</p><p class="en">English：</p>），值在**紧随其后的
    那个 <td>** 里。按 <td> 切开再配对，比把整页压成一串文本后用正则去猜
    边界可靠得多——后者会让英文标签混进值里，也会让值越过相邻字段。
    """
    cells: list[str] = []
    for td in re.findall(r"<td[^>]*>(.*?)</td>", html, re.S | re.I):
        # 单元格内若还有嵌套表格（研究实施地点、结局指标等复合块），
        # 先整体压平，但保留内部换行以免相邻子项粘连。
        txt = re.sub(r"</(p|div|tr|li)>", "\n", td, flags=re.I)
        txt = re.sub(r"<br\s*/?>", "\n", txt, flags=re.I)
        txt = _TAG_RE.sub(" ", txt)
        txt = txt.replace("&nbsp;", " ")
        cells.append(_clean_multiline(txt))
    return cells


def _clean_multiline(s: str) -> str:
    """压空白但保留换行（用于在单元格内部区分层级）。

    必须在这里解码 HTML 实体：页面用 `&#32;` / `&#39;` 等十进制实体书写
    部分单元格文本（实测「具体地址」「指标中文名」），若不解码，抽出的值
    会带着字面 `&#32;` 入库，与 HTML 原文（真实空格）对不上。
    """
    s = html_mod.unescape(s)
    s = s.replace("\u00a0", " ").replace("\r", "\n")
    s = re.sub(r"[ \t\u3000]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def _strip_label(text: str) -> str:
    """剥掉单元格开头的「中文标签：」或「English label：」前缀。"""
    t = text.strip()
    # 去掉所有前导的「XXX：」短标签（中文或英文），最多 2 层
    for _ in range(2):
        m = re.match(r"^([^：:\n]{1,40}?)\s*[：:]\s*(.*)$", t, re.S)
        if not m:
            break
        head = m.group(1).strip()
        # 只剥看起来像标签的（不长、不含句末标点）
        if len(head) <= 30 and not re.search(r"[。！？；]$", head):
            t = m.group(2).strip()
        else:
            break
    return t.strip(" ：:;；")


def parse_detail(html: str) -> dict[str, Any]:
    """把详情页的「字段：值」对提取为 dict。

    实现分两步：
      1. 表格结构解析（主路径）：按 <td> 切分，标签单元格与值单元格相邻配对。
         这是页面真实结构，能干净拿到「值」，不会把英文标签吞进值里。
      2. 纯文本正则回退：极少数字段不落在标准 <td> 结构里（例如位于嵌套
         表格或跨行单元格），用压平文本 + 前瞻断言兜底补齐。

    纯文本回退里必须先把正文起点定位到「注册号：」之后：页面顶部导航栏也含
    同名文字（实测「经费或物资来源统计」在偏移 141、「征募研究对象情况统计」
    在 152，早于正文真实字段），否则会命中导航栏取到串味的值。
    """
    plain = _clean(
        _TAG_RE.sub(" ", re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I))
    )

    fields: dict[str, str] = {}

    # ---------- 路径 1：表格结构解析 ----------
    cells = _td_cells(html)
    label_set = set(DETAIL_LABELS)
    for i, cell in enumerate(cells):
        # 标签单元格的判据：开头是「已知中文标签：」。
        m = re.match(r"^([\u4e00-\u9fa5][^：:\n]{0,40}?)\s*[：:]", cell)
        if not m:
            continue
        label = m.group(1).strip()
        if label not in label_set or label in SECTION_ONLY_LABELS:
            continue
        if i + 1 >= len(cells):
            continue
        # 值单元格：剥离可能的前导英文标签（<p class="en">…</p> 被压平后成了
        # 单元格开头的一部分），再取内容。
        val = _clean_multiline(cells[i + 1])
        # 值单元格可能整条就是英文标签 + 值，剥掉英文前缀
        val = re.sub(r"^(?:[A-Za-z][A-Za-z0-9'()/\-\.\s,:]{0,60}?)\s*[：:]\s*", "", val, count=2)
        val = val.strip(" ：:;；")
        # 空值单元格（实测「研究课题代号(代码)：」「注册题目简写：」原页面留空）
        # 必须显式判空后放弃：若继续走纯文本回退，会匹配到扁平文本里紧随的
        # 下一个标签名，抽出 'Study subject ID' 这类伪造值。
        if not val:
            fields[label] = ""
            continue
        fields.setdefault(label, val)

    # ---------- 路径 2：纯文本回退（补结构解析漏掉的字段）----------
    body_start = 0
    m_body = re.search(r"注册号\s*[：:]\s*(?:" + _EN_BOUNDARY_RE + r"\s*[：:]\s*)?", plain)
    if m_body:
        body_start = m_body.start()

    body = plain[body_start:]
    tail_cut = re.search(r"(版权声明|Copyright|网站地图|友情链接)\s*[：:]?", body)
    if tail_cut:
        body = body[: tail_cut.start()]

    en_lead = r"(?:(?:" + _EN_BOUNDARY_RE + r")\s*[：:]\s*)*"
    for label in DETAIL_LABELS:
        # 结构解析已给出结论（含"确认为空"）的字段不再回退，
        # 否则空值会被扁平文本里的下一个标签名伪造出一段假值。
        # 区块标题（SECTION_ONLY_LABELS）本身不是字段，回退也会抽到
        # 下一行的英文标签名（实测 'Outcomes'、'Collecting sample(s)…'）。
        if label in fields or label in SECTION_ONLY_LABELS:
            continue
        m = re.search(
            re.escape(label) + _LABEL_TAIL_NOISE + r"[：:]\s*" + en_lead +
            r"(.{0,%d}?)(?=(?:" % _MAX_FIELD_LEN + _BOUNDARY_RE + r")\s*[：:]|$)",
            body,
        )
        if m:
            val = m.group(1).strip(" ：:;；")
            if val:
                fields[label] = val

    regno = None
    m = REGNO_RE.search(plain)
    if m:
        regno = m.group(0)

    # 空值字段不进入输出：结构解析用它阻止回退伪造假值，但对外它只是
    # 「页面该字段留空」，与「字段不存在」在本次抓取里没有区别。
    fields = {k: v for k, v in fields.items() if v}

    return {
        "registration_number": regno,
        "fields": fields,
        "field_count": len(fields),
        "raw_text": plain,
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
            # 原始 HTML 默认不返回（约 250KB，会给 MCP 通道和调用方带来
            # 不必要的负担）。需要留档时加 &raw=1 显式索取。
            if one("raw") in ("1", "true", "yes"):
                data["raw_html"] = body
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
