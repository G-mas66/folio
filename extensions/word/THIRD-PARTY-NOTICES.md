# Folio Word 插件第三方 notices

## citeproc-js

本插件通过 `citeproc` npm 包 2.4.63 将 citeproc-js 打包进任务窗格。citeproc-js 由 Frank Bennett 编写，版权声明为 2009–2019 Frank Bennett。citeproc-js 的原始授权是 CPAL 1.0 或 GNU AGPL 第 3 版及后续版本双重许可；Folio 在此分发中选择 CPAL 1.0，完整许可文本见 `CPAL-1.0.txt`。上游双重许可说明和署名保留在 `CITEPROC-LICENSE.txt`，对应的原版引擎源码随包放在 `source/citeproc`。项目主页：[Juris-M/citeproc-js](https://github.com/Juris-M/citeproc-js)。

## core-js

任务窗格使用 core-js 3.50.0 为较旧的 Word WebView 提供 JavaScript 垫片。core-js 由 Denis Pushkarev 与 CoreJS Company 提供，依照 MIT 许可证授权；完整许可文本见 `core-js-LICENSE.txt`。

## CSL 格式与 locale 数据

`styles/apa.csl`（APA Style 7th edition）和 `styles/gb-t-7714-2015-numeric.csl`（GB/T 7714-2015 numeric）来自 Zotero CSL 样式库。APA 样式列出的作者为 Brenton M. Wiernik 和 Andrew Dunning，贡献者为 Jay Pfaffman；GB/T 样式列出的作者为牛耕田，贡献者为 Zeping Lee。样式文件声明依照 Creative Commons Attribution-ShareAlike 3.0 授权，完整许可文本见 `CC-BY-SA-3.0.txt`。`styles/locales-en-US.xml` 和 `styles/locales-zh-CN.xml` 是随 CSL 格式使用的 locale 数据，其原有作者和译者信息保留在文件中。

## Microsoft Office.js

`taskpane.html` 从 Microsoft 提供的 `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` 加载 Office.js。本插件不随包分发此文件。
