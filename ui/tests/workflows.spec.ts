import { test, expect, type Page } from '@playwright/test';

// UI request-contract tests use synthetic IPC. Rust tests verify SQLite and replay.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const campaign = { id: 'campaign', symbol: 'TEST', status: 'active', shares: 100, costA: 150, costB: 148, costC: 147, premiumRealized: 200, premiumOpen: 100, dividends: 0, adjustments: 0, price: 160, safetyMargin: 12 / 148, nextOption: null, realizedPnl: null, sharePnl: 0, startedAt: '2026-01-02', endedAt: null, cycles: 1, costPoints: [{ at: '2026-01-02', shares: 100, premiumRealized: 0, premiumOpen: 0, costA: 150, costB: 150, costC: 150 }, { at: '2026-02-20', shares: 100, premiumRealized: 200, premiumOpen: 0, costA: 150, costB: 148, costC: 148 }] };
    const position = { campaignId: 'campaign', symbol: 'TEST', contract: 'TEST 2026-02-20 150P', right: 'P', strike: 150, expiry: '2026-02-20', daysLeft: -256, openQty: 1, multiplier: 100, avgCredit: 2, openedAt: '2026-01-02' };
    const callPosition = { campaignId: 'campaign', symbol: 'TEST', contract: 'TEST 2026-12-18 160C', right: 'C', strike: 160, expiry: '2026-12-18', daysLeft: 45, openQty: 1, multiplier: 100, avgCredit: 1, openedAt: '2026-02-20' };
    const entry = { id: 'entry', campaignId: 'campaign', symbol: 'TEST', contract: position.contract, right: 'P', multiplier: 100, qty: 1, openQty: 0, openedAt: '2026-01-02', closedAt: '2026-02-20', status: 'closed', premiumGross: 200, fees: 1, closeCost: 324.5, netPremium: -125.5, collateral: 15000, daysHeld: 49, annualizedReturn: -.0623 };
    const state = window as any;
    state.isTauri = true; state.testCalls = []; state.testReject = false;
    state.testAccounts = [{ id: 'main', name: '默认账户', broker: null, currency: 'USD', createdAt: '2026-01-01', archivedAt: null, eventCount: 1 }];
    state.testRejectSettings = false; state.testPartial = false;
    state.testRejectMetadata = false; state.testRejectDashboard = false;
    state.testVision = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', hasKey: true, keyHint: '1234', enabled: true, consent: true };
    state.testVisionKey = 'sk-test-1234';
    const preferences = { includeDividendsInCost: localStorage.getItem('test-dividends') === 'true', reminderLeadDays: 7, autoBackupEnabled: true, autoBackupKeep: 7 };
    const currentCampaign = () => ({ ...campaign, dividends: 100,
      costB: preferences.includeDividendsInCost ? 147 : 148,
      costC: preferences.includeDividendsInCost ? 146 : 147,
      costPoints: campaign.costPoints.map((point, index) => index === 0 || !preferences.includeDividendsInCost ? point : { ...point, costB: point.costB - 1, costC: point.costC - 1 }),
    });
    const history = [
      { id: 'buy', date: '2026-01-02', kind: 'shares_buy', symbol: 'TEST', qty: 100, price: 150, fees: 0, amount: 0, note: '本轮买入', expiry: null, strike: null, right: null, multiplier: null, splitNumerator: null, splitDenominator: null, splitCashInLieu: null },
      { id: 'dividend', date: '2026-01-10', kind: 'dividend', symbol: 'TEST', qty: 100, price: 1, fees: 0, amount: 0, note: '本轮分红', expiry: null, strike: null, right: null, multiplier: null, splitNumerator: null, splitDenominator: null, splitCashInLieu: null },
      { id: 'call', date: '2026-02-20', kind: 'option_open_short', symbol: 'TEST', qty: 1, price: 1, fees: 0, amount: 0, note: '本轮 Call', expiry: '2026-12-18', strike: 160, right: 'C', multiplier: 100, splitNumerator: null, splitDenominator: null, splitCashInLieu: null },
    ];
    const splitEvent = { id: 'split', date: '2026-03-01', kind: 'stock_split', symbol: 'TEST', qty: 0, price: 0, fees: 0, amount: 0, note: '本轮拆股', expiry: null, strike: null, right: null, multiplier: null, splitNumerator: 2, splitDenominator: 1, splitCashInLieu: 3.25 };
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: Record<string, unknown>) => {
      state.testCalls.push({ command, args });
      switch (command) {
        case 'dashboard':
          if (state.testRejectDashboard) throw new Error('dashboard read failed');
          if (args.accountId === 'acct-2') return { accountId: 'acct-2', asOf: '2026-11-03', summary: { premiumRealized: 0, premiumOpen: 0, activeCampaigns: 1, openPositions: 0, openContracts: 0, collateral: 0, sharesHeld: 0 }, campaigns: [{ ...currentCampaign(), id: 'other', symbol: 'OTHER', shares: 0, costA: null, costB: null, costC: null }] };
          return { accountId: 'main', asOf: '2026-11-03', summary: { premiumRealized: 200, premiumOpen: 100, activeCampaigns: 1, openPositions: 1, openContracts: 1, collateral: 15000, sharesHeld: 100 }, campaigns: state.testExtraCampaign ? [currentCampaign(), { ...currentCampaign(), id: 'second', symbol: 'NEW' }] : [currentCampaign()] };
        case 'ledger': return { entries: [entry], totalNet: -125.5, totalCollateral: 15000, count: 1 };
        case 'positions': return [{ ...position, multiplier: state.testMultiplier ?? position.multiplier }];
        case 'list_events': return [...(state.testSplit ? [splitEvent] : []), { id: 'ev', date: '2026-01-02', kind: 'shares_buy', symbol: 'TEST', qty: 100, price: 150, fees: 1, amount: 0, note: '=SUM(A1:A2)', expiry: null, strike: null, right: null, multiplier: null, splitNumerator: null, splitDenominator: null, splitCashInLieu: null }];
        case 'monthly_income': return state.testMonthly ?? {
          months: [
            { month: '2025-12', premium: 50, dividends: 0, fees: 0, adjustments: 0, total: 50, cumulative: 50, closedEntries: 1 },
            { month: '2026-01', premium: 0, dividends: 100, fees: 5, adjustments: 0, total: 95, cumulative: 145, closedEntries: 0 },
            { month: '2026-02', premium: 148, dividends: 0, fees: 0, adjustments: 20, total: 168, cumulative: 313, closedEntries: 1 },
          ],
          total: { premium: 198, dividends: 100, fees: 5, adjustments: 20, total: 313, closedEntries: 2, monthCount: 3 },
        };
        case 'annual_report': return state.testAnnual ?? {
          availableYears: [2025, 2026],
          years: [
            {
              year: 2025,
              months: [{ month: '2025-12', premium: 0, sharePnl: 100, dividends: 20, fees: 0, adjustments: 0, total: 120, cumulative: 120, closedEntries: 0, shareEvents: 1 }],
              symbols: [{ symbol: 'MSFT', premium: 0, sharePnl: 100, dividends: 20, fees: 0, adjustments: 0, total: 120 }],
              total: { premium: 0, sharePnl: 100, dividends: 20, fees: 0, adjustments: 0, total: 120, closedEntries: 0, shareEvents: 1 },
            },
            {
              year: 2026,
              months: [
                { month: '2026-01', premium: 148, sharePnl: 0, dividends: 0, fees: 0, adjustments: 0, total: 148, cumulative: 148, closedEntries: 1, shareEvents: 0 },
                { month: '2026-02', premium: 0, sharePnl: 0, dividends: 100, fees: 5, adjustments: 20, total: 115, cumulative: 263, closedEntries: 0, shareEvents: 0 },
                { month: '2026-03', premium: 0, sharePnl: 400, dividends: 0, fees: 50, adjustments: 0, total: 350, cumulative: 613, closedEntries: 0, shareEvents: 1 },
              ],
              symbols: [
                { symbol: 'AAPL', premium: 148, sharePnl: 400, dividends: 100, fees: 5, adjustments: 20, total: 663 },
                { symbol: 'MSFT', premium: 0, sharePnl: 0, dividends: 0, fees: 50, adjustments: 0, total: -50 },
              ],
              total: { premium: 148, sharePnl: 400, dividends: 100, fees: 55, adjustments: 20, total: 613, closedEntries: 1, shareEvents: 1 },
            },
          ],
        };
        case 'list_prices': return state.testPrices ?? [{ symbol: 'TEST', date: '2026-11-03', close: 160, source: '手动', quotedAt: null }];
        case 'search_symbols':
          if (state.testRejectSearch) throw new Error('search offline');
          if (args.query === 'OLD') await new Promise(resolve => setTimeout(resolve, 900));
          return String(args.query).includes('APPLE') ? [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'US' }] : args.query === 'OLD' ? [{ symbol: 'OLD', name: 'Old result', exchange: 'US' }] : [];
        case 'fetch_quote':
          if (state.testRejectQuote) throw new Error('quote offline');
          return { symbol: args.symbol, name: 'Synthetic Company', price: 165, previousClose: 160, changePercent: 3.125, quotedAt: '2026-11-03 10:30:00', source: '腾讯财经', currency: 'USD' };
        case 'refresh_quotes':
          if (state.testHoldMarket) {
            state.testHoldMarket = false;
            await new Promise(resolve => { state.testReleaseMarket = resolve; });
          }
          if (state.testRejectMarket) throw new Error('market offline');
          if (!state.testRefreshEnabled) return { updated: [], failed: [] };
          state.testPrices = (args.symbols as string[]).map(symbol => ({ symbol, date: '2026-11-03', close: 165, source: '腾讯财经', quotedAt: '2026-11-03 10:30:00' }));
          return { updated: state.testPrices, failed: state.testPartialMarket ? [{ symbol: 'BAD', error: 'unknown symbol' }] : [] };
        case 'set_price': state.testPrices = [{ symbol: args.symbol, date: args.date, close: args.close, source: '手动', quotedAt: null }]; return null;
        case 'app_info':
          if (state.testRejectMetadata) throw new Error('metadata read failed');
          return { version: '0.4.0', dbPath: 'test-only/wheel.db' };
        case 'list_accounts': return [...state.testAccounts];
        case 'create_account': {
          if (state.testAccounts.some((account: any) => account.name === args.name)) throw new Error('账户名称已存在。');
          const created = { id: `acct-${state.testAccounts.length + 1}`, name: String(args.name), broker: null, currency: 'USD', createdAt: '2026-11-03', archivedAt: null, eventCount: 0 };
          state.testAccounts.push(created);
          return created;
        }
        case 'set_account_archived': {
          const account = state.testAccounts.find((item: any) => item.id === args.accountId);
          if (!account) throw new Error('账户不存在。');
          if (args.archived && state.testAccounts.filter((item: any) => !item.archivedAt).length <= 1) throw new Error('至少保留一个可用账户，不能归档最后一个账户。');
          account.archivedAt = args.archived ? '2026-11-04' : null;
          return { ...account };
        }
        case 'delete_account': {
          const account = state.testAccounts.find((item: any) => item.id === args.accountId);
          if (!account) throw new Error('账户不存在。');
          if (account.eventCount > 0) throw new Error(`账户「${account.name}」还有 ${account.eventCount} 笔交易（含已撤销），不能删除；可先归档保留数据。`);
          if (!account.archivedAt && state.testAccounts.filter((item: any) => !item.archivedAt).length <= 1) throw new Error('至少保留一个可用账户，不能删除最后一个账户。');
          state.testAccounts = state.testAccounts.filter((item: any) => item.id !== args.accountId);
          return true;
        }
        case 'rename_account': {
          const account = state.testAccounts.find((item: any) => item.id === args.accountId);
          if (!account) throw new Error('账户不存在。');
          if (state.testAccounts.some((item: any) => item.id !== args.accountId && item.name === args.name)) throw new Error('账户名称已存在。');
          account.name = String(args.name);
          return { ...account };
        }
        case 'get_settings': return { ...preferences };
        case 'set_settings':
          if (state.testRejectSettings) throw new Error('settings write failed');
          preferences.includeDividendsInCost = Boolean(args.includeDividendsInCost);
          localStorage.setItem('test-dividends', String(preferences.includeDividendsInCost));
          return { ...preferences };
        case 'set_preferences':
          preferences.reminderLeadDays = Number(args.reminderLeadDays);
          preferences.autoBackupEnabled = Boolean(args.autoBackupEnabled);
          preferences.autoBackupKeep = Number(args.autoBackupKeep);
          return { ...preferences };
        case 'restore_status': return { pending: state.testPending ?? null, lastResult: state.testLastResult ?? null, failed: [] };
        case 'list_backups': return state.testBackups ?? [
          { fileName: 'wheel-1767225600000000000-0.sqlite', kind: 'manual', sizeBytes: 40960, modifiedAt: '2026-01-02 08:00:00', encrypted: false },
          { fileName: 'auto-1767225600000000000-1.sqlite', kind: 'auto', sizeBytes: 30720, modifiedAt: '2026-01-02 09:00:00', encrypted: false },
          { fileName: 'pre-restore-1767225600000000000-2.sqlite', kind: 'safety', sizeBytes: 20480, modifiedAt: '2026-01-02 10:00:00', encrypted: false },
          { fileName: 'wheel-1767225600000000000-3.sqlite.enc', kind: 'manual', sizeBytes: 20480, modifiedAt: '2026-01-02 11:00:00', encrypted: true },
        ];
        case 'validate_backup':
          if (state.testInvalidBackup) return { fileName: args.fileName, valid: false, integrity: 'not ok: synthetic corruption', events: 0, accounts: 0, prices: 0, issues: ['完整性检查失败'] };
          if (String(args.fileName).endsWith('.enc') && args.password !== 'correct horse') throw new Error('密码错误或备份文件已损坏');
          return { fileName: args.fileName, valid: true, integrity: 'ok', events: 3, accounts: 1, prices: 5, issues: [] };
        case 'stage_restore':
          state.testPending = { version: String(args.fileName).endsWith('.enc') ? 2 : 1, backupFile: String(args.fileName), safetyFile: 'pre-restore-1767225600000000000-2.sqlite', requestedAt: '2026-01-02 10:05:00', stagedFile: String(args.fileName).endsWith('.enc') ? 'staged-1.sqlite' : null };
          return state.testPending;
        case 'campaign_detail': return {
          campaign: { ...currentCampaign(), shares: state.testPartial ? 200 : 100 }, entries: [entry], positions: [position, callPosition], lots: [], events: state.testSplit ? [...history, splitEvent] : history,
          callScenarios: [{ contract: 'TEST 2026-12-18 160C', qty: 1, sharesSold: 100, strike: 160, assignmentFees: 0,
            saleProceeds: 16000, sharePnl: 1000, premiumRealized: 300, dividends: 100, adjustments: 0, realizedTotal: 1400,
            remainingShares: state.testPartial ? 100 : 0, remainingContracts: state.testPartial ? 1 : 0, closesCampaign: !state.testPartial }],
        };
        case 'add_event': {
          if (state.testReject) throw new Error('insufficient shares');
          const req = args.req as any;
          if (req.kind === 'stock_split' && req.splitNumerator === 4 && req.splitDenominator === 3) throw new Error('拆股比例 4:3 会使未平仓期权的每手股数不是整数');
          return 'saved';
        }
        case 'add_events': return ['close', 'open'];
        case 'backup_now': return args.password ? 'test-only/backups/snapshot.sqlite.enc' : 'test-only/backups/snapshot.sqlite';
        case 'export_json': return JSON.stringify({ format: 'wheel-export', version: 1, appVersion: '0.4.0', exportedAt: '2026-11-04 00:00:00 +00:00', accounts: [{ id: 'main', name: '默认账户', broker: null, currency: 'USD', createdAt: '2026-01-01' }], settings: { includeDividendsInCost: false, reminderLeadDays: 7, autoBackupEnabled: true, autoBackupKeep: 7 }, events: [{ accountId: 'main', id: 'ev', seq: 1, occurredAt: '2026-01-02', kind: 'shares_buy', symbol: 'TEST', expiry: null, strike: null, right: null, multiplier: null, qty: 100, price: 150, fees: 1, amount: 0, note: 'synthetic' }], prices: [{ symbol: 'TEST', date: '2026-11-03', close: 160, source: '手动', quotedAt: null }] }, null, 2);
        case 'rebuild': return { events: 1, campaigns: 1, entries: 1, issues: [] };
        case 'import_preview': {
          const mapping = (args.req as any).mapping ?? { fields: { date: 0, action: 1, symbol: 2, qty: 3, price: 4 }, dateFormat: 'auto', delimiter: 'comma', hasHeader: true };
          const rows = state.testPreviewRows ?? [
            { rowNumber: 1, line: 2, status: 'ok', messages: [], cells: ['2026-01-02', '卖出开仓', 'AAPL', '1', '2.00'], raw: 'synthetic row', event: { date: '2026-01-02', kind: 'option_open_short', symbol: 'AAPL', qty: 1, price: 2, fees: 1, amount: 0, expiry: '2026-02-20', strike: 150, right: 'P', note: null }, selectedByDefault: true },
            { rowNumber: 2, line: 3, status: 'warning', messages: ['按月/日/年解析日期，请确认无误。'], cells: ['01/03/2026', '买入', 'AAPL', '100', '150.00'], raw: 'synthetic row', event: { date: '2026-01-03', kind: 'shares_buy', symbol: 'AAPL', qty: 100, price: 150, fees: 0, amount: 0, expiry: null, strike: null, right: null, note: null }, selectedByDefault: true },
            { rowNumber: 3, line: 4, status: 'duplicate', messages: ['与账本中的记录重复。'], cells: ['2026-01-02', '卖出开仓', 'AAPL', '1', '2.00'], raw: 'synthetic row', event: { date: '2026-01-02', kind: 'option_open_short', symbol: 'AAPL', qty: 1, price: 2, fees: 1, amount: 0, expiry: '2026-02-20', strike: 150, right: 'P', note: null }, selectedByDefault: false },
            { rowNumber: 4, line: 5, status: 'error', messages: ['缺少交易日期。'], cells: ['', '卖出开仓', 'AAPL', '1', '2.00'], raw: 'synthetic row', event: null, selectedByDefault: false },
          ];
          return { headers: ['日期', '方向', '代码', '数量', '价格'], signature: '0123456789abcdef', delimiter: 'comma', headerLine: 1,
            mapping, mappingSource: (args.req as any).mapping ? 'manual' : 'detected', rows,
            counts: { total: 4, ok: 1, warning: 1, duplicate: 1, error: 1, selected: 2 },
            warnings: ['已自动识别 5 个字段；请确认列映射后再导入。'] };
        }
        case 'import_commit': return { imported: (args.req as any).rows.length, eventIds: (args.req as any).rows.map((row: any) => `import-${row.rowNumber}`), accountId: 'main', notePrefix: '导入:粘贴文本', duplicateCount: 1 };
        case 'import_save_mapping': return true;
        case 'text_import_preview': {
          const source = String((args.req as any).source ?? '');
          const template = source.toLowerCase().includes('schwab') ? 'Schwab' : '通用邮件';
          const row = { rowNumber: 1, line: 1, status: 'ok', messages: [], cells: ['2026-01-02', 'option_open_short', 'AAPL', '1', '2', '1', '2026-02-20', '150', 'P'], raw: 'synthetic email row',
            event: { date: '2026-01-02', kind: 'option_open_short', symbol: 'AAPL', qty: 1, price: 2, fees: 1, amount: 0, expiry: '2026-02-20', strike: 150, right: 'P', note: `${template} · 第 1 行` }, selectedByDefault: true };
          return { headers: ['日期', '方向', '代码', '数量', '价格', '费用', '到期日', '行权价', '看涨看跌', '备注'], signature: 'fedcba9876543210', delimiter: 'comma', headerLine: 1,
            mapping: { fields: { date: 0, kind: 1, symbol: 2, qty: 3, price: 4, fees: 5, expiry: 6, strike: 7, right: 8, note: 9 }, dateFormat: 'yearMonthDay', delimiter: 'comma', hasHeader: true },
            mappingSource: 'text', rows: [row],
            counts: { total: 1, ok: 1, warning: 0, duplicate: 0, error: 0, selected: 1 },
            warnings: [`已从${template}识别 1 笔交易，请核对后导入。`, '第 2 行：未找到成交价，已跳过。'] };
        }
        case 'get_vision_settings': return { ...state.testVision };
        case 'set_vision_settings': {
          const req = args.req as any;
          if (!String(req.baseUrl).startsWith('https://')) throw new Error('Base URL 必须使用 https://。');
          if (!String(req.model).trim()) throw new Error('请填写模型名称。');
          if (req.enabled && !req.consent) throw new Error('启用前请先阅读并同意隐私说明。');
          if (req.apiKey !== undefined) {
            if (req.apiKey === '') {
              state.testVisionKey = '';
              state.testVision.hasKey = false;
              state.testVision.keyHint = '';
            } else {
              state.testVisionKey = String(req.apiKey);
              state.testVision.hasKey = true;
              state.testVision.keyHint = String(req.apiKey).slice(-4);
            }
          }
          if (req.enabled && !state.testVision.hasKey) throw new Error('启用 AI 截图识别前请先保存 API Key。');
          state.testVision = { ...state.testVision, baseUrl: String(req.baseUrl).replace(/\/$/, ''), model: String(req.model), enabled: Boolean(req.enabled), consent: Boolean(req.consent) };
          return { ...state.testVision };
        }
        case 'vision_import_preview': {
          if (!state.testVision.enabled) throw new Error('AI 截图识别未启用，请前往设置 → AI 识别。');
          const row = { rowNumber: 1, line: 2, status: 'ok', messages: [], cells: ['2026-01-02', 'option_open_short', 'AAPL', '1', '2', '1', '2026-02-20', '150', 'P'], raw: 'synthetic vision row',
            event: { date: '2026-01-02', kind: 'option_open_short', symbol: 'AAPL', qty: 1, price: 2, fees: 1, amount: 0, expiry: '2026-02-20', strike: 150, right: 'P', note: '云端视觉 · gpt-4o' }, selectedByDefault: true };
          return { headers: ['日期', '方向', '代码', '数量', '价格', '费用', '到期日', '行权价', '看涨看跌', '备注'], signature: '0011223344556677', delimiter: 'comma', headerLine: 1,
            mapping: { fields: { date: 0, kind: 1, symbol: 2, qty: 3, price: 4, fees: 5, expiry: 6, strike: 7, right: 8, note: 9 }, dateFormat: 'yearMonthDay', delimiter: 'comma', hasHeader: true },
            mappingSource: 'vision', rows: [row],
            counts: { total: 1, ok: 1, warning: 0, duplicate: 0, error: 0, selected: 1 },
            warnings: ['已从云端视觉（gpt-4o）识别 1 笔交易，请核对后导入。', `来源截图：${(args.req as any).source}`] };
        }
        default: throw new Error(`Unexpected IPC: ${command}`);
      }
    } };
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'TEST', exact: true })).toBeVisible();
}
async function fillBuy(page: Page) {
  await page.locator('header').getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('交易类型').selectOption('shares_buy'); await page.getByLabel('标的代码').fill('TEST');
  await page.getByLabel('股数', { exact: true }).fill('100'); await page.getByLabel('每股成交价', { exact: true }).fill('150');
}
test('portfolio quotes refresh on startup and after five minutes', async ({ page }) => {
  await page.clock.install(); await setup(page);
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'refresh_quotes').length)).toBe(1);
  await page.clock.fastForward(300000);
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'refresh_quotes').length)).toBe(2);
});

