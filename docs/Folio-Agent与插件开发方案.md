# Folio Agent 与插件开发方案

用户已于 2026-10-11 确认开始开发，Windows 优先。Chrome/Edge 为浏览器目标。

## 共同原则
- 普通 PDF 继续使用现有导入，不要求作者、年份、期刊或 DOI。
- 网页论文收藏提取书目信息，字段缺失可保存，明确标识；允许手动纠正。
- Agent 读取、分析自动执行；笔记/批注实际写入保留确认。
- 不显示模型思考内容，显示实际任务步骤、工具与进度。
- Word 目标：Windows Microsoft 365、2024、2021、2019、2016；按 Office API requirement sets 检测能力，不能把模拟测试说成实机验收。

## Agent
阅读助手保留现有聊天。深度研究增加计划、执行、证据检查、任务状态、停止及恢复。共用现有模型和工具，增加章节、页面图像、笔记与批注读取。Research Skills 使用已接入的论文精读与证据批判性分析。首版单文献，有限预算。

验收：局部/全文范围准确，中断恢复保留进度与证据，图像真实来自当前 PDF，写入仍确认，普通聊天不改变。

## 插件
新增独立 bibliographic records，可关联现有 paper_id，也可没有 PDF。CSL-JSON 作为 Word 和浏览器共同的数据格式。稳定 record id、来源字段、缺失字段、DOI/PDF 去重、用户可纠正。

Chrome/Edge MV3 插件：当前网页/学术结果页提取、PDF 候选、选择文件夹、导入状态。连接本机授权桥，不能暴露桌面内部会话 token，不允许任意代理路径。

Word 加载项：独立任务窗格，查询 Folio 记录，多篇引用、定位页码、GB/T 7714 与 APA、文档内关联和书目快照、刷新编号与书目、能力检测。CSL 引擎复用成熟实现。提供开发安装说明与 Word 版本兼容矩阵。

验收：缺失信息不阻塞普通 PDF；网页元数据与 PDF 对应；配对和权限隔离；Word 保存重开后关联保留；增删引用刷新及换格式正确。实际无法启动的 Word 版本明确列为待实机验证。

## 分工与集成约定
- Research worker：backend/research_agent.py、src/Reader.tsx、相关新组件和 tests。app.py/db.py 由主智能体集成。
- Browser worker：backend/literature.py、electron/plugin-bridge.cjs、extensions/browser/**、tests。app.py、electron/main.cjs、SettingsPanel.tsx、package.json 由主智能体集成。
- Word worker：extensions/word/**、tests、安装说明。不得改公共 package.json。
- 文献接口：GET /literature?q=，GET/PATCH /literature/{id}，POST /literature/capture。
- 外部桥：127.0.0.1:37861，GET /health；文献接口 /v1/literature，POST /v1/capture，GET /v1/folders。外部 bearer 为插件配对凭证，内部会话 token 留在 Electron。
- 公共文献列表响应：{items:[{id,paper_id,title,authors:[{given,family}],year,container_title,doi,url,pdf_url,missing_fields,csl}],total}。csl.id 必须等于稳定 record id。
- capture 输入：{title,authors,year,container_title,doi,url,pdf_url,folder_id,source}。额外字段需双方协商。

步骤：先实现模块与各自测试 → 主智能体集成公共接口 → 后端/前端/插件验证 → 审查安全和数据迁移 → 交付本地可测试构建及安装说明。此轮不自动发布 GitHub 或软件更新。
