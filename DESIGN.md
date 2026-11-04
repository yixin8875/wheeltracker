# Wheel Tracker — 美股期权车轮策略成本追踪器

> 详细设计文档 v0.1 · 2026-11-03
> 技术栈：Tauri 2 + React + TypeScript · 成本口径：双轨展示 · 数据来源：手工 + 截图/邮件导入 · 首版：MVP

---

## 0. 一句话

一个**本地优先**的桌面应用：记录每一笔 sell put / sell call / 指派 / 平仓，自动算出「这只票我现在每股到底是多少钱」，并沉淀一份可复盘的收租台账。

---

## 1. 产品目标与非目标

### 1.1 目标

| # | 目标 | 验收方式 |
|---|---|---|
| G1 | 任何一个持仓标的，1 秒内看到当前每股成本 | Dashboard 卡片大字直接显示 |
| G2 | 成本随时间的变化可视化 | 阶梯折线图，每个权利金事件是一个台阶 |
| G3 | 每笔期权收租可追溯：开仓价、平仓成本、净收入、年化 | 收租台账表格 |
| G4 | 手工录入一笔交易 ≤ 15 秒 | 键盘优先的快速录入表单 |
| G5 | 数据可完整重算、可导出、可备份 | 事件溯源 + 一键重建 + JSON/SQLite 导出 |
| G6 | 截图/邮件里的成交信息能半自动进系统 | 云端视觉 / 文本解析 → 人工确认 → 入库 |

### 1.2 非目标（明确不做）

- ❌ 不连接券商下单，**只读记账**，永远不发送任何交易指令。
- ❌ 不做行情终端（不替代 TWS / 富途）。
- ❌ MVP 不做多币种换算（统一 USD 记账，字段保留 currency）。
- ❌ MVP 不做税务申报口径（只提供导出原始数据）。
- ❌ 不做云端同步 / 多设备（本地 SQLite 为唯一真相源）。

### 1.3 核心用户旅程

```
卖出 Put（收租）
   │
   ├─ 到期作废 ─────────────► 权利金落袋，成本池增加，继续卖 Put
   │
   └─ 被指派 ──► 买入 100 股 ──► 卖出 Call（继续收租降低有效成本）
                                    │
                                    ├─ 到期作废 ──► 成本继续下降
                                    └─ 被 Call 走 ──► 卖出股票，战役结束，结算总收益
```

应用要能完整表达上面每一条边，并且随时回答：**「如果现在被 call 走，我这轮赚多少？」**

---

## 2. 核心领域概念

### 2.1 战役（Campaign）—— 成本计算的边界

> **战役 = 同一标的从「首次开仓」到「持股被清空且无未平仓期权」的一段过程。**

精确规则（P0 实现口径）：

1. 首次卖出期权时开启战役。
2. 战役**尚未持有过股票**时，即使所有期权都到期作废、仓位归零，战役也不结束——它处于「建仓前收租期」，权利金继续累积，等待未来某次指派。
3. 一旦发生过指派或手工买入（`ever_held_shares = true`），当股票被全部卖出且没有未平仓期权时，战役结束并结算。
4. 纯卖 Put 且从未被指派过的标的会长期保持一个 active 战役，这是有意为之：它的累计收租本身就是一份可查看的战绩，日后可加「手动结算」按钮。

为什么需要它：权利金的归属必须有边界。上一轮战役赚到的钱，不应该自动摊到下一轮新开仓的股票上——否则成本会越算越低，失去参考意义。

```
战役 #1 ──┬── sell put ── 作废 ── sell put ── 指派 ── buy 100股 ── sell call ── 被call走
           │                                                                      │
           └──────────────────── 战役结束，结算总 P&L ───────────────────────────┘

战役 #2 ──┬── sell put ...   （全新的池子，从 0 开始）
```

> 可配置项 `campaign_mode`：
> - `continuous`（默认）：空仓→有仓→空仓 为一个战役
> - `per_cycle`：每次指派单独成战役（日后可选）
> - `per_symbol`：永不重置，按标的全历史累积（激进口径，不推荐）

### 2.2 事件（Event）—— 唯一真相源

所有数据都是**不可变事件**。持仓、成本、台账全部由事件推导而来，随时可以从零重算。

| 事件类型 | 含义 | 关键字段 |
|---|---|---|
| `OPTION_OPEN_SHORT` | 卖出开仓（STO） | 合约、手数、权利金/股、费用 |
| `OPTION_CLOSE` | 买入平仓（BTC） | 合约、手数、平仓价/股、费用 |
| `OPTION_EXPIRE` | 到期作废 | 合约、手数 |
| `OPTION_ASSIGN` | 被指派/行权 | 合约、手数、指派费 |
| `SHARES_BUY` | 手工买入股票 | 标的、股数、价格、费用 |
| `SHARES_SELL` | 手工卖出股票 | 标的、股数、价格、费用 |
| `DIVIDEND` | 分红（可选计入成本） | 标的、金额 |
| `FEE` | 独立费用调整 | 标的、金额 |
| `ADJUSTMENT` | 手工修正 | 标的、备注、覆盖值 |
| `SPLIT` | 拆股 / 合股 | 标的、分子、分母、零股现金补偿 |

**滚动（Roll）不新增事件类型**：一次 roll 就是 `OPTION_CLOSE` + `OPTION_OPEN_SHORT` 两笔，天然把净现金流算对。UI 层可提供「滚动录入」把两个表单合并，落库仍是两条事件。

### 2.3 期权持仓与股票批次

- **期权持仓（Option Position）**：同一合约的多次 STO 合并为一个持仓，按**加权平均权利金**记账；部分平仓时释放对应比例。
- **股票批次（Share Lot）**：每次指派生成一个批次，记录原始成本；总成本按批次汇总到标的上。

### 2.4 权利金池（Premium Pool）

每个战役维护两个池：

| 池 | 含义 | 何时变动 |
|---|---|---|
| `premium_open`（浮动） | 已收到但义务未了结的净权利金 | STO 时 +，平仓/到期/指派时 − |
| `premium_realized`（已落袋） | 已确定归属的净权利金 | 平仓/到期/指派时 + |
| `dividends`（可选） | 战役期间收到的分红 | 分红事件时 + |

净权利金一律**扣除费用**：`net = 权利金 × 100 × 手数 − 费用`。

---

## 3. 成本模型（核心）

### 3.1 三个口径

设某标的当前：

- `S` = 持股数
- `C` = 股票总成本（含买入/指派费用，美元）
- `R` = 战役已落袋净权利金
- `O` = 战役未平仓净权利金
- `D` = 计入成本的分红（设置里可开关，默认关）