test('new holdings queue behind a running quote refresh', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '行情', exact: true }).click();
  const refresh = page.getByRole('button', { name: '更新持仓行情', exact: true });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => { (window as any).testHoldMarket = true; });
  await refresh.click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).testReleaseMarket)).toBe('function');
  await page.evaluate(() => { (window as any).testExtraCampaign = true; });
  await page.getByRole('button', { name: '刷新账本', exact: true }).click();
  await expect(page.locator('.market-watchlist').getByRole('button', { name: 'NEW', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).testReleaseMarket(); });
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.some((call: any) => call.command === 'refresh_quotes' && call.args.symbols.includes('NEW')))).toBe(true);
  await expect(refresh).toBeEnabled();
});

test('symbol dropdown selects with keyboard and loads reference without changing execution price', async ({ page }) => {
  await setup(page); await fillBuy(page);
  const input = page.getByRole('combobox', { name: '标的代码', exact: true });
  await input.fill('APPLE');
  await expect(page.getByRole('option').filter({ hasText: 'Apple Inc.' })).toBeVisible();
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(input).toHaveValue('AAPL');
  await expect(page.locator('.quote-reference')).toContainText('$165.00');
  await expect(page.locator('.quote-reference')).toContainText('美东');
  await expect(page.getByLabel('每股成交价', { exact: true })).toHaveValue('150');
  const writes = await page.evaluate(() => (window as any).testCalls.filter((call: any) => ['add_event', 'set_price'].includes(call.command)));
  expect(writes).toHaveLength(0);
});

