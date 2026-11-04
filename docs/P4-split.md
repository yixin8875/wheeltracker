# P4 拆股 / 合约乘数验收记录

日期：2026-11-04 · 版本：0.3.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 138 通过，1 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 108 通过，1 忽略 |
| 核心场景 | `cargo test -p wheel-core --test scenarios` | 27 通过 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `ui/node_modules/.bin/playwright test --config ui/playwright.config.ts` | 39 通过 |

新增 / 覆盖的用例：

- `split_two_for_one_adjusts_shares_and_open_contract`：100 股 + 1 手 Put 在 2:1 后变为 200 股，行权价减半、乘数 200，未平仓净权利金与占用资金总额不变。
- `reverse_split_scales_strike_and_multiplier`、`three_for_two_split_keeps_fractional_strike`：1:10 与 3:2 的行权价 / 乘数缩放。
- `non_integral_option_split_is_rejected`：4:3 无法整除乘数时整笔拒绝，状态不变。
- `fractional_split_needs_cash_in_lieu_and_books_it`：101 股 1:10 无补偿拒绝；带补偿则 10 股 + 现金 + 已实现盈亏。
- `consecutive_splits_follow_the_alias_chain`、`split_aliases_let_the_old_contract_close`、`backfilled_split_applies_before_a_later_dated_close`：连续拆股、旧合约平仓、补录拆股。
- `opening_a_pre_split_contract_after_the_split_is_rejected`：拆股后旧合约新开仓返回 `AdjustedContractRequired`。
- `one_for_one_split_is_a_no_op`、`split_without_a_campaign_is_recorded_as_a_note`、`t7_multi_contract_uses_multiplier`。
- `commands::tests::dashboard_uses_the_contract_multiplier_for_collateral`、`build_event_accepts_splits_and_requires_both_terms`：资金义务按乘数、IPC 拆股参数与 camelCase 输出。
- `store`：旧库幂等补齐拆股列、`user_version = 2`、拆股事件 round-trip、拒绝带数量 / 合约 / 非法比例 / 负补偿。
- Playwright「stock split entry submits ratio and cash in lieu without trade fields」：拆股模式隐藏数量 / 价格 / 费用，提交 `stock_split`、比例与零股补偿。
- Playwright「non-integral split ratio surfaces a readable error and keeps the form」：后端拒绝时显示可读错误并保留输入。
- Playwright「split ratio appears in the event log and campaign timeline」：交易记录与战役时间轴显示 `2 : 1` 与零股补偿。
- Playwright「open contract multiplier drives entry prefill and reminder premium」：200 股/手持仓回填表单，提醒净权利金按乘数计算。

## 口径

- 新股数 = 旧股数 × 分子 ÷ 分母，向下取整；零股不保留仓位，必须填写现金补偿（可为 0）。
- 行权价 = 旧行权价 × 分母 ÷ 分子，四舍五入到 4 位小数；每手股数 = 旧乘数 × 分子 ÷ 分母，必须精确整除。
- 零股对应成本按比例从战役成本中扣除，现金补偿计入战役现金与已实现股票盈亏。
- 拆股只作用于该标的当前进行中的战役；没有持仓时记录为无害历史事件，不回溯已结束战役。
- 未平仓台账与持仓的每股权利金按比例缩放，`net_premium`、手数与占用资金总额不变。

## 被拒绝的情形

| 情形 | 结果 |
|---|---|
| 分子 / 分母为 0 或超过 1,000,000 | `InvalidSplitTerms` |
| 期权调整后乘数不是正整数 | `NonIntegralOptionAdjustment` |
| 有零股但未填补偿 | `FractionalSplitNeedsCashInLieu` |
| 无零股却填了非零补偿 | `UnexpectedCashInLieu` |
| 拆股事件带合约、数量、价格、费用或金额 | 入库校验拒绝 |
| 拆股后用旧合约新开仓 | `AdjustedContractRequired` |
| 数据库 `user_version` 高于应用支持版本 | 拒绝打开并提示升级应用 |

## 手工检查（桌面版）

- [ ] 在真实账本录入 2:1 拆股，核对持股数、A / B / C′ 成本、未平仓合约行权价与每手股数。
- [ ] 录入 101 股 1:10 反向拆股，确认必须填写零股补偿，现金与已实现盈亏正确。
- [ ] 拆股后对旧合约执行平仓、指派与到期作废，确认均能匹配调整后持仓。
- [ ] 连续记录两次 2:1 拆股，确认比例累计为 4:1，旧合约仍可平仓。
- [ ] 旧账本升级后拆股列为空、`user_version` 为 2；用更新版本创建的数据库被拒绝打开。
- [ ] 备份并恢复拆股后的账本，确认拆股事件与派生状态完整重放。

本轮未执行 Windows 原生桌面端到端验收；Rust 与浏览器测试均使用合成数据。
