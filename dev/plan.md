
# 开发目的
基于http服务，构建一个mcp server，查询临床实验信息，以json方式输出

# 技术方案
**采用方案 A: 使用 Playwright 浏览器自动化**
- 优点: 可以绕过反爬虫机制，完整模拟浏览器行为
- 缺点: 资源消耗较大，但稳定性更好

# 开发流程
1. 初始化项目：创建 TypeScript + MCP Server 项目结构
2. 添加依赖：安装 @modelcontextprotocol/sdk, playwright 等
3. 实现核心功能：
   - 搜索临床试验列表（关键词 + 时间范围）
   - 查询单个试验详情（根据注册号）
4. HTML 解析：提取关键字段并转换为 JSON
5. 测试：验证功能正确性
6. 完善文档：README 中英文文档
7. 发布：推送到 GitHub 和 NPM
8. mcp服务需要支持3种主要类型 sse/http/stdio, 并且提供cli命令

# 功能需求
## 1. 搜索临床试验 (search_trials)
**输入参数:**
- `keyword`: 关键词（必填），如 "KRAS G12C"
- `months`: 时间范围（可选），默认 6 个月
- `max_results`: 最大结果数（可选），默认 10

**输出字段:**
- 注册号 (registration_number)
- 注册题目 (title)
- 研究类型 (study_type)
- 注册时间 (registration_date)
- 研究实施单位 (institution)
- 招募状态（从详情页获取）

**排序**: 按注册时间从最近到最远

## 2. 查询试验详情 (get_trial_detail)
**输入参数:**
- `registration_number`: 注册号（必填），如 "ChiCTR2400084905"

**输出字段:**
- 基本信息：注册号、注册题目、注册状态
- 联系信息：申请人、研究负责人、联系方式
- 研究信息：研究类型、研究阶段、研究设计
- 单位信息：研究实施单位、试验主办单位
- 伦理信息：伦理委员会批准情况
- 招募信息：招募状态、研究时间
- 干预措施：各组别的干预措施和样本量
- 纳入排除标准

**输出格式**: JSON

# 网站路径
https://www.chictr.org.cn/searchproj.html?title=KRAS&officialname=&subjectid=&regstatus=&regno=&secondaryid=&applier=&studyleader=&createyear=&sponsor=&secsponsor=&sourceofspends=&studyailment=&studyailmentcode=&studytype=&studystage=&studydesign=&recruitmentstatus=&gender=&agreetosign=&measure=&country=&province=&city=&institution=&institutionlevel=&intercode=&ethicalcommitteesanction=&whetherpublic=&minstudyexecutetime=&maxstudyexecutetime=&btngo=btn

# 信息参考
- curl样本
curl 'https://www.chictr.org.cn/searchproj.html?title=KRAS&officialname=&subjectid=&regstatus=&regno=&secondaryid=&applier=&studyleader=&createyear=&sponsor=&secsponsor=&sourceofspends=&studyailment=&studyailmentcode=&studytype=&studystage=&studydesign=&recruitmentstatus=&gender=&agreetosign=&measure=&country=&province=&city=&institution=&institutionlevel=&intercode=&ethicalcommitteesanction=&whetherpublic=&minstudyexecutetime=&maxstudyexecutetime=&btngo=btn' \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -b 'acw_tc=1a0c399817632843118422343ec25308eaa420a1c3d8fecf22952f7b4a85a8; perf_dv6Tr4n=1; acw_sc__v2=69199566cb154ac17b083090e650210617848de7; ssxmod_itna=1-Yq0xyD0DuDc7KY5G=G0D2DEeG7GRDIoc2ADBP011kDuxiK08D6QDB_46PD=6pFKb33mTxrqqjWfiNDlOhroDSxD67DK4GTp_pwD_zbb00EpIq_GnHhIFlcex_CdhDOiOKdrnnYhcFBvIXgfdNXQxGIADG2DYoDCqDSSDD9S2dD4S3Dt4DIDAYDDxDWjeDBYaRtDGpN2mTi=jw5EiRNxift8jptDitzxi5F=PcN=n_NxDf1xB6axAfKHhntbeGn/GSt8gTDj_yaAFgKxYppRWOpxBjh1Qr8e6nTMilbWYXSd2dpUu4Plq_CFGeRroR2rQDkQwDdxe9urY0Dz48Sx/322b_xABTRhPmioQHSFHw8HoY04HbtGDzFRr0qZQ_eiDqm0xGio0AND_iWDi/r5O0CeAr70DA7VeD; ssxmod_itna2=1-Yq0xyD0DuDc7KY5G=G0D2DEeG7GRDIoc2ADBP011kDuxiK08D6QDB_46PD=6pFKb33mTxrqqjWfioDipeboKdDj4wCb5DxDsYmRPY_6bwxr3202j0arUjqekAj_jFeuY/OLL2HI=Z7bUwL7GuQPDlDEG7GxR_YElhQqu_DEzGXjGGxM_O=LKDx5QYL7AnhRm7W5hGigiwjAURjOlQRFchdQWwhrcx0NxQArOGtKCLxzaiioR2tozG2OPnvT5=42AT9EgSuFNbQPAIT0o=UbiAeu5B5uD1LmcR4sic_xRx3u2yGzFHYqaB5oGXu1tm7xxD' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Sec-Fetch-User: ?1' \
  -H 'Upgrade-Insecure-Requests: 1' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "macOS"'

