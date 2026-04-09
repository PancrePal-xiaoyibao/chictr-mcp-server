import { BrowserManager } from "../browser.js";
import { HtmlParser, TrialDetail } from "../parsers/html-parser.js";
import { getProjectIdByRegistrationNumber, searchTrials } from "./search.js";
import { RequestOrchestrator } from "../runtime/orchestrator.js";
import { ChallengeDetector } from "../runtime/challenge-detector.js";
import { globalCacheManager } from "../runtime/cache-singleton.js";

const DETAIL_TTL_MS = 10 * 60 * 1000;

function isDetailEmpty(detail: TrialDetail): boolean {
  const basic = detail.basic_info;
  const study = detail.study_info;
  const contact = detail.contact_info;
  return ![
    basic.registration_number,
    basic.title,
    basic.scientific_title,
    study.disease,
    study.objectives,
    contact.applicant,
    contact.study_leader,
  ].some((v) => (v || "").trim().length > 0);
}

function buildFallbackDetail(html: string, url: string, registrationNumber: string): TrialDetail {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const snippet = plain.slice(0, 6000);
  const titleGuess = (plain.match(/(注册题目|Public title|Scientific title)\s*[:：]\s*([^。；;]{5,120})/)?.[2] || "").trim();

  return {
    basic_info: {
      registration_number: registrationNumber,
      title: titleGuess,
      title_en: "",
      scientific_title: "",
      scientific_title_en: "",
      registration_status: "",
      registration_status_en: "",
      registration_date: "",
      last_update_date: "",
    },
    contact_info: {
      applicant: "",
      applicant_en: "",
      study_leader: "",
      study_leader_en: "",
      applicant_phone: "",
      study_leader_phone: "",
      applicant_email: "",
      study_leader_email: "",
      applicant_institution: "",
      applicant_institution_en: "",
      leader_institution: "",
      leader_institution_en: "",
    },
    study_info: {
      disease: "",
      disease_en: "",
      study_type: "",
      study_type_en: "",
      study_phase: "",
      study_phase_en: "",
      study_design: "",
      study_design_en: "",
      objectives: "",
      objectives_en: "",
    },
    sponsor_info: {
      primary_sponsor: "",
      primary_sponsor_en: "",
      funding_source: "",
      funding_source_en: "",
    },
    raw_text: snippet,
    source_url: url,
  };
}

export async function getTrialDetail(
  browserManager: BrowserManager,
  orchestrator: RequestOrchestrator,
  challengeDetector: ChallengeDetector,
  registrationNumber: string
): Promise<TrialDetail> {
  // 生成缓存键
  const cacheKey = `detail_${registrationNumber}`;
  
  // 检查缓存
  const cachedResult = await globalCacheManager.get<TrialDetail>(cacheKey);
  if (cachedResult && !isDetailEmpty(cachedResult)) {
    // console.log(`[CACHE HIT] 详情缓存命中: ${cacheKey}`);
    return cachedResult;
  }

  if (!challengeDetector.canProceed()) {
    const snapshot = challengeDetector.getSnapshot();
    throw new Error(
      `访问处于冷却期，请稍后重试。cooldown_remaining_ms=${snapshot.cooldown_remaining_ms}`
    );
  }
  
  // console.log(`[CACHE MISS] 详情缓存未命中，执行新请求: ${cacheKey}`);

  // 先尝试从缓存获取项目ID
  let projectId = getProjectIdByRegistrationNumber(registrationNumber);
  
  // 如果缓存中没有，先按注册号搜索一次，拿到真实 project_id
  if (!projectId) {
    try {
      await searchTrials(
        browserManager,
        orchestrator,
        challengeDetector,
        undefined,
        registrationNumber,
        undefined,
        1
      );
      projectId = getProjectIdByRegistrationNumber(registrationNumber);
    } catch {
      // 忽略，继续走兼容旧逻辑兜底
    }
  }

  // 如果仍然没有，则从注册号推导（兼容旧逻辑兜底）
  if (!projectId) {
    projectId = registrationNumber.replace("ChiCTR", "");
  }

  // 构建URL
  const url = `https://www.chictr.org.cn/showproj.html?proj=${projectId}`;

  return browserManager.withPage(async (page, sessionId) => {
    try {
      await orchestrator.execute({
        requestId: `detail-${sessionId}-${projectId}-${Date.now()}`,
        endpoint: "detail",
        handler: async () => {
          // 导航到页面
          await page.goto(url, { waitUntil: "networkidle" });
        },
      });

      // 检查是否需要验证码
      const pageTitle = await page.title();
      if (pageTitle.includes("验证") || pageTitle.includes("Verification") || pageTitle.includes("滑动")) {
        challengeDetector.reportChallenge([
          {
            type: "TITLE",
            confidence: 0.9,
            details: `title=${pageTitle}`,
          },
        ]);
        // 触发验证码，抛出错误提示用户
        throw new Error(
          "检测到滑动验证码，建议：\n" +
          "1. 减少请求频率（增加延迟时间）\n" +
          "2. 使用缓存避免重复请求\n" +
          "3. 考虑更换网络环境或IP"
        );
      }

      await browserManager.randomDelay(3000, 8000); // 增加延迟时间

      // 检查是否页面加载成功
      const title = await page.title();
      if (title.includes("页面未找到") || title.includes("404")) {
        throw new Error(`未找到注册号为 ${registrationNumber} 的试验`);
      }

      // 解析HTML
      const html = await page.content();
      const detail = HtmlParser.parseTrialDetail(html);

      const finalDetail = isDetailEmpty(detail)
        ? buildFallbackDetail(html, url, registrationNumber)
        : detail;

      // 存储到缓存
      await globalCacheManager.set(cacheKey, finalDetail, DETAIL_TTL_MS);
      challengeDetector.recordSuccess();

      return finalDetail;
    } catch (error) {
      throw new Error(`获取试验详情失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// 添加清除详情缓存的函数
export function clearDetailCache(): void {
  globalCacheManager.clearAll();
  // console.log("[CACHE] 详情缓存已清除");
}

// 获取缓存统计信息
export function getDetailCacheStats(): { keys: number; hits: number; misses: number } {
  const stats = globalCacheManager.getStats();
  return {
    keys: stats.l1_keys + stats.l2_keys,
    hits: stats.l1_hits + stats.l2_hits,
    misses: stats.l1_misses + stats.l2_misses
  };
}

export function getDetailCacheStatsV2() {
  return globalCacheManager.getStats();
}
