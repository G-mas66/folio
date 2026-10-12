# Folio 浏览器扩展

Folio 文献收藏扩展适用于 Chrome 和 Microsoft Edge，可把当前网页、Google Scholar 结果、网页 PDF，以及用户选取的 BibTeX／RIS 记录收藏到本机 Folio。

## 安装与连接

安装并启动 Folio 后，受信任的扩展会通过 Native Messaging 自动连接；Folio 退出后，扩展会在下次请求时自动重连。无需复制或输入配对凭证。连接由本机原生消息程序转发到 Folio 的当前用户命名管道，并用仅供该用户读取的本机随机密钥认证。普通网页无法调用这条连接。

浏览器只会为明确登记的扩展 ID 注册 Native Messaging 主机。开发预览版通过 Folio 预览启动入口登记对应开发扩展 ID；加载解压扩展时，其 ID 必须与 Folio 允许列表一致。Edge 商店 ID `gimnkmpfcblogmkkamdlpejgleeiidpb` 已加入正式与开发预览允许列表；商店扩展也须更新至支持 Native Messaging 的版本才能免凭证连接。Chrome 商店 ID 尚未配置。

更新本地开发扩展后，可在浏览器扩展管理页刷新扩展。卸载扩展可在同一管理页完成。

## 收藏与引用

点击工具栏图标后，扩展读取当前标签页的标题、作者、DOI、期刊／会议和结构化元数据，并允许选择 Folio 文件夹。可先检查网页元数据，再明确核对 DOI 解析结果；扩展不会因为 DOI 命中就自动覆盖网页记录。确认保存后，可以预览 GB/T 7714 或 APA 格式，并再次确认要保存的引用版本。

扩展可把页面提供的 BibTeX／RIS 下载作为额外候选项；读取前会针对对应网站询问可选权限，导入内容不会静默覆盖原网页记录。Scholar 结果可逐条选择。网页 PDF 会被作为默认导入候选，保存时浏览器会一次询问所选 PDF 来源的权限；拒绝后仍会保存书目，也可在失败后重试。单个 PDF 上限为 25 MiB。PDF 请求可使用该来源在浏览器中的登录 Cookie，Cookie 不会转发给 Folio；BibTeX／RIS 请求不携带 Cookie。下载不会自动跟随重定向，以免转向未经用户选择的主机；如发生跳转，请先在浏览器中打开最终 PDF 地址后再导入。下载检查文件大小和超时。

## 权限与隐私

`activeTab` 和 `scripting` 只用于用户点击扩展后读取当前标签页；`nativeMessaging` 用于连接 Folio；`alarms` 用于后台连接健康维护。扩展没有通用网站访问权限。读取用户选中的 PDF 或 BibTeX／RIS 文件前，会单独请求对应网站的可选 HTTP(S) 权限。

书目、所选 PDF 和用户确认的引用操作通过 Native Messaging 传到本机 Folio。DOI 核对会将该 DOI 发给 Crossref 或 DataCite 查询元数据；其他书目和 PDF 不会因此上传到这些服务。扩展不会向网页注入连接凭证，也不会向 Folio 云服务器上传书目或 PDF。完整说明见[扩展隐私政策](../../docs/Folio浏览器扩展隐私政策.md)。

如果无法连接，请确认 Folio 正在运行，并通过 Folio 的预览启动入口运行与当前扩展 ID 匹配的开发版本。扩展状态区提供重连操作。
