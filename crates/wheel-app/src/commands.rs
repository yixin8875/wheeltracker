//! IPC commands. Each command replays the event log and returns read models;
//! writes append events only, never derived rows.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use wheel_core::{DerivedState, Event, EventKind, OptionContract, Right};

use crate::{backup, restore, store, views, AppState};

fn account_or_default(account_id: Option<String>) -> String {
    account_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| "main".to_string())
}

fn data_dir(state: &AppState) -> PathBuf {
    PathBuf::from(&state.data_dir)
}

fn backups_dir(state: &AppState) -> PathBuf {
    data_dir(state).join(backup::BACKUP_DIR)
}

/// While a restore is staged, every write is refused until the app restarts
/// and swaps the database; otherwise the restored snapshot would lose new rows.
fn ensure_no_pending_restore(state: &AppState) -> Result<(), String> {
    let pending = restore::is_pending(&data_dir(state)).map_err(|error| error.to_string())?;
    if pending {
        Err("已安排恢复，请完全退出并重启应用后再修改账本。".to_string())
    } else {
        Ok(())
    }
}

fn derive(conn: &rusqlite::Connection, account_id: &str) -> Result<DerivedState, String> {
    let events = store::list_events(conn, account_id).map_err(|error| error.to_string())?;
    let settings = store::get_settings(conn).map_err(|error| error.to_string())?;
    store::replay_checked(account_id, &events, settings).map_err(|error| format!("{error:#}"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub include_dividends_in_cost: bool,
    pub reminder_lead_days: i64,
    pub auto_backup_enabled: bool,
    pub auto_backup_keep: u32,
}

fn settings_view(
    conn: &rusqlite::Connection,
    settings: wheel_core::Settings,
) -> Result<SettingsView, String> {
    let preferences = store::get_preferences(conn).map_err(|error| error.to_string())?;
    Ok(SettingsView {
        include_dividends_in_cost: settings.include_dividends_in_cost,
        reminder_lead_days: preferences.reminder_lead_days,
        auto_backup_enabled: preferences.auto_backup_enabled,
        auto_backup_keep: preferences.auto_backup_keep,
    })
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let conn = state.conn();
    let settings = store::get_settings(&conn).map_err(|error| error.to_string())?;
    settings_view(&conn, settings)
}

#[tauri::command]
pub fn set_settings(
    state: State<'_, AppState>,
    include_dividends_in_cost: bool,
) -> Result<SettingsView, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    let settings = store::set_settings(&conn, include_dividends_in_cost)
        .map_err(|error| error.to_string())?;
    settings_view(&conn, settings)
}

#[tauri::command]
pub fn set_preferences(
    state: State<'_, AppState>,
    reminder_lead_days: i64,
    auto_backup_enabled: bool,
    auto_backup_keep: u32,
) -> Result<SettingsView, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    let preferences = store::Preferences {
        reminder_lead_days,
        auto_backup_enabled,
        auto_backup_keep,
    };
    store::set_preferences(&conn, preferences).map_err(|error| error.to_string())?;
    let settings = store::get_settings(&conn).map_err(|error| error.to_string())?;
    settings_view(&conn, settings)
}

const VISION_BASE_URL_KEY: &str = "vision.baseUrl";
const VISION_MODEL_KEY: &str = "vision.model";
const VISION_API_KEY_KEY: &str = "vision.apiKey";
const VISION_ENABLED_KEY: &str = "vision.enabled";
const VISION_CONSENT_KEY: &str = "vision.consent";
const DEFAULT_VISION_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_VISION_MODEL: &str = "gpt-4o";

/// Settings exposed to the UI. The API key itself never crosses IPC; only a
/// boolean and the last four characters are returned.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VisionSettingsView {
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    pub key_hint: String,
    pub enabled: bool,
    pub consent: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionSettingsReq {
    pub base_url: String,
    pub model: String,
    /// `None` keeps the saved key; `Some("")` clears it.
    #[serde(default)]
    pub api_key: Option<String>,
    pub enabled: bool,
    pub consent: bool,
}

struct VisionSettingsState {
    view: VisionSettingsView,
    key: String,
}

fn setting_bool(conn: &rusqlite::Connection, key: &str, default: bool) -> Result<bool, String> {
    match store::get_setting_value(conn, key).map_err(|error| error.to_string())? {
        Some(value) => match value.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("设置 {key} 的值无效")),
        },
        None => Ok(default),
    }
}

fn vision_settings_state(conn: &rusqlite::Connection) -> Result<VisionSettingsState, String> {
    let base_url = store::get_setting_value(conn, VISION_BASE_URL_KEY)
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| DEFAULT_VISION_BASE_URL.to_string());
    let model = store::get_setting_value(conn, VISION_MODEL_KEY)
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| DEFAULT_VISION_MODEL.to_string());
    let key = store::get_setting_value(conn, VISION_API_KEY_KEY)
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let hint = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Ok(VisionSettingsState {
        view: VisionSettingsView {
            base_url,
            model,
            has_key: !key.trim().is_empty(),
            key_hint: hint,
            enabled: setting_bool(conn, VISION_ENABLED_KEY, false)?,
            consent: setting_bool(conn, VISION_CONSENT_KEY, false)?,
        },
        key,
    })
}

fn vision_config(conn: &rusqlite::Connection) -> Result<crate::vision::VisionConfig, String> {
    let state = vision_settings_state(conn)?;
    if !state.view.enabled {
        return Err("AI 截图识别未启用，请前往设置 → AI 识别。".to_string());
    }
    if !state.view.consent {
        return Err("请先在设置 → AI 识别中同意隐私说明。".to_string());
    }
    if state.key.trim().is_empty() {
        return Err("请先在设置 → AI 识别中保存 API Key。".to_string());
    }
    Ok(crate::vision::VisionConfig {
        base_url: state.view.base_url,
        model: state.view.model,
        api_key: state.key,
    })
}

#[tauri::command]
pub fn get_vision_settings(
    state: State<'_, AppState>,
) -> Result<VisionSettingsView, String> {
    let conn = state.conn();
    Ok(vision_settings_state(&conn)?.view)
}

fn set_vision_for(
    conn: &rusqlite::Connection,
    req: VisionSettingsReq,
) -> Result<VisionSettingsView, String> {
    let base_url = crate::vision::normalize_base_url(&req.base_url)?;
    if base_url.len() > 300 {
        return Err("Base URL 过长。".to_string());
    }
    let model = crate::vision::validate_model(&req.model)?;
    if model.len() > 100 {
        return Err("模型名称过长。".to_string());
    }
    let existing = vision_settings_state(conn)?.key;
    let replace_key = req.api_key.is_some();
    let key = match req.api_key {
        Some(raw) if raw.trim().is_empty() => String::new(),
        Some(raw) => crate::vision::validate_api_key(&raw)?,
        None => existing,
    };
    if req.enabled && key.trim().is_empty() {
        return Err("启用 AI 截图识别前请先保存 API Key。".to_string());
    }
    if req.enabled && !req.consent {
        return Err("启用前请先阅读并同意隐私说明。".to_string());
    }

    let tx = rusqlite::Transaction::new_unchecked(
        conn,
        rusqlite::TransactionBehavior::Immediate,
    )
    .map_err(|error| error.to_string())?;
    store::set_setting_value(&tx, VISION_BASE_URL_KEY, &base_url)
        .map_err(|error| error.to_string())?;
    store::set_setting_value(&tx, VISION_MODEL_KEY, &model)
        .map_err(|error| error.to_string())?;
    store::set_setting_value(
        &tx,
        VISION_ENABLED_KEY,
        if req.enabled { "true" } else { "false" },
    )
    .map_err(|error| error.to_string())?;
    store::set_setting_value(
        &tx,
        VISION_CONSENT_KEY,
        if req.consent { "true" } else { "false" },
    )
    .map_err(|error| error.to_string())?;
    if replace_key {
        store::set_setting_value(&tx, VISION_API_KEY_KEY, &key)
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(vision_settings_state(conn)?.view)
}

#[tauri::command]
pub fn set_vision_settings(
    state: State<'_, AppState>,
    req: VisionSettingsReq,
) -> Result<VisionSettingsView, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    set_vision_for(&conn, req)
}

#[tauri::command]
pub fn dashboard(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<views::DashboardView, String> {
    let account_id = account_or_default(account_id);
    let conn = state.conn();
    let derived = derive(&conn, &account_id)?;
    let prices = store::latest_prices(&conn).map_err(|error| error.to_string())?;
    let today = store::today();

    let mut campaigns: Vec<views::CampaignCardView> = derived
        .campaigns
        .iter()
        .map(|campaign| {
            views::campaign_card(
                campaign,
                &derived,
                prices.get(&campaign.symbol).copied(),
                today,
            )
        })
        .collect();
    campaigns.sort_by(|a, b| {
        let rank = |status: &str| if status == "active" { 0 } else { 1 };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| a.symbol.cmp(&b.symbol))
    });

    let open_contracts = derived
        .positions
        .iter()
        .map(|position| position.open_qty)
        .sum();
    let collateral = derived
        .positions
        .iter()
        .filter(|position| position.contract.right == Right::Put)
        .map(|position| position.contract.strike * 100.0 * position.open_qty as f64)
        .sum();
    let shares_held = derived
        .campaigns
        .iter()
        .filter(|campaign| campaign.is_active())
        .map(|campaign| campaign.shares)
        .sum();

    let summary = views::SummaryView {
        premium_realized: derived.total_premium_realized(),
        premium_open: derived.total_premium_open(),
        active_campaigns: derived
            .campaigns
            .iter()
            .filter(|campaign| campaign.is_active())
            .count(),
        open_positions: derived.positions.len(),
        open_contracts,
        collateral,
        shares_held,
    };

    Ok(views::DashboardView {
        account_id,
        as_of: today.to_string(),
        summary,
        campaigns,
    })
}