| 轨道 | 公式 | 名称 | 用途 |
|---|---|---|---|
| **A** | `A = C / S` | 纯股票成本 | 税务/券商 App 里显示的成本，用来对账 |
| **B** | `B = (C − R − D) / S` | **有效成本（已落袋）** | 主展示数字，当前真实的成本线 |
| **C′** | `C′ = (C − R − O − D) / S` | 含浮盈理论成本 | 开关项，把未平仓权利金也算进去 |

**B 永远 ≤ A**（权利金非负时），差额就是「靠收租摊薄了多少」。B 可以为负数——股票白拿还倒赚，此时显示为绿色并标注 `成本已归零`。

### 3.2 状态更新规则

按时间顺序重放事件。设当前战役状态为 `{S, C, R, O, D}`。

| 事件 | 现金 | 状态变化 |
|---|---|---|
| `OPTION_OPEN_SHORT` | `+price×100×qty − fees` | `O += net`；若 S=0 且战役未激活则开启战役 |
| `OPTION_CLOSE` | `−price×100×qty − fees` | `close_cost = price×100×qty + fees`；`O −= 释放的原始净权利金`；`R += 释放权利金 − close_cost` |
| `OPTION_EXPIRE` | 0 | `O −= 释放的净权利金`；`R += 释放的净权利金` |
| `OPTION_ASSIGN`（Put） | `−K×100×qty − 指派费` | `O −= 净权利金`；`R += 净权利金`；`S += 100qty`；`C += K×100qty + 指派费`；生成股票批次 |
| `OPTION_ASSIGN`（Call） | `+K×100×qty − 指派费` | `O −= 净权利金`；`R += 净权利金`；`S −= 100qty`；`C −= 按比例分摊的股票成本`；若 S=0 且无未平仓期权 → 结算战役 |
| `SHARES_BUY` | `−price×qty − fees` | `S += qty`；`C += price×qty + fees` |
| `SHARES_SELL` | `+price×qty − fees` | `S −= qty`；`C −= 分摊成本`；S→0 且无期权 → 结算 |
| `DIVIDEND` | `+amount` | `D += amount`（若开关打开） |
| `FEE` | `−amount` | `R −= amount` 或计入对应事件 |
| `ADJUSTMENT` | 视情况 | 覆盖指定字段并打审计标记 |

**部分平仓的分摊**：按该持仓的加权平均权利金比例释放；股票成本按 `C × (卖出股数 / S)` 分摊。

### 3.3 完整示例（AAPL，1 手 = 100 股）

| 日期 | 事件 | 权利金 | 费用 | 状态 |
|---|---|---|---|---|
| 01-05 | STO 1× 02-20 200P | $5.00 | $1.50 | O = 498.50 |
| 02-20 | 到期作废 | — | — | R = 498.50, O = 0 |
| 02-25 | STO 1× 03-20 195P | $6.00 | $1.50 | O = 598.50 |
| 03-20 | 被指派 | — | $0 | R = 1,097.00；买入 100 股 @195；**C = 19,500** |
| 03-23 | 成本快照 | | | **A = 195.00**，**B = (19500−1097)/100 = 184.03** |
| 03-25 | STO 1× 04-17 200C | $4.00 | $1.50 | O = 398.50；**C′ = 180.05** |
| 04-17 | 到期作废 | — | — | R = 1,495.50；**B = 180.05** ✔ 与 C′ 收敛 |
| 05-15 | STO 1× 06-19 205C | $3.00 | $1.50 | O = 298.50 |
| 06-19 | 被 Call 走 @205 | — | $0 | R = 1,794.00；卖出 100 股 @205 |

**战役结算：**

```
卖出所得        20,500.00
− 股票成本      19,500.00   → 股票价差 +1,000.00
+ 累计权利金     1,794.00
────────────────────────────
战役总收益      2,794.00
投入资本        19,500.00
收益率           14.33%
持有期           约 5.6 个月
年化            约 30.7%
```

整个过程中 B 从 `195.00` 一路降到 `180.05`，最后一次 Call 让它实际上变成 `162.06`——这就是用户想「一眼看到」的东西。

### 3.4 边界情况

| 情况 | 处理 |
|---|---|
| 同一合约多次 STO | 合并持仓，加权平均权利金 |
| 部分平仓 | 按比例释放，台账拆出子行 |
| 提前指派（Put 在到期前被行权） | 事件日期用实际指派日；状态标记 `assigned_early` |
| B 变为负数 | 正常显示负成本，UI 显示 `成本已归零 · 剩余 $X/股 安全垫` |
| 空头 Call 股数不足 | 校验报错，要求先有对应股票 |
| 拆股/合股 | 记录 `SPLIT` 事件，自动调整持股数、未平仓期权的行权价与每手股数；零股以现金补偿入账，不保留小数股 |
| 同一标的重复战役 | 持股清空且无持仓后自动开新战役，旧战役归档 |
| 纯卖 Put 从未被指派 | 战役保持 active，权利金持续累积，等待指派 |
| 手工改历史 | 生成 `ADJUSTMENT` 事件，不直接改原事件（保留审计链） |
| 期权到期日当天未标记 | 应用按日期自动把过期未处理持仓标红，提示「已到期，请标记作废或指派」 |

---

## 4. 收租台账与收益指标

### 4.1 台账字段（每笔期权一行）

| 字段 | 说明 |
|---|---|
| 标的 / 合约 | `AAPL 2026-04-17 200C` |
| 方向 | Sell Put / Sell Call |
| 手数 | 1 |
| 开仓日 / 平仓日 | 到期作废时平仓日 = 到期日 |
| 状态 | `open` / `closed` / `expired` / `assigned` |
| 开仓权利金（毛） | $4.00 × 100 = $400 |
| 平仓成本 | BTC 时才有；作废为 0 |
| 费用 | 佣金 + 监管费 |
| **净收入** | 毛权利金 − 平仓成本 − 费用 |
| 占用资金 | Put：`K×100×手数`；Call：`行权价×100×手数` |
| 持有天数 | 平仓日 − 开仓日 |
| 静态收益率 | `净收入 / 占用资金` |
| **年化收益率** | `静态收益率 × 365 / max(持有天数,1)` |
| 归属战役 | 链接回 Campaign |

### 4.2 汇总指标

**账户级**

- 累计净收租（已落袋 / 含浮盈两列）
- 今年 / 本月 / 本周净收租
- 年化收租率 = `近 12 个月净权利金 / 平均占用资金`
- 平均占用资金（按日快照近似）
- 未平仓义务总额（cash secured + covered call 市值）
- 战役完成数、胜率（作废 vs 被指派）、平均持有天数

**标的高级**