[response]
/Users/qinxiaoqiang/Downloads/chictr_trials/response_general_query.json 


# 单一实验查询

- url
https://www.chictr.org.cn/showproj.html?proj=219315

- 响应curl+参数
```shell
curl 'https://www.chictr.org.cn/showproj.html?proj=219315' \
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' \
  -H 'Accept-Language: zh-CN,zh;q=0.9' \
  -H 'Connection: keep-alive' \
  -b 'perf_dv6Tr4n=1; acw_tc=0a472f5217632921236223667e8388b1d06e9191bd0987a73557f8891b10fd; acw_sc__v2=6919b40c6cb58e4ff97e12b08f01dae17690f3fa; ssxmod_itna=1-Yq0xyD0DuDc7KY5G=G0D2DEeG7GRDIoc2ADBP011kDuxiK08D6QDB_46PD=6pFKb3KDO0GPYGDEm4TFD0vPKpDA5Dn_x7YDta3Ft4YSooxqAt6QY_pzK3ln_XvYimLoRxN50Ao_vjoB9_VlE=M9kXb_4GIADG2DYoDCqDSSDD9SxQD43dDt4DIDAYDDxDWReDBt6RtDGPrylurTjqoEAbrxiftGjptDiUsxivHT1arTn4rxD3sxB=HxA3YHgnt7eGn/BSt8rWDjSyaUUOYxYpIBjgIxBQwwmr83PaaMACpBTx0DLDesbhDhitFGeRroR2Dl2kiqxdxelq4oizS2eaq7WIx5ionvx6Ge3rS7vMGel3xx3hx8RVQmTDw47weiDqm0xb_xFqie4rCEPWib7DbYYk7iKkEPeD; ssxmod_itna2=1-Yq0xyD0DuDc7KY5G=G0D2DEeG7GRDIoc2ADBP011kDuxiK08D6QDB_46PD=6pFKb3KDO0GPYGDEm4TDGfWtKpQYe03QRxh3WDlhG8QdW67rbU62WmMdw0dNMw0yxQRI/1cO3mAcR9x7ESDf3_Do9R4e7G3YWQ5PlkGZiW=slOdq/R4K_qqo7BtXnm3PiBjC4T2Gzdj0YR07Yirn8wGuKGjXmYtyDkEX48nbwgnX96WX4cG/j7GXfLW14q43cgrKi0dGo4kqtT4XDw9yWq6r=egxr7G6DFvGy3vI5UgkocFeia6LZzXSzCI0Wtzhd0GoaxIBmvrZNdmi_Qf/DKgOxPDrTpEI100mj8=q0OihgAQavc=Q0c0P/KOxRd30bK0QUt0prKIoYF4eW41ITz3pzlwGQmxADpEGmnuC8hzYD' \
  -H 'Sec-Fetch-Dest: document' \
  -H 'Sec-Fetch-Mode: navigate' \
  -H 'Sec-Fetch-Site: none' \
  -H 'Sec-Fetch-User: ?1' \
  -H 'Upgrade-Insecure-Requests: 1' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' \
  -H 'sec-ch-ua: "Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "macOS"'
```

  - response 参考如下文件
 /Users/qinxiaoqiang/Downloads/chictr_trials/response_single_query.json