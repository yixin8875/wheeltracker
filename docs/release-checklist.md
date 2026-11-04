# 发布检查清单（0.5.1）

日期：2026-11-04 · 目标：Windows 11 x64 · 安装包：NSIS（currentUser）

## 1. 版本与工作树

- [ ] `Cargo.toml`、`crates/wheel-app/Cargo.toml`（继承 workspace）、`Cargo.lock` 均为 `0.5.1`。
- [ ] `crates/wheel-app/tauri.conf.json`、`ui/package.json`、`ui/package-lock.json` 均为 `0.5.1`。
- [ ] `python -I scripts/release.py --no-build --skip-tests` 版本一致性检查通过。
- [ ] 工作树干净，发布提交已记录在 `dist/release/release-manifest.json` 的 `gitCommit`。
- [ ] `LICENSE` 为 MIT，已通过 `bundle.licenseFile` 打包。

## 2. 自动化验证

- [ ] `cargo test --offline --workspace`
- [ ] `cargo clippy --offline -p wheel-app --no-deps -- -D warnings`
- [ ] `npm --prefix ui run build`
- [ ] Playwright：`ui/node_modules/.bin/playwright test --config ui/playwright.config.ts`
- [ ] 数据库保护：旧库（`user_version = 0`）迁移后为 3；更高版本数据库与备份被拒绝。

## 3. 构建与产物

- [ ] `python -I scripts/release.py --skip-tests` 成功生成 NSIS 安装包。
- [ ] `dist/release/<installer>.sha256` 与安装包哈希一致，格式为 `<hex>  <filename>`。
- [ ] `dist/release/release-manifest.json` 含版本、`gitCommit`、`builtAt`（UTC）、`target`、文件名、大小、SHA-256、`signing: "unsigned"`、`updater: "not-configured"`。
- [ ] 安装包文件名版本为 `0.5.1`。

## 4. 干净安装

- [ ] 在未安装过旧版本的 Windows 11 x64 上运行安装包；WebView2 缺失时按提示安装。
- [ ] 安装模式为 currentUser；开始菜单出现 `Wheel Tracker`；语言选择器可选简体中文 / English。
- [ ] 启动后「设置」显示版本 `0.5.1`，数据库路径位于当前用户 AppData。
- [ ] 录入一笔交易、刷新账本、查看年度报表；图表与中文界面正常（CSP 无报错）。
- [ ] AI 识别设置页可打开；导入页的截图上传按钮可点击（未配置时提示前往设置）。
- [ ] 备份 SQLite、校验并暂存恢复；重启后数据正确。

## 5. 覆盖安装升级

- [ ] 从 0.5.0 覆盖安装 0.5.1，账本、备份与设置保留。
- [ ] 覆盖后版本显示 `0.5.1`，拆股事件与年度报表可正常读取。
- [ ] 控制面板 / 设置 → 应用只保留一个卸载项。

## 6. 卸载

- [ ] 卸载移除程序与开始菜单项。
- [ ] `%APPDATA%\com.wheeltracker.desktop\wheel.db` 及 `backups/` 保留；重新安装后可继续使用。

## 7. CSP 冒烟

- [ ] 仪表盘、成本图、战役对比、收租月报、年度报表、到期日历均正常渲染。
- [ ] CSV / Excel / JSON 导出可下载。
- [ ] 导入向导两种模式（CSV / AI 截图）界面正常。
- [ ] DevTools 控制台无 CSP 拒绝记录；`npm run desktop` 开发模式 HMR 正常。

## 8. 已知限制

- [ ] GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 已配置（使用无密码密钥时无需 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）；不要提交私钥。
- [ ] GitHub Release 包含安装包、`.exe.sig`、`release-manifest.json` 与 `latest.json`。
- [ ] `latest.json` 的 `platforms.windows-x86_64.url` 指向本版本安装包，`signature` 与 `.exe.sig` 内容一致。
- [ ] 安装包未做 Authenticode 签名，首次运行可能出现 SmartScreen 提示；发布说明需注明。
- [ ] 自动更新：从上一版本启动应用，能发现新版本并完成下载、验签与安装；更新后重启显示新版本。
- [ ] 不提供单实例、日志上传或崩溃上报插件。
- [ ] 旧版应用拒绝打开新版数据库；回滚需先恢复旧版备份。
