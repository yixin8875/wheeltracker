# P9 — 全部账户持仓总览

## 目标

多账户的股票与期权分散在各个账户里，逐账户切换才能看清现在到底持有什么、每只票的实际成本是多少。本功能提供一个**只读**页面，回答三个问题：

1. 所有可用账户现在持有哪些股票，各多少股？
2. 每个持仓扣掉已落袋权利金后的实际成本是多少？
3. 按最新参考价计算，全部持仓的浮动盈亏是多少？

页面同时列出全部账户的未平仓期权，方便一眼看到 Put 义务与到期分布；期权本身不做估值。

## 聚合口径

```
实际成本 / 股（B） = (股票成本总额 − 已落袋净权利金 − 计入口径的分红) / 股数
持仓市值           = 最新参考价 × 股数
实际成本总额       = 实际成本 / 股 × 股数
持仓盈亏           = 持仓市值 − 实际成本总额 = (参考价 − 实际成本 / 股) × 股数
盈亏率             = 持仓盈亏 / 实际成本总额        // 成本总额 ≤ 0 时显示「—」
```

- 每个「账户 × 标的 × 战役」一行，**不按标的跨账户合并**；同一标的不同账户分别显示，避免把不同券商、不同用途的资金混成一个虚假组合。
- 只列未归档账户中 `shares > 0` 的进行中战役。已结束战役的股票已清空，不进入持仓表。
- 实际成本沿用单账户的 B 轨口径；分红是否摊薄成本跟随「设置 → 成本口径」。同时展示 A（纯股票成本）与 C′（再扣除未平仓权利金）作参考。
- 参考价来自 `prices` 表该标的最新一条记录。**没有参考价的持仓不计入**持仓市值、实际成本总额与浮动盈亏的合计，界面单独计数并提示先更新行情。
- 汇总中的「已落袋净权利金」「未平仓净权利金」按**全部账户的所有战役**求和，不只持股战役；「未平仓 Put 义务」为 `Σ 行权价 × 每手股数 × 手数`（仅 Put）。
- 期权表按到期日升序，列出账户、合约、手数、每股净权利金、到期日、剩余天数与 Put 义务；不提供期权市值或浮动盈亏，因为本应用不保存期权报价。

## 返回结构

`all_holdings_overview()` 返回：

```json
{
  "asOf": "2026-11-09",
  "holdings": [{
    "accountId": "main", "accountName": "默认账户",
    "campaignId": "AAPL|2026-01-02", "symbol": "AAPL",
    "shares": 100, "costA": 150, "costB": 148, "costC": 147,
    "price": 160, "marketValue": 16000, "costBasis": 14800,
    "unrealizedPnl": 1200, "unrealizedPct": 0.0811,
    "premiumRealized": 200, "premiumOpen": 100, "dividends": 0,
    "startedAt": "2026-01-02"
  }],
  "options": [{
    "accountId": "main", "accountName": "默认账户",
    "campaignId": "AAPL|2026-01-02", "symbol": "AAPL",
    "contract": "AAPL 2026-12-18 160C", "right": "C",
    "strike": 160, "expiry": "2026-12-18", "daysLeft": 39,
    "openQty": 1, "multiplier": 100, "avgCredit": 1, "collateral": 0
  }],
  "totals": {
    "accountCount": 1, "holdingCount": 1, "pricedHoldings": 1, "unpricedHoldings": 0,
    "totalShares": 100, "marketValue": 16000, "costBasis": 14800,
    "unrealizedPnl": 1200, "unrealizedPct": 0.0811,
    "premiumRealized": 200, "premiumOpen": 100,
    "optionCount": 1, "openContracts": 1, "optionCollateral": 0
  }
}
```

所有日期为美东交易日 `YYYY-MM-DD`，金额为 USD。已归档账户不进入持仓或期权列表，也不参与合计。

## 交互

- 侧栏「复盘 → 全部持仓」新增页面；顶部五张汇总卡：持仓市值、浮动盈亏、实际成本总额、已落袋净权利金、未平仓 Put 义务。
- 股票持仓表：账户、标的、股数、实际成本 / 股、纯股票成本 / 股、参考价、持仓盈亏（附成本总额）、盈亏率、操作；无参考价的持仓显示「无参考价」标签。
- 未平仓期权表：账户、合约、手数、每股净权利金、到期日、剩余天数、Put 义务。
- 「打开战役」会先切换到该行所属账户，再打开战役详情；只读，不修改账本。
- 有未记录参考价的持仓时页面给出明确警告；所有内容只读。

## 存储与兼容

- 未新增表、列或事件类型；schema 仍为 4。
- 每次请求都按账户重放事件计算，不缓存派生汇总；账户新增 / 归档、行情更新或账本刷新后重新读取。

## 主要改动

- `wheel-app`：新增 `HoldingView`、`HoldingOptionView`、`HoldingsTotalsView`、`AllHoldingsView`、`holdings_for` 与 `all_holdings_overview` 命令。
- UI：`AllHoldings.tsx`、导航「全部持仓」、类型定义与 IPC mock。
- 测试：Rust 覆盖多账户聚合、归档排除、无参考价持仓与合计；Playwright 覆盖汇总与持仓行、未定价警告、期权表与跨账户打开战役。

## 验证

- `cargo test --offline --workspace`
- `cargo clippy --offline -p wheel-app --no-deps -- -D warnings`
- `npm --prefix ui run build`
- Playwright：全部持仓汇总与持仓行、未定价提示、期权表与跨账户打开战役。

## 已知限制

- 只列股票持仓与未平仓期权；不合并不同账户的持仓成本，也不生成组合层面的战役或报表。
- 浮动盈亏依赖 `prices` 表已保存的参考价，可能延迟；没有报价的持仓不计入合计。
- 期权不做市值与浮动盈亏估算，只展示合约、权利金与 Put 义务。
- 不连接券商，持仓仍只反映账本事件；未记录的股票、期权与跨账户调拨不会被发现。
