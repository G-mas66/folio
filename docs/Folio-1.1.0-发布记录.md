# Folio 1.1.0 Windows 发布记录

发布时间：2026-10-11（北京时间）。本轮发布 Windows x64，macOS 保持 1.0.4。

正式发布页：https://github.com/G-mas66/folio/releases/tag/v1.1.0 。GitHub Release ID 为 `409404483`，稳定版，已设为 Latest。

源代码已推送到 `origin/main`，标签 `v1.1.0` 指向 `07fa59b0a6e99e8abeb22e679c896e75910cde2e`。后续发布记录提交不改变该标签和安装包。

## 发布附件

共 7 个附件；GitHub 返回的 SHA-256 和大小均与本地产物一致。

| 文件 | SHA-256 |
| --- | --- |
| Folio-1.1.0-Windows-x64-Setup.exe | 06d8da0317b0e7eb8c5abe887a90018d6b2278c47e80221c3693d73243efa333 |
| Folio-1.1.0-Windows-x64-Setup.exe.blockmap | 49687bc16f151ad8b880178dd05e3f19d9f0ddf659a3a494ffbf9790dffc22a1 |
| latest.yml | 30ad0faf0dbde236e12f913b140546907986f668fb53fe1ee469b7d9c4c02e45 |
| beta.yml | 30ad0faf0dbde236e12f913b140546907986f668fb53fe1ee469b7d9c4c02e45 |
| SHA256SUMS.txt | 0f6ea80e828dcda66676cb381f8617091d24e9184d680c7ed346164b3337eb49 |
| smoke-windows-x64.json | 76a4169efd3208b536f97ff6377e346bbc3f2c47b376c7b16d9d710dfac0dfb5 |
| Folio-1.1.0-Windows-acceptance-report.md | 65ef26034e63085ed5720fbc2504e713c6525bd0dcc7bb335b60c5c18df9561f |

安装包为 504,632,465 字节。验收报告附件保留发布前验收时的内容，发布状态以本文为准。

## 更新验证

匿名访问确认该版本为 GitHub Latest，7 个附件的官方摘要和大小正确；公开 `latest.yml`、`beta.yml` 与本地逐字节一致；安装包 HTTP Range 返回 206，前 64 KiB 与本地一致，标签提交匹配。

分别启动隔离目录中的真实打包客户端查询公开 GitHub 更新源：1.0.4 返回 `available`，目标版本 1.1.0；1.1.0 返回 `not-available`。仅检查更新，没有执行下载或安装。证据为 `public-release.json`、`public-clients.json`。

使用真实 1.0.4 与 1.1.0 安装包，在本地回环 HTTP 服务上运行生产差分下载逻辑：成功重建 1.1.0，SHA-256、SHA-512 与正式安装包一致，无整包回退。差分主体 18,269,681 字节，含清单和 blockmap 总传输 19,322,761 字节，节省 96.1709%。这是隔离的本地重建验证，不代表用户网络下的固定下载量；缺少旧包缓存时会下载整包。

公开发布列表经生产 Mac 更新选择器核验，arm64 和 x64 的最新适用版本仍为 1.0.4；未构建或上传 Mac 1.1.0。

原验收边界仍适用：AI 使用隔离模拟服务；未覆盖安装用户现有程序、修改用户文献库或凭据。

本地发布证据位于 `.review/release-1.1.0/`，其中 `publish-audit.json` 保存发布及附件核验，`differential/stable104-stable110-evidence.json` 保存差分重建结果。
