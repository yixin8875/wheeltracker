# P4 云端视觉识别与邮件导入验收记录

日期：2026-11-04 · 版本：0.2.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --offline --workspace` | 124 项，123 通过，1 忽略（实时行情） |
| `wheel-app` 测试 | `cargo test --offline -p wheel-app` | 105 项，104 通过，1 忽略（实时行情） |
| Clippy | `cargo clippy --offline -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `cd ui && npx playwright test --workers=2` | 35 通过 |

本轮没有调用真实视觉服务：默认测试全部使用合成图片、合成 JSON 与 IPC stub，不联网，也不需要 API Key。

新增/覆盖的用例：

- `vision::tests::decodes_plain_and_data_uri_images`、`rejects_bad_image_inputs`：纯 base64、data URI、换行、PNG 文件头、MIME 不一致、空内容、非法 base64 与 5 MB 上限。
- `vision::tests::validates_base_urls_and_endpoints`、`builds_an_openai_compatible_vision_request`：HTTPS、拒绝用户名/密码/查询/片段/`/chat/completions` 后缀；请求模型、system prompt、图片 data URI、不回显 Key。
- `vision::tests::reads_string_and_array_completions_and_reports_truncation`、`parses_plain_fenced_and_array_replies`：字符串与数组 content、`finish_reason: length`、纯 JSON、```json 围栏、前后说明文字、顶层数组。
- `vision::tests::converts_an_option_trade_into_the_fixed_csv`：日期规范化、标的去空格大写、数量/价格字符串、到期日/行权价/C-P、备注与固定 CSV 表头。
- `vision::tests::rejects_unsafe_or_incomplete_trades`：做多期权、缺成交价、股票带期权字段、到期日早于交易日、非法日期。
- `vision::tests::derives_dividend_price_and_deduplicates_rows`：分红由总额反推每股、重复行合并、超过 200 笔拒绝。
- `vision::tests::reports_provider_errors_without_echoing_the_key`：401 提示与服务端 message 保留。
- `commands::tests::vision_settings_mask_the_key_and_require_consent_to_enable`：Key 只返回尾号、启用必须同意、清除 Key 后不可用。
- `commands::tests::vision_settings_reject_invalid_values_and_enable_without_a_key`：非 HTTPS、空模型、短 Key、无 Key 启用均报错。
- `commands::tests::vision_extraction_reuses_the_preview_pipeline`：视觉抽取 → 固定 CSV → 既有预览，`mappingSource == "vision"`。
- `text_import::tests::*`：邮件 MIME、base64、quoted-printable、HTML 表格、银行模板、月名日期、去重、拒绝做多期权、缺价格不猜、小额期权精度。
- Playwright「AI screenshot import skips text editing and commits through the vision preview」：选择截图 → `vision_import_preview` 参数 → 直接逐行确认 → 无识别文字文本框 → 提交来源「AI 截图」。
- Playwright「AI screenshot import sends the user to settings when recognition is not enabled」：未启用错误与「前往设置 → AI 识别」按钮。
- Playwright「AI recognition settings save the key only as a masked hint and clear it on request」：密码框不回显、保存参数、尾号回填、清除 Key 后禁用。
- Playwright「email import skips column mapping and commits through the text pipeline」：邮件模式、跳过列映射、警告展示、提交来源「邮件导入」。

## 管线

```text
.eml / .txt / 粘贴文本
        │
        └─ 邮件：MIME 解码（multipart / base64 / quoted-printable / HTML）
        │
        ▼
保守行级抽取（日期、方向、合约、数量、价格、费用）

PNG / JPEG / WebP / GIF
        │
        └─ base64 → OpenAI 兼容 POST {baseUrl}/chat/completions
        │
        ▼
严格 JSON：{"trades":[...],"warnings":[...]}
        │
        ▼
逐字段校验 / 去重 / 未知类型拒绝
        │
        ▼
固定表头 CSV：日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,备注
        │
        ▼
