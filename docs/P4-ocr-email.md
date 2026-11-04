# P4 截图 OCR 与邮件导入验收记录

日期：2026-11-04 · 版本：0.2.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 115 项，113 通过，2 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 96 项，94 通过，2 忽略 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `cd ui && npx playwright test` | 33 通过 |
| 真实 OCR（手工启用） | `WHEEL_OCR_TEST_IMAGE=<截图路径> cargo test -p wheel-app windows_ocr_reads_a_real_image -- --ignored` | 通过，返回识别行 |

新增/覆盖的用例：

- `text_import::tests::schwab_confirmation_is_extracted_with_fees_from_the_next_line`：`Trade Date`、STO 合约行、下一行费用；CSV 行与备注。
- `text_import::tests::fidelity_share_purchase_uses_the_previous_date_line`：上一行 `Date:` 作为交易日期，`Bought 100 shares of MSFT at $300`。
- `text_import::tests::ibkr_buy_to_close_is_supported`：BTC、数量与价格。
- `text_import::tests::futu_chinese_confirmation_is_supported`：中文日期、卖出开仓、`张`、成交价与手续费。
- `text_import::tests::dividend_derives_per_share_from_the_total`：分红数量与总额反推每股金额。
- `text_import::tests::multipart_mime_prefers_the_plain_text_part`、`base64_body_is_decoded`、`html_table_keeps_the_date_and_the_trade_on_separate_lines`：MIME、base64、HTML 表格。
- `text_import::tests::repeated_trade_lines_are_merged_with_a_warning`、`buy_to_open_is_rejected_instead_of_being_guessed`、`missing_price_is_reported_not_defaulted`：去重、拒绝做多期权、缺价格不猜。
- `text_import::tests::month_name_expiry_is_normalized`、`quoted_printable_soft_breaks_and_escapes_are_decoded`：月名日期与 quoted-printable。
- `text_import::tests::missing_price_does_not_borrow_the_next_trade_price`：缺少成交价的交易不会把下一笔交易的价格并入。
- `text_import::tests::exercise_price_is_not_treated_as_an_assignment`、`at_followed_by_a_date_is_not_a_price`：`exercise price` 不触发指派，`at <日期>` 不当成成交价。
- `text_import::tests::american_warning_only_tracks_the_resolved_trade_date`：只有实际采用的交易日期是 `M/D/YYYY` 时才提示。
- `text_import::tests::sub_cent_option_prices_keep_their_precision`：小额期权价格保留六位小数，不提前四舍五入到分。
- `ocr::tests::accepts_common_image_types`、`decodes_plain_and_data_uri_base64`、`rejects_empty_and_invalid_payloads`：MIME 白名单、data URI、非法输入与路径扩展名拒绝。
- `commands::tests::text_import_preview_maps_email_trades_and_flags_duplicates`：抽取器 → 固定 CSV → 既有预览；提交后再次预览标记重复。
- Playwright「email import skips column mapping and commits through the text pipeline」：邮件模式、跳过列映射、警告展示、`text_import_preview` 参数、提交来源「邮件导入」。
- Playwright「OCR import lets the user correct recognized text before parsing」：图片选择 → `ocr_image` 参数 → 编辑识别文字 → 解析 → 提交来源「截图 OCR」。

## 管线

```text
.eml / .txt / 粘贴文本 / 截图
        │
        ├─ 邮件：MIME 解码（multipart / base64 / quoted-printable / HTML）
        └─ 截图：Windows.Media.Ocr（PowerShell 5.1 WinRT）
        │
        ▼
保守行级抽取（日期、方向、合约、数量、价格、费用）
        │
        ▼
固定表头 CSV：日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,备注
        │
        ▼
import::parse_document → build_preview → import_commit（去重 / 校验 / 单事务）
```

- 抽取结果从不直接写库；向导先显示逐行预览，用户可改类型、取消选择。
- 备注由提交路径追加前缀：`导入:<来源> · <模板> · 第 N 行`。
- 日期统一规范为 `YYYY-MM-DD`（UTC 账本口径）；美式 `M/D/YYYY` 会提示按月/日/年解析。

