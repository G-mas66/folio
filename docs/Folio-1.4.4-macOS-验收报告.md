# Folio 1.4.4 macOS 验收报告

日期：2026-10-27。Apple Silicon arm64 与 Intel x64 从 1.0.4 更新至 1.4.4，分别使用 GitHub 托管 macOS 15 运行器原生构建。

构建源：`52926700ea3ffab72d593052543ee7d7ff782887`。[构建、验收与安装包上传](https://github.com/G-mas66/folio/actions/runs/40492974096)。

## 同步功能与构建修复

- 同步紧凑文献列表、右侧首页封面与详细信息、收藏、最近阅读、新版 Markdown 笔记，以及问答网页来源过滤。
- 修复暂停翻译或 OCR 时，辅助进程立即退出被误报为生成失败的竞态；新增回归用例覆盖两种任务。
- 固定 `bitstring==4.4.0`。上游 [5.0 说明](https://pypi.org/project/bitstring/5.0.0/)明确移除旧流式类，导致当前 PDF 引擎无法导入 `BitStream`；构建新增源码与冻结引擎自检，在生成大型安装包前发现此类问题。
- 补齐随应用分发的 PDF 引擎集成源码，包含新增的 OCR 模块与 Windows 脚本；macOS 本地 OCR 暂未实现。
- 更新 Mac 验收脚本，使用新版文献列表、详情、收藏、最近阅读和 Markdown 笔记控件，保存后从后端读回笔记核对。

## 双架构验收

每个架构均完成以下检查：

- 228 项后端测试全部通过，13 项存储检查通过。
- `.app`、本地后端与 PDF 引擎的 Mach-O 架构匹配目标芯片；资源不包含 Windows 可执行文件；`codesign --verify --deep --strict` 通过。
- PDF 引擎及 cryptography 原生加载自检通过。实际启动打包应用，版本为 1.4.4，默认数据目录位于用户 Application Support。
- 中文 PDF 导入保留源文件字节；单击显示右侧详情与渲染后的首页封面，收藏筛选、最近阅读和 PDF 正文画布正常。
- AI 的 Chat Completions、Responses 协议，文献读取工具、流式停止，以及笔记编辑、保存和后端读回通过。
- macOS Keychain 凭据往返与临时 API Key 删除、删除后不存在检查通过。
- 反馈表单经过真实 IPC，在测试中拦截固定接口并模拟成功响应，验证没有调用外部邮件应用；未发送测试邮件。
- 实际免费全文翻译成功生成中文、双语两份 PDF，并检查两份输出均包含中文。对应报告的 `free_translation.status` 与总结果均为 `success` / `passed`。
- 更新选择拒绝错误芯片架构，并验证稳定版、beta 频道规则。

## 发布与公开下载

发布页：[v1.4.4](https://github.com/G-mas66/folio/releases/tag/v1.4.4)。两个 Mac 安装包、`smoke-arm64.json`、`smoke-x64.json`、Mac 对应源码归档与 `SHA256SUMS-macOS.txt` 附于同一发布页。

通过匿名 GitHub 官方资产接口下载两个安装包的前 65,536 字节，检查 HTTP 206、Content-Range 与有效 ZIP 头。完整下载两份 smoke 报告及校验清单，核对公开文件与 GitHub SHA-256；Mac 源码上传摘要与本机完整归档摘要一致。没有在本机重新下载两个完整 Mac 安装包，包摘要采用 GitHub 对上传文件计算的 SHA-256。

使用公开发布元数据调用更新选择函数，验证两种芯片从 1.0.4 均选择 1.4.4，当前 1.4.4 不重复升级。原 Windows 发布文件的资产 ID、大小与 SHA-256 保持一致，最新稳定发布仍为 v1.4.4。

| 安装包 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| Folio-1.4.4-macOS-arm64.zip | 680539090 | `db766b35cbe099e9d06336c60408931b0ef79c254972818f262595cd944e4f46` |
| Folio-1.4.4-macOS-x64.zip | 693387735 | `32aa0c26eecd588768b57d08b499b638cf0e36bd7ae8631ff72c7e3c2e0ba3aa` |

原 `v1.4.4` 标签继续对应此前已发布的 Windows 版本。Mac 包包含本次暂停竞态与构建兼容修复，其完整源码为发布资产 `Folio-1.4.4-macOS-source.zip`，归档的 Git 提交注释与上述 Mac 构建源一致。源码仅从 Git 已提交文件导出，不含用户文献库、个人数据或未提交的其他开发改动。

## 安装与限制

解压对应芯片架构的 zip，将 `Folio.app` 放入「应用程序」。macOS 更新需要手动下载并替换应用。本包采用 ad-hoc 签名，没有 Apple Developer ID 签名或公证，首次打开可能出现系统安全提示。本次验收在 GitHub 托管 Mac 运行器进行，尚未在用户实体 Mac 上验收首次安装。

本地 OCR 与浏览器扩展自动连接目前仅支持 Windows。免费全文翻译依赖外部服务，本次样本成功不代表服务持续可用，也不保证复杂论文版式完全一致。