test('older search responses cannot replace current results', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '行情', exact: true }).click();
  const input = page.getByRole('combobox', { name: '搜索美股或 ETF', exact: true });
  await input.fill('OLD');
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.some((call: any) => call.command === 'search_symbols' && call.args.query === 'OLD'))).toBe(true);
  await input.fill('APPLE'); await expect(page.getByRole('option').filter({ hasText: 'Apple Inc.' })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByRole('option').filter({ hasText: 'Old result' })).toHaveCount(0);
});

test('offline symbol search preserves common choices and quote failure permits transaction entry', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).testRejectSearch = true; (window as any).testRejectQuote = true; });
  await fillBuy(page); const input = page.getByRole('combobox', { name: '标的代码' });
  await input.fill('苹果'); await expect(page.getByRole('option').filter({ hasText: 'AAPL' })).toBeVisible();
  await expect(page.locator('.symbol-menu')).toContainText('在线搜索不可用');
  await page.getByRole('option').filter({ hasText: 'AAPL' }).click();
  await expect(page.locator('.quote-reference')).toContainText('quote offline');
  await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
});

test('market refresh persists quote metadata and partial failure retains successful prices', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '行情', exact: true }).click();
  await page.evaluate(() => { (window as any).testRefreshEnabled = true; (window as any).testPartialMarket = true; });
  await page.getByRole('button', { name: '更新持仓行情', exact: true }).click();
  await expect(page.locator('.market-watchlist')).toContainText('$165.00');
  await expect(page.locator('.market-watchlist')).toContainText('腾讯财经');
  await expect(page.locator('.market-watchlist')).toContainText('BAD：unknown symbol');
  await page.evaluate(() => { (window as any).testRejectMarket = true; });
  await page.getByRole('button', { name: '更新持仓行情', exact: true }).click();
  await expect(page.locator('.market-watchlist')).toContainText('market offline');
  await expect(page.locator('.market-watchlist')).toContainText('$165.00');
});

