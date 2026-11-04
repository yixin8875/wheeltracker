# Windows 桌面验收

日期：2026-11-04。结论：**Debug 与 Release 独立安装版均完成真实 WebView → IPC → SQLite 验收，每种构建 17 项检查全部通过。**

本轮没有发现需要修改财务业务代码的问题。新增可重复运行的原生验收入口，并补齐正式构建、安装启动、核算、重启、备份与卸载的证据。测试未使用正式账本。

## 验证结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript 与 Vite 生产构建 | 通过 | Tauri 前置构建成功；仍有约 680 KB 的单包体积提示 |
| Rust 正式版与 NSIS x64 构建 | 通过 | Release optimized；makensis 成功，退出码 0 |
| 正式应用 PE 文件头 | 通过 | wheel-app.exe machine=0x8664，GUI subsystem=2 |
| Debug 安装版原生验收 | 17/17 通过 | runId=t2026110408370022e7d5 |
| Release 安装版原生验收 | 17/17 通过 | runId=t20261104084106dd4496，profile=release |
| 原生截图检查 | 通过 | 已实际查看详情、指派收益预览和备份页面截图 |
| 验收清理 | 通过 | 两轮均卸载成功；验收注册项和 tauri-driver/msedgedriver 进程无残留；测试账本保留 |
| 验收脚本检查 | 通过 | Python 语法检查；代码审查发现的标签关联与失败清理问题已修正；Release 模式与截图修改已复核 |

此前已有 44 项离线 Rust 测试及 19 项合成 IPC Playwright 测试通过；它们是其他层级的既有证据，本轮新增的是实际安装后运行的原生测试。

## 原始证据

| 构建 | 时间（本机） | 原生报告 | 截图 |
| --- | --- | --- | --- |
| Debug | 08:37:00—08:39:01 | [report.json](../target/desktop-acceptance/t2026110408370022e7d5/report.json) | [空账本](../target/desktop-acceptance/t2026110408370022e7d5/01-empty.png)、[详情](../target/desktop-acceptance/t2026110408370022e7d5/02-call-scenario.png)、[备份](../target/desktop-acceptance/t2026110408370022e7d5/03-backup.png) |
| Release | 08:41:06—08:43:40 | [report.json](../target/desktop-acceptance/t20261104084106dd4496/report.json) | [空账本](../target/desktop-acceptance/t20261104084106dd4496/01-empty.png)、[指派收益预览](../target/desktop-acceptance/t20261104084106dd4496/02-call-scenario.png)、[备份](../target/desktop-acceptance/t20261104084106dd4496/03-backup.png) |

原生报告和截图在本地 target 目录，默认不纳入 Git。构建及驱动日志与各轮 report.json 同目录。

## 正式安装包

```bash
npm --prefix ui run desktop:build -- --bundles nsis
```

交付产物：`target/release/bundle/nsis/Wheel Tracker_0.2.0_x64-setup.exe`，4,003,664 字节（3.82 MiB）。包含首次录入 MAX(seq) NULL 解码修复。

SHA-256（验收后再次核对一致）：

```text
87f0b7c7816bff7707f4d293a0cffbd2068dacdbba9e81de451b7ef8bdf14a3c
```

应用主体：`target/release/wheel-app.exe`，14,024,704 字节，SHA-256：

```text
a04a22a2bc6bd6ab94703ad729ffc70aa825b619bf8efb0d85f4db13065ff518
```

NSIS 启动桩为 x86 PE，安装的应用主体为 x64，是正常结构。哈希对应本次产物，后续重建需重新计算。

为避免读写正式账本，实际安装测试使用独立名称和标识的安装包；Release 验收包与生产包使用相同财务代码和优化构建模式。默认正式标识的生产安装包没有覆盖安装到用户环境。

## 可重复的原生验收

入口：[desktop_acceptance.py](../scripts/desktop_acceptance.py)。使用 Python 标准库连接 Tauri 官方 tauri-driver 的 WebDriver 协议，不替换前端 IPC，不以浏览器预览代替桌面应用。

每次生成唯一 `com.wheeltracker.acceptance.t<时间><随机值>` 应用标识、独立窗口标题、独立 SQLite 目录和独立安装目录。写入前检查 app_info.dbPath 包含本次标识且交易列表为空，否则立即停止。

测试使用虚构代码 ZZWHEEL，日期为 YYYY-MM-DD。行情请求会正常发往行情源，失败不影响财务流程断言；本轮不以该虚构标的的行情成功作为通过条件。

