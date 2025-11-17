import * as cheerio from "cheerio";

export interface TrialListItem {
  registration_number: string;
  project_id: string; // 从 showproj.html?proj=XXX 中提取的ID
  title: string;
  study_type: string;
  registration_date: string;
  institution: string;
}

// 添加分页信息接口
export interface SearchPagination {
  totalResults: number;
  totalPages: number;
  currentPage: number;
}

export interface TrialDetail {
  basic_info: {
    registration_number: string;
    title: string;
    title_en: string;
    scientific_title: string;
    scientific_title_en: string;
    registration_status: string;
    registration_status_en: string;
    registration_date: string;
    last_update_date: string;
  };
  contact_info: {
    applicant: string;
    applicant_en: string;
    study_leader: string;
    study_leader_en: string;
    applicant_phone?: string;
    study_leader_phone?: string;
    applicant_email?: string;
    study_leader_email?: string;
    applicant_institution: string;
    applicant_institution_en: string;
    leader_institution: string;
    leader_institution_en: string;
  };
  ethics_info?: {
    approved: string;
    committee_name: string;
    committee_name_en: string;
    approval_number?: string;
    approval_date?: string;
  };
  study_info: {
    disease: string;
    disease_en: string;
    study_type: string;
    study_type_en: string;
    study_phase?: string;
    study_phase_en?: string;
    study_design?: string;
    study_design_en?: string;
    objectives: string;
    objectives_en: string;
  };
  sponsor_info: {
    primary_sponsor: string;
    primary_sponsor_en: string;
    secondary_sponsors?: Array<{
      country: string;
      province: string;
      city: string;
      institution: string;
    }>;
    funding_source?: string;
    funding_source_en?: string;
  };
  recruitment_info?: {
    recruitment_status?: string;
    recruitment_status_en?: string;
    study_start_date?: string;
    study_end_date?: string;
    recruitment_start_date?: string;
    recruitment_end_date?: string;
  };
  interventions?: Array<{
    group: string;
    group_en: string;
    sample_size: string;
    intervention: string;
    intervention_en: string;
  }>;
  inclusion_criteria?: string;
  inclusion_criteria_en?: string;
  exclusion_criteria?: string;
  exclusion_criteria_en?: string;
}

export class HtmlParser {
  // 解析搜索列表页
  static parseSearchResults(html: string): { results: TrialListItem[], pagination: SearchPagination } {
    const $ = cheerio.load(html);
    const results: TrialListItem[] = [];

    // 查找表格中的每一行（跳过表头）
    $("table.table1 tr").each((index, element) => {
      if (index === 0) return; // 跳过表头

      const $row = $(element);
      const cells = $row.find("td");

      if (cells.length >= 5) {
        const registrationNumber = $(cells[1]).text().trim();
        const titleLink = $(cells[2]).find("a.tit1");
        const title = titleLink.attr("title") || titleLink.text().trim();
        const institution = $(cells[2]).find("p").text().trim();
        const studyType = $(cells[3]).text().trim();
        const registrationDate = $(cells[4]).text().trim();
        
        // 提取 project_id （从showproj.html?proj=XXX中提取）
        const href = titleLink.attr("href") || "";
        const projMatch = href.match(/proj=(\d+)/);
        const projectId = projMatch ? projMatch[1] : "";

        if (registrationNumber && title && projectId) {
          results.push({
            registration_number: registrationNumber,
            project_id: projectId,
            title: title,
            study_type: studyType,
            registration_date: registrationDate,
            institution: institution,
          });
        }
      }
    });

    // 提取分页信息
    const pagination: SearchPagination = {
      totalResults: 0,
      totalPages: 1,
      currentPage: 1
    };

    // 查找总结果数
    const totalText = $("#data-total").text() || $("div:contains('共检索到')").first().text() || $("div.pagerbox").text();
    if (totalText) {
      const totalMatch = totalText.match(/\d+/g);
      if (totalMatch && totalMatch.length > 0) {
        // 取第一个数字作为总结果数
        pagination.totalResults = parseInt(totalMatch[0], 10);
        
        // 如果有多个数字，第二个可能是总页数
        if (totalMatch.length > 1) {
          pagination.totalPages = parseInt(totalMatch[1], 10);
        }
      }
    }

    // 查找总页数
    const pageText = $("div.pagination, .page, .pagerbox").text();
    if (pageText) {
      const pageMatch = pageText.match(/共\s*(\d+)\s*页/);
      if (pageMatch) {
        pagination.totalPages = parseInt(pageMatch[1], 10);
      } else {
        // 尝试其他模式
        const pageMatch2 = pageText.match(/共(\d+)页/);
        if (pageMatch2) {
          pagination.totalPages = parseInt(pageMatch2[1], 10);
        }
      }
      
      // 查找当前页
      const currentMatch = pageText.match(/第\s*(\d+)\s*页/) || pageText.match(/第(\d+)页/);
      if (currentMatch) {
        pagination.currentPage = parseInt(currentMatch[1], 10);
      }
    }

    return { results, pagination };
  }