test('manual price fallback and settings responsibilities are separate', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '行情', exact: true }).click();
  await page.getByText('手动校准价格', { exact: false }).first().click();
  await page.getByRole('combobox', { name: '校准标的' }).fill('TEST');
  await page.getByLabel('每股价格', { exact: true }).fill('155');
  await page.getByRole('button', { name: '保存校准价', exact: true }).click();
  await expect(page.locator('.market-watchlist')).toContainText('$155.00');
  await expect(page.locator('.market-watchlist')).toContainText('手动校准');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('分红计入有效成本')).toBeVisible();
  await expect(page.getByRole('heading', { name: '交易事件日志' })).toHaveCount(0);
  await page.getByRole('button', { name: '交易记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '交易事件日志' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '校准标的' })).toHaveCount(0);
});

test('market layout fits mobile and quote can prefill only the ticker in entry', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '行情', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索美股或 ETF' }).fill('APPLE');
  await page.getByRole('option').filter({ hasText: 'Apple Inc.' }).click();
  await expect(page.locator('.market-result')).toContainText('$165.00');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: 'test-results/market-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: 'test-results/market-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '记录交易', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '标的代码' })).toHaveValue('AAPL');
  await expect(page.getByLabel('每股权利金 / 平仓价')).toHaveValue('0');
});

