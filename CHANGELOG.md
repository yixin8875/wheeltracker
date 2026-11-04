# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 拆股 / 合股：新增 `stock_split` 事件，记录分子 / 分母与可选零股现金补偿；重放时调整进行中战役的持股数（向下取整）、未平仓期权的行权价（四舍五入 4 位）与每手股数，零股按「整数股 + 现金补偿」入账并计入已实现盈亏，不保留小数股
- 拆股后合约 alias：旧合约 id 可继续平仓 / 指派 / 到期作废；连续拆股沿 alias 链解析；拆股后用旧合约新开仓被 `AdjustedContractRequired` 拒绝
- 拆股校验：比例须为 1–1,000,000 的整数，期权调整后乘数必须整除，有零股时必须给出补偿（可为 0），无零股时补偿必须为 0；任一不满足整笔拆股不入账、状态不变
- 期权乘数：录入、台账、持仓、到期提醒、指派预览与仪表盘资金义务使用 `contract.multiplier`（默认 100），不再硬编码 100；CSV / 邮件 / 视觉导入新增可选「乘数」列
- 数据库 schema v2：`events` 新增 `split_numerator` / `split_denominator` / `split_cash_in_lieu`，幂等 `ALTER TABLE` 迁移并写 `PRAGMA user_version = 2`；更高版本数据库拒绝打开
- `EventView` / `ExportEvent` / JSON 导出 / 事件 CSV 包含拆股比例与现金补偿；`DerivedState.event_share_pnl` 记录股票卖出、Call 指派与拆股零股的已实现盈亏，并校验其总额等于 `Campaign.share_pnl`
- 邮件导入：导入向导新增「邮件」模式，选择 `.eml` / `.txt` 或粘贴正文；`text_import` 模块本地解码 multipart、base64、quoted-printable 与 HTML，按 Schwab、Fidelity、IBKR、富途、老虎和通用成交确认抽取日期、方向、合约、数量、价格与费用
- 邮件抽取器保守处理：缺少日期、数量、价格或合约的行不猜测，记录为警告并跳过；同一封邮件中的完全重复记录合并；做多期权（Buy to Open / Sell to Close）明确拒绝；抽取结果生成固定表头 CSV，复用现有预览、去重、整批事务与备注前缀
- AI 截图识别：导入向导新增「AI 截图」，支持 PNG / JPEG / WebP / GIF 与 Ctrl+V 粘贴；`vision` 模块向用户配置的 OpenAI 兼容 `/chat/completions` 接口发送 base64 图片，要求模型返回严格 JSON，再逐字段校验、去重并生成固定表头 CSV
- AI 识别设置：设置页新增「AI 识别」，可配置 Base URL、模型与 API Key，显式同意后才允许启用；Key 保存在本机 `settings` 表，界面只显示尾号，清除需再次保存
- `get_vision_settings` / `set_vision_settings` / `vision_import_preview` 命令；`import_preview` 的映射来源新增 `text` 与 `vision`
- 云端视觉安全边界：仅 HTTPS、禁止重定向、60 秒超时、响应上限 2 MB、图片 ≤ 5 MB；模型返回的未知交易类型、缺失价格、期权字段不完整、做多期权与重复行均被拒绝或合并，结果只进入人工确认
- `wheel-app` 新增 `regex` 与 `base64` 依赖（均来自既有离线锁定版本）
- 备份加密：手动备份可设置 8–128 位密码，生成 `.sqlite.enc`；`crypto` 模块使用 PBKDF2-HMAC-SHA256（200,000 次）与 AES-256-GCM，文件头作为 AAD，密码错误或文件被改写会在解密时失败
- 加密备份的校验与恢复：备份列表显示锁标记；校验需密码并解密到临时文件做完整性检查；暂存时解密到 `restore/staged-*.sqlite`，marker 升级为 version 2，替换完成或失败后删除明文副本
- JSON 导出：`export_json` 输出 `wheel-export` version 1 文档，包含所有账户事件、报价与设置，事件按日期 / 账户 / seq 排序；设置页新增「导出 JSON」
- `backup_now`、`validate_backup`、`stage_restore` 接受可选密码；`list_backups` 返回 `encrypted`；`PendingRestore` 增加 `stagedFile`
- 收租月报：按 UTC 月份统计已落袋净收租、分红、独立费用与现金调整，柱形月度合计叠加区间累计折线，支持年份筛选与 CSV 导出
- `monthly_income(accountId)` 命令按账户聚合月度收入；`DerivedState` 新增 `event_dividends`，记录分红事件按当时持股解析出的金额，便于报表与引擎口径一致
- 多账户 UI：侧栏「切换账户」与设置 → 账户页，支持新建（最多 50 个、名称唯一）与重命名；仪表盘、持仓、台账、事件、战役详情、录入与 CSV 导入均按账户隔离，当前账户保存在本地，行情与成本口径保持全局
- `list_accounts` / `create_account` / `rename_account` 命令；`campaign_detail` 接受 `accountId`；`app_info` 不再返回账户 ID
- 到期提醒：可配置提前天数（0–60，默认 7），侧栏数量徽标、仪表盘提醒卡与 UTC 到期日历；仅应用内提醒
- 战役对比页：按战役聚合的持续天数 / 已实现收益率散点图，按标的着色，附精确数据表
- 真实 `.xlsx` 导出：手写 STORE-only ZIP + OOXML，台账单表与「台账 / 交易记录 / 持仓 / 战役」四表工作簿，无公式、金额与百分比格式
- 每日自动备份：启动与后台每 30 分钟按 UTC 日期检查，默认保留 7 份，仅清理 `auto-*.sqlite`
- 备份恢复向导：只读校验完整性、计数与必需表；暂存 marker，下次启动前归档当前库及 WAL/SHM 后替换，失败回滚，暂存期间拒绝写入
- 盯市成本图：成本阶梯叠加已保存参考价、现价与当前 Call 行权价，逐台阶 Δ 与数据表
- `settings` 增加 `reminderLeadDays` / `autoBackupEnabled` / `autoBackupKeep` 偏好；新增 `set_preferences`、`list_backups`、`validate_backup`、`stage_restore`、`restore_status` 命令
- CSV 导入向导：选择文件或粘贴文本，自动识别中英文表头；列映射可确认并保存复用，逐行预览可修改交易类型、排除重复或错误行
- 导入去重指纹（账户 + 日期 + 类型 + 标的 + 到期 + 行权价 + C/P + 数量 + 价格 + 费用），重复行默认不勾选，确认后可强制导入
- 导入整批复用既有事务写入路径：按日期稳定排序、任一行非法则整批回滚，备注自动标注 `导入:<来源>`
- `wheel-app` 新增 `import` 模块与 `import_preview` / `import_commit` / `import_save_mapping` 命令；`settings` 表增加通用键值读写，用于保存列映射

