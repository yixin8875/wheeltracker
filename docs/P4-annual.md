# P4 年度报表验收记录

日期：2026-11-04 · 版本：0.3.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 142 通过，1 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 112 通过，1 忽略 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `ui/node_modules/.bin/playwright test --config ui/playwright.config.ts` | 40 通过 |

新增 / 覆盖的用例：

- `commands::tests::annual_report_groups_realized_pnl_by_year_month_and_symbol`：跨年战役与多标的的年度 / 月度聚合、年度内累计、标的按合计绝对值降序、账户隔离、camelCase 输出；只返回有活动的月份。
- `commands::tests::annual_report_books_call_assignment_and_excludes_put_assignment_share_pnl`：Call 指派把股票已实现盈亏计入指派日；Put 指派只计已实现权利金，不计股票盈亏；已结束战役的年度合计与 `Campaign.realized_pnl` 一致。
- `commands::tests::annual_report_counts_split_cash_in_lieu_as_share_pnl`：拆股零股现金补偿计入股票已实现盈亏，金额为现金减按比例分摊的成本。
- `commands::tests::annual_report_is_empty_without_realized_activity`：只有未平仓权利金时不返回年份。
- 既有 `monthly_income_buckets_realized_income_and_isolates_accounts` 保持不变。
- Playwright「annual report filters years and exports month and symbol sheets」：导航、年度汇总、月度明细与标的归因表、年份切换后合计与行数、CSV 下载内容、Excel 两张工作表与单元格内容。

## 口径

- 净收租：已了结期权行的 `net_premium`，按 `closed_at` 的 UTC 年 / 月入账。
- 股票已实现盈亏：`DerivedState.event_share_pnl`，按卖出、Call 指派或拆股零股补偿的事件日入账；Put 指派买入股票不计盈亏。
- 分红：`event_dividends`，按事件日入账；费用与现金调整取 `amount`，按事件日入账。
- 合计 = 净收租 + 股票已实现盈亏 + 分红 − 费用 + 现金调整。
- 月份只在有活动时出现，升序并在年度内累计；年份同样只返回有活动的年份。
- 标的按年度合计绝对值降序，金额相同则按代码升序。

## 边界

- 未平仓权利金与股票浮盈亏不计入；已在开仓时支付 / 收取的费用通过 `net_premium` 体现，不重复扣除。
- 不是税务申报表：不做短期 / 长期分类、wash sale 或 1099 汇总。
- 收租月报独立保留，年度报表不替代月报。

## 手工检查（桌面版）

- [ ] 在真实账本切换年份，确认汇总卡、图表、月度明细与标的归因同步变化。
- [ ] 核对某一年度合计与该账户仪表盘「已落袋净收租」加股票已实现盈亏、分红、费用与调整后的结果。
- [ ] 切换账户，确认年度报表按账户隔离。
- [ ] 导出 CSV 用 Excel 打开，中文表头无乱码，月度段与标的段均可读。
- [ ] 导出 Excel，确认「年度月度」「年度标的」两张工作表与页面数字一致。

本轮未执行 Windows 原生桌面端到端验收；Rust 与浏览器测试均使用合成数据。