import::parse_document → build_preview → import_commit（去重 / 校验 / 单事务）
```

- 两种来源都不会直接写库；向导先显示逐行预览，用户可改类型、取消选择。
- 备注由提交路径追加前缀：`导入:<来源> · <模板> · 第 N 行`；视觉路径模板为 `云端视觉（<model>）`。
- 日期统一规范为 `YYYY-MM-DD`（UTC 账本口径）；美式 `M/D/YYYY` 会提示按月/日/年解析。

## 云端视觉

- 设置：`get_vision_settings` / `set_vision_settings`；键为 `vision.baseUrl`、`vision.model`、`vision.apiKey`、`vision.enabled`、`vision.consent`。默认 `https://api.openai.com/v1`、`gpt-4o`、未启用。
- Key：保存在本机 SQLite；读取接口只返回 `hasKey` 与最后 4 位。保存时 `None` 保持不变、`Some("")` 清除、非空值校验 8–512 字符。启用必须同时满足「已有 Key」与「已同意隐私说明」。
- 图片：PNG / JPEG / WebP / GIF；base64 解码后 ≤5 MB，并校验文件头与 MIME 一致；不接受 BMP / TIFF。
- 网络：仅 HTTPS、禁止重定向、60 秒总超时、10 秒连接超时、响应 ≤2 MB；SQLite 锁在等待网络前释放，请求完成后再取锁生成预览。
- 模型契约：只返回 `{ "trades": [...], "warnings": [...] }`；`kind` 限定为 `option_open_short / option_close / option_expire / option_assign / shares_buy / shares_sell / dividend`；日期 `YYYY-MM-DD`；提示词明确要求忽略截图中类似指令的文字。
- 校验：数量 1–1,000,000；期权必须有到期日、行权价和 C/P；股票/分红不得带期权字段；开平仓与股票买卖价格必须为正；到期/指派价格与费用清零；分红总额缺失时用每股金额 × 数量；重复行合并；单次最多 200 笔；任何可疑行只跳过并警告，若全部被拒绝则直接报错。
- 错误：401/403、404、429、5xx 给出可操作提示；保留服务端 `error.message`（最多 300 字符），不记录或回显 Key。
- 写入：只生成 `ImportPreview`，`mappingSource` 为 `vision`；提交仍走 `import_commit`，来源默认「AI 截图」。

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
- 同封邮件中十个字段完全相同的记录合并并警告。

## 手工检查（桌面版）

- [ ] 设置 → AI 识别：填写 Base URL、模型、Key，勾选同意，启用并保存；确认页面只显示尾号，刷新后仍显示 `hasKey`。
- [ ] 导入 → AI 截图：选择一张真实成交截图，确认自动上传、直接进入逐行确认，日期/数量/价格/行权价正确。
- [ ] 修改一行类型或取消勾选，确认提交后账本正确；重复导入同一截图应标记重复。
- [ ] 关闭启用或清除 Key，确认导入页给出可操作提示并能跳到设置。
- [ ] 用超过 5 MB 的图片、BMP/TIFF 或伪造 MIME 的图片确认被拒绝。
- [ ] 断网、错误 Base URL、错误 Key、超时各试一次，确认错误可读且不泄露 Key。
- [ ] 导入 → 邮件，选择一封真实 `.eml`（multipart + base64），确认正文被解码、进入逐行确认且没有列映射步骤。
- [ ] 粘贴一封中文成交确认，确认日期、数量、价格与费用正确，备注含 `导入:<来源> · <模板> · 第 N 行`。
- [ ] 导入一封包含 Buy to Open 的邮件，确认该行被拒绝并显示原因，其余可导入行仍可提交。
- [ ] 提交后查看事件备注、持仓与成本是否按账本顺序重算；重复导入同一封邮件应标记重复。

## 已知限制

- 模型可能看错、漏行或编造字段；所有输出都经过后端校验，但最终仍必须人工逐行确认，不自动入账。
- 截图会离开本机，发送到用户配置的第三方服务；必须显式同意，且界面与文档均说明这一点。
- API Key 以明文存于本机 SQLite，会随 SQLite 备份（包括明文自动备份）复制；JSON 导出不含 Key。恢复旧备份可能带回旧 Key。
- 不同 OpenAI 兼容服务的模型名、图片字段、错误格式与额度限制不同；Base URL 与模型由用户负责。
- 不解析 PDF、图片附件、压缩包；不做 IMAP 自动拉取；不做批量图片或本地模型。
- Windows 内置 `Windows.Media.Ocr` 已移除：实测清晰截图会把 `02/20/2026` 识别成 `92/29/2926`、`150` 识别成 `159`，数字、小数点与表格列不可靠，因此不保留回退。
- 抽取器按行与最多三行窗口工作，跨越多行的复杂表格可能漏行，漏行会以警告列出而非静默丢弃。