test('successful save cannot submit the same transaction twice', async ({ page }) => {
  await setup(page); await fillBuy(page); await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'add_event'));
  expect(calls).toHaveLength(1); expect(calls[0].args.req).toMatchObject({ symbol: 'TEST', qty: 100, price: 150, kind: 'shares_buy' });
});
test('failed write retains values and permits correction', async ({ page }) => {
  await setup(page); await fillBuy(page); await page.evaluate(() => { (window as any).testReject = true; });
  await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('insufficient shares'); await expect(page.getByLabel('标的代码')).toHaveValue('TEST');
  await expect(page.getByRole('button', { name: '保存交易', exact: true })).toBeEnabled();
});
test('overdue expiry prefills its date and rolling submits two legs', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '当前持仓', exact: true }).click(); await page.getByRole('button', { name: '到期作废', exact: true }).click();
  await expect(page.getByLabel('交易日期')).toHaveValue('2026-02-20'); await page.getByLabel('交易类型').selectOption('option_close');
  await page.getByLabel('每股权利金 / 平仓价').fill('1'); await page.getByLabel('滚动：平仓后同时开出新合约').check();
  await page.getByLabel('新到期日').fill('2026-12-18'); await page.getByLabel('新行权价').fill('145'); await page.getByLabel('新每股权利金').fill('3'); await page.getByLabel('新开仓费用').fill('1.5');
  await page.getByRole('button', { name: '保存交易', exact: true }).click(); await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'add_events'));
  expect(calls).toHaveLength(1); expect(calls[0].args.reqs).toMatchObject([{ kind: 'option_close', symbol: 'TEST', price: 1 }, { kind: 'option_open_short', symbol: 'TEST', price: 3, strike: 145, expiry: '2026-12-18', fees: 1.5 }]);
});
test('cost chart provides an accessible exact-value table', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '查看战役' }).click(); await expect(page.getByRole('img', { name: /三轨每股成本/ })).toBeVisible();
  await page.getByRole('button', { name: '查看数据', exact: true }).click(); const row = page.getByRole('row').filter({ hasText: '2026-02-20' }).first();
  await expect(row).toContainText('$148.00'); await expect(row).toContainText('$150.00');
});
test('cost setting persists, refreshes dashboard and historical chart costs', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('分红计入有效成本').check();
  await page.getByRole('button', { name: '保存成本设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('成本设置已保存');
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
  await expect(page.locator('.cost-breakdown').first()).toContainText('$150.00');
  await page.getByRole('button', { name: '查看战役' }).click();
  await page.getByRole('button', { name: '查看数据', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '2026-02-20' }).first()).toContainText('$147.00');
  await page.reload();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('分红计入有效成本')).toBeChecked();
});

test('metadata read failure does not block refreshed accounting values', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '查看战役' }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$148.00');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => { (window as any).testRejectMetadata = true; });
  await page.getByLabel('分红计入有效成本').check();
  await page.getByRole('button', { name: '保存成本设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('账本已更新，但应用信息读取失败');
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
  await expect(page.locator('.footnote')).toContainText('当前分红计入');
  await page.getByRole('button', { name: '查看战役' }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
});

test('financial read failure hides stale costs until retry succeeds', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '查看战役' }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$148.00');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => { (window as any).testRejectDashboard = true; });
  await page.getByLabel('分红计入有效成本').check();
  await page.getByRole('button', { name: '保存成本设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('dashboard read failed');
  await expect(page.getByLabel('分红计入有效成本')).toBeChecked();
  await page.getByRole('alert').getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await expect(page.getByText('账本尚未刷新，财务数据暂不可用。')).toBeVisible();
  await expect(page.locator('.cost-focus')).toHaveCount(0);
  await expect(page.getByText('从第一笔交易开始')).toHaveCount(0);
  await expect(page.getByText('历史成本已重新计算', { exact: false })).toHaveCount(0);
  await page.evaluate(() => { (window as any).testRejectDashboard = false; });
  await page.getByRole('button', { name: '重试读取账本', exact: true }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
  await expect(page.locator('.footnote')).toContainText('当前分红计入');
  await page.getByRole('button', { name: '查看战役' }).click();
  await expect(page.locator('.cost-focus').first()).toContainText('$147.00');
});

test('failed cost setting save retains selection and permits retry', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => { (window as any).testRejectSettings = true; });
  await page.getByLabel('分红计入有效成本').check();
  await page.getByRole('button', { name: '保存成本设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('settings write failed');
  await expect(page.getByLabel('分红计入有效成本')).toBeChecked();
  await expect(page.getByRole('button', { name: '保存成本设置', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).testRejectSettings = false; });
  await page.getByRole('button', { name: '保存成本设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('成本设置已保存');
});

test('campaign timeline shows only returned campaign events and preview does not write', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '查看战役' }).click();
  const timeline = page.locator('section').filter({ has: page.getByRole('heading', { name: '战役事件时间轴' }) });
  await expect(timeline.getByRole('listitem')).toHaveCount(3);
  await expect(timeline).toContainText('本轮分红');
  await expect(timeline).not.toContainText('=SUM');
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: '被 Call 走收益预览' }) });
  await expect(preview).toContainText('预计本轮总收益');
  await expect(preview.locator('.scenario-total')).toContainText('$1,400.00');
  const writes = await page.evaluate(() => (window as any).testCalls.filter((call: any) => ['add_event', 'add_events', 'delete_event', 'set_settings'].includes(call.command)));
  expect(writes).toHaveLength(0);
});

test('partial assignment preview does not claim final campaign profit and fits mobile', async ({ page }) => {
  await setup(page); await page.evaluate(() => { (window as any).testPartial = true; });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '查看战役' }).click();
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: '被 Call 走收益预览' }) });
  await expect(preview).toContainText('指派后累计已实现收益');
  await expect(preview).toContainText('仍持有 100 股、1 手期权');
  await expect(preview).not.toContainText('预计本轮总收益');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('CSV preserves numeric losses and escapes text formulas; backup reports path', async ({ page }) => {
  await setup(page); await page.getByRole('button', { name: '收租台账', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const stream = await (await download).createReadStream(); const chunks = []; for await (const chunk of stream!) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8'); expect(text).toContain('"-125.5"'); expect(text).not.toContain("'-125.5");
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '备份与维护', exact: true }).click(); const events = page.waitForEvent('download'); await page.getByRole('button', { name: '导出交易 CSV', exact: true }).click();
  const eventStream = await (await events).createReadStream(); const parts = []; for await (const chunk of eventStream!) parts.push(chunk);
  expect(Buffer.concat(parts).toString('utf8')).toContain("'=SUM(A1:A2)"); await page.getByRole('button', { name: '备份 SQLite', exact: true }).click(); await expect(page.getByRole('status')).toContainText('snapshot.sqlite');
});

test('CSV import wizard maps columns, blocks duplicates and commits selected rows only', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByLabel('粘贴 CSV 文本').fill('日期,方向,代码,数量,价格\n2026-01-02,卖出开仓,AAPL,1,2.00\n01/03/2026,买入,AAPL,100,150.00');
  await page.getByRole('button', { name: '解析预览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认列映射' })).toBeVisible();
  await expect(page.getByText('已自动识别 5 个字段；请确认列映射后再导入。')).toBeVisible();
  await expect(page.getByLabel('标的代码')).toHaveValue('2');
  await page.getByLabel('标的代码').selectOption('1');
  await page.getByRole('button', { name: '重新预览', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as any).testCalls.filter((call: any) => call.command === 'import_preview');
    return calls.at(-1).args.req.mapping.fields.symbol;
  })).toBe(1);
  await page.getByRole('button', { name: '下一步 · 逐行确认' }).click();
  await expect(page.getByText('共 4 行 · 可导入 2 · 重复 1 · 错误 1')).toBeVisible();
  const duplicate = page.getByLabel('选择第 3 行');
  await expect(duplicate).not.toBeChecked();
  await expect(page.getByLabel('选择第 4 行')).toBeDisabled();
  await page.getByLabel('第 1 行类型').selectOption('shares_buy');
  await duplicate.check();
  const commitButton = page.getByRole('button', { name: '确认导入 3 笔' });
  await expect(commitButton).toBeDisabled();
  expect(await page.evaluate(() => (window as any).testCalls.some((call: any) => call.command === 'import_commit'))).toBe(false);
  await page.getByRole('checkbox', { name: /允许重复导入/ }).check();
  await expect(commitButton).toBeEnabled();
  await commitButton.click();
  await expect(page.locator('.alert.success')).toContainText('已导入 3 笔交易');
  const commit = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'import_commit'));
  expect(commit.args.req.allowDuplicates).toBe(true);
  expect(commit.args.req.origin).toBe('粘贴文本');
  expect(commit.args.req.rows.map((row: any) => row.rowNumber)).toEqual([1, 2, 3]);
  expect(commit.args.req.rows[0].event.kind).toBe('shares_buy');
});

