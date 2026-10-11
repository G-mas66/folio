# Folio Word 引用加载项

此加载项可在 Word 中搜索 Folio 文献、插入 APA 7 或 GB/T 7714-2015（顺序编码制）引用，并按文档中的控件顺序刷新引用和书目。文档内保存 CSL 书目快照，因此切换格式和重新编号可以离线完成。点击“刷新文档引用”时，加载项会尝试按 Folio 返回的稳定文献 ID 更新快照；连接失败时会保留原快照并显示离线回退提示。

## 安装

1. 启动 Folio 桌面工作台。打开“设置 → 浏览器与 Word 插件”，选择“查看配对凭证”，暂时复制显示的凭证。
2. 在 PowerShell 中进入本目录，手动运行 `scripts/Install-WordDevCertificate.ps1`。如果执行策略阻止运行，可用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-WordDevCertificate.ps1`。脚本会在当前 Windows 用户的 `%LOCALAPPDATA%\FolioWordAddin` 下准备 `localhost` HTTPS 证书，并询问是否信任。
3. 只有在你决定信任此本机证书时，才在脚本提示处输入大写 `TRUST`。这会把证书导入当前 Windows 用户的 `Root` 信任存储。脚本不会由应用自动运行；不输入 `TRUST` 时，证书不会被导入，Word 加载项的本机 HTTPS 页面也无法正常打开。
4. 将本目录中的 `manifest.xml` 复制到一个 Windows 文件共享目录，并取得该目录的 UNC 路径（例如 `\\server\share`）。只需共享 manifest 文件；加载项页面和图标仍由 Folio 本机 host 提供。
5. 在 Word 桌面版打开“文件 → 选项 → 信任中心 → 信任中心设置 → 受信任的加载项目录”，添加该 UNC 路径并勾选“在菜单中显示”。确认后重启 Word。
6. 在 Word 中选择“插入 → 我的加载项 → 共享文件夹”，打开 Folio 引用任务窗格，把第 1 步复制的凭证粘贴到“Folio 插件 token”并保存。

Folio 会在启动时提供加载项使用的本机 HTTPS host 和文献查询中继；普通安装不需要另装 Node.js，也不需要手动启动服务。若 Folio 设置页显示 Word 服务未就绪，在准备证书后重启 Folio，或使用“重试连接服务”。

## 使用

在 Folio 的书目中补充或修正文献后，回到 Word 点击“刷新文档引用”以按稳定文献 ID 更新文档快照。首次打开和切换引用格式只使用文档内快照，不联网。完成插入、刷新或换格式后，请保存 Word 文档。

引用和书目内容保存在当前 Word 文档；配对凭证保存在此 Word 加载项的本地配置中。重置 Folio 配对凭证后，请在任务窗格中更新保存的 token。

## 兼容性

清单声明最低要求为 WordApi 1.1。当前自动化测试使用 Word API 模拟，没有在 Word 2021 COM 中完成保存/重开验收，也没有运行 Office.js 加载项本身或验证共享目录侧加载流程；Microsoft 365、Word 2024、2021、2019 和 2016 等版本的加载项兼容性仍待逐版实机验证。

## 开发构建

在 Folio 源代码检出目录运行 `npm --prefix extensions/word ci`，然后运行 `npm run build:plugins` 生成 `extensions/word/dist`。Folio 开发版从该目录启动加载项 host。

第三方依赖及随附 CSL 格式文件的归属和许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
