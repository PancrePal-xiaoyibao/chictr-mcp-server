/**
 * ChiCTR sidecar 客户端。
 *
 * Python sidecar（sidecar/chictr_sidecar.py）负责阿里盾过盾与页面抓取，
 * 这里只做 HTTP 调用 + 到现有 TrialListItem / TrialDetail 类型的映射。
 *
 * 设计原则：
 *   1. 默认关闭。只有显式设置 CHICTR_USE_SIDECAR=1（或 "true"）才启用，
 *      保证不改变现有 Playwright 路径的默认行为。
 *   2. 任何失败都返回 null 并记录原因，由调用方决定是否回退到 Playwright。
 *   3. sidecar 不可达时快速失败（短超时），不拖慢整体流程。
 */

import type { TrialDetail, TrialListItem } from "../parsers/html-parser.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8848";

export interface SidecarStatus {
  enabled: boolean;
  available: boolean;
  baseUrl: string;
  lastError: string | null;
}

export interface SidecarSearchResult {
  total: number | null;
  totalPages: number | null;
  results: TrialListItem[];
}

interface SidecarRawItem {
  project_id?: string;
  registration_number?: string | null;
  title?: string | null;
  institution?: string | null;
  study_type?: string | null;
  registration_date?: string | null;
  detail_url?: string;
}

let lastError: string | null = null;
let lastAvailability = false;

export function isSidecarEnabled(): boolean {
  const raw = (process.env.CHICTR_USE_SIDECAR || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function baseUrl(): string {
  return (process.env.CHICTR_SIDECAR_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function timeoutMs(): number {
  const n = Number(process.env.CHICTR_SIDECAR_TIMEOUT_MS || 30000);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

export function getSidecarStatus(): SidecarStatus {
  return {
    enabled: isSidecarEnabled(),
    available: lastAvailability,
    baseUrl: baseUrl(),
    lastError,
  };
}

async function callSidecar<T>(path: string): Promise<T | null> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      lastError = `sidecar 返回非 JSON（status=${res.status}）`;
      lastAvailability = false;
      return null;
    }

    const obj = payload as Record<string, unknown>;
    if (!res.ok || obj.error) {
      lastError = String(obj.error || `HTTP ${res.status}`);
      lastAvailability = false;
      return null;
    }

    lastError = null;
    lastAvailability = true;
    return payload as T;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastAvailability = false;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测 sidecar 是否在线（供 get_runtime_metrics 等工具使用）。 */
export async function pingSidecar(): Promise<SidecarStatus> {
  if (!isSidecarEnabled()) {
    return getSidecarStatus();
  }
  await callSidecar<{ ok: boolean }>("/health");
  return getSidecarStatus();
}

function toListItem(raw: SidecarRawItem): TrialListItem | null {
  const registrationNumber = (raw.registration_number || "").trim();
  const title = (raw.title || "").trim();
  if (!registrationNumber || !title) {
    return null;
  }
  return {
    registration_number: registrationNumber,
    project_id: (raw.project_id || "").trim(),
    title,
    study_type: (raw.study_type || "").trim(),
    registration_date: (raw.registration_date || "").trim(),
    institution: (raw.institution || "").trim(),
  };
}

/**
 * 通过 sidecar 执行搜索。失败返回 null（调用方决定是否回退 Playwright）。
 */
export async function searchTrialsViaSidecar(options: {
  keyword?: string;
  registrationNumber?: string;
  year?: number;
  maxResults?: number;
}): Promise<SidecarSearchResult | null> {
  if (!isSidecarEnabled()) {
    return null;
  }

  const maxResults = options.maxResults ?? 20;
  const perPage = 10;
  const pages = Math.max(1, Math.min(Math.ceil(maxResults / perPage), 50));

  const params = new URLSearchParams();
  if (options.keyword) params.set("title", options.keyword);
  if (options.registrationNumber) params.set("regno", options.registrationNumber);
  if (options.year !== undefined) params.set("createyear", String(options.year));
  params.set("page", "1");
  params.set("pages", String(pages));

  const payload = await callSidecar<{
    total: number | null;
    total_pages: number | null;
    results: SidecarRawItem[];
  }>(`/search?${params.toString()}`);

  if (!payload) {
    return null;
  }

  const items = (payload.results || [])
    .map(toListItem)
    .filter((x): x is TrialListItem => x !== null)
    .slice(0, maxResults);

  if (items.length === 0) {
    lastError = "sidecar 搜索返回 0 条有效结果";
    return null;
  }

  return {
    total: payload.total ?? null,
    totalPages: payload.total_pages ?? null,
    results: items,
  };
}

/**
 * 通过 sidecar 获取详情。
 *
 * sidecar 的 /detail 返回「中文字段 -> 值」的扁平表；这里把关键字段映射到
 * 现有 TrialDetail 结构，未覆盖的字段留空字符串，raw_text 保留 sidecar 的
 * 原文长度信息，便于调用方判断数据完整度。
 */
export async function getTrialDetailViaSidecar(
  projectId: string,
  registrationNumber: string
): Promise<TrialDetail | null> {
  if (!isSidecarEnabled()) {
    return null;
  }
  if (!projectId) {
    return null;
  }

  const payload = await callSidecar<{
    fields: Record<string, string>;
    registration_number: string | null;
    url: string;
  }>(`/detail?proj=${encodeURIComponent(projectId)}`);

  if (!payload || !payload.fields) {
    return null;
  }

  const f = payload.fields;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = f[k];
      if (v && v.trim()) return v.trim();
    }
    return "";
  };

  return {
    basic_info: {
      registration_number: pick("注册号") || registrationNumber,
      title: pick("注册题目"),
      title_en: "",
      scientific_title: "",
      scientific_title_en: "",
      registration_status: pick("注册号状态"),
      registration_status_en: "",
      registration_date: pick("注册时间"),
      last_update_date: pick("最近更新日期"),
    },
    contact_info: {
      applicant: pick("申请人", "申办者"),
      applicant_en: "",
      study_leader: pick("研究负责人", "主要研究者"),
      study_leader_en: "",
      applicant_institution: "",
      applicant_institution_en: "",
      leader_institution: "",
      leader_institution_en: "",
    },
    study_info: {
      disease: pick("研究疾病"),
      disease_en: "",
      study_type: pick("研究类型"),
      study_type_en: "",
      study_phase: pick("研究分期"),
      study_phase_en: "",
      study_design: pick("研究设计"),
      study_design_en: "",
      objectives: pick("研究目的", "主要研究目的"),
      objectives_en: "",
    },
    sponsor_info: {
      primary_sponsor: pick("申办者"),
      primary_sponsor_en: "",
      funding_source: pick("经费来源"),
      funding_source_en: "",
    },
    inclusion_criteria: pick("纳入标准"),
    exclusion_criteria: pick("排除标准"),
    source_url: payload.url,
  };
}