  // 解析详情页
  static parseTrialDetail(html: string): TrialDetail {
    const $ = cheerio.load(html);

    // 辅助函数：提取表格中的数据
    const getTableValue = (labelCn: string): string => {
      let value = "";
      $("table").each((_, table) => {
        $(table)
          .find("tr")
          .each((_, row) => {
            const $row = $(row);
            const label = $row.find(".left_title p.cn").text().trim();
            if (label.includes(labelCn)) {
              value = $row.find("td:not(.left_title)").first().text().trim();
              return false;
            }
          });
        if (value) return false;
      });
      return value;
    };

    const getTableValueEn = (labelEn: string): string => {
      let value = "";
      $("table").each((_, table) => {
        $(table)
          .find("tr")
          .each((_, row) => {
            const $row = $(row);
            const label = $row.find(".left_title p.en").text().trim();
            if (label.includes(labelEn)) {
              value = $row.find("td:not(.left_title)").first().text().trim();
              return false;
            }
          });
        if (value) return false;
      });
      return value;
    };

    // 提取基本信息
    const basic_info = {
      registration_number: getTableValue("注册号："),
      title: getTableValue("注册题目："),
      title_en: getTableValueEn("Public title："),
      scientific_title: getTableValue("研究课题的正式科学名称："),
      scientific_title_en: getTableValueEn("Scientific title："),
      registration_status: getTableValue("注册号状态："),
      registration_status_en: getTableValueEn("Registration Status："),
      registration_date: getTableValue("注册时间："),
      last_update_date: getTableValue("最近更新日期："),
    };

    // 提取联系信息
    const contact_info = {
      applicant: getTableValue("申请注册联系人："),
      applicant_en: getTableValueEn("Applicant："),
      study_leader: getTableValue("研究负责人："),
      study_leader_en: getTableValueEn("Study leader："),
      applicant_phone: getTableValue("申请注册联系人电话："),
      study_leader_phone: getTableValue("研究负责人电话："),
      applicant_email: getTableValue("申请注册联系人电子邮件："),
      study_leader_email: getTableValue("研究负责人电子邮件："),
      applicant_institution: getTableValue("申请人所在单位："),
      applicant_institution_en: getTableValueEn("Applicant's institution："),
      leader_institution: getTableValue("研究负责人所在单位："),
      leader_institution_en: getTableValueEn("Affiliation of the Leader："),
    };

    // 提取伦理信息
    const ethics_info = {
      approved: getTableValue("是否获伦理委员会批准："),
      committee_name: getTableValue("批准本研究的伦理委员会名称："),
      committee_name_en: getTableValueEn("Name of the ethic committee："),
      approval_number: getTableValue("伦理委员会批件文号："),
      approval_date: getTableValue("伦理委员会批准日期："),
    };

    // 提取研究信息
    const study_info = {
      disease: getTableValue("研究疾病："),
      disease_en: getTableValueEn("Target disease："),
      study_type: getTableValue("研究类型："),
      study_type_en: getTableValueEn("Study type："),
      study_phase: getTableValue("研究所处阶段："),
      study_phase_en: getTableValueEn("Study phase："),
      study_design: getTableValue("研究设计："),
      study_design_en: getTableValueEn("Study design："),
      objectives: getTableValue("研究目的："),
      objectives_en: getTableValueEn("Objectives of Study："),
    };

    // 提取主办单位信息
    const sponsor_info = {
      primary_sponsor: getTableValue("研究实施负责（组长）单位："),
      primary_sponsor_en: getTableValueEn("Primary sponsor："),
      funding_source: getTableValue("经费或物资来源："),
      funding_source_en: getTableValueEn("Source(s) of funding："),
    };

    // 提取招募信息
    const recruitment_info = {
      recruitment_status: getTableValue("征募研究对象情况："),
      study_start_date: getTableValue("研究实施时间(开始)"),
      study_end_date: getTableValue("研究实施时间(结束)"),
    };

    // 提取干预措施
    const interventions: Array<{
      group: string;
      group_en: string;
      sample_size: string;
      intervention: string;
      intervention_en: string;
    }> = [];

    $("table").each((_, table) => {
      const $table = $(table);
      if ($table.find(".left_title:contains('干预措施')").length > 0) {
        $table.find("table.noComma").each((_, subTable) => {
          const $subTable = $(subTable);
          let group = "";
          let groupEn = "";
          let sampleSize = "";
          let intervention = "";
          let interventionEn = "";

          $subTable.find("tr").each((_, row) => {
            const $row = $(row);
            const cells = $row.find("td");

            cells.each((idx, cell) => {
              const $cell = $(cell);
              const text = $cell.text().trim();

              if (text.includes("组别：")) {
                group = $cell.next().text().trim();
              } else if (text.includes("Group：")) {
                groupEn = $cell.next().text().trim();
              } else if (text.includes("样本量：")) {
                sampleSize = $cell.next().text().trim();
              } else if (text.includes("Sample size：")) {
                if (!sampleSize) {
                  sampleSize = $cell.next().text().trim();
                }
              } else if (text.includes("干预措施：")) {
                intervention = $cell.next().text().trim();
              } else if (text.includes("Intervention：")) {
                interventionEn = $cell.next().text().trim();
              }
            });
          });

          if (group || intervention) {
            interventions.push({
              group,
              group_en: groupEn,
              sample_size: sampleSize,
              intervention,
              intervention_en: interventionEn,
            });
          }
        });
      }
    });

    // 提取纳入排除标准
    const inclusion_criteria = getTableValue("纳入标准：");
    const inclusion_criteria_en = getTableValueEn("Inclusion criteria");
    const exclusion_criteria = getTableValue("排除标准：");
    const exclusion_criteria_en = getTableValueEn("Exclusion criteria：");

    return {
      basic_info,
      contact_info,
      ethics_info: ethics_info.approved ? ethics_info : undefined,
      study_info,
      sponsor_info,
      recruitment_info: recruitment_info.recruitment_status
        ? recruitment_info
        : undefined,
      interventions: interventions.length > 0 ? interventions : undefined,
      inclusion_criteria: inclusion_criteria || undefined,
      inclusion_criteria_en: inclusion_criteria_en || undefined,
      exclusion_criteria: exclusion_criteria || undefined,
      exclusion_criteria_en: exclusion_criteria_en || undefined,
    };
  }

  // 提取总数
  static extractTotalCount(html: string): number {
    const $ = cheerio.load(html);
    const totalText = $("#data-total").text().trim();
    return parseInt(totalText) || 0;
  }
}
