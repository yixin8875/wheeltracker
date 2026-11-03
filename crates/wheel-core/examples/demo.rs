//! Replays the DESIGN.md section 3.3 walkthrough and prints the cost ladder.
//!
//!     cargo run -p wheel-core --example demo --offline

use time::macros::date;
use time::Date;
use wheel_core::{replay, CampaignStatus, Event, OptionContract, Right, Settings};

const ACCOUNT: &str = "demo";

fn put(expiry: Date, strike: f64) -> OptionContract {
    OptionContract::new("AAPL", expiry, strike, Right::Put)
}

fn call(expiry: Date, strike: f64) -> OptionContract {
    OptionContract::new("AAPL", expiry, strike, Right::Call)
}

fn money(value: Option<f64>) -> String {
    match value {
        Some(v) => format!("{v:>9.2}"),
        None => format!("{:>9}", "-"),
    }
}

fn main() {
    let p200 = put(date!(2026 - 02 - 20), 200.0);
    let p195 = put(date!(2026 - 03 - 20), 195.0);
    let c200 = call(date!(2026 - 04 - 17), 200.0);
    let c205 = call(date!(2026 - 06 - 19), 205.0);

    let events = vec![
        Event::sell_option(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), p200.clone(), 1, 5.0, 1.5)
            .note("卖 Put 200P @5.00"),
        Event::expire_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p200, 1)
            .note("200P 到期作废"),
        Event::sell_option(ACCOUNT, "e3", 3, date!(2026 - 02 - 25), p195.clone(), 1, 6.0, 1.5)
            .note("卖 Put 195P @6.00"),
        Event::assign_option(ACCOUNT, "e4", 4, date!(2026 - 03 - 20), p195, 1, 0.0)
            .note("195P 被指派，买入 100 股"),
        Event::sell_option(ACCOUNT, "e5", 5, date!(2026 - 03 - 25), c200.clone(), 1, 4.0, 1.5)
            .note("卖 Call 200C @4.00"),
        Event::expire_option(ACCOUNT, "e6", 6, date!(2026 - 04 - 17), c200, 1)
            .note("200C 到期作废"),
        Event::sell_option(ACCOUNT, "e7", 7, date!(2026 - 05 - 15), c205.clone(), 1, 3.0, 1.5)
            .note("卖 Call 205C @3.00"),
        Event::assign_option(ACCOUNT, "e8", 8, date!(2026 - 06 - 19), c205, 1, 0.0)
            .note("205C 被行权，股票被 call 走"),
    ];

    println!(
        "{:>2}  {:<10}  {:<28}  {:>6}  {:>9}  {:>9}  {:>9}  {:>9}  {:>9}",
        "#", "date", "event", "shares", "cost A", "cost B", "cost C'", "realized", "open"
    );
    println!("{}", "-".repeat(116));

    for n in 1..=events.len() {
        let state = replay(ACCOUNT, &events[..n], Settings::default()).unwrap();
        let campaign = &state.campaigns[0];
        let event = &events[n - 1];
        println!(
            "{:>2}  {:<10}  {:<28}  {:>6}  {}  {}  {}  {:>9.2}  {:>9.2}",
            n,
            event.occurred_at.to_string(),
            event.note,
            campaign.shares,
            money(campaign.cost_a()),
            money(campaign.cost_b(false)),
            money(campaign.cost_c(false)),
            campaign.premium_realized,
            campaign.premium_open
        );
    }

    println!("{}", "-".repeat(116));

    let final_state = replay(ACCOUNT, &events, Settings::default()).unwrap();
    let campaign = &final_state.campaigns[0];
    println!("\nCampaign summary");
    println!("  status          : {}", campaign.status.as_str());
    println!("  started         : {}", campaign.started_at);
    println!("  ended           : {:?}", campaign.ended_at);
    println!("  cycles          : {}", campaign.cycles);
    println!("  share P&L       : {:>10.2}", campaign.share_pnl);
    println!("  premium realized: {:>10.2}", campaign.premium_realized);
    println!(
        "  campaign P&L    : {:>10.2}",
        campaign.realized_pnl.unwrap_or(0.0)
    );
    assert_eq!(campaign.status, CampaignStatus::Closed);

    println!("\nPremium ledger");
    println!(
        "  {:<8}  {:<24}  {:<8}  {:>8}  {:>10}  {:>8}  {:>9}",
        "status", "contract", "opened", "net", "collateral", "days", "ann."
    );
    for entry in final_state.entries_for(&campaign.id) {
        let days = entry
            .days_held()
            .map(|d| d.to_string())
            .unwrap_or_else(|| "-".to_string());
        let ann = entry
            .annualized_return()
            .map(|r| format!("{:.2}%", r * 100.0))
            .unwrap_or_else(|| "-".to_string());
        println!(
            "  {:<8}  {:<24}  {:<8}  {:>8.2}  {:>10.2}  {:>8}  {:>9}",
            entry.status.as_str(),
            entry.contract.display(),
            entry.opened_at.to_string(),
            entry.net_premium,
            entry.collateral,
            days,
            ann
        );
    }

    let issues = final_state.check_invariants();
    assert!(issues.is_empty(), "invariants: {issues:#?}");
    println!("\nAll invariants hold.");
}
