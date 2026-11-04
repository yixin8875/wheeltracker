# P4 收租月报验收记录

日期：2026-11-04 · 版本：0.3.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 83 通过，1 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 64 通过，1 忽略 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `cd ui && npx playwright test` | 29 通过 |

新增/覆盖的用例：

- `engine::tests::dividend_report_amount_uses_the_holding_when_quantity_is_omitted`：分红事件未填数量时，报表金额按当时持股解析。
- `commands::tests::monthly_income_buckets_realized_income_and_isolates_accounts`：1 月分红 + 费用、2 月平仓净收租 + 现金调整的月份、累计、合计与账户隔离；IPC 字段为 camelCase。
- Playwright「monthly income report accumulates rent by month and filters by year」：三卡与表尾合计、月份倒序、2026 年筛选后区间合计 $263.00、2025 年行隐藏、图表可见。

## 口径

- 净收租：已了结期权行的 `net_premium`，按平仓日的美东交易日月份入账。
- 分红：`DerivedState.event_dividends`，按事件日入账。
- 独立费用与现金调整：按事件日入账；合计 = 净收租 + 分红 − 费用 + 调整。
- 未平仓权利金、股票浮盈亏不计入；只显示有活动的月份。

## 手工检查（桌面版）

- [ ] 在真实账本中切换账户，确认收租月报随账户变化且合计与仪表盘「已落袋净收租」一致。
- [ ] 选择年份后图表 X 轴与表尾合计同步缩小。
- [ ] 导出的 CSV 含合计行，用 Excel 打开中文表头无乱码。
