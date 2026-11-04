# P5 发布工程验收记录

日期：2026-11-04 · 版本：0.3.0 · 目标：Windows 11 x64 · 安装包：NSIS（currentUser）

## 范围

版本统一、Windows 安装包配置、内容安全策略（CSP）、数据库降级保护、发布脚本与哈希清单、发布检查清单、Windows CI。不做代码签名、自动更新、单实例、日志上传或崩溃上报。

## 版本

| 文件 | 值 |
|---|---|
| `Cargo.toml`（workspace） | `0.3.0` |
| `crates/wheel-core/Cargo.toml` | `version.workspace = true` |
| `crates/wheel-app/Cargo.toml` | `version.workspace = true` |
| `Cargo.lock`（`wheel-core` / `wheel-app`） | `0.3.0` |
| `crates/wheel-app/tauri.conf.json` | `0.3.0` |
| `ui/package.json` | `0.3.0` |
| `ui/package-lock.json`（根与 `packages[""]`） | `0.3.0` |

`scripts/release.py` 在构建前校验以上全部位置，任一不一致即退出。

## 安装包

- `bundle.targets = ["nsis"]`，`installMode = currentUser`。
- 语言 `SimpChinese` / `English`，显示语言选择器；开始菜单文件夹 `Wheel Tracker`；lzma 压缩。
- `licenseFile` 指向 MIT `LICENSE`；publisher / copyright / 分类 Finance / 中英文描述已写入。
- 构建结果：`target/release/bundle/nsis/Wheel Tracker_0.3.0_x64-setup.exe`，4,678,770 字节（4.46 MiB）。

## CSP

- 生产：`default-src 'self'`；`connect-src ipc: http://ipc.localhost`；`img-src 'self' data: blob:`；`style-src 'self' 'unsafe-inline'`；`script-src 'self'`；`font-src 'self' data:`。
- 开发：额外允许 `ws://127.0.0.1:1420` / `http://127.0.0.1:1420` 与开发期内联脚本。
- 生产 `index.html` 只引用外部 `/assets/*.js` 与 `/assets/*.css`，无内联脚本、无 `eval` / `new Function`。

## 数据库保护

- 0.3.0 发布时 schema `user_version = 2`（账户归档功能加入后升至 3）；打开更高版本数据库直接拒绝。
- 备份校验新增 `user_version > 2` 检查，提示“备份由更新版本创建…请升级应用后再恢复”，不再允许旧版恢复新版快照。
- 新增测试 `backup::tests::validation_rejects_backups_from_a_newer_schema`；Windows 下测试结束前关闭连接以释放文件句柄。

## 发布脚本与产物

`python -I scripts/release.py`：

1. 校验版本一致性；
2. `cargo test --offline --workspace`、`cargo clippy --offline -p wheel-app --no-deps -- -D warnings`、`npm --prefix ui run build`；
3. `npm --prefix ui run desktop:build -- --bundles nsis`（`CARGO_NET_OFFLINE=true`）；
4. 选择与版本同名的安装包，写 `dist/release/<installer>.sha256`（`<hex>  <filename>`）与 `dist/release/release-manifest.json`。

本轮产物：

- SHA-256：`2d98b9fc063ba3c508acca42a6bed51d16030a442698b10ffb183e9d2cb78db2`
- manifest：`product`、`version 0.3.0`、`gitCommit`、`builtAt`（UTC）、`target x86_64-pc-windows-msvc`、`sizeBytes 4678770`、`sha256`、`signing: unsigned`、`updater: not-configured`。
- `dist/` 由 `.gitignore` 排除，发布产物不进入版本库。

## 自动化结果

| 项目 | 结果 |
|---|---|
| `cargo test --offline --workspace` | 113 app + 27 core 场景 + 2 core 单元 + 1 文档测试，全部通过 |
| `cargo clippy --offline -p wheel-app --no-deps -- -D warnings` | 通过 |
| `npm --prefix ui run build` | 通过（chunk 体积警告，未拆分） |
| Playwright（Edge，合成 IPC 数据） | 40 项通过 |
| NSIS 构建 | 通过，1 个安装包 |
| 哈希复核 | `sha256sum` 与 sidecar / manifest 一致 |

## 未覆盖 / 手工项

- 干净安装、覆盖升级、卸载与 SmartScreen 提示未在本环境自动验证，按[发布检查清单](release-checklist.md)人工执行。
- 安装包未签名；升级需手动覆盖安装；无自动更新。
- CI 工作流尚未在 GitHub Actions 上实际运行；Playwright 仍为本地门禁。