test('email import skips column mapping and commits through the text pipeline', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: '邮件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '导入邮件' })).toBeVisible();
  await page.getByLabel('粘贴邮件正文或 .eml 内容').fill('Trade Date: 2026-01-02\nSOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00\nFees: 1.00');
  await page.getByRole('button', { name: '解析邮件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '逐行确认' })).toBeVisible();
  await expect(page.getByText('已从通用邮件识别 1 笔交易，请核对后导入。')).toBeVisible();
  await expect(page.getByText('第 2 行：未找到成交价，已跳过。')).toBeVisible();
  const preview = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'text_import_preview'));
  expect(preview.args.req.text).toContain('SOLD TO OPEN');
  expect(preview.args.req.source).toBe('粘贴邮件');
  await expect(page.getByRole('button', { name: '返回来源' })).toBeVisible();
  await page.getByRole('button', { name: '确认导入 1 笔' }).click();
  await expect(page.locator('.alert.success')).toContainText('已导入 1 笔交易');
  const commit = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'import_commit'));
  expect(commit.args.req.origin).toBe('邮件导入');
});

test('AI screenshot import skips text editing and commits through the vision preview', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: 'AI 截图', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 截图识别' })).toBeVisible();
  await expect(page.getByText('截图会发送到你配置的云端视觉服务')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('synthetic-image') });
  await expect(page.getByRole('heading', { name: '逐行确认' })).toBeVisible();
  await expect(page.getByText('已从云端视觉（gpt-4o）识别 1 笔交易，请核对后导入。')).toBeVisible();
  await expect(page.getByText('来源截图：shot.png')).toBeVisible();
  await expect(page.getByLabel('识别文字（可修改）')).toHaveCount(0);
  const preview = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'vision_import_preview'));
  expect(preview.args.req.mime).toBe('image/png');
  expect(preview.args.req.data.length).toBeGreaterThan(0);
  expect(preview.args.req.source).toBe('shot.png');
  expect(preview.args.req.accountId).toBe('main');
  await page.getByRole('button', { name: '确认导入 1 笔' }).click();
  await expect(page.locator('.alert.success')).toContainText('已导入 1 笔交易');
  const commit = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'import_commit'));
  expect(commit.args.req.origin).toBe('AI 截图');
});

test('AI screenshot import sends the user to settings when recognition is not enabled', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).testVision.enabled = false; });
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: 'AI 截图', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('synthetic-image') });
  await expect(page.getByText('AI 截图识别未启用，请前往设置 → AI 识别。')).toBeVisible();
  await page.getByRole('button', { name: '前往设置 → AI 识别', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 截图识别' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'AI 识别', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('AI recognition settings save the key only as a masked hint and clear it on request', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'AI 识别', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 截图识别' })).toBeVisible();
  const key = page.getByLabel('API Key');
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', /尾号 1234/);
  await page.getByLabel('Base URL').fill('https://openrouter.ai/api/v1/');
  await page.getByLabel('模型').fill('qwen-vl-max');
  await key.fill('sk-vision-9876');
  await page.getByLabel('我理解截图会发送到上面配置的第三方服务').uncheck();
  await page.getByLabel('我理解截图会发送到上面配置的第三方服务').check();
  await page.getByLabel('启用 AI 截图识别').check();
  await page.getByRole('button', { name: '保存 AI 识别设置' }).click();
  await expect(page.locator('.alert.success')).toContainText('AI 识别设置已保存。');
  const saved = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'set_vision_settings'));
  expect(saved.args.req.baseUrl).toBe('https://openrouter.ai/api/v1/');
  expect(saved.args.req.model).toBe('qwen-vl-max');
  expect(saved.args.req.apiKey).toBe('sk-vision-9876');
  expect(saved.args.req.enabled).toBe(true);
  expect(saved.args.req.consent).toBe(true);
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', /尾号 9876/);
  await page.getByRole('button', { name: '清除密钥' }).click();
  await page.getByRole('button', { name: '保存 AI 识别设置' }).click();
  const cleared = await page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'set_vision_settings').at(-1));
  expect(cleared.args.req.apiKey).toBe('');
  expect(cleared.args.req.enabled).toBe(false);
  await expect(key).toHaveAttribute('placeholder', '输入 API Key');
});

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzipStore(buffer: Buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function readZip(download: Awaited<ReturnType<Page['waitForEvent']>>) {
  const stream = await (download as any).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return unzipStore(Buffer.concat(chunks));
}

test('expiry reminders and calendar surface overdue contracts', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.nav-badge')).toHaveText('1');
  await expect(page.locator('nav').getByRole('button', { name: '当前持仓', exact: true })).toHaveAttribute('title', '1 个到期提醒');
  const card = page.locator('.reminder-card');
  await expect(card).toContainText('TEST 2026-02-20 150P');
  await expect(card).toContainText('已过期 256 天');
  await page.locator('nav').getByRole('button', { name: '到期日历', exact: true }).click();
  await expect(page.getByRole('heading', { name: '到期日历', level: 1 })).toBeVisible();
  for (let index = 0; index < 9; index++) await page.getByRole('button', { name: '上一个月' }).click();
  await expect(page.locator('.calendar-month')).toHaveText('2026 年 2 月');
  await page.getByRole('gridcell', { name: '2026-02-20，1 个到期合约' }).click();
  const selected = page.locator('section').filter({ has: page.getByRole('heading', { name: '2026-02-20 到期合约' }) });
  await expect(selected).toContainText('TEST 2026-02-20 150P');
  await expect(selected).toContainText('已过期 256 天');
});

test('campaign comparison reports exact days, return and peak capital', async ({ page }) => {
  await setup(page);
  await page.locator('nav').getByRole('button', { name: '战役对比', exact: true }).click();
  await page.getByRole('button', { name: '查看数据', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'TEST' }).first();
  await expect(row).toContainText('305');
  await expect(row).toContainText('$300.00');
  await expect(row).toContainText('$30,000.00');
  await expect(row).toContainText('1.00%');
  await expect(row).toContainText('进行中');
});

test('Excel export writes stored ZIP parts with CRCs and no formulas', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '收租台账', exact: true }).click();
  const ledgerDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
  const ledgerZip = await readZip(await ledgerDownload);
  expect([...ledgerZip.keys()].filter(name => name.startsWith('xl/worksheets/'))).toHaveLength(1);
  expect(ledgerZip.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('<v>-125.5</v>');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '备份与维护', exact: true }).click();
  const workbookDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Excel 工作簿', exact: true }).click();
  const workbook = await readZip(await workbookDownload);
  const sheets = [...workbook.keys()].filter(name => name.startsWith('xl/worksheets/'));
  expect(sheets).toHaveLength(4);
  expect(workbook.get('xl/workbook.xml')!.toString('utf8')).toContain('台账');
  const events = workbook.get('xl/worksheets/sheet2.xml')!.toString('utf8');
  expect(events).toContain('<t>=SUM(A1:A2)</t>');
  for (const sheet of sheets) expect(workbook.get(sheet)!.toString('utf8')).not.toContain('<f>');
});

