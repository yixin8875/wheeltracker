# P8 — 全部账户只读总览

## 目标

多账户的现金与 Put 义务分散在各个账户里，逐账户切换才能拼出整体风险。本功能提供一个**只读**页面，回答三个问题：

1. 所有可用账户加起来的账本现金是多少？
2. 全部未平仓 Put 的资金义务有多大，覆盖率如何？
3. 各账户分别是什么状态，哪一个需要先补录现金？

它不合并持仓、成本、战役或报表——这些仍然按账户隔离，避免把不同券商、不同用途的资金混成一个虚假的组合。

## 聚合口径

```
总账本现金 = Σ (已记录入金 / 出金的账户).account_cash
总 Put 义务 = Σ (全部可用账户).collateral
已记录现金账户的 Put 义务 = Σ (已记录现金账户).collateral
综合覆盖率 = 总账本现金 / 已记录现金账户的 Put 义务   // 分母为 0 时显示「—」
总现金缺口 = Σ max(0, account.collateral − account.account_cash)  // 仅已记录现金账户
```

- `account_cash` = 全部交易现金流 + 累计入金 − 累计出金；未记录入金 / 出金的账户，它只是交易现金流净额，不能当作余额。
- 因此总现金只累加 `cash_tracked` 的账户；未记录现金的账户单独计数，并在界面标记「未记录现金」。
- 综合覆盖率只覆盖已记录现金账户的 Put 义务。若存在「有 Put 但未记录现金」的账户，页面显示警告，提醒这部分义务未计入分母。
- 总缺口逐账户计算后相加，一个账户的现金盈余不会抵消另一个账户的缺口；资金未必能跨券商划转。
- 未平仓净权利金、进行中战役数、持仓数与股数按全部可用账户求和，仅用于展示规模，不参与覆盖率。

## 返回结构

`all_accounts_overview()` 返回：

```json
{
  "asOf": "2026-11-06",
  "accounts": [{
    "id": "main", "name": "默认账户",
    "premiumRealized": 200, "premiumOpen": 100,
    "activeCampaigns": 1, "openPositions": 1, "openContracts": 1,
    "collateral": 15000, "sharesHeld": 100,
    "accountCash": 5200, "cashDeposits": 20000, "cashWithdrawals": 500,
    "cashTracked": true, "cashCoverage": 0.3467, "cashShortfall": 9800
  }],
  "totals": {
    "accountCount": 1, "cashTrackedAccounts": 1,
    "untrackedAccounts": 0, "untrackedPutAccounts": 0,
    "premiumRealized": 200, "premiumOpen": 100,
    "activeCampaigns": 1, "openPositions": 1, "openContracts": 1,
    "collateral": 15000, "trackedCollateral": 15000, "sharesHeld": 100,
    "accountCash": 5200, "cashDeposits": 20000, "cashWithdrawals": 500,
    "cashCoverage": 0.3467, "cashShortfall": 9800
  }
}
```

所有日期为美东交易日 `YYYY-MM-DD`，金额为 USD。已归档账户不进入 `accounts`，也不参与合计。

## 交互

- 侧栏「复盘 → 全部账户」新增页面；顶部五张汇总卡：账本现金、总 Put 资金义务、综合覆盖率、现金缺口、未平仓净权利金。
- 账户表：账户名、账本现金、Put 义务、覆盖率、缺口、未平仓净权利金、持仓数；未记录现金的账户显示「未记录现金」标签与交易净额。
- 「打开账户」只切换当前账户并回到仪表盘，不修改账本。
- 有未记录现金但持有 Put 的账户时，页面给出明确警告；只有未记录现金、没有 Put 时，用脚注说明这些账户未计入总现金。
- 页面所有内容只读；输入、保存、对账与备份入口仍只在单账户页面。

## 存储与兼容

- 未新增表、列或事件类型；schema 仍为 4。
- 每次请求都按账户重放事件计算，不缓存派生汇总；账户新增、归档、切换或账本刷新后重新读取。

## 主要改动

- `wheel-app`：抽取 `summary_view` 复用单账户现金 / 义务口径；新增 `AccountOverviewView`、`OverviewTotalsView`、`AllAccountsView`、`overview_for` 与 `all_accounts_overview` 命令。
- UI：`AccountsOverview.tsx`、导航「全部账户」、总览样式、类型定义。
- 测试：Rust 覆盖多账户合计、归档排除、未记录现金分离与无现金覆盖率；Playwright 覆盖汇总卡、未记录现金警告与打开账户切换。

## 验证

- `cargo test --offline --workspace`
- `cargo clippy --offline -p wheel-app --no-deps -- -D warnings`
- `npm --prefix ui run build`
- Playwright：总览汇总与账户行、未记录现金提示、打开账户切换并刷新该账户仪表盘。

## 已知限制

- 只汇总现金、义务与未平仓权利金；不合并持仓、成本、战役或报表。
- 总覆盖率只基于已记录现金的账户；未记录入金 / 出金的账户需要先补录期初入金，才能纳入整体判断。
- 总缺口是各账户缺口之和，不代表实际可调拨资金；跨券商转账、汇率与在途资金均未建模。
- 不连接券商，现金仍只反映账本事件。
