# P6 — 账户现金与 Put 覆盖

## 目标

在只记账、不连接券商的前提下，回答两个问题：

1. 账本记录的账户现金还有多少？
2. 这些现金能否承接全部未平仓 Put 的指派义务？

同时提供只读的券商现金对照，帮助定位漏记的入金 / 出金或交易，而不是自动改写账本。

## 事件模型

新增两个账户级事件，金额均为正数：

| 事件 | 现金影响 | 说明 |
|---|---|---|
| `CASH_DEPOSIT` | `+amount` | 入金；无标的、无合约、无数量 / 价格 / 费用 |
| `CASH_WITHDRAWAL` | `−amount` | 出金；无标的、无合约、无数量 / 价格 / 费用 |

两者都不进入战役，不影响 A / B / C′ 成本、战役收益或收租 / 年度报表。

## 派生与口径

```
account_cash = Σ 全部 event_cash
             = Σ campaigns.cash_flow + cash_deposits − cash_withdrawals
cash_tracked = cash_deposits > 0 或 cash_withdrawals > 0
cash_coverage = account_cash / open Put 资金义务   // 仅在 cash_tracked 且有未平仓 Put 时
cash_shortfall = max(0, open Put 资金义务 − account_cash)  // 仅在 cash_tracked 时
```

- 未记录任何入金 / 出金时，`account_cash` 只是交易现金流净额，不含期初余额；界面显示「交易现金流净额」，覆盖率显示「—」，并提示先补录期初入金。
- 现金覆盖只基于账本事件，不含未记录的利息、券商费用、在途资金、融资额度或未入账交易。
- 引擎不变量：`Σ event_cash == account_cash == Σ campaign.cash_flow + deposits − withdrawals`。

## 交互

- 仪表盘「账户现金与 Put 覆盖」面板：账户现金 / 交易现金流净额、累计入金 / 出金、Put 资金义务、现金覆盖率与缺口；按钮「记录入金」「记录出金」「与券商对账」。
- 「记一笔」新增入金 / 出金类型：隐藏标的、数量、价格、费用与合约字段，只填写交易日、金额、备注；保存时 `symbol` 固定为空。
- 「与券商对账」：输入券商现金余额，显示账本现金、券商现金、差额，并列出最近 60 笔现金变动与变动后余额。按美东交易日排序，最新在前；到期作废现金影响为 0，不进入列表。对账结果不保存。
- 交易记录与导入预览对入金 / 出金显示金额，数量 / 费用列为「—」，标的列显示「账户」。

## CSV 导入

识别别名：入金 / 存入 / 存款 / 转入 / Deposit / Transfer In；出金 / 取出 / 取款 / 转出 / Withdraw / Transfer Out。

- 必须提供金额列；金额必须大于 0。
- 入金金额为负时报错（避免方向被静默翻转）；出金金额为负时取绝对值并提示。
- 带标的代码会被忽略并提示；带数量、价格或费用的行会清零并提示，带合约则报错。
- 指纹包含金额，因此同日但金额不同的入金 / 出金不会互相判重；日期、类型与金额都相同时仍按重复行处理。

## 存储与兼容

- schema `user_version` 从 3 升至 4；没有新增表或列，只因新增事件语义而升版。
- 0.5.6 及更早版本会拒绝打开 schema 4 的数据库，避免读到无法识别的事件类型。
- 备份校验沿用 `user_version > SCHEMA_VERSION` 的拒绝规则。

## 主要改动

- `wheel-core`：`EventKind::CashDeposit` / `CashWithdrawal`、事件构造器、`EngineError::InvalidCashAmount`、`DerivedState::{event_cash, account_cash, cash_deposits, cash_withdrawals}`、现金不变量。
- `wheel-app`：事件校验与 kind 映射、schema 4、`SummaryView` 现金 / 覆盖率字段、`cash_movements` IPC、CSV 别名与逐行校验、`build_event` 支持现金类型。
- UI：`AccountCash.tsx`（现金面板与对账弹窗）、录入表单现金模式、事件日志 / 导入预览显示、月报 / 年报脚注。

## 验证

- `cargo test --offline --workspace`：现金场景、非法金额、战役成本不受影响、存储 round-trip 与校验、仪表盘覆盖率 / 缺口、现金变动顺序与限额、CSV 行解析与指纹。
- `cargo clippy --offline -p wheel-app --no-deps -- -D warnings`
- `npm --prefix ui run build`
- Playwright：现金面板展示、对账差额与现金变动列表、「记录入金」提交字段。

## 已知限制

- 不连接券商：入金 / 出金需手工或 CSV 补录，现金余额不会自动与券商同步。
- 不含利息、融资、在途资金与未记录交易；覆盖率只是账本视角的下限判断。
- 对账差额不会自动生成调整事件，需用户判断后决定是否补录入金 / 出金或修正交易。
