# P4 备份加密与 JSON 导出验收记录

日期：2026-11-04 · 版本：0.2.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 91 通过，1 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 72 通过，1 忽略 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `cd ui && npx playwright test` | 31 通过 |

新增/覆盖的用例：

- `crypto::tests::round_trip_preserves_bytes_with_the_default_iteration_count`：默认 200,000 次迭代与 Unicode 密码往返。
- `crypto::tests::wrong_password_and_tampering_are_rejected`：错误密码、magic / 盐 / 密文标签被改写、截断文件全部拒绝。
- `crypto::tests::rejects_invalid_iterations_and_short_input`、`password_policy_requires_eight_to_128_characters`：迭代次数上限与 8–128 字符密码策略。
- `backup::tests::encrypted_snapshot_round_trips_and_requires_its_password`：加密备份不留下明文 `.sqlite`，列表返回 `encrypted`，无密码 / 错误密码校验失败，正确密码可解密校验并 materialize。
- `restore::tests::encrypted_restore_stages_a_decrypted_copy_and_removes_it_after_apply`：暂存生成 `staged-*.sqlite`、marker version 2；替换成功后删除暂存明文。
- `restore::tests::missing_staged_copy_keeps_the_live_database`：暂存副本丢失时保留原库并隔离 marker。
- `commands::tests::json_export_contains_every_account_event_prices_and_settings`：跨账户事件（含仅存在于事件表的账户）、报价、设置与 camelCase 字段。
- Playwright「encrypted backup is created and restored only with its password」：密码创建 `.sqlite.enc`、锁标记、错误密码报错、正确密码校验并暂存，IPC 参数含密码。
- Playwright「JSON export downloads the full ledger document」：下载文件名、`wheel-export` 文档结构、事件日期与设置字段。

## 文件格式

```text
"WHEELBK1" (8) | iterations (u32 LE) | salt (16) | nonce (12) | AES-256-GCM ciphertext | tag (16)
```

- 密钥：PBKDF2-HMAC-SHA256（默认 200,000 次，解密上限 5,000,000）。
- 40 字节头作为 AAD；修改迭代次数或盐会认证失败。
- 密码 8–128 字符，不落盘、不写日志；遗失无法恢复。

## 恢复流程

1. `validate_backup(fileName, password)` 对 `.sqlite.enc` 解密到备份目录临时文件，执行 `integrity_check` 与必需表/列检查后删除临时文件。
2. `stage_restore(fileName, password)` 解密到 `restore/staged-<stamp>.sqlite` 并再次校验；marker 为 version 2，含 `stagedFile`。
3. 下次启动 `apply_pending` 在 `store::open` 前归档当前库，把暂存副本复制为临时文件、校验后替换；成功或失败都会删除暂存明文，加密备份保留。
4. version 1 marker（普通 SQLite 恢复）保持原行为。

## 手工检查（桌面版）

- [ ] 设置 → 备份与维护，填写密码后备份，确认 `backups/` 只新增 `.sqlite.enc`、没有对应明文 `.sqlite`。
- [ ] 用错误密码校验加密备份，确认提示「密码错误或备份文件已损坏」且不进入恢复。
- [ ] 用正确密码校验并暂存恢复，退出重启后数据被替换、`restore/` 下无 `staged-*.sqlite` 残留。
- [ ] 导出 JSON 并用编辑器打开，确认包含所有账户、事件日期为 `YYYY-MM-DD`、中文未转义为乱码。
- [ ] 关闭自动备份并确认不会生成加密文件；自动备份始终为 `auto-*.sqlite`。