环境：Windows 11，Edge 与 WebView2 Runtime 均为 156.0.4314.58，EdgeDriver 同版本；已通过注册表及实际会话确认。驱动路径：

- target/native-tools/bin/tauri-driver.exe：Cargo 从官方 crate 构建。
- target/native-tools/edge-156/msedgedriver.exe：Microsoft 官方下载。

准备 Tauri 驱动：

```bash
cargo install tauri-driver --locked --root target/native-tools
```

EdgeDriver 匹配要求与下载说明：[Tauri Windows WebDriver 文档](https://v2.tauri.app/develop/tests/webdriver/)。下载内容放入独立工具目录，不从解压目录运行 Python 等解释器。

Debug 验收：

```bash
python -I scripts/desktop_acceptance.py
```

Release 验收：

```bash
python -I scripts/desktop_acceptance.py --release
```

自定义驱动：

```bash
python -I scripts/desktop_acceptance.py --release --driver C:/tools/tauri-driver.exe --edge-driver C:/tools/msedgedriver.exe
```

脚本构建本次独立 NSIS 包，进行当前用户范围的静默安装，从安装目录启动真实应用，执行流程并静默卸载。不会关闭用户原有应用。成功与失败路径均尝试清理验收安装，保留测试账本和证据；清理错误单独报告，不覆盖原始失败原因。

输出：target/desktop-acceptance/<runId>/，包含 tauri.acceptance.json、build.log、webdriver.log、report.json 和三张截图。失败时尽力保存 failure.png、failure.txt。Release 报告额外记录 profile；首轮 Debug 报告的构建类型见首条用例及安装包路径。

## 已通过的 17 项检查

以下全部在两种构建中通过：

| 场景 | 实际断言 |
| --- | --- |
| 验收安装包构建 | 本次唯一标识的 Debug/Release NSIS 构建成功 |
| 安装 | 当前用户范围静默安装成功，可执行文件和卸载程序存在 |
| 安装后启动 | 从安装目录启动真实 WebView2；唯一数据库为空 |
| 首次录入 | 卖 1 手 100P，$2/股、费用 $1；序号 1，未落袋 $199，资金义务 $10,000 |
| Put 作废 | 已落袋 $199，合约清空 |
| Put 指派 | 再卖 100P，$3/股、开仓费 $1、指派费 $1；100 股，A=$100.01，B=$95.03 |
| 分红与设置 | 每股分红 $0.50；UI 开启摊薄后 B=$94.53，设置持久化 |
| 原子滚动 | 110C 开仓 $2、平仓 $0.50，各 $1 费用；新 115C 开仓 $2.50、费用 $1；已落袋 $646，未落袋 $249 |
| 无效第二腿 | 真实 IPC 提交平仓 + 负权利金开仓；拒绝原因匹配，前后事件完全一致 |
| 依赖撤销拒绝 | UI 撤销指派依赖的 Put 开仓；拒绝且历史不变 |
| 合法撤销 | UI 撤销分红，B 增加 $0.50；重新录入，软删除审计保留 |
| Call 平仓与作废 | 滚动的平仓已落袋；115C 作废后累计期权净收益 $895 |
| 指派预览 | 再卖 110C，$1/股、费 $1；真实详情展示预计总收益 $2,043；Release 另核对 C′=$89.57 |
| Call 结算 | 指派费 $1；清空 100 股，战役结束，总收益 $2,042 |
| 重启恢复 | 保存测试价格并重开安装版；事件、成本设置、报价元数据与衍生值一致 |
| 重算与备份 | UI 检查通过并备份；只读打开快照，integrity_check=ok；账户、含软删除事件、价格、设置逐行一致 |
| 卸载 | 验收程序移除，测试账本保留 |

交易、滚动、撤销、成本设置、重算和备份通过真实 UI；非法批次校验与测试价格写入通过真实 IPC；核算断言读取真实 IPC，快照比对只读打开 SQLite。报告保留这些边界，不把直接 IPC 调用称为 UI 点击。

## 本轮边界

完成的是本机独立安装、核心财务流程、重启和备份快照验收。未覆盖默认正式应用的升级覆盖安装、缺少 WebView2 的机器、不同 DPI/最小窗口、完整备份恢复、原生 CSV 下载以及真实行情搜索与报价时间。本轮未验证代码签名或 SmartScreen 信誉，不能随本轮通过一并标为通过。