## 邮件解码

- `MIME-Version` 或带 `boundary` / `Content-Transfer-Encoding` 的 `Content-Type` 触发解码。
- multipart 优先使用 `text/plain`，没有时才用 `text/html`；HTML 的 `</td>` 转制表符，`</tr>/</p>/</div>` 转换行。
- base64 去除空白并补齐填充；quoted-printable 处理软换行与 `=XX`。
- 声明字符集不是 UTF-8 / ASCII / Latin-1 时给出警告，按 UTF-8 lossy 解码，不静默猜测。
- 模板识别只用于备注与提示：Schwab、Fidelity、IBKR、富途、老虎、通用邮件。

## 抽取规则（保守）

- 期权合约：`AAPL 02/20/2026 150 P`、`AAPL 20 FEB 2026 150 P`、OCC 代码。
- 方向：STO / BTC / 到期 / 指派 / 买卖股票 / 分红；带合约的 `Sell` / `Buy` 映射为卖出开仓 / 买入平仓。
- 明确拒绝 Buy to Open、Sell to Close、买入开仓、卖出平仓。
- 期权开平仓与股票买卖必须有 `> 0` 的价格；缺日期、数量、价格、合约的行逐条警告并跳过。
- 到期与指派价格、费用清零；分红需要持股数量，金额取标注总额、每股金额或唯一的 `$` 数值。
- 同封邮件中十个字段完全相同的记录合并并警告。

## 截图 OCR

- 命令：`ocr_image({ data: base64, mime })`；支持 PNG / JPEG / WebP / BMP / GIF / TIFF，解码后 ≤10 MB。
- Windows 内置引擎：嵌入 PowerShell 5.1 脚本，显式使用 `ContentType=WindowsRuntime` 的程序集限定类型名加载 `Windows.Storage` / `Graphics.Imaging` / `Media.Ocr`。
- 临时目录 `%TEMP%/wheel-ocr-<pid>-<nanos>/`：写入图片、脚本、`out.txt`、`err.txt`；成功、失败、超时都会删除。
- 无窗口启动（`CREATE_NO_WINDOW`），45 秒超时后终止进程；输出为 UTF-8，每行一条识别结果。
- 语言包缺失时返回「系统未安装可用的 OCR 语言包」；识别为空时提示换更清晰的截图。
- 非 Windows 平台返回「截图 OCR 仅支持 Windows」。

## 手工检查（桌面版）

- [ ] 导入 → 邮件，选择一封真实 `.eml`（multipart + base64），确认正文被解码、进入逐行确认且没有列映射步骤。
- [ ] 粘贴一封中文成交确认，确认日期、数量、价格与费用正确，备注含 `导入:<来源> · <模板> · 第 N 行`。
- [ ] 导入一封包含 Buy to Open 的邮件，确认该行被拒绝并显示原因，其余可导入行仍可提交。
- [ ] 导入 → 截图 OCR，选择清晰截图；确认识别文字可编辑，修正后能预览并提交。
- [ ] 尝试 Ctrl+V 粘贴截图与「从剪贴板读取」；确认无图片时提示清楚。
- [ ] 提交后查看事件备注、持仓与成本是否按账本顺序重算；重复导入同一封邮件应标记重复。
- [ ] OCR 结束后检查 `%TEMP%` 下没有 `wheel-ocr-*` 残留。
- [ ] 在一台未安装英语/中文 OCR 语言包的机器上确认错误提示可操作。

## 已知限制

- OCR 对数字、小数点和斜杠易出错（实测样例会把 `02/20/2026` 识别成 `92/29/2926`），因此识别文本必须人工核对；不做低置信度自动修正。
- 不解析 PDF、图片附件、压缩包；不做 IMAP 自动拉取。
- 邮件模板是通用规则加提示标签，不保证覆盖券商所有版式；新模板应补充样例测试。
- 抽取器按行与最多三行窗口工作，跨越多行的复杂表格可能漏行，漏行会以警告列出而非静默丢弃。