test('backup list validates, rejects corruption, and stages a restore for restart', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '备份与维护', exact: true }).click();
  const list = page.locator('.backup-list');
  await expect(list.locator('.backup-row')).toHaveCount(4);
  await expect(list).toContainText('手动备份');
  await expect(list).toContainText('自动备份');
  await expect(list).toContainText('恢复前安全快照');
  await expect(list).toContainText('已加密');
  await expect(list).toContainText('2026-01-02 08:00:00 UTC');

  await page.evaluate(() => { (window as any).testInvalidBackup = true; });
  await page.getByRole('button', { name: '校验与恢复' }).first().click();
  await expect(page.locator('.restore-validation')).toContainText('not ok: synthetic corruption');
  await expect(page.getByRole('button', { name: '恢复此备份…' })).toBeDisabled();

  await page.evaluate(() => { (window as any).testInvalidBackup = false; });
  await page.getByRole('button', { name: '校验与恢复' }).first().click();
  await expect(page.locator('.restore-validation')).toContainText('校验通过');
  await expect(page.locator('.validation-values')).toContainText('3');
  await page.getByRole('button', { name: '恢复此备份…' }).click();
  await expect(page.getByRole('dialog')).toContainText('pre-restore-*.sqlite');
  await page.getByRole('button', { name: '确认恢复并重启' }).click();
  await expect(page.locator('.alert.error')).toContainText('已安排从 wheel-1767225600000000000-0.sqlite 恢复账本');
  expect(await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'stage_restore').args.fileName)).toBe('wheel-1767225600000000000-0.sqlite');
});

test('encrypted backup is created and restored only with its password', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '备份与维护', exact: true }).click();
  await page.getByLabel('备份加密密码').fill('correct horse');
  await page.getByRole('button', { name: '备份 SQLite' }).click();
  await expect(page.getByRole('status')).toContainText('加密备份已保存');
  await expect(page.getByRole('status')).toContainText('.sqlite.enc');
  expect(await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'backup_now').args.password)).toBe('correct horse');

  const encryptedRow = page.locator('.backup-row').filter({ hasText: '.sqlite.enc' });
  await expect(encryptedRow).toContainText('已加密');
  await encryptedRow.getByRole('button', { name: '校验与恢复' }).click();
  await expect(page.locator('.restore-validation')).toContainText('此备份使用密码加密');
  const decrypt = page.getByRole('button', { name: '解密并校验' });
  await expect(decrypt).toBeDisabled();
  await page.getByLabel('恢复密码').fill('wrong password');
  await decrypt.click();
  await expect(page.locator('.alert.error')).toContainText('密码错误');
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByLabel('恢复密码').fill('correct horse');
  await decrypt.click();
  await expect(page.locator('.restore-validation')).toContainText('校验通过');
  await page.getByRole('button', { name: '恢复此备份…' }).click();
  await expect(page.getByRole('dialog')).toContainText('暂存时会用恢复密码解密');
  await page.getByRole('button', { name: '确认恢复并重启' }).click();
  await expect(page.locator('.alert.error')).toContainText('已安排从 wheel-1767225600000000000-3.sqlite.enc 恢复账本');
  const staged = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'stage_restore'));
  expect(staged.args.password).toBe('correct horse');
  expect(staged.args.fileName).toBe('wheel-1767225600000000000-3.sqlite.enc');
});

test('JSON export downloads the full ledger document', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '备份与维护', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^wheel-ledger-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(document.format).toBe('wheel-export');
  expect(document.version).toBe(1);
  expect(document.accounts[0].id).toBe('main');
  expect(document.events[0].occurredAt).toBe('2026-01-02');
  expect(document.prices[0].symbol).toBe('TEST');
  expect(document.settings.autoBackupKeep).toBe(7);
  await expect(page.getByRole('status')).toContainText('不能直接恢复');
});

test('auto backup settings preserve reminder lead days', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '备份与维护', exact: true }).click();
  await page.locator('.auto-backup-form input[type=number]').fill('5');
  await page.getByRole('button', { name: '保存自动备份设置' }).click();
  await expect(page.getByRole('status')).toContainText('保留最近 5 份');
  const call = await page.evaluate(() => (window as any).testCalls.find((entry: any) => entry.command === 'set_preferences'));
  expect(call.args).toEqual({ reminderLeadDays: 7, autoBackupEnabled: true, autoBackupKeep: 5 });
});

test('cost chart overlays saved price and the next call strike', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '查看战役' }).click();
  await expect(page.locator('.chart-call-note')).toContainText('Call 行权价 $160.00');
  await page.getByRole('button', { name: '查看数据', exact: true }).click();
  const header = page.getByRole('row').filter({ hasText: '日期' }).first();
  await expect(header).toContainText('参考价');
  await expect(header).toContainText('成本变化 B');
});

test('creating and switching an account scopes reads and new entries', async ({ page }) => {
  await setup(page);
  await expect(page.getByLabel('切换账户')).toHaveValue('main');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByLabel('新账户名称').fill('长期账户');
  await page.getByRole('button', { name: '创建并切换' }).click();
  await expect(page.getByLabel('切换账户')).toHaveValue('acct-2');
  await expect(page.locator('header')).toContainText('长期账户');
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'dashboard').at(-1).args.accountId)).toBe('acct-2');
  expect(await page.evaluate(() => localStorage.getItem('wheel.account'))).toBe('acct-2');
  await page.locator('header').getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('交易类型').selectOption('shares_buy');
  await page.getByLabel('标的代码').fill('OTHER');
  await page.getByLabel('股数', { exact: true }).fill('100');
  await page.getByLabel('每股成交价', { exact: true }).fill('20');
  await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'add_event').args.req.accountId)).toBe('acct-2');
  await page.getByLabel('切换账户').selectOption('main');
  await expect(page.locator('header')).toContainText('默认账户');
  await expect.poll(() => page.evaluate(() => (window as any).testCalls.filter((call: any) => call.command === 'dashboard').at(-1).args.accountId)).toBe('main');
});

test('monthly income report accumulates rent by month and filters by year', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '收租月报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '收租月报', level: 1 })).toBeVisible();
  await expect(page.locator('.income-summary')).toContainText('$313.00');
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const latest = page.locator('tbody tr').first();
  await expect(latest).toContainText('2026-02');
  await expect(latest).toContainText('$168.00');
  await expect(latest).toContainText('$313.00');
  await expect(page.locator('tfoot')).toContainText('$198.00');
  await page.getByLabel('选择年份').selectOption('2026');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('.income-summary')).toContainText('$263.00');
  await expect(page.locator('tfoot')).toContainText('$263.00');
  await expect(page.locator('tbody tr').filter({ hasText: '2025-12' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /收租月报图/ })).toBeVisible();
});

test('renaming the current account updates the switcher and header', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByRole('button', { name: '重命名 默认账户' }).click();
  await page.getByLabel('重命名 默认账户').fill('主账户');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.getByLabel('切换账户')).toContainText('主账户');
  await expect(page.locator('header')).toContainText('主账户');
  await expect(page.getByRole('status')).toContainText('重命名为「主账户」');
});

