# Folio 1.0.4 macOS 验收报告

日期：2026-10-10。Apple Silicon arm64 与 Intel x64 原生构建，包含 Windows 1.0.4 同步的翻译限流恢复和应用内反馈表单。

构建源：`01f8c4c5f0d6b99b80a39ea2a9290b453cc27b87`。[GitHub Actions 验收与上传](https://github.com/G-mas66/folio/actions/runs/38045884728)。相对 `v1.0.4` 的产品代码（electron、backend、src、package.json、package-lock.json）无变化；新增 Mac 更新版本与反馈 IPC 验收。版本标签保持 `13ffc7a219967b7382323debeec6729c9f1e4c31`。

## 双架构验收

每个架构在 macOS 15.7.9 上完成：

- 141 项后端测试与 13 项存储检查。
- `.app`、本地后端、PDF 引擎均为对应 Mach-O 架构，资源不包含 Windows 可执行文件；`codesign --verify --deep --strict` 通过。
- 打包应用实际启动，版本为 1.0.4；默认文献库存放于用户 Application Support。
- 反馈框通过真实 IPC 提交到被替换为模拟响应的固定 FormSubmit 接口，提交字段仅反馈文本、版本与仓库来源，无外部邮件应用调用。没有发送测试邮件。
- 中文 PDF 导入、画布渲染、笔记保存读回、AI 两种协议、原文读取工具和流式停止通过。
- macOS Keychain 往返和临时 API Key 清理通过，PDF 引擎与 cryptography 原生自检通过。
- 实际免费全文翻译生成中文和双语 PDF，并检验两份输出包含中文文本。
- 更新选择匹配芯片架构、拒绝另一架构，验证 stable/beta 频道规则。

## 发布核对

公开发布页：[v1.0.4](https://github.com/G-mas66/folio/releases/tag/v1.0.4)。安装包、逐架构 `smoke-arm64.json` / `smoke-x64.json` 和 `SHA256SUMS-macOS.txt` 均附于该页。

通过匿名 GitHub 官方资产接口下载两个 zip 的前 65,536 字节，Range 返回 HTTP 206，前缀为有效 ZIP；本机直连 github.com 下载域名连接失败，公开资产接口下载通过。公开 smoke 报告 SHA-256 与 GitHub 上传摘要相符。包摘要来自 GitHub 对上传文件计算的 SHA-256，未在本机重新下载两个完整 zip。用公开 Releases API 数据调用更新选择函数，以旧 `0.14.0-beta.3` 为当前版本时两架构各选择 1.0.4，以 1.0.4 为当前版本时无重复升级。该函数与 beta.3 构建源 `f6cf325cceec34a97e6f569f13ead308f6193c6d` 相同，未在本机实际运行旧 Mac 应用。

Windows 的六项原有发布资产 ID、大小与 SHA-256 保持一致；latest 稳定发布仍为 v1.0.4。


| 包 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| Folio-1.0.4-macOS-arm64.zip | 695582993 | `dedbac77b4fcbbea84c707ba625ff41f20763e11021d623a7bb835fc2b2f9097` |
| Folio-1.0.4-macOS-x64.zip | 708228822 | `2ac6b95e6a1518fdae607f811a219dff6635b2c4edcaab7ec60b2b655f0a39af` |

## 安装与限制

解压对应芯片架构的 zip，将 `Folio.app` 放入「应用程序」。Mac 更新仍为下载 zip 后手动替换应用，没有自动替换或差分安装。包采用 ad-hoc 签名，没有 Apple Developer ID 签名或公证，首次打开可能出现 Gatekeeper 提示。本次验收在 GitHub 托管 Mac 运行器进行，未在用户实体 Mac 验收；免费翻译长期限流时仍可能失败。