#[tauri::command]
pub fn campaign_detail(
    state: State<'_, AppState>,
    campaign_id: String,
    account_id: Option<String>,
) -> Result<views::CampaignDetailView, String> {
    let account_id = account_or_default(account_id);
    campaign_detail_for(&state.conn(), &account_id, &campaign_id)
}

fn campaign_detail_for(
    conn: &rusqlite::Connection,
    account_id: &str,
    campaign_id: &str,
) -> Result<views::CampaignDetailView, String> {
    let events = store::list_events(conn, account_id).map_err(|error| error.to_string())?;
    let settings = store::get_settings(conn).map_err(|error| error.to_string())?;
    let derived = store::replay_checked(account_id, &events, settings)
        .map_err(|error| format!("{error:#}"))?;
    let today = store::today();
    let prices = store::latest_prices(conn).map_err(|error| error.to_string())?;
    let campaign = derived
        .campaign(campaign_id)
        .ok_or_else(|| format!("campaign `{campaign_id}` not found"))?;
    let price = prices.get(&campaign.symbol).copied();

    Ok(views::CampaignDetailView {
        campaign: views::campaign_card(campaign, &derived, price, today),
        entries: derived
            .entries_for(campaign_id)
            .into_iter()
            .map(views::entry)
            .collect(),
        positions: derived
            .positions_for(campaign_id)
            .into_iter()
            .map(|position| views::position(position, today))
            .collect(),
        lots: derived
            .lots
            .iter()
            .filter(|lot| lot.campaign_id == campaign_id)
            .map(views::lot)
            .collect(),
        events: events
            .iter()
            .filter(|event| {
                derived
                    .event_campaigns
                    .get(&event.id)
                    .is_some_and(|id| id == campaign_id)
            })
            .cloned()
            .map(event_view)
            .collect(),
        call_scenarios: call_scenarios(&events, &derived, campaign_id)?,
    })
}

fn call_scenarios(
    events: &[Event],
    derived: &DerivedState,
    campaign_id: &str,
) -> Result<Vec<views::CallScenario>, String> {
    let mut scenarios = Vec::new();
    for position in derived
        .positions_for(campaign_id)
        .into_iter()
        .filter(|position| position.contract.right == Right::Call)
    {
        let seq = events
            .iter()
            .map(|event| event.seq)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("projection event sequence overflow")?;
        let mut id = format!("projection-{}", position.contract.id());
        while events.iter().any(|event| event.id == id) {
            id.push('-');
        }
        let at = events
            .iter()
            .map(|event| event.occurred_at)
            .max()
            .unwrap_or(position.contract.expiry)
            .max(position.contract.expiry);
        let assignment = Event::assign_option(
            &derived.account_id,
            &id,
            seq,
            at,
            position.contract.clone(),
            position.open_qty,
            0.0,
        );
        let mut hypothetical = events.to_vec();
        hypothetical.push(assignment);
        let simulated = store::replay_checked(&derived.account_id, &hypothetical, derived.settings)
            .map_err(|error| format!("assignment projection failed: {error:#}"))?;
        let campaign = simulated
            .campaign(campaign_id)
            .ok_or("projected campaign missing")?;
        let shares_sold = position
            .open_qty
            .checked_mul(position.contract.multiplier)
            .ok_or("projection share quantity overflow")?;
        let remaining_contracts = simulated
            .positions_for(campaign_id)
            .iter()
            .try_fold(0u32, |total, p| total.checked_add(p.open_qty))
            .ok_or("projection contract quantity overflow")?;
        let realized_total = campaign.share_pnl
            + campaign.premium_realized
            + campaign.dividends
            + campaign.adjustments;
        let sale_proceeds = position.contract.strike * f64::from(shares_sold);
        if !realized_total.is_finite() || !sale_proceeds.is_finite() {
            return Err("assignment projection produced non-finite totals".to_string());
        }
        scenarios.push(views::CallScenario {
            contract: position.contract.display(),
            qty: position.open_qty,
            shares_sold,
            strike: position.contract.strike,
            assignment_fees: 0.0,
            sale_proceeds,
            share_pnl: campaign.share_pnl,
            premium_realized: campaign.premium_realized,
            dividends: campaign.dividends,
            adjustments: campaign.adjustments,
            realized_total,
            remaining_shares: campaign.shares,
            remaining_contracts,
            closes_campaign: !campaign.is_active(),
        });
    }
    Ok(scenarios)
}