- 当前 A / B / C′ 三轨成本
- 距离成本线的百分比 = `(现价 − B) / B`
- 下一张 Call 的行权价与剩余天数
- 本轮已收租占股票成本比例
- 若现在被 call 走的总收益

### 4.3 图表

1. **成本阶梯图**（核心图）
   - X 轴时间，Y 轴每股成本
   - 阶梯线：B 在每个权利金事件处下降一档
   - 叠加：现价折线、A 轨虚线、当前 Call 行权价水平线
   - 每个台阶 hover 显示「事件 + 降幅 $/股」

2. **收租累积图**：按月柱状 + 累计折线

3. **战役对比**：同一标的历次战役的收益率/天数散点

4. **到期日历**：未来 30 天到期的合约，按日期排布

---

## 5. 数据模型（SQLite）

### 5.1 表结构

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 账户
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  broker        TEXT,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  created_at    TEXT NOT NULL
);

-- 标的
CREATE TABLE instruments (
  symbol   TEXT PRIMARY KEY,
  name     TEXT,
  currency TEXT NOT NULL DEFAULT 'USD'
);

-- 期权合约（事件入库时自动 upsert）
CREATE TABLE option_contracts (
  id         TEXT PRIMARY KEY,              -- OCC symbol，如 AAPL260417C00200000
  underlying TEXT NOT NULL,
  expiry     TEXT NOT NULL,                 -- YYYY-MM-DD
  strike     REAL NOT NULL,
  right      TEXT NOT NULL CHECK (right IN ('P','C')),
  multiplier INTEGER NOT NULL DEFAULT 100
);

-- ★ 唯一真相源：不可变事件
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  seq          INTEGER NOT NULL,            -- 账户内单调递增，稳定排序
  occurred_at  TEXT NOT NULL,               -- 成交/到期/指派日
  kind         TEXT NOT NULL,
  contract_id  TEXT REFERENCES option_contracts(id),
  symbol       TEXT,
  qty          INTEGER,                     -- 期权=手数，股票=股数
  price        REAL,                        -- 每股权利金 / 每股股价
  fees         REAL NOT NULL DEFAULT 0,
  cash_flow    REAL,                        -- 写入时校验，读取时可重算
  source       TEXT NOT NULL DEFAULT 'manual',  -- manual|import|ocr|email
  source_ref   TEXT,
  note         TEXT,
  payload      TEXT,                        -- JSON 扩展
  split_numerator   INTEGER,                -- 拆股分子（仅 SPLIT）
  split_denominator INTEGER,                -- 拆股分母
  split_cash_in_lieu REAL,                  -- 零股现金补偿
  created_at   TEXT NOT NULL,
  UNIQUE (account_id, seq)
);
CREATE INDEX idx_events_acct_time ON events(account_id, occurred_at, seq);

-- 派生：股票批次
CREATE TABLE share_lots (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  campaign_id    TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  qty            INTEGER NOT NULL,
  remaining_qty  INTEGER NOT NULL,
  cost_per_share REAL NOT NULL,
  origin_event   TEXT NOT NULL
);

-- 派生：未平仓期权
CREATE TABLE option_positions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  contract_id   TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  open_qty      INTEGER NOT NULL,
  avg_credit    REAL NOT NULL,      -- 每股净权利金（加权平均）
  opened_at     TEXT NOT NULL,
  open_event    TEXT NOT NULL
);

-- 派生：战役
CREATE TABLE campaigns (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT NOT NULL,   -- active | closed
  shares           INTEGER NOT NULL DEFAULT 0,
  cost_total       REAL NOT NULL DEFAULT 0,
  premium_realized REAL NOT NULL DEFAULT 0,
  premium_open     REAL NOT NULL DEFAULT 0,
  dividends        REAL NOT NULL DEFAULT 0,
  realized_pnl     REAL,
  cycles           INTEGER NOT NULL DEFAULT 0
);

-- 派生：收租台账
CREATE TABLE premium_entries (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  contract_id   TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  right         TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  status        TEXT NOT NULL,      -- open|closed|expired|assigned
  premium_gross REAL NOT NULL,
  close_cost    REAL NOT NULL DEFAULT 0,
  fees          REAL NOT NULL DEFAULT 0,
  net_premium   REAL,               -- 平仓后确定
  collateral    REAL NOT NULL,
  days_held     INTEGER,
  ann_return    REAL,
  open_event    TEXT NOT NULL,
  close_event   TEXT
);

-- 派生：成本点（阶梯图的点）
CREATE TABLE cost_points (
  campaign_id      TEXT NOT NULL,
  at               TEXT NOT NULL,
  shares           INTEGER NOT NULL,
  cost_total       REAL NOT NULL,
  premium_realized REAL NOT NULL,
  cost_a           REAL,
  cost_b           REAL,
  PRIMARY KEY (campaign_id, at)
);

