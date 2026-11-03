# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-11-03

P0：领域内核与成本引擎。验收记录见 [docs/P0-acceptance.md](docs/P0-acceptance.md)。

### Added

- `wheel-core` 领域模型：`Event`（卖出开仓 / 平仓 / 到期 / 指派 / 买卖股票 / 分红 / 费用 / 调整）、`OptionContract`、`Right`
- 战役（`Campaign`）生命周期与权利金池：纯卖 Put 阶段不结束战役，持股清空且无未平仓期权后才结算
- 三轨成本：A 纯股票成本、B 已落袋有效成本、C′ 含未平仓权利金的理论成本
- 收租台账（`PremiumEntry`）：净权利金、占用资金、持有天数、年化收益率；部分平仓自动拆行
- 成本阶梯点（`CostPoint`）：供前端绘制成本变化曲线
- 确定性重放引擎 `replay()`：同一事件流结果一致，输入乱序不影响结果
- 7 条不变量校验，含现金流水与战役已实现盈亏对账
- 16 项测试：golden 场景、边界、错误输入、500 组随机合法序列（约 1.2 万事件）
- `examples/demo.rs`：重放设计文档 §3.3 的 AAPL 算例

### Changed

- 战役结束规则修正为「曾持股且持股清空」才结束，修复纯卖 Put 阶段被误判为新战役、导致权利金无法摊入后续成本的问题
- 随机序列测试改用内置确定性 LCG，移除 `proptest` 依赖，保证离线环境可构建
- 归零处理：消除浮点负零，报告与 demo 中不再出现 `-0.00`

### Known Issues

- CSV / 截图 OCR / 邮件导入尚未实现（规划在 P2）
- 未运行 `cargo clippy`：当前工具链未安装该组件，且环境离线无法安装