#[tauri::command]
pub fn ledger(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<views::LedgerView, String> {
    let account_id = account_or_default(account_id);
    let conn = state.conn();
    let derived = derive(&conn, &account_id)?;

    let mut entries: Vec<views::EntryView> =
        derived.premium_entries.iter().map(views::entry).collect();
    entries.sort_by(|a, b| {
        b.opened_at
            .cmp(&a.opened_at)
            .then_with(|| a.contract.cmp(&b.contract))
    });

    let total_net = entries.iter().map(|entry| entry.net_premium).sum();
    let total_collateral = entries.iter().map(|entry| entry.collateral).sum();

    Ok(views::LedgerView {
        count: entries.len(),
        entries,
        total_net,
        total_collateral,
    })
}

#[tauri::command]
pub fn monthly_income(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<views::MonthlyIncomeView, String> {
    monthly_income_for(&state.conn(), &account_or_default(account_id))
}

#[derive(Default)]
struct MonthBucket {
    premium: f64,
    dividends: f64,
    fees: f64,
    adjustments: f64,
    closed_entries: u32,
}

fn month_key(date: time::Date) -> String {
    format!("{}-{:02}", date.year(), date.month() as u8)
}

/// Realized income by calendar month. Premium is booked when an option ledger
/// line closes (net of open and close fees); dividends, fees and cash
/// adjustments are booked on their event date. Open premium is excluded.
fn monthly_income_for(
    conn: &rusqlite::Connection,
    account_id: &str,
) -> Result<views::MonthlyIncomeView, String> {
    let events = store::list_events(conn, account_id).map_err(|error| error.to_string())?;
    let settings = store::get_settings(conn).map_err(|error| error.to_string())?;
    let derived = store::replay_checked(account_id, &events, settings)
        .map_err(|error| format!("{error:#}"))?;

    let mut buckets: std::collections::BTreeMap<String, MonthBucket> =
        std::collections::BTreeMap::new();
    for entry in &derived.premium_entries {
        let Some(closed_at) = entry.closed_at else {
            continue;
        };
        let bucket = buckets.entry(month_key(closed_at)).or_default();
        bucket.premium += entry.net_premium;
        bucket.closed_entries += 1;
    }
    for event in &events {
        match event.kind {
            EventKind::Dividend => {
                let amount = derived
                    .event_dividends
                    .get(&event.id)
                    .copied()
                    .unwrap_or(event.price * event.qty as f64);
                buckets
                    .entry(month_key(event.occurred_at))
                    .or_default()
                    .dividends += amount;
            }
            EventKind::Fee => {
                buckets
                    .entry(month_key(event.occurred_at))
                    .or_default()
                    .fees += event.amount;
            }
            EventKind::Adjustment => {
                buckets
                    .entry(month_key(event.occurred_at))
                    .or_default()
                    .adjustments += event.amount;
            }
            _ => {}
        }
    }

    let mut cumulative = 0.0;
    let months: Vec<views::MonthIncomeView> = buckets
        .into_iter()
        .map(|(month, bucket)| {
            let total = bucket.premium + bucket.dividends - bucket.fees + bucket.adjustments;
            cumulative += total;
            views::MonthIncomeView {
                month,
                premium: bucket.premium,
                dividends: bucket.dividends,
                fees: bucket.fees,
                adjustments: bucket.adjustments,
                total,
                cumulative,
                closed_entries: bucket.closed_entries,
            }
        })
        .collect();

    let mut total = views::MonthIncomeTotalView {
        premium: 0.0,
        dividends: 0.0,
        fees: 0.0,
        adjustments: 0.0,
        total: 0.0,
        closed_entries: 0,
        month_count: months.len(),
    };
    for month in &months {
        total.premium += month.premium;
        total.dividends += month.dividends;
        total.fees += month.fees;
        total.adjustments += month.adjustments;
        total.total += month.total;
        total.closed_entries += month.closed_entries;
    }

    Ok(views::MonthlyIncomeView { months, total })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub id: String,
    pub account_id: String,
    pub seq: u64,
    pub date: String,
    pub kind: String,
    pub symbol: String,
    pub qty: u32,
    pub price: f64,
    pub fees: f64,
    pub amount: f64,
    pub expiry: Option<String>,
    pub strike: Option<f64>,
    pub right: Option<String>,
    pub multiplier: Option<u32>,
    pub note: String,
}

fn event_view(event: Event) -> EventView {
    EventView {
        expiry: event.contract.as_ref().map(|c| c.expiry.to_string()),
        strike: event.contract.as_ref().map(|c| c.strike),
        right: event
            .contract
            .as_ref()
            .map(|c| c.right.as_str().to_string()),
        multiplier: event.contract.as_ref().map(|c| c.multiplier),
        date: event.occurred_at.to_string(),
        kind: store::kind_to_str(event.kind).to_string(),
        id: event.id,
        account_id: event.account_id,
        seq: event.seq,
        symbol: event.symbol,
        qty: event.qty,
        price: event.price,
        fees: event.fees,
        amount: event.amount,
        note: event.note,
    }
}

#[tauri::command]
pub fn list_events(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<Vec<EventView>, String> {
    let conn = state.conn();
    let events = store::list_events(&conn, &account_or_default(account_id))
        .map_err(|error| error.to_string())?;
    Ok(events.into_iter().map(event_view).collect())
}

#[tauri::command]
pub fn positions(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<Vec<views::PositionView>, String> {
    let conn = state.conn();
    let derived = derive(&conn, &account_or_default(account_id))?;
    let today = store::today();
    Ok(derived
        .positions
        .iter()
        .map(|position| views::position(position, today))
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEventReq {
    #[serde(default)]
    pub account_id: Option<String>,
    pub date: String,
    pub kind: String,
    pub symbol: String,
    #[serde(default)]
    pub qty: u32,
    #[serde(default)]
    pub price: f64,
    #[serde(default)]
    pub fees: f64,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub expiry: Option<String>,
    #[serde(default)]
    pub strike: Option<f64>,
    #[serde(default)]
    pub right: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub fn add_event(state: State<'_, AppState>, req: NewEventReq) -> Result<String, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    let mut ids = append_requests(&conn, vec![req])?;
    Ok(ids.remove(0))
}

#[tauri::command]
pub fn add_events(
    state: State<'_, AppState>,
    reqs: Vec<NewEventReq>,
) -> Result<Vec<String>, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    append_requests(&conn, reqs)
}

fn append_requests(
    conn: &rusqlite::Connection,
    reqs: Vec<NewEventReq>,
) -> Result<Vec<String>, String> {
    if reqs.is_empty() {
        return Err("at least one event is required".to_string());
    }
    let mut sequences = std::collections::HashMap::new();
    let mut events = Vec::with_capacity(reqs.len());
    let mut ids = Vec::with_capacity(reqs.len());
    for req in reqs {
        let account_id = account_or_default(req.account_id.clone());
        let seq = match sequences.get(&account_id) {
            Some(seq) => *seq,
            None => store::next_seq(conn, &account_id).map_err(|error| error.to_string())?,
        };
        sequences.insert(
            account_id.clone(),
            seq.checked_add(1).ok_or("event sequence overflow")?,
        );
        let id = next_event_id(seq);
        events.push(build_event(&req, &account_id, &id, seq)?);
        ids.push(id);
    }
    match events.as_slice() {
        [event] => store::insert_event(conn, event),
        _ => store::insert_events(conn, &events),
    }
    .map_err(|error| format!("{error:#}"))?;
    Ok(ids)
}

fn build_event(req: &NewEventReq, account_id: &str, id: &str, seq: u64) -> Result<Event, String> {
    let at = store::parse_date(&req.date).map_err(|error| error.to_string())?;
    let symbol = req.symbol.trim().to_ascii_uppercase();
    if symbol.is_empty() {
        return Err("symbol is required".to_string());
    }
    if !req.price.is_finite()
        || req.price < 0.0
        || !req.fees.is_finite()
        || req.fees < 0.0
        || !req.amount.is_finite()
    {
        return Err(
            "price and fees must be finite and nonnegative; amount must be finite".to_string(),
        );
    }
    let contract = match (&req.expiry, req.strike, &req.right) {
        (None, None, None) => None,
        (Some(expiry), Some(strike), Some(right)) => {
            if !strike.is_finite() || strike <= 0.0 {
                return Err("strike must be finite and greater than zero".to_string());
            }
            let right = match right.to_ascii_uppercase().as_str() {
                "P" => Right::Put,
                "C" => Right::Call,
                _ => return Err("right must be P or C".to_string()),
            };
            Some(OptionContract {
                underlying: symbol.clone(),
                expiry: store::parse_date(expiry).map_err(|error| error.to_string())?,
                strike,
                right,
                multiplier: 100,
            })
        }
        _ => return Err("option contract needs expiry, strike and right together".to_string()),
    };
    let require_contract = || {
        contract
            .clone()
            .ok_or_else(|| "option events need expiry, strike and right".to_string())
    };

    let event = match req.kind.as_str() {
        "option_open_short" => Event::sell_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.price,
            req.fees,
        ),
        "option_close" => Event::close_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.price,
            req.fees,
        ),
        "option_expire" => {
            Event::expire_option(account_id, id, seq, at, require_contract()?, req.qty)
        }
        "option_assign" => Event::assign_option(
            account_id,
            id,
            seq,
            at,
            require_contract()?,
            req.qty,
            req.fees,
        ),
        "shares_buy" => Event::buy_shares(
            account_id, id, seq, at, &symbol, req.qty, req.price, req.fees,
        ),
        "shares_sell" => Event::sell_shares(
            account_id, id, seq, at, &symbol, req.qty, req.price, req.fees,
        ),
        "dividend" => Event::dividend(account_id, id, seq, at, &symbol, req.price, req.qty),
        "fee" => Event::fee(account_id, id, seq, at, &symbol, req.amount),
        "adjustment" => Event::adjustment(account_id, id, seq, at, &symbol, req.amount),
        other => return Err(format!("unknown event kind `{other}`")),
    };

    let event = event.note(req.note.clone().unwrap_or_default());
    store::validate_event(&event).map_err(|error| error.to_string())?;
    Ok(event)
}

fn next_event_id(seq: u64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("ev-{millis}-{seq}-{unique}")
}

#[tauri::command]
pub fn delete_event(state: State<'_, AppState>, event_id: String) -> Result<bool, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    store::delete_event(&conn, &event_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_price(
    state: State<'_, AppState>,
    symbol: String,
    date: String,
    close: f64,
) -> Result<(), String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    let date = store::parse_date(&date).map_err(|error| error.to_string())?;
    store::upsert_price(&conn, &symbol.trim().to_ascii_uppercase(), date, close)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_prices(state: State<'_, AppState>) -> Result<Vec<views::PriceView>, String> {
    let conn = state.conn();
    let prices = store::list_prices(&conn).map_err(|error| error.to_string())?;
    Ok(prices)
}

#[tauri::command]
pub async fn search_symbols(query: String) -> Result<Vec<views::SymbolMatch>, String> {
    crate::market::search(&query).await
}

#[tauri::command]
pub async fn fetch_quote(symbol: String) -> Result<views::MarketQuote, String> {
    crate::market::fetch(&symbol).await
}

#[tauri::command]
pub async fn refresh_quotes(
    state: State<'_, AppState>,
    symbols: Vec<String>,
) -> Result<views::RefreshQuotesView, String> {
    ensure_no_pending_restore(&state)?;
    if symbols.len() > crate::market::MAX_SYMBOLS {
        return Err("一次最多刷新 50 个标的".into());
    }
    let mut valid = Vec::new();
    let mut failed = Vec::new();
    for symbol in symbols {
        match crate::market::normalize_symbol(&symbol) {
            Ok(symbol) if !valid.contains(&symbol) => valid.push(symbol),
            Ok(_) => {}
            Err(error) => failed.push(views::QuoteFailure { symbol, error }),
        }
    }
    // All network I/O finishes before acquiring the SQLite mutex.
    let (quotes, errors) = match crate::market::fetch_batch(&valid).await {
        Ok(result) => result,
        Err(error) => {
            failed.extend(valid.into_iter().map(|symbol| views::QuoteFailure {
                symbol,
                error: error.clone(),
            }));
            return Ok(views::RefreshQuotesView {
                updated: Vec::new(),
                failed,
            });
        }
    };
    failed.extend(errors);
    // A restore may have been staged while the network request was in flight.
    ensure_no_pending_restore(&state)?;
    Ok(persist_quotes(&state.conn(), quotes, failed))
}

fn persist_quotes(
    conn: &rusqlite::Connection,
    quotes: Vec<views::MarketQuote>,
    mut failed: Vec<views::QuoteFailure>,
) -> views::RefreshQuotesView {
    let mut updated = Vec::new();
    for quote in quotes {
        match store::upsert_market_quote(conn, &quote) {
            Ok(price) => updated.push(price),
            Err(error) => failed.push(views::QuoteFailure {
                symbol: quote.symbol,
                error: error.to_string(),
            }),
        }
    }
    views::RefreshQuotesView { updated, failed }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildView {
    pub events: usize,
    pub campaigns: usize,
    pub entries: usize,
    pub issues: Vec<String>,
}

#[tauri::command]
pub fn rebuild(
    state: State<'_, AppState>,
    account_id: Option<String>,
) -> Result<RebuildView, String> {
    let account_id = account_or_default(account_id);
    let conn = state.conn();
    let derived = derive(&conn, &account_id)?;
    Ok(RebuildView {
        events: store::count_events(&conn, &account_id).map_err(|error| error.to_string())?,
        campaigns: derived.campaigns.len(),
        entries: derived.premium_entries.len(),
        issues: derived.check_invariants(),
    })
}

#[tauri::command]
pub fn backup_now(
    state: State<'_, AppState>,
    password: Option<String>,
) -> Result<String, String> {
    let directory = backups_dir(&state);
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    let conn = state.conn();
    let path = match password.filter(|value| !value.is_empty()) {
        Some(password) => {
            backup::create_encrypted(&conn, &directory, "wheel-", stamp, &password)
        }
        None => backup::create(&conn, &directory, "wheel-", stamp),
    }
    .map_err(|error| format!("{error:#}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_backups(state: State<'_, AppState>) -> Result<Vec<backup::BackupEntry>, String> {
    backup::list(&backups_dir(&state)).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn validate_backup(
    state: State<'_, AppState>,
    file_name: String,
    password: Option<String>,
) -> Result<backup::BackupValidation, String> {
    backup::validate_with_password(
        &backups_dir(&state),
        &file_name,
        password.as_deref().filter(|value| !value.is_empty()),
    )
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn stage_restore(
    state: State<'_, AppState>,
    file_name: String,
    password: Option<String>,
) -> Result<restore::PendingRestore, String> {
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    let conn = state.conn();
    restore::stage_with_password(
        &conn,
        &data_dir(&state),
        &file_name,
        stamp,
        password.as_deref().filter(|value| !value.is_empty()),
    )
    .map_err(|error| format!("{error:#}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportEvent {
    account_id: String,
    id: String,
    seq: u64,
    /// `YYYY-MM-DD`, same UTC date口径 as the SQLite rows.
    occurred_at: String,
    kind: String,
    symbol: String,
    expiry: Option<String>,
    strike: Option<f64>,
    right: Option<&'static str>,
    multiplier: Option<u32>,
    qty: u32,
    price: f64,
    fees: f64,
    amount: f64,
    note: String,
}

impl ExportEvent {
    fn from_event(event: Event) -> Self {
        let contract = event.contract;
        Self {
            account_id: event.account_id,
            id: event.id,
            seq: event.seq,
            occurred_at: store::format_date(event.occurred_at),
            kind: store::kind_to_str(event.kind).to_string(),
            symbol: event.symbol,
            expiry: contract
                .as_ref()
                .map(|contract| store::format_date(contract.expiry)),
            strike: contract.as_ref().map(|contract| contract.strike),
            right: contract.as_ref().map(|contract| match contract.right {
                Right::Put => "put",
                Right::Call => "call",
            }),
            multiplier: contract.as_ref().map(|contract| contract.multiplier),
            qty: event.qty,
            price: event.price,
            fees: event.fees,
            amount: event.amount,
            note: event.note,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerExport<'a> {
    format: &'a str,
    version: u32,
    app_version: &'a str,
    exported_at: String,
    accounts: Vec<AccountView>,
    settings: SettingsView,
    events: Vec<ExportEvent>,
    prices: Vec<views::PriceView>,
}

fn export_json_for(conn: &rusqlite::Connection) -> Result<String, String> {
    let accounts = store::list_accounts(conn).map_err(|error| error.to_string())?;
    // The accounts table is authoritative, but include any event-only account
    // ids as well so an export never silently drops rows.
    let mut account_ids: BTreeSet<String> = accounts.iter().map(|account| account.id.clone()).collect();
    {
        let mut statement = conn
            .prepare("SELECT DISTINCT account_id FROM events WHERE deleted_at IS NULL")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            account_ids.insert(row.map_err(|error| error.to_string())?);
        }
    }
    let mut events = Vec::new();
    for account_id in &account_ids {
        for event in store::list_events(conn, account_id).map_err(|error| error.to_string())? {
            events.push(ExportEvent::from_event(event));
        }
    }
    events.sort_by(|left, right| {
        left.occurred_at
            .cmp(&right.occurred_at)
            .then_with(|| left.account_id.cmp(&right.account_id))
            .then_with(|| left.seq.cmp(&right.seq))
    });
    let settings = store::get_settings(conn).map_err(|error| error.to_string())?;
    let document = LedgerExport {
        format: "wheel-export",
        version: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        exported_at: time::OffsetDateTime::now_utc().to_string(),
        accounts: accounts.into_iter().map(AccountView::from).collect(),
        settings: settings_view(conn, settings)?,
        events,
        prices: store::list_prices(conn).map_err(|error| error.to_string())?,
    };
    serde_json::to_string_pretty(&document).map_err(|error| error.to_string())
}

/// A portable, human-readable copy of every account's event log plus prices
/// and settings. Unlike a SQLite snapshot it is not a restorable backup.
#[tauri::command]
pub fn export_json(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.conn();
    export_json_for(&conn)
}

#[tauri::command]
pub fn restore_status(state: State<'_, AppState>) -> Result<restore::RestoreStatus, String> {
    restore::status(&data_dir(&state)).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> views::AppInfoView {
    views::AppInfoView {
        version: env!("CARGO_PKG_VERSION").to_string(),
        db_path: state.db_path.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub name: String,
    pub broker: Option<String>,
    pub currency: String,
    pub created_at: String,
}

impl From<store::AccountRecord> for AccountView {
    fn from(account: store::AccountRecord) -> Self {
        Self {
            id: account.id,
            name: account.name,
            broker: account.broker,
            currency: account.currency,
            created_at: account.created_at,
        }
    }
}

fn valid_account_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("账户名称不能为空。".to_string());
    }
    if name.chars().count() > 40 {
        return Err("账户名称不能超过 40 个字符。".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("账户名称不能包含换行或控制字符。".to_string());
    }
    Ok(name.to_string())
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<AccountView>, String> {
    let conn = state.conn();
    store::list_accounts(&conn)
        .map(|accounts| accounts.into_iter().map(AccountView::from).collect())
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub fn create_account(state: State<'_, AppState>, name: String) -> Result<AccountView, String> {
    ensure_no_pending_restore(&state)?;
    let name = valid_account_name(&name)?;
    let conn = state.conn();
    if store::account_name_taken(&conn, &name, None).map_err(|error| error.to_string())? {
        return Err("已存在同名账户，请换一个名称。".to_string());
    }
    let count = store::list_accounts(&conn)
        .map_err(|error| error.to_string())?
        .len();
    if count >= 50 {
        return Err("账户数量已达上限 50 个。".to_string());
    }
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    let mut id = format!("acct-{stamp}");
    let mut attempt = 0;
    while store::account_exists(&conn, &id).map_err(|error| error.to_string())? {
        attempt += 1;
        id = format!("acct-{stamp}-{attempt}");
    }
    let created_at = store::today().to_string();
    store::insert_account(&conn, &id, &name, &created_at)
        .map_err(|error| format!("{error:#}"))?;
    Ok(AccountView {
        id,
        name,
        broker: None,
        currency: "USD".to_string(),
        created_at,
    })
}

#[tauri::command]
pub fn rename_account(
    state: State<'_, AppState>,
    account_id: String,
    name: String,
) -> Result<AccountView, String> {
    ensure_no_pending_restore(&state)?;
    let name = valid_account_name(&name)?;
    let conn = state.conn();
    if !store::account_exists(&conn, &account_id).map_err(|error| error.to_string())? {
        return Err("账户不存在。".to_string());
    }
    if store::account_name_taken(&conn, &name, Some(&account_id))
        .map_err(|error| error.to_string())?
    {
        return Err("已存在同名账户，请换一个名称。".to_string());
    }
    if !store::rename_account(&conn, &account_id, &name).map_err(|error| error.to_string())? {
        return Err("账户不存在。".to_string());
    }
    let account = store::list_accounts(&conn)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "账户不存在。".to_string())?;
    Ok(account.into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewReq {
    pub text: String,
    #[serde(default)]
    pub delimiter: Option<crate::import::Delimiter>,
    #[serde(default)]
    pub mapping: Option<crate::import::ColumnMapping>,
    #[serde(default)]
    pub has_header: Option<bool>,
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitRow {
    pub row_number: u32,
    pub event: crate::import::CandidateEvent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitReq {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub allow_duplicates: bool,
    pub rows: Vec<ImportCommitRow>,
}

#[tauri::command]
pub fn import_preview(
    state: State<'_, AppState>,
    req: ImportPreviewReq,
) -> Result<crate::import::ImportPreview, String> {
    let conn = state.conn();
    preview_for(&conn, req)
}

fn preview_for(
    conn: &rusqlite::Connection,
    req: ImportPreviewReq,
) -> Result<crate::import::ImportPreview, String> {
    let delimiter = req
        .mapping
        .as_ref()
        .and_then(|mapping| mapping.delimiter)
        .or(req.delimiter);
    let has_header = req
        .mapping
        .as_ref()
        .and_then(|mapping| mapping.has_header)
        .or(req.has_header);
    let mut document = crate::import::parse_document(&req.text, delimiter, has_header)?;
    let columns = document.headers.len();
    let account = account_or_default(req.account_id.clone());
    let existing: BTreeSet<String> = store::list_events(conn, &account)
        .map_err(|error| error.to_string())?
        .iter()
        .map(crate::import::fingerprint_existing)
        .collect();

    let (mapping, source) = match req.mapping {
        Some(mapping) => {
            crate::import::validate_mapping(&mapping, columns)?;
            (mapping, "manual")
        }
        None => {
            let key = crate::import::mapping_key(&document.signature);
            let saved = store::get_setting_value(conn, &key)
                .map_err(|error| error.to_string())?
                .and_then(|json| {
                    serde_json::from_str::<crate::import::ColumnMapping>(&json).ok()
                })
                .filter(|mapping| crate::import::validate_mapping(mapping, columns).is_ok());
            match saved {
                Some(mapping) => (mapping, "saved"),
                None => {
                    let (mapping, warnings) = crate::import::auto_map(&document.headers);
                    document.warnings.extend(warnings);
                    document.warnings.push(format!(
                        "已自动识别 {} 个字段；请确认列映射后再导入。",
                        mapping.fields.len()
                    ));
                    (mapping, "detected")
                }
            }
        }
    };

    Ok(crate::import::build_preview(
        &document,
        mapping,
        source,
        &account,
        &existing,
    ))
}

#[tauri::command]
pub fn import_commit(
    state: State<'_, AppState>,
    req: ImportCommitReq,
) -> Result<crate::import::ImportSummary, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    commit_for(&conn, req)
}

fn commit_for(
    conn: &rusqlite::Connection,
    req: ImportCommitReq,
) -> Result<crate::import::ImportSummary, String> {
    if req.rows.is_empty() {
        return Err("至少选择一行再导入".to_string());
    }
    if req.rows.len() > crate::import::MAX_ROWS {
        return Err(format!("单次导入不能超过 {} 行", crate::import::MAX_ROWS));
    }
    let account = account_or_default(req.account_id);
    let origin = crate::import::sanitize_origin(req.origin.as_deref().unwrap_or("CSV"));
    let mut rows = req.rows;
    // Reports are often newest-first; sequence order must follow trade dates so
    // replay sees the same history a manual entry would.
    rows.sort_by(|left, right| {
        left.event
            .date
            .cmp(&right.event.date)
            .then(left.row_number.cmp(&right.row_number))
    });

    let existing: BTreeSet<String> = store::list_events(conn, &account)
        .map_err(|error| error.to_string())?
        .iter()
        .map(crate::import::fingerprint_existing)
        .collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut duplicates = 0usize;
    let mut requests = Vec::with_capacity(rows.len());

    for row in rows {
        let fingerprint = crate::import::fingerprint_candidate(&row.event, &account);
        if existing.contains(&fingerprint) || !seen.insert(fingerprint) {
            duplicates += 1;
            if !req.allow_duplicates {
                return Err(format!(
                    "第 {} 行与账本或本次导入中的记录重复；确认无误后请勾选允许重复导入。",
                    row.row_number
                ));
            }
        }
        let note = match row
            .event
            .note
            .as_deref()
            .map(str::trim)
            .filter(|note| !note.is_empty())
        {
            Some(note) => format!("导入:{origin} · {note}"),
            None => format!("导入:{origin}"),
        };
        requests.push(NewEventReq {
            account_id: Some(account.clone()),
            date: row.event.date,
            kind: row.event.kind,
            symbol: row.event.symbol,
            qty: row.event.qty,
            price: row.event.price,
            fees: row.event.fees,
            amount: row.event.amount,
            expiry: row.event.expiry,
            strike: row.event.strike,
            right: row.event.right,
            note: Some(note),
        });
    }

    let event_ids = append_requests(conn, requests)?;
    Ok(crate::import::ImportSummary {
        imported: event_ids.len(),
        event_ids,
        account_id: account,
        note_prefix: format!("导入:{origin}"),
        duplicate_count: duplicates,
    })
}

#[tauri::command]
pub fn import_save_mapping(
    state: State<'_, AppState>,
    signature: String,
    mapping: crate::import::ColumnMapping,
) -> Result<bool, String> {
    ensure_no_pending_restore(&state)?;
    let conn = state.conn();
    save_mapping_for(&conn, &signature, mapping)
}

fn save_mapping_for(
    conn: &rusqlite::Connection,
    signature: &str,
    mapping: crate::import::ColumnMapping,
) -> Result<bool, String> {
    if !crate::import::is_valid_signature(signature) {
        return Err("无效的表头签名".to_string());
    }
    let columns = mapping
        .fields
        .values()
        .max()
        .map(|index| index + 1)
        .unwrap_or(0);
    crate::import::validate_mapping(&mapping, columns)?;
    let json = serde_json::to_string(&mapping).map_err(|error| error.to_string())?;
    store::set_setting_value(conn, &crate::import::mapping_key(signature), &json)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportReq {
    pub text: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

/// Parse an email / pasted broker confirmation and return the same preview
/// shape as CSV import, so the wizard can reuse review and commit unchanged.
#[tauri::command]
pub fn text_import_preview(
    state: State<'_, AppState>,
    req: TextImportReq,
) -> Result<crate::import::ImportPreview, String> {
    let conn = state.conn();
    text_preview_for(&conn, req)
}

fn text_preview_for(
    conn: &rusqlite::Connection,
    req: TextImportReq,
) -> Result<crate::import::ImportPreview, String> {
    let extraction = crate::text_import::extract(&req.text, req.source.as_deref())?;
    extraction_preview_for(conn, extraction, req.account_id, "text")
}

fn extraction_preview_for(
    conn: &rusqlite::Connection,
    extraction: crate::text_import::Extraction,
    account_id: Option<String>,
    mapping_source: &str,
) -> Result<crate::import::ImportPreview, String> {
    let csv_req = ImportPreviewReq {
        text: extraction.csv.clone(),
        delimiter: Some(crate::import::Delimiter::Comma),
        mapping: Some(text_mapping()),
        has_header: Some(true),
        account_id,
    };
    let mut preview = preview_for(conn, csv_req)?;
    let mut warnings = extraction.warnings;
    warnings.insert(
        0,
        format!(
            "已从{}识别 {} 笔交易，请核对后导入。",
            extraction.template,
            extraction.trades.len()
        ),
    );
    warnings.extend(preview.warnings);
    preview.warnings = warnings;
    preview.mapping_source = mapping_source.to_string();
    Ok(preview)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionImportReq {
    pub data: String,
    pub mime: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

/// Send one screenshot to the configured OpenAI-compatible vision endpoint,
/// then reuse the same preview path as CSV and email imports. The SQLite lock
/// is released while the network request is in flight.
#[tauri::command]
pub async fn vision_import_preview(
    state: State<'_, AppState>,
    req: VisionImportReq,
) -> Result<crate::import::ImportPreview, String> {
    let config = {
        let conn = state.conn();
        vision_config(&conn)?
    };
    let extraction = crate::vision::extract(&config, &req.data, &req.mime).await?;
    let source = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .filter(|ch| !ch.is_control())
                .take(120)
                .collect::<String>()
        });
    let conn = state.conn();
    let mut preview =
        extraction_preview_for(&conn, extraction, req.account_id, "vision")?;
    if let Some(source) = source {
        preview.warnings.insert(1, format!("来源截图：{source}"));
    }
    Ok(preview)
}

fn text_mapping() -> crate::import::ColumnMapping {
    use crate::import::{ColumnMapping, DateFormat, Delimiter, Field};
    let fields = std::collections::BTreeMap::from([
        (Field::Date, 0),
        (Field::Kind, 1),
        (Field::Symbol, 2),
        (Field::Qty, 3),
        (Field::Price, 4),
        (Field::Fees, 5),
        (Field::Expiry, 6),
        (Field::Strike, 7),
        (Field::Right, 8),
        (Field::Note, 9),
    ]);
    ColumnMapping {
        fields,
        date_format: DateFormat::YearMonthDay,
        delimiter: Some(Delimiter::Comma),
        has_header: Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> NewEventReq {
        serde_json::from_value(serde_json::json!({
            "date": "2026-01-02", "kind": "option_open_short", "symbol": " aapl ",
            "qty": 1, "price": 2.0, "expiry": "2026-02-20", "strike": 150.0, "right": "P"
        }))
        .unwrap()
    }
    fn db() -> rusqlite::Connection {
        store::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn date() -> time::Date {
        store::parse_date("2026-01-02").unwrap()
    }

    #[test]
    fn account_names_are_trimmed_and_validated() {
        assert_eq!(valid_account_name("  长期账户 ").unwrap(), "长期账户");
        assert!(valid_account_name("   ").is_err());
        assert!(valid_account_name(&"x".repeat(41)).is_err());
        assert!(valid_account_name("line\nbreak").is_err());
        assert!(valid_account_name(&"账".repeat(41)).is_err());
    }

    #[test]
    fn monthly_income_buckets_realized_income_and_isolates_accounts() {
        let conn = db();
        let at = |value: &str| store::parse_date(value).unwrap();
        let contract = OptionContract::new("AAPL", at("2026-02-20"), 150.0, Right::Put);
        store::insert_events(
            &conn,
            &[
                Event::buy_shares("main", "buy", 1, at("2026-01-02"), "AAPL", 100, 150.0, 0.0),
                Event::sell_option("main", "sto", 2, at("2026-01-05"), contract.clone(), 1, 2.0, 1.0),
                Event::dividend("main", "div", 3, at("2026-01-10"), "AAPL", 1.0, 100),
                Event::fee("main", "fee", 4, at("2026-01-20"), "AAPL", 5.0),
                Event::close_option("main", "btc", 5, at("2026-02-20"), contract, 1, 0.5, 1.0),
                Event::adjustment("main", "adj", 6, at("2026-02-25"), "AAPL", 20.0),
                Event::buy_shares("other", "other-buy", 1, at("2026-03-01"), "MSFT", 10, 300.0, 0.0),
                Event::dividend("other", "other-div", 2, at("2026-03-10"), "MSFT", 2.0, 10),
            ],
        )
        .unwrap();

        let report = monthly_income_for(&conn, "main").unwrap();
        assert_eq!(
            report.months.iter().map(|month| month.month.as_str()).collect::<Vec<_>>(),
            vec!["2026-01", "2026-02"]
        );
        let january = &report.months[0];
        assert_eq!(january.premium, 0.0);
        assert_eq!(january.dividends, 100.0);
        assert_eq!(january.fees, 5.0);
        assert_eq!(january.adjustments, 0.0);
        assert_eq!(january.total, 95.0);
        assert_eq!(january.cumulative, 95.0);
        assert_eq!(january.closed_entries, 0);
        let february = &report.months[1];
        assert_eq!(february.premium, 148.0);
        assert_eq!(february.adjustments, 20.0);
        assert_eq!(february.total, 168.0);
        assert_eq!(february.cumulative, 263.0);
        assert_eq!(february.closed_entries, 1);
        assert_eq!(report.total.total, 263.0);
        assert_eq!(report.total.closed_entries, 1);
        assert_eq!(report.total.month_count, 2);

        let other = monthly_income_for(&conn, "other").unwrap();
        assert_eq!(other.months.len(), 1);
        assert_eq!(other.months[0].month, "2026-03");
        assert_eq!(other.months[0].dividends, 20.0);

        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(wire["months"][1]["closedEntries"], 1);
        assert_eq!(wire["months"][1]["cumulative"], 263.0);
        assert_eq!(wire["total"]["monthCount"], 2);
    }

    #[test]
    fn json_export_contains_every_account_event_prices_and_settings() {
        let conn = db();
        store::ensure_account(&conn, "main", "Test").unwrap();
        let at = |value: &str| store::parse_date(value).unwrap();
        let contract = OptionContract::new("AAPL", at("2026-02-20"), 150.0, Right::Put);
        store::insert_events(
            &conn,
            &[
                Event::sell_option("main", "sto", 1, at("2026-01-05"), contract, 1, 2.0, 1.0),
                Event::buy_shares(
                    "other",
                    "orphan-buy",
                    1,
                    at("2026-01-10"),
                    "MSFT",
                    10,
                    300.0,
                    0.0,
                ),
            ],
        )
        .unwrap();
        store::upsert_price(&conn, "AAPL", at("2026-01-02"), 150.0).unwrap();

        let document: serde_json::Value =
            serde_json::from_str(&export_json_for(&conn).unwrap()).unwrap();
        assert_eq!(document["format"], "wheel-export");
        assert_eq!(document["version"], 1);
        assert_eq!(document["accounts"].as_array().unwrap().len(), 1);
        let events = document["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["accountId"], "main");
        assert_eq!(events[0]["occurredAt"], "2026-01-05");
        assert_eq!(events[0]["kind"], "option_open_short");
        assert_eq!(events[0]["expiry"], "2026-02-20");
        assert_eq!(events[0]["right"], "put");
        assert_eq!(events[0]["strike"], 150.0);
        assert_eq!(events[1]["accountId"], "other");
        assert_eq!(events[1]["kind"], "shares_buy");
        assert_eq!(events[1]["qty"], 10);
        assert_eq!(document["prices"][0]["symbol"], "AAPL");
        assert!(document["settings"]["includeDividendsInCost"].is_boolean());
        assert!(document["settings"]["autoBackupKeep"].is_number());
    }

    #[test]
    fn pending_restore_blocks_every_write_path_guard() {
        let data_dir = std::env::temp_dir().join(format!(
            "wheel-commands-pending-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(crate::restore::restore_dir(&data_dir)).unwrap();
        let state = AppState {
            conn: std::sync::Mutex::new(db()),
            db_path: data_dir.join("wheel.db").to_string_lossy().into_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
        };
        assert!(ensure_no_pending_restore(&state).is_ok());
        std::fs::write(
            crate::restore::restore_dir(&data_dir).join("pending.json"),
            br#"{"version":1,"backupFile":"a.sqlite","safetyFile":"pre-restore-1.sqlite","requestedAt":"2026-01-02 00:00:00"}"#,
        )
        .unwrap();
        let error = ensure_no_pending_restore(&state).unwrap_err();
        assert!(error.contains("已安排恢复"), "unexpected error: {error}");
        assert!(error.contains("重启应用"), "unexpected error: {error}");
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn first_record_saves_and_sequences_survive_undo_and_new_accounts() {
        let conn = db();
        let ids = append_requests(&conn, vec![request()]).unwrap();
        assert_eq!(store::list_events(&conn, "main").unwrap()[0].seq, 1);
        assert!(store::delete_event(&conn, &ids[0]).unwrap());
        append_requests(&conn, vec![request()]).unwrap();
        assert_eq!(store::list_events(&conn, "main").unwrap()[0].seq, 2);
        let mut other = request();
        other.account_id = Some("other".into());
        append_requests(&conn, vec![other]).unwrap();
        assert_eq!(store::list_events(&conn, "other").unwrap()[0].seq, 1);
    }

    #[test]
    fn first_batch_assigns_consecutive_sequences_in_empty_ledger() {
        let conn = db();
        let ids = append_requests(&conn, vec![request(), request()]).unwrap();
        assert_eq!(ids.len(), 2);
        let events = store::list_events(&conn, "main").unwrap();
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(store::next_seq(&conn, "main").unwrap(), 3);
    }

    #[test]
    fn refresh_persists_good_quotes_and_reports_bad_rows_individually() {
        let conn = db();
        let quote = |symbol: &str, price| views::MarketQuote {
            symbol: symbol.into(),
            name: "Example".into(),
            price,
            previous_close: None,
            change_percent: None,
            quoted_at: "2026-01-02 16:00:00".into(),
            source: crate::market::SOURCE.into(),
            currency: "USD".into(),
        };
        let response = persist_quotes(
            &conn,
            vec![quote("AAPL", 155.0), quote("MSFT", 0.0)],
            vec![views::QuoteFailure {
                symbol: "MISSING".into(),
                error: "missing quote".into(),
            }],
        );
        assert_eq!(response.updated.len(), 1);
        assert_eq!(response.failed.len(), 2);
        assert_eq!(store::latest_prices(&conn).unwrap()["AAPL"], 155.0);
        assert!(!store::latest_prices(&conn).unwrap().contains_key("MSFT"));
        let wire = serde_json::to_value(response).unwrap();
        assert_eq!(wire["updated"][0]["quotedAt"], "2026-01-02 16:00:00");
        assert_eq!(wire["updated"][0]["source"], "腾讯财经");
        assert_eq!(wire["failed"][1]["symbol"], "MSFT");
        let wire = serde_json::to_value(quote("AAPL", 155.0)).unwrap();
        assert_eq!(wire["previousClose"], serde_json::Value::Null);
        assert_eq!(wire["changePercent"], serde_json::Value::Null);
    }

    #[test]
    fn settings_replay_changes_cost_tracks_and_chart_but_preserves_a() {
        let conn = db();
        store::insert_events(
            &conn,
            &[
                Event::buy_shares("main", "buy", 1, date(), "AAPL", 100, 150.0, 0.0),
                Event::dividend("main", "dividend", 2, date(), "AAPL", 2.0, 100),
            ],
        )
        .unwrap();
        let before = campaign_detail_for(&conn, "main", "main#c0").unwrap().campaign;
        assert_eq!(before.cost_a, Some(150.0));
        assert_eq!(before.cost_b, Some(150.0));
        assert_eq!(before.cost_c, Some(150.0));
        store::set_settings(&conn, true).unwrap();
        let after = campaign_detail_for(&conn, "main", "main#c0").unwrap().campaign;
        assert_eq!(after.cost_a, before.cost_a);
        assert_eq!(after.cost_b, Some(148.0));
        assert_eq!(after.cost_c, Some(148.0));
        assert_eq!(after.cost_points[0].cost_a, before.cost_points[0].cost_a);
        assert_eq!(after.cost_points[0].cost_b, 148.0);
        assert_eq!(after.cost_points[0].cost_c, 148.0);
        assert!(
            derive(&conn, "main")
                .unwrap()
                .settings
                .include_dividends_in_cost
        );
        for invalid in [
            serde_json::json!("true"),
            serde_json::json!(1),
            serde_json::Value::Null,
        ] {
            assert!(serde_json::from_value::<SettingsView>(serde_json::json!({
                "includeDividendsInCost": invalid
            }))
            .is_err());
        }
        assert_eq!(
            serde_json::to_value(SettingsView {
                include_dividends_in_cost: true,
                reminder_lead_days: 7,
                auto_backup_enabled: true,
                auto_backup_keep: 7
            })
            .unwrap(),
            serde_json::json!({
                "includeDividendsInCost": true,
                "reminderLeadDays": 7,
                "autoBackupEnabled": true,
                "autoBackupKeep": 7
            })
        );
    }

    #[test]
    fn timeline_uses_event_ownership_at_same_day_campaign_boundary() {
        let conn = db();
        let events = vec![
            Event::buy_shares("main", "buy-old", 1, date(), "AAPL", 100, 100.0, 0.0),
            Event::dividend("main", "div-old", 2, date(), "AAPL", 1.0, 100),
            Event::fee("main", "fee-old", 3, date(), "AAPL", 2.0),
            Event::adjustment("main", "adjust-old", 4, date(), "AAPL", 3.0),
            Event::sell_shares("main", "close-old", 5, date(), "AAPL", 100, 110.0, 0.0),
            Event::buy_shares("main", "buy-new", 6, date(), "AAPL", 100, 120.0, 0.0),
            Event::dividend("main", "div-new", 7, date(), "AAPL", 1.0, 100),
            Event::fee("main", "fee-new", 8, date(), "AAPL", 2.0),
            Event::adjustment("main", "adjust-new", 9, date(), "AAPL", -3.0),
        ];
        store::insert_events(&conn, &events).unwrap();
        let old = campaign_detail_for(&conn, "main", "main#c0").unwrap();
        let new = campaign_detail_for(&conn, "main", "main#c1").unwrap();
        assert_eq!(
            old.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["buy-old", "div-old", "fee-old", "adjust-old", "close-old"]
        );
        assert_eq!(
            new.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["buy-new", "div-new", "fee-new", "adjust-new"]
        );
        let wire = serde_json::to_value(old).unwrap();
        assert_eq!(wire["events"][4]["seq"], 5);
        assert_eq!(wire["callScenarios"], serde_json::json!([]));
    }

    #[test]
    fn call_projections_match_committed_assignment_and_do_not_write() {
        for partial in [false, true] {
            let conn = db();
            let shares = if partial { 300 } else { 100 };
            let expiry = store::parse_date("2026-02-20").unwrap();
            let prior = OptionContract::new("AAPL", expiry, 80.0, Right::Put);
            let mut call = OptionContract::new("AAPL", expiry, 110.0, Right::Call);
            call.multiplier = 50;
            let other = OptionContract::new("AAPL", expiry, 120.0, Right::Call);
            let mut events = vec![
                Event::sell_option("main", "prior-open", 1, date(), prior.clone(), 1, 2.0, 1.0),
                Event::expire_option("main", "prior-expire", 2, date(), prior, 1),
                Event::buy_shares("main", "buy", 3, date(), "AAPL", shares + 20, 100.0, 2.0),
                Event::sell_shares("main", "prior-sale", 4, date(), "AAPL", 20, 120.0, 1.0),
                Event::dividend("main", "div", 5, date(), "AAPL", 0.5, shares),
                Event::fee("main", "fee", 6, date(), "AAPL", 3.0),
                Event::sell_option("main", "call", 7, date(), call.clone(), 2, 2.0, 1.0),
            ];
            if partial {
                events.push(Event::sell_option(
                    "main",
                    "other",
                    8,
                    date(),
                    other.clone(),
                    1,
                    3.0,
                    2.0,
                ));
            }
            // Exercise both a future expiry and historical activity after expiry.
            let last_date =
                store::parse_date(if partial { "2026-03-01" } else { "2026-01-03" }).unwrap();
            let assignment_at = last_date.max(expiry);
            events.push(Event::adjustment(
                "main", "adjust", 9, last_date, "AAPL", 7.0,
            ));
            store::insert_events(&conn, &events).unwrap();
            store::set_settings(&conn, true).unwrap();
            let before = store::list_events(&conn, "main").unwrap();
            let changes = conn.total_changes();
            let next_seq = store::next_seq(&conn, "main").unwrap();
            let detail = campaign_detail_for(&conn, "main", "main#c0").unwrap();
            assert_eq!(detail.call_scenarios.len(), if partial { 2 } else { 1 });
            assert_eq!(conn.total_changes(), changes);
            assert_eq!(store::next_seq(&conn, "main").unwrap(), next_seq);
            assert_eq!(store::list_events(&conn, "main").unwrap(), before);
            for scenario in &detail.call_scenarios {
                let contract = if scenario.contract == call.display() {
                    call.clone()
                } else {
                    other.clone()
                };
                let mut committed = before.clone();
                committed.push(Event::assign_option(
                    "main",
                    "real-assignment",
                    next_seq,
                    assignment_at,
                    contract.clone(),
                    scenario.qty,
                    0.0,
                ));
                // Commit each scenario independently in a copy of the original database.
                let actual_db = db();
                store::insert_events(&actual_db, &committed).unwrap();
                store::set_settings(&actual_db, true).unwrap();
                let actual = derive(&actual_db, "main").unwrap();
                let campaign = actual.campaign("main#c0").unwrap();
                assert_eq!(scenario.shares_sold, scenario.qty * contract.multiplier);
                assert_eq!(
                    scenario.sale_proceeds,
                    contract.strike * f64::from(scenario.shares_sold)
                );
                assert_eq!(scenario.assignment_fees, 0.0);
                assert_eq!(scenario.share_pnl, campaign.share_pnl);
                assert_eq!(scenario.premium_realized, campaign.premium_realized);
                assert_eq!(scenario.dividends, campaign.dividends);
                assert_eq!(scenario.adjustments, campaign.adjustments);
                assert_eq!(
                    scenario.realized_total,
                    campaign.share_pnl
                        + campaign.premium_realized
                        + campaign.dividends
                        + campaign.adjustments
                );
                assert_eq!(scenario.remaining_shares, campaign.shares);
                assert_eq!(
                    scenario.remaining_contracts,
                    actual
                        .positions_for("main#c0")
                        .iter()
                        .map(|p| p.open_qty)
                        .sum::<u32>()
                );
                assert_eq!(scenario.closes_campaign, !campaign.is_active());
                assert_eq!(scenario.closes_campaign, !partial);
                assert_eq!(scenario.adjustments, 4.0);
                if !partial {
                    assert_eq!(scenario.premium_realized, 398.0);
                    assert_eq!(Some(scenario.realized_total), campaign.realized_pnl);
                    assert_eq!(campaign.ended_at, Some(assignment_at));
                } else {
                    assert!(campaign.premium_open > 0.0);
                    assert_ne!(scenario.realized_total, campaign.cash_flow);
                }
                let wire = serde_json::to_value(scenario).unwrap();
                assert!(wire.get("sharesSold").is_some());
                assert!(wire.get("realizedTotal").is_some());
            }
        }
    }

    #[test]
    fn invalid_assignment_fails_detail_without_writes_or_partial_scenarios() {
        let conn = db();
        let expiry = store::parse_date("2026-02-20").unwrap();
        store::insert_events(
            &conn,
            &[
                Event::buy_shares("main", "buy", 1, date(), "AAPL", 100, 100.0, 0.0),
                Event::sell_option(
                    "main",
                    "covered",
                    2,
                    date(),
                    OptionContract::new("AAPL", expiry, 110.0, Right::Call),
                    1,
                    2.0,
                    0.0,
                ),
                Event::sell_option(
                    "main",
                    "uncovered",
                    3,
                    date(),
                    OptionContract::new("AAPL", expiry, 120.0, Right::Call),
                    2,
                    2.0,
                    0.0,
                ),
            ],
        )
        .unwrap();
        let changes = conn.total_changes();
        assert!(campaign_detail_for(&conn, "main", "main#c0")
            .err()
            .unwrap()
            .contains("only 100 held"));
        assert_eq!(conn.total_changes(), changes);
        assert_eq!(store::count_events(&conn, "main").unwrap(), 3);
    }

    #[test]
    fn request_rejects_invalid_right_and_numeric_fields() {
        let mut req = request();
        req.right = Some("anything".into());
        assert!(build_event(&req, "main", "id", 1).is_err());
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.0] {
            let mut req = request();
            req.strike = Some(value);
            assert!(build_event(&req, "main", "id", 1).is_err());
        }
        for value in [f64::NAN, f64::INFINITY, -1.0] {
            let mut req = request();
            req.price = value;
            assert!(build_event(&req, "main", "id", 1).is_err());
            let mut req = request();
            req.fees = value;
            assert!(build_event(&req, "main", "id", 1).is_err());
        }
        let mut req = request();
        req.amount = f64::NAN;
        assert!(build_event(&req, "main", "id", 1).is_err());
        let mut req = request();
        req.qty = 0;
        assert!(build_event(&req, "main", "id", 1).is_err());
        let mut req = request();
        req.expiry = None;
        assert!(build_event(&req, "main", "id", 1).is_err());
    }
    #[test]
    fn fee_and_adjustment_do_not_require_quantity() {
        for kind in ["fee", "adjustment"] {
            let mut req = request();
            req.kind = kind.into();
            req.qty = 0;
            req.amount = 10.0;
            req.expiry = None;
            req.strike = None;
            req.right = None;
            assert!(build_event(&req, "main", "id", 1).is_ok());
        }
    }
    #[test]
    fn event_view_serializes_frontend_camel_case_fields() {
        let event = build_event(&request(), "main", "id", 1).unwrap();
        let value = serde_json::to_value(event_view(event)).unwrap();
        assert_eq!(value["accountId"], "main");
        assert_eq!(value["symbol"], "AAPL");
        assert_eq!(value["kind"], "option_open_short");
        assert_eq!(value["date"], "2026-01-02");
        assert_eq!(value["right"], "P");
        assert_eq!(value["strike"], 150.0);
        assert!(value.get("account_id").is_none());
    }

    fn import_request(text: &str) -> ImportPreviewReq {
        serde_json::from_value(serde_json::json!({
            "text": text,
            "fileName": "broker.csv"
        }))
        .unwrap()
    }

    fn commit_rows(preview: &crate::import::ImportPreview) -> Vec<ImportCommitRow> {
        preview
            .rows
            .iter()
            .filter_map(|row| {
                row.event
                    .clone()
                    .map(|event| ImportCommitRow {
                        row_number: row.row_number,
                        event,
                    })
            })
            .collect()
    }

    fn commit_request(rows: Vec<ImportCommitRow>, allow_duplicates: bool) -> ImportCommitReq {
        ImportCommitReq {
            account_id: None,
            origin: Some("broker.csv".to_string()),
            allow_duplicates,
            rows,
        }
    }

    #[test]
    fn import_preview_is_read_only_and_serializes_camel_case() {
        let conn = db();
        let before = store::next_seq(&conn, "main").unwrap();
        let preview = preview_for(
            &conn,
            import_request(
                "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                 2026-01-02,卖出开仓,AAPL,1,2.00,1.00,2026-02-20,150,P\n",
            ),
        )
        .unwrap();
        assert_eq!(preview.counts.total, 1);
        assert_eq!(preview.counts.selected, 1);
        assert_eq!(
            preview.rows[0].event.as_ref().unwrap().kind,
            "option_open_short"
        );
        assert_eq!(preview.mapping_source, "detected");
        assert!(store::list_events(&conn, "main").unwrap().is_empty());
        assert_eq!(store::next_seq(&conn, "main").unwrap(), before);

        let value = serde_json::to_value(&preview).unwrap();
        assert!(value["rows"][0].get("rowNumber").is_some());
        assert!(value["rows"][0].get("row_number").is_none());
        assert!(value.get("mappingSource").is_some());
    }

    #[test]
    fn import_preview_reuses_saved_mapping_for_same_header_signature() {
        let conn = db();
        let text = "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                    2026-01-02,卖出开仓,AAPL,1,2.00,1.00,2026-02-20,150,P\n";
        let first = preview_for(&conn, import_request(text)).unwrap();
        assert_eq!(first.mapping_source, "detected");
        save_mapping_for(&conn, &first.signature, first.mapping.clone()).unwrap();
        let second = preview_for(&conn, import_request(text)).unwrap();
        assert_eq!(second.mapping_source, "saved");
        assert_eq!(second.mapping, first.mapping);
    }

    #[test]
    fn import_commit_prefixes_origin_and_writes_all_rows() {
        let conn = db();
        let preview = preview_for(
            &conn,
            import_request(
                "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                 2026-01-02,Sell to Open,AAPL,1,2.00,1.00,2026-02-20,150,P\n\
                 2026-01-03,Sell to Open,MSFT,1,3.00,1.00,2026-02-20,400,P\n",
            ),
        )
        .unwrap();
        let summary = commit_for(&conn, commit_request(commit_rows(&preview), false)).unwrap();
        assert_eq!(summary.imported, 2);
        assert_eq!(summary.duplicate_count, 0);
        let events = store::list_events(&conn, "main").unwrap();
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|event| event.note.starts_with("导入:broker.csv")));
    }

    #[test]
    fn text_import_preview_maps_email_trades_and_flags_duplicates() {
        let conn = db();
        let text = "\
Trade Date: 2026-01-02
SOLD TO OPEN 1 AAPL 2026-02-20 150 P @ 2.00
Fees: 1.00
";
        let preview = text_preview_for(
            &conn,
            TextImportReq {
                text: text.to_string(),
                source: Some("schwab.eml".to_string()),
                account_id: None,
            },
        )
        .unwrap();
        assert_eq!(preview.rows.len(), 1);
        let event = preview.rows[0].event.as_ref().unwrap();
        assert_eq!(event.kind, "option_open_short");
        assert_eq!(event.symbol, "AAPL");
        assert_eq!(event.qty, 1);
        assert_eq!(event.price, 2.0);
        assert_eq!(event.fees, 1.0);
        assert_eq!(event.expiry.as_deref(), Some("2026-02-20"));
        assert_eq!(event.strike, Some(150.0));
        assert!(preview.warnings[0].contains("Schwab"));
        assert_eq!(preview.mapping_source, "text");

        commit_for(&conn, commit_request(commit_rows(&preview), false)).unwrap();
        let again = text_preview_for(
            &conn,
            TextImportReq {
                text: text.to_string(),
                source: Some("schwab.eml".to_string()),
                account_id: None,
            },
        )
        .unwrap();
        assert_eq!(again.counts.duplicate, 1);
    }

    #[test]
    fn import_commit_sorts_dates_before_allocating_sequences() {
        let conn = db();
        let preview = preview_for(
            &conn,
            import_request(
                "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                 2026-01-05,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n\
                 2026-01-02,Sell to Open,MSFT,1,3.00,0,2026-02-20,400,P\n",
            ),
        )
        .unwrap();
        commit_for(&conn, commit_request(commit_rows(&preview), false)).unwrap();
        let events = store::list_events(&conn, "main").unwrap();
        assert_eq!(events[0].symbol, "MSFT");
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].symbol, "AAPL");
        assert_eq!(events[1].seq, 2);
    }

    #[test]
    fn import_commit_rolls_back_the_whole_batch_when_a_row_cannot_replay() {
        let conn = db();
        let preview = preview_for(
            &conn,
            import_request(
                "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                 2026-01-02,Buy to Close,AAPL,1,1.00,0,2026-02-20,150,P\n\
                 2026-01-03,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n",
            ),
        )
        .unwrap();
        assert_eq!(preview.counts.error, 0);
        let result = commit_for(&conn, commit_request(commit_rows(&preview), false));
        assert!(result.is_err());
        assert!(store::list_events(&conn, "main").unwrap().is_empty());
        assert_eq!(store::next_seq(&conn, "main").unwrap(), 1);
    }

    #[test]
    fn import_commit_blocks_duplicates_unless_explicitly_allowed() {
        let conn = db();
        let preview = preview_for(
            &conn,
            import_request(
                "日期,方向,代码,数量,价格,费用,到期日,行权价,看涨看跌\n\
                 2026-01-02,Sell to Open,AAPL,1,2.00,0,2026-02-20,150,P\n",
            ),
        )
        .unwrap();
        commit_for(&conn, commit_request(commit_rows(&preview), false)).unwrap();
        let repeat = commit_for(&conn, commit_request(commit_rows(&preview), false));
        assert!(repeat.unwrap_err().contains("重复"));
        assert_eq!(store::list_events(&conn, "main").unwrap().len(), 1);

        let allowed = commit_for(&conn, commit_request(commit_rows(&preview), true)).unwrap();
        assert_eq!(allowed.imported, 1);
        assert_eq!(allowed.duplicate_count, 1);
        assert_eq!(store::list_events(&conn, "main").unwrap().len(), 2);
    }

    #[test]
    fn import_save_mapping_rejects_bad_signature_and_empty_required_fields() {
        let conn = db();
        let mut mapping = crate::import::ColumnMapping::default();
        mapping.fields.insert(crate::import::Field::Date, 0);
        assert!(save_mapping_for(&conn, "nope", mapping.clone()).is_err());
        assert!(save_mapping_for(&conn, "0123456789abcdef", mapping.clone()).is_err());
        mapping.fields.insert(crate::import::Field::Symbol, 1);
        mapping.fields.insert(crate::import::Field::Action, 2);
        assert!(save_mapping_for(&conn, "0123456789abcdef", mapping).unwrap());
        assert!(store::get_setting_value(
            &conn,
            &crate::import::mapping_key("0123456789abcdef")
        )
        .unwrap()
        .is_some());
    }

    fn vision_settings(api_key: Option<&str>, enabled: bool, consent: bool) -> VisionSettingsReq {
        VisionSettingsReq {
            base_url: "https://api.openai.com/v1/".into(),
            model: "gpt-4o".into(),
            api_key: api_key.map(str::to_string),
            enabled,
            consent,
        }
    }

    #[test]
    fn vision_settings_mask_the_key_and_require_consent_to_enable() {
        let conn = db();
        let saved = set_vision_for(&conn, vision_settings(Some("sk-test-1234"), false, false))
            .unwrap();
        assert_eq!(saved.base_url, "https://api.openai.com/v1");
        assert!(saved.has_key);
        assert_eq!(saved.key_hint, "1234");
        assert!(!saved.enabled);

        let error = set_vision_for(&conn, vision_settings(None, true, false)).unwrap_err();
        assert!(error.contains("隐私说明"), "{error}");
        assert!(vision_config(&conn).is_err());

        let enabled = set_vision_for(&conn, vision_settings(None, true, true)).unwrap();
        assert!(enabled.enabled && enabled.consent);
        let config = vision_config(&conn).unwrap();
        assert_eq!(config.api_key, "sk-test-1234");
        assert_eq!(config.model, "gpt-4o");

        let cleared = set_vision_for(&conn, vision_settings(Some(""), false, true)).unwrap();
        assert!(!cleared.has_key);
        assert!(cleared.key_hint.is_empty());
        assert!(vision_config(&conn).is_err());
    }

    #[test]
    fn vision_settings_reject_invalid_values_and_enable_without_a_key() {
        let conn = db();
        for req in [
            VisionSettingsReq {
                base_url: "http://api.openai.com/v1".into(),
                ..vision_settings(None, false, false)
            },
            VisionSettingsReq {
                model: " ".into(),
                ..vision_settings(None, false, false)
            },
            VisionSettingsReq {
                api_key: Some("short".into()),
                ..vision_settings(None, false, false)
            },
        ] {
            assert!(set_vision_for(&conn, req).is_err());
        }
        let error = set_vision_for(&conn, vision_settings(None, true, true)).unwrap_err();
        assert!(error.contains("API Key"), "{error}");
    }

    #[test]
    fn vision_extraction_reuses_the_preview_pipeline() {
        let conn = db();
        let extraction = crate::vision::to_extraction(
            vec![serde_json::json!({
                "date": "2026-01-02",
                "kind": "option_open_short",
                "symbol": "AAPL",
                "qty": 1,
                "price": 2.0,
                "fees": 1.0,
                "expiry": "2026-02-20",
                "strike": 150,
                "right": "P"
            })],
            Vec::new(),
            "gpt-4o",
        )
        .unwrap();
        let preview = extraction_preview_for(&conn, extraction, None, "vision").unwrap();
        assert_eq!(preview.mapping_source, "vision");
        assert_eq!(preview.rows.len(), 1);
        assert!(preview.warnings[0].contains("云端视觉（gpt-4o）"));
        assert_eq!(preview.rows[0].event.as_ref().unwrap().note.as_deref(), Some("云端视觉 · gpt-4o"));
    }
}