-- 手动/导入的行情（MVP 手工维护）
CREATE TABLE prices (
  symbol TEXT NOT NULL,
  date   TEXT NOT NULL,
  close  REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- 设置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 5.2 派生原则

- `events` 是唯一可写表；其余派生表均可删除重建。
- 每次写入事件后，在**同一事务**内增量重算受影响的战役；同时提供 `rebuild_all()` 全量重建。
- `schema_meta(engine_version)` 记录算法版本，升级时触发重建。
- 持久化 schema 版本写入 `PRAGMA user_version`（当前为 3）。打开数据库前若版本高于应用支持的版本，拒绝并提示升级应用，不执行任何 DDL；旧库通过幂等 `ALTER TABLE` 补齐拆股列与账户归档列。

---

## 6. 计算引擎与一致性

### 6.1 引擎结构（纯 Rust，无 Tauri 依赖）

```
wheel-core/
├── model.rs        // Event, Campaign, Position, LedgerEntry
├── engine.rs       // replay(events) -> DerivedState
├── campaign.rs     // 战役开闭与结算
├── premium.rs      // 权利金池、台账生成
├── metrics.rs      // A/B/C 成本、年化、汇总
├── store.rs        // sqlx 读写与事务
└── import/         // CSV/AI 截图/邮件解析（也可独立 crate）
```

### 6.2 不变量（每次重算后断言）

1. `shares >= 0`
2. 对每个期权持仓：`已平手数 + 未平手数 == 原始手数`
3. `campaign.premium_realized + premium_open + dividends == Σ premium_entries.net_premium`
4. `cost_b == (cost_total − premium_realized − dividends) / shares`（S > 0 时）
5. 战役 `closed` 时：`shares == 0`、无未平仓期权，且 `ever_held_shares == true`（纯 Put 战役不关闭）
6. 全部事件 `cash_flow` 之和 == 账户现金净变化
7. 任意两次全量重建结果字节级一致（幂等）

### 6.3 测试策略

- **Golden scenarios**：把第 3.3 节示例、roll、部分平仓、多手、提前指派写成固定用例，断言 A/B/C。
- **Property tests（proptest）**：随机生成合法事件序列，验证不变量 1–6。
- **重建测试**：随机打乱写入顺序 → 按时间重放 → 结果一致。
- **导入测试**：真实券商对账单脱敏样本 → 解析结果快照。

### 6.4 性能

数据量级：单账户十年约 1–3 万事件。全量重放 < 50ms。无需缓存，无需异步复杂化。

---

## 7. 界面设计

### 7.1 信息架构

```
仪表盘        ← 默认页，所有标的一览
├─ 标的详情   ← 战役时间轴 + 成本阶梯图 + 事件列表
├─ 持仓       ← 股票持仓 / 期权持仓（含到期倒计时）
├─ 收租台账   ← 全量表格 + 筛选 + 汇总
├─ 记一笔     ← 快速录入（快捷键 Ctrl+N）
├─ 导入       ← CSV / AI 截图 / 邮件文本
└─ 设置       ← 账户、成本口径、提醒、备份
```

### 7.2 仪表盘（核心页面）

```
┌────────────────────────────────────────────────────────────────────┐
│  Wheel Tracker                      AAPL  NVDA  TSLA …   [＋记一笔] │
├────────────────────────────────────────────────────────────────────┤
│  累计净收租  $12,480.50     年化 23.4%    占用资金 $86,000   持仓 4 │
├────────────────────────────────────────────────────────────────────┤
│  AAPL                                              持股 100 股      │
│                                                                     │
│   有效成本   $180.05 /股          现价 $197.20     安全垫 +9.53%    │
│   ████████████████████░░░░░░   ── 成本线 ──────────── 现价          │
│                                                                     │
│   纯股票成本 $195.00   已落袋权利金 $1,495.50   未平仓 $298.50     │
│   下一张：2026-06-19  205C  剩 2 天   若被call走总收益 +$2,794      │
│                                                                     │
│   [ 成本阶梯图 ××╲××××╲××××××╲×× ]                    [详情 →]   │
├────────────────────────────────────────────────────────────────────┤
│  NVDA   有效成本 $112.40   现价 $128.90   +14.7%   1× 130C 剩 9 天 │
├────────────────────────────────────────────────────────────────────┤
│  TSLA   ⚠ 卖 Put 中   195P 剩 1 天   已收租 $420   资金占用 $19,500│
└────────────────────────────────────────────────────────────────────┘
```

设计要点：

- **成本数字是本应用的第一视觉**——24–32px、等宽数字字体（`tabular-nums`），不放在表格里。
- 成本线与现价用同一根横向标尺对比，安全垫用颜色编码（绿/黄/红）。
- 每张卡片固定 4 行信息，不做折叠，保证扫视效率。

### 7.3 标的详情页

```
┌──────────────────────────────────────────────────────────────┐
│ ← AAPL                                   战役 #3  进行中       │
├──────────────────────────────────────────────────────────────┤
│  [成本阶梯图 · 可切换 A/B/C′ · 叠加现价]                      │
├──────────────────────────────────────────────────────────────┤
│  战役时间轴                                                   │
│  ○ 01-05 卖 Put 200P @$5.00   ── 收租 $498.50                │
│  ○ 02-20 到期作废                                            │
│  ● 03-20 被指派 195 ×100股    ── 成本 195.00                  │
│  ○ 03-25 卖 Call 200C @$4.00  ── 收租 $398.50                │
│  ○ 04-17 到期作废             ── 有效成本降至 180.05          │
│  ○ 05-15 卖 Call 205C @$3.00  ── 剩余 2 天                   │
├──────────────────────────────────────────────────────────────┤
│  本轮统计：已收租 $1,495.50 · 周期 3 · 日均 $8.9 · 年化 21%   │
└──────────────────────────────────────────────────────────────┘
```

### 7.4 快速录入（Ctrl+N）

键盘优先，Tab 流转，Enter 提交：

```
类型     [卖 Put ▾]   标的 [AAPL___]  到期 [2026-06-19]
行权价   [205.00]     权利金 [3.00]   手数 [1]
费用     [1.50]       日期 [2026-05-15] 账户 [默认 ▾]
备注     [____________________]
────────────────────────────────────────────
净收入   +$298.50      占用资金 $20,500     年化 21.2%
                                    [保存并继续]  [保存]
```

- 实时预览净收入与年化，避免录完才发现算错。
- 支持「滚动」按钮：预填 BTC + STO 两条，一次提交。
- 支持粘一行文本自动解析：`AAPL 6/19 205C STO 1 @3.00 fee1.5`。

### 7.5 收租台账

- 列：日期、标的、合约、方向、手数、开仓价、平仓价、净收入、占用资金、天数、年化、状态、战役
- 顶部筛选：账户 / 标的 / 时间 / 状态 / 方向
- 底部汇总行：合计净收入、平均年化、笔数
- 状态用色块：`expired` 绿、`assigned` 蓝、`closed` 灰、`open` 橙
- 一键导出 CSV / Excel

### 7.6 视觉规范

| 项 | 取值 |
|---|---|
| 主题 | 深色默认，浅色可切换 |
| 数字字体 | `ui-monospace` + `font-variant-numeric: tabular-nums` |
| 盈利色 | `#22c55e`，亏损色 `#ef4444`，警示 `#f59e0b` |
| 圆角 | 12px，卡片间距 16px |
| 密度 | 桌面中等密度，表格行高 40px |

---

## 8. 架构与技术选型

### 8.1 总体

```
┌─────────────────────────────────────────────┐
│  React 18 + TypeScript + Vite               │
│  Zustand（状态）· TanStack Table · ECharts  │
│  Tailwind CSS + shadcn/ui                   │
└──────────────────┬──────────────────────────┘
                   │  Tauri IPC（typed commands）
┌──────────────────▼──────────────────────────┐
│  Rust / Tauri 2                             │
│  ├── wheel-core（领域引擎，纯逻辑 + 测试）  │
│  ├── store（sqlx + SQLite）                 │
│  ├── import（CSV / AI 截图 / 邮件解析）     │
│  ├── notify（到期提醒）                     │
│  └── backup（自动备份 / 导出）              │
└─────────────────────────────────────────────┘
                   │
        %APPDATA%/WheelTracker/wheel.db
```

### 8.2 选型理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 壳 | Tauri 2 | 包体 ~10MB、内存低；领域逻辑放 Rust，好做单元测试与性质测试 |
| 前端 | React + TS | 生态成熟，图表/表格库齐全 |
| 样式 | **Tailwind CSS**（已确认） + shadcn/ui | 原子化样式，深色默认；与设计规范中的色板/圆角直接对应 |
| 状态 | Zustand | 轻量，不需要 Redux 的仪式感 |
| 图表 | Apache ECharts | 阶梯图、多轴、markLine 支持最好 |
| 表格 | TanStack Table | 无样式、虚拟滚动、列筛选 |
| 存储 | SQLite + sqlx | 事务可靠、可导出、零运维 |
| IPC 类型 | tauri-specta | 自动生成 TS 类型，前后端不漂移 |
| 日期 | `time` crate | 期权到期是纯日期，避免时区陷阱 |

### 8.3 目录结构

```
optiontrader/
├── Cargo.toml                 # workspace
├── crates/
│   ├── wheel-core/            # 领域模型 + 引擎 + 存储（可独立测试）
│   │   ├── src/{model,engine,campaign,premium,metrics,store}.rs
│   │   └── tests/scenarios/
│   ├── wheel-import/          # CSV / AI 截图 / 邮件解析
│   └── wheel-app/             # Tauri 二进制
│       ├── src/{main,commands,store,views,backup,restore,import,market}.rs
│       └── tauri.conf.json
├── ui/
│   ├── src/
│   │   ├── pages/{Dashboard,Positions,Ledger,Entry,Campaign,Import,Settings}.tsx
│   │   ├── components/{CostCard,CostChart,CampaignTimeline,LedgerTable,QuickEntry}.tsx
│   │   ├── api/               # tauri-specta 生成的 bindings
│   │   └── store/
│   └── package.json
└── DESIGN.md
```

### 8.4 关键命令（IPC）

```rust
list_campaigns(account_id) -> Vec<CampaignView>
get_dashboard(account_id) -> DashboardView
get_campaign(campaign_id, account_id) -> CampaignDetail
list_accounts() -> Vec<AccountView>
create_account(name) -> AccountView            // 名称唯一，≤50 个账户
rename_account(account_id, name) -> AccountView
add_event(req: NewEventReq) -> EventId
delete_event(event_id) -> ()          // 软删除 + 重建
rebuild_all(account_id) -> RebuildReport
list_ledger(filter: LedgerFilter) -> LedgerPage
monthly_income(account_id) -> MonthlyIncomeView   // 已落袋口径，按 UTC 月份
list_positions(account_id) -> PositionsView
preview_option(req) -> OptionPreview   // 录入时实时算净收入/年化
import_preview(req: ImportPreviewReq) -> ImportPreview
import_commit(req: ImportCommitReq) -> ImportSummary
import_save_mapping(signature, mapping) -> bool
text_import_preview(req: TextImportReq) -> ImportPreview   // 邮件文本
get_vision_settings() -> VisionSettingsView                // 只返回 hasKey / 尾号
set_vision_settings(req: VisionSettingsReq) -> VisionSettingsView
vision_import_preview(req: VisionImportReq) -> ImportPreview  // 云端视觉 → 逐行确认
set_price(symbol, date, close)
export_report(range, format) -> Path
backup_now(password: Option<String>) -> Path      // 有密码时生成 .sqlite.enc
export_json() -> String                          // 全账户事件 + 报价 + 设置
set_preferences(reminder_lead_days, auto_backup_enabled, auto_backup_keep) -> SettingsView
list_backups() -> Vec<BackupEntry>               // 含 encrypted 标志
validate_backup(file_name, password: Option<String>) -> BackupValidation
stage_restore(file_name, password: Option<String>) -> PendingRestore  // 写 marker，不立即替换
restore_status() -> RestoreStatus
```

### 8.5 P3 体验闭环

- **到期提醒**：前端由 `positions.daysLeft` 与 `settings.reminderLeadDays` 推导；`<0` 过期，`<=min(3, lead)` 紧急，`<=lead` 即将到期。侧栏徽标、仪表盘卡片、日历共用同一口径，不注册系统通知。
- **到期日历**：纯 `Date.UTC` 的周一起始 42 格月历；选中日列出合约，顶部汇总未来 30 天。账本日期统一使用后端 UTC `asOf`。
- **战役对比**：按战役聚合，已实现收益 = `realizedPnl`（回退为权利金 + 分红 + 股票盈亏 + 现金调整）；峰值投入取逐日「未平仓 Put 占用资金 + 当日持股纯股票成本」的最大值；收益率为两者之比，投入为 0 时留空。进行中战役不含未平仓权利金与股票浮盈亏。
- **Excel**：`ui/src/xlsx.ts` 手写 STORE-only ZIP 与 OOXML（CRC32、UTF-8 文件名、inlineStr、冻结首行、金额/百分比 `numFmt`），不引入依赖、不生成 `<f>` 公式；`export.ts` 组装台账、交易记录、持仓、战役四表。
- **自动备份**：应用启动及后台线程每 30 分钟读取 UTC 日期，`lastAutoBackupDay` 相同则跳过；恢复 marker 存在时跳过。成功生成 `auto-*.sqlite` 后更新日期，再按 `autoBackupKeep` 清理旧自动备份；手动备份与 `pre-restore-*` 不受影响。
- **恢复协议**：`restore/pending.json` 只存文件名、安全快照名与请求时间。暂存时先只读校验备份，再用 `VACUUM INTO` 生成 `pre-restore-*.sqlite`，最后原子写 marker。下次启动在 `store::open` 之前执行 `apply_pending`：重新校验 → 归档 `wheel.db` 与 WAL/SHM/journal → 复制为临时文件并校验 → 替换 `wheel.db`；任一步失败回滚并隔离 marker，回滚失败则中止启动，绝不静默新建空库。成功保留最近 3 组归档。marker 存在期间所有写入命令返回「已安排恢复，请重启应用」。
- **偏好**：`reminderLeadDays`（0–60，默认 7）、`autoBackupEnabled`（默认开）、`autoBackupKeep`（1–100，默认 7）存于 `settings` 键值表，严格解析，非法值不会部分写入。

### 8.6 P4 多账户

- **模型**：沿用既有 `accounts` 表；事件带 `account_id`，重放与不变量按账户独立执行。`main` / 默认账户在首次启动时创建，旧账本无需迁移。
- **选择**：当前账户存于前端 `localStorage`（`wheel.account`）；读取 `list_accounts` 后若该 ID 不存在则回退到最早创建的账户。切换账户会清除战役详情并刷新仪表盘、持仓、台账与事件。
- **隔离范围**：仪表盘、持仓、台账、事件日志、战役详情、录入与 CSV 导入均传 `accountId`；行情报价、成本口径、备份与恢复为全局资源。
- **管理**：设置 → 账户显示币种、交易数、建立日期与归档状态，支持新建、重命名、归档 / 恢复与删除空账户；名称去首尾空白、1–40 字符、不含控制字符、不区分大小写唯一，最多 50 个账户（含已归档）。暂存恢复期间拒绝全部账户写操作。
- **归档**：`accounts.archived_at` 记录归档日期（`YYYY-MM-DD`，恢复时置空）；归档账户从侧栏切换器隐藏，但数据、交易与报表完全保留；至少保留一个可用账户，不能归档最后一个。
- **删除**：只允许删除没有任何事件行（含已撤销）的空账户；删除当前账户时前端自动切到另一个可用账户。最后一个可用账户不能删除。
- **存储**：schema v3 为 `accounts` 增加可空 `archived_at`，幂等 `ALTER TABLE` 迁移并写 `PRAGMA user_version = 3`；`list_accounts` 同时返回每账户事件计数，供前端禁用删除。

### 8.7 P4 收租月报

- **口径**：只统计已落袋收入。净收租按 `PremiumEntry.status != open` 的行在 `closed_at` 所在月入账，金额为 `net_premium`（已扣开仓与平仓费用）；分红按 `Dividend` 事件日入账，金额取 `DerivedState.event_dividends`（事件未填数量时由引擎按当时持股解析）；独立费用按 `Fee` 事件日、现金调整按 `Adjustment` 事件日入账。未平仓权利金与股票浮盈亏不计入。
- **月合计**：`净收租 + 分红 − 独立费用 + 现金调整`；`BTreeMap<YYYY-MM>` 保证月份升序，逐月累加得到累计。
- **前端**：柱形为月度合计、折线为所选年份区间累计；年份筛选后重新计算区间合计与累计；表尾显示区间合计；CSV 导出当前筛选结果，含合计行。
- **边界**：只返回有活动的月份，不补零；没有已了结期权时只显示分红 / 费用 / 调整月份。

### 8.8 P4 备份加密与 JSON 导出

- **文件格式**：加密备份写入 `.sqlite.enc`，布局为 `WHEELBK1`（8 字节）+ 迭代次数（u32 LE）+ 盐（16）+ nonce（12）+ AES-256-GCM 密文与 16 字节标签。密钥由 PBKDF2-HMAC-SHA256 从密码派生（默认 200,000 次），整个 40 字节头作为 AAD，改写迭代次数或盐会直接认证失败。
- **密码策略**：8–128 个字符、不能只含空白；密码不写入磁盘、不进入日志。密码遗失无法恢复。
- **创建**：仅手动备份支持加密。先 `VACUUM INTO` 生成普通快照，读入内存加密后原子替换为 `.sqlite.enc`，随后删除明文快照；任何一步失败都清理中间文件。自动备份与 `pre-restore-*` 安全快照保持普通 SQLite。
- **校验**：`validate_backup` 对加密文件先在备份目录解密到临时文件，再做 `integrity_check` 与必需表/列检查，完成后删除临时文件。
- **恢复**：暂存时解密到 `restore/staged-<stamp>.sqlite` 并校验，marker 升级为 version 2 并记录 `stagedFile`；下次启动 `apply_pending` 直接使用该副本，替换成功或失败后都删除明文副本，加密备份本身保留。version 1 marker 继续按原路径恢复。
- **JSON 导出**：`export_json` 输出 `wheel-export` version 1 文档，包含所有账户（含仅存在于事件表的账户 ID）、全部未删除事件（`occurredAt` 为 `YYYY-MM-DD` UTC）、报价与设置；事件按日期、账户、seq 排序。JSON 仅供查看与迁移，不能替代 SQLite 快照恢复。

### 8.9 P4 拆股与合约乘数

- **乘数**：`OptionContract.multiplier` 默认 100，录入时可填实际每手股数；毛权利金、占用资金、指派预览、年化、到期提醒与仪表盘资金义务均按乘数计算。CSV / 邮件 / 视觉导入新增可选「乘数」列，默认 100。
- **事件**：`EventKind::Split` 无载荷，比例与零股补偿存于 `Event.split: Option<SplitTerms>`；`kind == Split` 当且仅当 `split.is_some()`。拆股事件不得携带合约、数量、价格、费用或金额；分子 / 分母为 1–1,000,000 的整数，`cash_in_lieu` 有限且非负。
- **重放顺序**：拆股只作用于该标的当前进行中的战役；没有持仓时记录为无害历史事件。先预检全部未平仓合约与持股，任一失败则整笔拆股不入账、状态不变。
- **期权调整**：行权价 `new = old_strike × denominator ÷ numerator`，四舍五入到 4 位小数；每手股数 `new_multiplier = old_multiplier × numerator ÷ denominator` 必须精确整除且为正整数，否则返回 `NonIntegralOptionAdjustment`。未平仓台账与持仓的合约直接替换，`premium_gross_per_share` / `credit_per_share` 除以比例；`net_premium`、手数与占用资金总额不变。
- **股票调整**：`exact = shares × numerator ÷ denominator`，`new_shares = floor(exact)`；有零股时必须提供现金补偿（可为 0），无零股时补偿必须为 0。零股对应成本 `cost_total × fractional ÷ exact` 从战役成本中扣除，现金补偿计入 `cash_flow` 与已实现股票盈亏；批次股数与每股成本按比例缩放，财务总额以战役为准。
- **合约 alias**：保留旧合约 id → 调整后合约的映射，连续拆股沿链解析；平仓、指派、作废先 canonicalize 再匹配，拆股后用旧合约新开仓被 `AdjustedContractRequired` 拒绝。
- **存储**：schema v2 增加 `split_numerator` / `split_denominator` / `split_cash_in_lieu` 并写 `PRAGMA user_version = 2`；`EventView`、JSON 导出与交易记录 CSV 均带拆股字段。
- **前端**：交易类型新增「拆股 / 合股」，拆股模式只显示日期、标的、分子、分母、零股补偿与备注；期权表单显示「1 手 = N 股」，选择持仓时回填乘数。

### 8.10 P4 年度已实现收益报表

- **口径**：净收租取 `PremiumEntry.net_premium`，按 `closed_at` 的年 / 月入账；股票已实现盈亏取 `DerivedState.event_share_pnl`（卖出、Call 指派、拆股零股补偿），按事件日的年 / 月与标的入账；分红取 `event_dividends`，费用与现金调整取 `amount`，均按事件日入账。`total = premium + share_pnl + dividends - fees + adjustments`。未平仓权利金与股票浮盈亏不计入。
- **聚合**：`annual_report(accountId)` 一次重放后按「年 → 月、标的」聚合；只返回有活动的年份与月份，月份升序并在年度内累计；标的按 `|total|` 降序。跨年战役的期权按平仓日、股票按卖出 / 指派日归属；账户之间完全隔离。
- **DTO**：`AnnualReportView { availableYears, years }`，每年含 `months`、`symbols` 与 `total`；`AnnualMonthView` 带 `cumulative`、`closedEntries`、`shareEvents`；`AnnualTotalView` 为年度合计。
- **前端**：导航新增「年度报表」，默认最新年份；汇总卡展示年度合计、净收租、股票盈亏、分红、费用与调整；柱形为月度合计、折线为年度累计；月度明细与按标的归因各一张表；CSV 导出含月度段、年度合计与标的段，Excel 导出「年度月度」「年度标的」两张工作表。
- **边界**：只读报表，不替代收租月报；不是税务申报表，不做短期 / 长期分类或 wash sale。

### 8.11 P5 发布工程

- **版本单一来源**：workspace `Cargo.toml` 为 `0.3.0`，`wheel-core` / `wheel-app` 均 `version.workspace = true`；`tauri.conf.json`、`ui/package.json`、`ui/package-lock.json` 与 `Cargo.lock` 同步镜像。`scripts/release.py` 在打包前逐项校验，任一不一致即失败。
- **安装包**：Tauri `bundle.targets = ["nsis"]`，`installMode = currentUser`，简体中文 / English 语言选择，开始菜单 `Wheel Tracker`，lzma 压缩；`licenseFile` 指向 MIT `LICENSE`，并设置 publisher / copyright / Finance 分类 / 中英文描述。
- **CSP**：生产 `default-src 'self'`，`connect-src` 仅 `ipc:` 与 `http://ipc.localhost`，图片允许 `data:` / `blob:`，样式允许内联；`devCsp` 额外放行 Vite 的 `127.0.0.1:1420` HTTP / WebSocket 与开发期内联脚本。
- **数据库保护**：当前 schema `user_version = 2`；更高版本数据库拒绝打开；备份校验同样拒绝 `user_version > 2` 的快照并提示升级应用，避免旧版破坏新数据。
- **发布产物**：`scripts/release.py` 依次执行版本检查、`cargo test --workspace`、clippy、前端构建与 NSIS 打包，然后在 `dist/release/` 写出 `<installer>.sha256`（`<hex>  <filename>`）与 `release-manifest.json`（产品、版本、git 提交、UTC 构建时间、目标三元组、文件名、大小、SHA-256、`signing: "unsigned"`、`updater: "not-configured"`）。产物目录不纳入版本控制。
- **自动化**：`.github/workflows/windows-ci.yml` 在 push / PR / 手动触发时运行 Rust 测试、clippy 与前端构建；Playwright 依赖 Edge 与开发服务器，暂为本地 / 人工门禁。安装、覆盖升级、卸载与 CSP 冒烟见 `docs/release-checklist.md`。
- **边界**：不做代码签名、自动更新、单实例、日志上传或崩溃上报；安装包未签名，SmartScreen 提示写入发布说明。

---

## 9. 数据导入

统一抽象：

```rust
trait ImportAdapter {
    fn parse(&self, input: &ImportInput) -> Vec<CandidateEvent>;
}
struct CandidateEvent { event: Event, confidence: f32, raw_excerpt: String }
```

**任何导入结果都必须经过人工确认页**，可逐条改、可丢弃，确认后才写库。

### 9.1 手工录入

见 7.4。另提供「批量粘贴」：一行一笔，用固定模板解析。

### 9.2 AI 截图识别

已实现（云端视觉，OpenAI 兼容协议）：

- 配置：设置 → AI 识别填写 Base URL（如 `https://api.openai.com/v1`）、模型与 API Key，勾选隐私同意后才能启用。Key 存在 `settings` 表的 `vision.apiKey`，`get_vision_settings` 只返回 `hasKey` 与尾号，不返回明文；JSON 导出不含 Key，但 SQLite 备份（含自动备份）会包含。
- 输入：导入向导「AI 截图」选择 PNG / JPEG / WebP / GIF（≤5 MB，base64 解码后再校验文件头），或在页面内 Ctrl+V 粘贴；不接受 BMP / TIFF。图片会发送到用户配置的第三方服务，界面在启用和导入页都明确提示。
- 请求：`POST {baseUrl}/chat/completions`，Bearer Key，`temperature: 0`、`max_tokens: 4096`，图片以 data URI 放入 `image_url`。客户端只允许 HTTPS、禁止重定向（避免 Key 被转发）、60 秒超时、10 秒连接超时、响应上限 2 MB。
- 模型契约：系统提示要求只返回 `{ "trades": [...], "warnings": [...] }`，字段为 `date / kind / symbol / qty / price / fees / expiry / strike / right / amount`，日期统一 `YYYY-MM-DD`；明确要求忽略截图里的指令（防提示注入），看不清就省略并写入 warnings，不猜。
- 后端校验：`vision` 模块解析纯 JSON、```json 围栏或顶层数组；逐条规范化日期与标的，数量 1–1,000,000；期权必须有到期日、行权价与 C/P，股票/分红不得带期权字段；开平仓与股票买卖必须有正价格，到期/指派价格与费用清零；`buy_to_open` / `sell_to_close` 明确拒绝；重复行合并并警告；单次最多 200 笔。任何字段不合法只跳过该行并列出原因，没有可导入行时直接报错。
- 写入：模型结果转换为固定表头 CSV（`日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,备注`），复用 CSV 的预览、去重、整批事务与 `导入:<来源>` 备注；预览的 `mappingSource` 为 `vision`，来源默认「AI 截图」。截图不会自动入账，必须逐行确认。
- 错误：401/403、404、429、5xx 给出可操作提示，并保留服务端 `error.message`（截断 300 字符，不回显 Key）；未启用、未同意或缺少 Key 时提示前往设置。
- 已知边界：不同兼容服务的模型名、图片字段和错误格式可能不同；模型可能幻觉或漏行，因此不信任模型输出，必须人工确认。已移除 Windows 内置 OCR：实测数字、小数点与斜杠错误严重，不再保留回退路径。

### 9.3 邮件导入

已实现（本地解析，不联网）：

- 输入：`.eml` / `.txt` 或粘贴正文；`text_import` 解码 MIME `multipart/*`（优先 `text/plain`，否则 HTML）、base64、quoted-printable，并把 HTML 表格转成制表符 / 换行文本。非 UTF-8 字符集给出警告，不猜测编码。
- 模板识别：Schwab、Fidelity、IBKR、富途、老虎与「通用邮件」；模板只影响备注与提示，字段抽取使用同一组通用规则，便于处理同一券商的不同邮件版式。
- 字段：交易日期（含 `Trade Date` / `成交日期`、上一行日期、月名日期）、方向（STO / BTC / 到期 / 指派 / 买卖股票 / 分红）、合约（`AAPL 02/20/2026 150 P`、月名格式或 OCC 代码）、数量、价格（`@`、`Price`、`成交价`、`at`）、费用（下一行也可）、分红金额与每股金额。
- 保守边界：缺少日期 / 数量 / 价格 / 合约的行逐条警告并跳过；做多期权明确拒绝；同封邮件完全重复的记录合并；持仓相关跨行错误仍由提交重放拒绝整批。
- 输出：固定表头 CSV（`日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌,备注`），因此复用 9.4 的映射、去重、逐行预览与单事务提交；备注格式 `导入:<来源> · <模板> · 第 N 行`。
- 未实现：IMAP 定时拉取、附件 PDF 解析。Phase 3 若加入 IMAP，仍应只读、按发件人过滤，并复用同一抽取器。

### 9.4 CSV 对账单

已实现（通用列映射，不绑定券商）：

- **输入**：桌面文件选择（`.csv` / `.txt`）或直接粘贴；RFC4180 引号与引号内换行、BOM/CRLF；上限 8 MB、5000 行、64 列。前端优先严格 UTF-8，失败回退 GB18030。
- **字段**：交易日期、类型（规范值）或方向/买卖、标的、OCC 合约代码、数量、价格、费用、金额、到期日、行权价、看涨/看跌、备注；中英文别名自动识别，歧义表头提示人工确认。
- **日期**：`YYYY-MM-DD`、`YYYY/M/D`、`YYYY年M月D日` 规范化为 `YYYY-MM-DD`；`M/D/YYYY` 按美式解析并显式提示。
- **类型**：STO / BTC / 到期 / 指派 / 买卖股票 / 分红 / 费用 / 调整；做多期权（Buy to Open、Sell to Close）明确拒绝，不静默归类。
- **映射持久化**：表头顺序敏感签名，保存于 `settings` 的 `importMapping:v1:<signature>`。
- **去重**：账户 + 日期 + 类型 + 标的 + 到期 + 行权价 + C/P + 数量 + 价格 + 费用，数值规范到 6 位小数；重复行默认不勾选，提交时在互斥锁内重查。
- **提交**：按 `(日期, 文件行号)` 稳定排序，复用 `append_requests` 的单一事务重放；任一行非法整批回滚；备注前缀 `导入:<来源>`。
- **预览边界**：预览只读，不做逐行持仓模拟；平仓/指派缺少持仓等跨行错误在提交重放时拒绝整批。

---

## 10. 路线图

| 阶段 | 内容 | 交付 | 估算 |
|---|---|---|---|
| **P0 内核** ✅ | `wheel-core` 领域模型 + 重放引擎 + 不变量断言 + golden/property 测试 | `cargo test` 全绿（16 项 + 文档测试），`cargo run --example demo` 可重放示例 | 已完成 |
| **P1 MVP** ✅ | Tauri 壳 + SQLite + 快速录入 + 仪表盘 + 标的详情 + 收租台账 + 手动价格 | 可日常使用的桌面应用 | 已完成 |
| **P2 导入** 🟢 | CSV 映射向导 + 去重、AI 截图、邮件文本解析（均已完成） | 历史数据可批量补录 | 已完成 |
| **P3 体验** ✅ | 到期提醒 + 到期日历 + 战役对比图 + 导出 Excel + 自动备份 + 恢复向导 + 盯市成本图 | 完整闭环 | 已完成 |
| **P4 扩展** ✅ | 多账户、收租月报、备份加密与 JSON 导出、AI 截图 / 邮件导入、拆股与合约乘数、年度已实现收益报表 | 进阶 | 已完成（不做云端同步） |
| **P5 发布** ✅ | 版本统一 0.3.0、NSIS + 中英文安装器、CSP、数据库降级保护、哈希清单与发布检查清单、Windows CI | 可分发安装包 | 已完成（不签名、不自动更新） |

**P1 的完成定义**：用户能连续一周只用这个应用记账，不打开券商 App 也能回答「我现在每股成本多少、这轮赚了多少」。

---

## 11. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 成本口径理解偏差 | 数字不可信，用户弃用 | 三轨并列显示 + 设置里可切换口径 + 文档解释每个数字来源 |
| 手工录入出错 | 成本越算越偏 | 实时预览、录入校验、事件可删可重建、每日核对提醒 |
| 指派日期与到期日混淆 | 时间轴错乱 | 分开存 `occurred_at` 与 `effective_at`，指派默认用到期日 |
| 视觉模型误识别 | 脏数据 | 严格字段校验、跳过可疑行、永远人工确认，不自动入账 |
| 券商改名/拆股 | 历史数据失真 | 拆股用 `SPLIT` 事件调整持股、行权价与乘数，零股现金补偿；更名走 `ADJUSTMENT` |
| 滚动记账复杂 | 用户漏记一半 | 「滚动」合并表单，一次生成两条事件 |
| 数据丢失 | 灾难 | WAL + 每日自动备份（保留 7 份）+ 一键导出 JSON |

---

## 12. 验收用例（P0 必须通过）

| # | 场景 | 断言 |
|---|---|---|
| T1 | 单次 Put 作废 | O→R 转移，成本不变，台账 `expired` |
| T2 | Put 指派形成持股 | A = strike，B = strike − premium/100 |
| T3 | Call 作废 | B 下降 premium/100，A 不变 |
| T4 | Call 被行权清仓 | 战役关闭，realized_pnl = 价差 + 权利金 |
| T5 | Roll（BTC + STO） | 净权利金正确，无重复计入 |
| T6 | 部分平仓 | 台账拆行，池子按比例释放 |
| T7 | 多手（3 张） | 现金、占用资金、成本按 300 股计 |
| T8 | 提前指派 | 日期正确，状态 `assigned` |
| T9 | 连续两轮战役 | 第二轮池子从 0 开始，不继承 |
| T10 | B 为负 | 正确显示，不报错 |
| T11 | 随机序列 10k 事件 | 不变量 1–7 全部成立，重建幂等 |
| T12 | 导入 500 行 CSV | 去重生效，人工确认后可入库 |

---

## 附：关键设计决策速查

| 决策 | 结论 |
|---|---|
| 权利金归属边界 | 按「战役」（空仓→有仓→空仓） |
| 成本口径 | 三轨：A 纯股票 / B 已落袋 / C′ 含浮盈 |
| 数据架构 | 事件溯源 + 可全量重算 |
| 期权持仓计价 | 加权平均权利金 |
| 股票成本分摊 | 按剩余股数比例 |
| Roll | 两条事件，UI 合并录入 |
| 行情 | MVP 手工维护，接口预留 |
| 导入 | 一律人工确认后入库 |
| 删除 | 软删除 + 重建，保留审计 |