test('archiving hides an account from the switcher and restoring brings it back', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await page.getByLabel('新账户名称').fill('长期账户');
  await page.getByRole('button', { name: '创建并切换' }).click();
  await expect(page.getByLabel('切换账户')).toHaveValue('acct-2');

  await page.getByRole('button', { name: '归档 长期账户' }).click();
  await expect(page.getByRole('status')).toContainText('已归档账户「长期账户」');
  await expect(page.getByLabel('切换账户')).toHaveValue('main');
  await expect(page.getByLabel('切换账户').locator('option', { hasText: '长期账户' })).toHaveCount(0);
  await expect(page.locator('.account-section-title')).toContainText('已归档');
  await expect(page.getByRole('button', { name: '恢复 长期账户' })).toBeVisible();

  await page.getByRole('button', { name: '恢复 长期账户' }).click();
  await expect(page.getByRole('status')).toContainText('已恢复账户「长期账户」');
  await expect(page.getByLabel('切换账户').locator('option', { hasText: '长期账户' })).toHaveCount(1);
  await expect(page.locator('.account-section-title')).toHaveCount(0);
});

test('deleting an empty account requires confirmation and keeps accounts with history', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '账户', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除 默认账户' })).toBeDisabled();

  await page.getByLabel('新账户名称').fill('待删除');
  await page.getByRole('button', { name: '创建并切换' }).click();
  await expect(page.getByLabel('切换账户')).toHaveValue('acct-2');

  await page.getByRole('button', { name: '删除 待删除' }).click();
  await expect(page.getByRole('dialog')).toContainText('确认删除空账户「待删除」');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '删除 待删除' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('status')).toContainText('已删除空账户「待删除」');
  await expect(page.getByLabel('切换账户')).toHaveValue('main');
  await expect(page.getByLabel('切换账户').locator('option', { hasText: '待删除' })).toHaveCount(0);
});

test('stock split entry submits ratio and cash in lieu without trade fields', async ({ page }) => {
  await setup(page);
  await page.locator('header').getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('交易类型').selectOption('stock_split');
  await expect(page.getByLabel('比例 · 分子')).toHaveValue('2');
  await expect(page.getByLabel('比例 · 分母')).toHaveValue('1');
  await expect(page.getByLabel('股数', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('每股成交价', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('费用总额')).toHaveCount(0);
  await page.getByLabel('标的代码').fill('TEST');
  await page.getByLabel('零股现金补偿（USD，选填）').fill('3.25');
  await expect(page.locator('.entry-preview')).toContainText('2 : 1');
  await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
  const req = await page.evaluate(() => (window as any).testCalls.find((call: any) => call.command === 'add_event').args.req);
  expect(req).toMatchObject({ kind: 'stock_split', symbol: 'TEST', qty: 0, amount: 0, splitNumerator: 2, splitDenominator: 1, splitCashInLieu: 3.25 });
});

test('non-integral split ratio surfaces a readable error and keeps the form', async ({ page }) => {
  await setup(page);
  await page.locator('header').getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('交易类型').selectOption('stock_split');
  await page.getByLabel('标的代码').fill('TEST');
  await page.getByLabel('比例 · 分子').fill('4');
  await page.getByLabel('比例 · 分母').fill('3');
  await page.getByRole('button', { name: '保存交易', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('4:3');
  await expect(page.getByLabel('比例 · 分子')).toHaveValue('4');
  await expect(page.getByRole('button', { name: '保存交易', exact: true })).toBeEnabled();
});

test('split ratio appears in the event log and campaign timeline', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).testSplit = true; });
  await page.getByRole('button', { name: '刷新账本', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '交易记录', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: '拆股 / 合股' });
  await expect(row).toContainText('2 : 1');
  await expect(row).toContainText('零股补偿 $3.25');
  await page.getByRole('button', { name: '仪表盘', exact: true }).click();
  await page.getByRole('button', { name: '查看战役' }).click();
  const timeline = page.locator('section').filter({ has: page.getByRole('heading', { name: '战役事件时间轴' }) });
  await expect(timeline.getByRole('listitem')).toHaveCount(4);
  await expect(timeline).toContainText('2 : 1');
  await expect(timeline).toContainText('零股补偿 $3.25');
});

test('open contract multiplier drives entry prefill and reminder premium', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).testMultiplier = 200; });
  await page.getByRole('button', { name: '刷新账本', exact: true }).click();
  await expect(page.locator('.reminder-card')).toContainText('净权利金 $400.00');
  await page.getByRole('button', { name: '当前持仓', exact: true }).click();
  await page.getByRole('button', { name: '到期作废', exact: true }).click();
  await expect(page.getByLabel('每手股数（乘数）')).toHaveValue('200');
});

test('annual report filters years and exports month and symbol sheets', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '年度报表', exact: true }).click();
  await expect(page.getByRole('heading', { name: '年度报表', level: 1 })).toBeVisible();
  await expect(page.locator('.annual-summary')).toContainText('$613.00');
  await expect(page.getByRole('img', { name: /年度已实现收益图/ })).toBeVisible();
  const months = page.locator('.monthly-breakdown');
  await expect(months.locator('tbody tr')).toHaveCount(3);
  await expect(months.locator('tbody tr').first()).toContainText('2026-03');
  await expect(months.locator('tbody tr').first()).toContainText('$350.00');
  await expect(months.locator('tfoot')).toContainText('$613.00');
  const symbols = page.locator('.symbol-breakdown');
  await expect(symbols.locator('tbody tr')).toHaveCount(2);
  await expect(symbols.locator('tbody tr').first()).toContainText('AAPL');
  await expect(symbols.locator('tbody tr').first()).toContainText('$663.00');
  await expect(symbols.locator('tbody tr').nth(1)).toContainText('MSFT');
  await expect(symbols.locator('tbody tr').nth(1)).toContainText('-$50.00');

  await page.getByLabel('选择年份').selectOption('2025');
  await expect(page.locator('.annual-summary')).toContainText('$120.00');
  await expect(months.locator('tbody tr')).toHaveCount(1);
  await expect(months.locator('tbody tr').first()).toContainText('2025-12');
  await expect(symbols.locator('tbody tr')).toHaveCount(1);
  await expect(symbols.locator('tbody tr').first()).toContainText('MSFT');
  await page.getByLabel('选择年份').selectOption('2026');

  const csv = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const csvStream = await (await csv).createReadStream();
  const csvChunks = []; for await (const chunk of csvStream!) csvChunks.push(chunk as Buffer);
  const csvText = Buffer.concat(csvChunks).toString('utf8');
  expect((await csv).suggestedFilename()).toBe('wheel-annual-2026.csv');
  expect(csvText).toContain('股票已实现盈亏');
  expect(csvText).toContain('2026-03');
  expect(csvText).toContain('AAPL');

  const workbookDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Excel', exact: true }).click();
  const workbook = await readZip(await workbookDownload);
  expect([...workbook.keys()].filter(name => name.startsWith('xl/worksheets/'))).toHaveLength(2);
  expect(workbook.get('xl/workbook.xml')!.toString('utf8')).toContain('年度月度');
  expect(workbook.get('xl/workbook.xml')!.toString('utf8')).toContain('年度标的');
  expect(workbook.get('xl/worksheets/sheet1.xml')!.toString('utf8')).toContain('2026-03');
  expect(workbook.get('xl/worksheets/sheet2.xml')!.toString('utf8')).toContain('AAPL');
});
