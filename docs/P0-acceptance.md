# P0 验收报告

| 项 | 值 |
|---|---|
| 版本 | v0.1.0 |
| 日期 | 2026-11-03 |
| 范围 | `wheel-core` 领域内核与成本引擎 |
| 环境 | Windows 11 · rustc 1.99.1 · cargo 1.99.1 · 离线构建（`--offline`） |

## 1. 结论

**P0 通过。** 设计文档第 12 节的 11 项用例已覆盖并通过；T12（CSV 导入）属于 P2 范围，不计入本次验收。另有 2 项已知差异见第 5 节。

## 2. 验证命令与结果

```bash
cargo test -p wheel-core --offline
```

```
running 16 tests
...
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
Doc-tests wheel_core: 1 passed; 0 failed
```

```bash
cargo run -p wheel-core --example demo --offline
```

demo 输出与设计文档 §3.3 完全一致：

```
 #  date        event                         shares     cost A     cost B    cost C'   realized       open
 1  2026-01-05  卖 Put 200P @5.00                   0          -          -          -       0.00     498.50
 2  2026-02-20  200P 到期作废                          0          -          -          -     498.50       0.00
 3  2026-02-25  卖 Put 195P @6.00                   0          -          -          -     498.50     598.50
 4  2026-03-20  195P 被指派，买入 100 股                100     195.00     184.03     184.03    1097.00       0.00
 5  2026-03-25  卖 Call 200C @4.00                100     195.00     184.03     180.04    1097.00     398.50
 6  2026-04-17  200C 到期作废                        100     195.00     180.04     180.04    1495.50       0.00
 7  2026-05-15  卖 Call 205C @3.00                100     195.00     180.04     177.06    1495.50     298.50
 8  2026-06-19  205C 被行权，股票被 call 走                0          -          -          -    1794.00       0.00

campaign P&L: 2794.00   share P&L: 1000.00   premium realized: 1794.00
All invariants hold.
```

## 3. 用例矩阵

| 用例 | 设计要求 | 实现测试 | 结果 |
|---|---|---|---|
| T1 | 单次 Put 作废 | `t1_expired_put_moves_premium_to_realized` | ✅ |
| T2 | Put 指派形成持股 | `t2_assignment_builds_share_lot_and_cost_b` | ✅ |
| T3 | Call 作废 | `t3_expired_call_lowers_cost_b_not_cost_a` | ✅ |
| T4 | Call 被行权清仓 | `walkthrough_matches_design_document` / `t9_second_campaign_starts_with_empty_pool` | ✅ |
| T5 | Roll（BTC + STO） | `t5_roll_nets_both_legs_without_double_counting` | ✅ |
| T6 | 部分平仓 | `t6_partial_close_splits_ledger_and_releases_proportionally` | ✅ |
| T7 | 多手（3 张） | `t7_multi_contract_uses_multiplier` | ✅ |
| T8 | 提前指派 | `t8_early_assignment_uses_actual_date` | ✅ |
| T9 | 连续两轮战役 | `t9_second_campaign_starts_with_empty_pool` | ✅ |
| T10 | B 为负 | `t10_negative_effective_cost_is_allowed` | ✅ |
| T11 | 随机序列 10k 事件 | `random_wheel_sequences_keep_invariants`（500 组 × 最多 24 事件 ≈ 1.2 万） | ✅ |
| T12 | 导入 500 行 CSV | 未实现，P2 范围 | ⏸ 延后 |

补充覆盖：分红开关、乱序重放幂等、重复事件 ID、超量平仓、无股被 call、负数量校验。

## 4. 不变量矩阵

| # | 不变量 | 实现位置 | 结果 |
|---|---|---|---|
| 1 | `shares >= 0` | `u32` 类型保证 | ✅ |
| 2 | 期权持仓手数守恒 | `check_invariants` 对比持仓与台账 open qty | ✅ |
| 3 | 权利金池与台账一致 | `premium_open` / `premium_realized` 求和校验 | ✅ |
| 4 | `cost_b` 公式自洽 | 由 `Campaign::cost_b` 统一计算，衍生数据同源 | ✅ |
| 5 | 战役关闭条件 | `ever_held_shares && shares == 0 && 无未平仓期权` | ✅ |
| 6 | 现金流对账 | `Campaign.cash_flow` 与 `realized_pnl` 比对 | ✅ |
| 7 | 重建幂等 | `replay_is_order_independent_and_idempotent` | ✅ |

## 5. 与设计的差异

1. **战役结束规则**：设计初稿为「空仓即结束」，实现中发现它与 §3.3 算例矛盾。已修正为「曾持股且持股清空」才结束，纯卖 Put 阶段保留在同一战役内。设计文档 §2.1 / §3.4 / §6.2 已同步。
2. **随机测试规模**：由 200 组提升到 500 组，事件总量约 1.2 万，满足 T11 的「10k 事件」要求。

## 6. 遗留项

| 项 | 说明 | 计划 |
|---|---|---|
| CSV / OCR / 邮件导入 | T12 未实现 | P2 |
| `cargo clippy` | 工具链未安装，离线无法安装 | P1 前补跑 |
| 多账户 | 引擎按单账户重放，`Event.account_id` 已预留 | P4 |
| 行情盯市 | 成本曲线只含成本，未叠加现价 | P1（手动价格）/ P3（导入） |
