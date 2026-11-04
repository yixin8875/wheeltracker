# P4 多账户验收记录

日期：2026-11-04 · 版本：0.3.0

## 自动化结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 工作区测试 | `cargo test --workspace` | 81 通过，1 忽略 |
| `wheel-app` 测试 | `cargo test -p wheel-app` | 63 通过，1 忽略 |
| Clippy | `cargo clippy -p wheel-app --no-deps -- -D warnings` | 无警告 |
| 前端构建 | `npm --prefix ui run build` | 通过（tsc + vite） |
| Playwright | `cd ui && npx playwright test` | 28 通过 |

新增/覆盖的用例：

- `store::tests::accounts_can_be_listed_created_and_renamed_without_duplicate_names`：列表顺序、创建、重命名、重名与缺失账户。
- `commands::tests::account_names_are_trimmed_and_validated`：去空白、空名、40 字符上限、控制字符。
- Playwright「creating and switching an account scopes reads and new entries」：新建并切换后仪表盘按 `accountId` 读取，侧栏与顶栏更新，录入请求携带 `accountId`，切回后恢复默认账户。
- Playwright「renaming the current account updates the switcher and header」：重命名后下拉与顶栏同步并提示成功。

## 手工检查（桌面版）

- [ ] 新建第二个账户后，录入一笔交易，切换回默认账户，确认仪表盘、持仓、台账均不出现该交易。
- [ ] 重启应用，确认仍停留在上次选择的账户。
- [ ] 在设置 → 账户尝试重名与超过 40 字符，确认被拒绝且账户列表不变。
- [ ] 暂存恢复期间点击「创建并切换」，确认提示需重启应用。

## 后续：账户归档与删除（2026-11-04）

- **归档 / 恢复**：`set_account_archived` 写入或清空 `accounts.archived_at`；归档账户从侧栏切换器隐藏，设置页「已归档」分组仍显示交易数与归档日期。至少保留一个可用账户。
- **删除**：`delete_account` 只删空账户；事件计数包含已撤销记录，避免丢失审计历史。删除当前账户后自动切到另一个可用账户。
- **存储**：schema v3，幂等补齐 `archived_at`；`list_accounts` 返回 `archivedAt` 与 `eventCount`。
- **自动化**：`store::tests::accounts_can_be_archived_restored_and_deleted`、`store::tests::version_two_accounts_table_gains_archived_column`、`commands::tests::accounts_archive_and_only_empty_ones_can_be_deleted`；Playwright「archiving hides an account…」「deleting an empty account…」。
- **手工检查**：
  - [ ] 归档当前账户后侧栏切到另一账户，重启后仍停留在可用账户。
  - [ ] 恢复归档账户后，其持仓、台账与报表数据完整。
  - [ ] 有交易或已撤销交易的账户删除按钮禁用；空账户删除需二次确认。