### Changed

- 「记一笔」新增交易类型「拆股 / 合股」：拆股模式只显示日期、标的、比例与零股补偿；期权表单显示「1 手 = N 股」并在选择持仓时回填乘数
- 台账、持仓、交易记录与 Excel / CSV 导出增加「每手股数」列；拆股事件在事件日志与战役时间轴显示比例与零股补偿
- 设置页拆为成本口径 / 账户 / 到期提醒 / 备份与维护 / 交易记录；顶栏显示当前账户名；备份列表显示类型、大小与 UTC 时间
- 页面、持仓与恢复状态统一使用后端 UTC 账本日期；录入表单仍以本地日期作默认值
- 战役卡片新增现金调整字段，供战役对比计算已实现收益

### Fixed

- 无表头 CSV 在重新预览时不再被误当作有表头文件（预览回填实际 `hasHeader`）
- 邮件抽取收紧边界：`exercise price` 不再触发指派，`at <日期>` 不再被当作成交价；只有实际采用的交易日期为美式 `M/D/YYYY` 时才提示；缺少成交价的交易不再借用下一笔交易的价格；金额保留六位小数，避免小额期权价格被提前舍入

### Removed

- 移除 Windows 内置 `Windows.Media.Ocr` 截图识别、`ocr` 模块与 `ocr_image` 命令：实测会把 `02/20/2026` 识别成 `92/29/2926`、`150` 识别成 `159`，数字与表格列不可靠；截图导入改由云端视觉模型完成

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
