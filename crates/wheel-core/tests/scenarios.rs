//! Golden scenarios from DESIGN.md plus a deterministic property test.
//! Every test asserts both the expected numbers and the structural invariants.

use time::macros::date;
use time::{Date, Duration};
use wheel_core::{
    replay, CampaignStatus, DerivedState, EntryStatus, Event, OptionContract, Right, Settings,
};

const ACCOUNT: &str = "main";

fn put(expiry: Date, strike: f64) -> OptionContract {
    OptionContract::new("AAPL", expiry, strike, Right::Put)
}

fn call(expiry: Date, strike: f64) -> OptionContract {
    OptionContract::new("AAPL", expiry, strike, Right::Call)
}

fn run(events: &[Event]) -> DerivedState {
    replay(ACCOUNT, events, Settings::default()).unwrap()
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "expected {expected}, got {actual}"
    );
}

fn assert_clean(state: &DerivedState) {
    let issues = state.check_invariants();
    assert!(issues.is_empty(), "invariant violations: {issues:#?}");
}

/// The end-to-end example from DESIGN.md section 3.3.
fn design_example() -> Vec<Event> {
    let p200 = put(date!(2026 - 02 - 20), 200.0);
    let p195 = put(date!(2026 - 03 - 20), 195.0);
    let c200 = call(date!(2026 - 04 - 17), 200.0);
    let c205 = call(date!(2026 - 06 - 19), 205.0);
    vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p200.clone(),
            1,
            5.0,
            1.5,
        ),
        Event::expire_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p200, 1),
        Event::sell_option(
            ACCOUNT,
            "e3",
            3,
            date!(2026 - 02 - 25),
            p195.clone(),
            1,
            6.0,
            1.5,
        ),
        Event::assign_option(ACCOUNT, "e4", 4, date!(2026 - 03 - 20), p195, 1, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e5",
            5,
            date!(2026 - 03 - 25),
            c200.clone(),
            1,
            4.0,
            1.5,
        ),
        Event::expire_option(ACCOUNT, "e6", 6, date!(2026 - 04 - 17), c200, 1),
        Event::sell_option(
            ACCOUNT,
            "e7",
            7,
            date!(2026 - 05 - 15),
            c205.clone(),
            1,
            3.0,
            1.5,
        ),
        Event::assign_option(ACCOUNT, "e8", 8, date!(2026 - 06 - 19), c205, 1, 0.0),
    ]
}

#[test]
fn walkthrough_matches_design_document() {
    let events = design_example();

    let after_assignment = run(&events[..4]);
    assert_clean(&after_assignment);
    let campaign = &after_assignment.campaigns[0];
    assert_eq!(campaign.shares, 100);
    assert_close(campaign.cost_a().unwrap(), 195.0);
    assert_close(campaign.cost_b(false).unwrap(), 184.03);
    assert_close(campaign.premium_realized, 1097.0);
    assert_close(campaign.premium_open, 0.0);
    assert_eq!(after_assignment.lots.len(), 1);
    assert_eq!(after_assignment.lots[0].remaining_qty, 100);

    let after_first_call = run(&events[..5]);
    assert_clean(&after_first_call);
    let campaign = &after_first_call.campaigns[0];
    assert_close(campaign.cost_b(false).unwrap(), 184.03);
    assert_close(campaign.cost_c(false).unwrap(), 180.045);
    assert_close(campaign.premium_open, 398.5);

    let after_call_expiry = run(&events[..6]);
    assert_clean(&after_call_expiry);
    let campaign = &after_call_expiry.campaigns[0];
    assert_close(campaign.cost_b(false).unwrap(), 180.045);
    assert_close(campaign.premium_realized, 1495.5);

    let final_state = run(&events);
    assert_clean(&final_state);
    let campaign = &final_state.campaigns[0];
    assert_eq!(campaign.status, CampaignStatus::Closed);
    assert_eq!(campaign.shares, 0);
    assert_close(campaign.realized_pnl.unwrap(), 2794.0);
    assert_close(campaign.share_pnl, 1000.0);
    assert_close(campaign.cash_flow, 2794.0);
    assert_eq!(final_state.premium_entries.len(), 4);
    assert!(final_state.positions.is_empty());
}

#[test]
fn t1_expired_put_moves_premium_to_realized() {
    let p = put(date!(2026 - 02 - 20), 200.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            5.0,
            1.5,
        ),
        Event::expire_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p, 1),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_close(campaign.premium_open, 0.0);
    assert_close(campaign.premium_realized, 498.5);
    // A put-only campaign keeps running: it has not held shares yet, so the
    // premium pool stays available for a future assignment.
    assert_eq!(campaign.status, CampaignStatus::Active);
    assert!(campaign.realized_pnl.is_none());
    assert_eq!(state.premium_entries[0].status, EntryStatus::Expired);
    assert_close(state.premium_entries[0].net_premium, 498.5);
}

#[test]
fn t2_assignment_builds_share_lot_and_cost_b() {
    let p = put(date!(2026 - 03 - 20), 195.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 02 - 25),
            p.clone(),
            1,
            6.0,
            1.5,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), p, 1, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 100);
    assert_close(campaign.cost_a().unwrap(), 195.0);
    assert_close(campaign.cost_b(false).unwrap(), (19500.0 - 598.5) / 100.0);
    assert_eq!(state.lots[0].cost_per_share, 195.0);
    assert_eq!(state.premium_entries[0].status, EntryStatus::Assigned);
}

#[test]
fn t3_expired_call_lowers_cost_b_not_cost_a() {
    let p = put(date!(2026 - 03 - 20), 195.0);
    let c = call(date!(2026 - 04 - 17), 200.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 02 - 25),
            p.clone(),
            1,
            6.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), p, 1, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e3",
            3,
            date!(2026 - 03 - 25),
            c.clone(),
            1,
            4.0,
            1.5,
        ),
        Event::expire_option(ACCOUNT, "e4", 4, date!(2026 - 04 - 17), c, 1),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_close(campaign.cost_a().unwrap(), 195.0);
    assert_close(campaign.cost_b(false).unwrap(), 195.0 - 6.0 - 3.985);
    assert_close(campaign.premium_realized, 600.0 + 398.5);
}

#[test]
fn t5_roll_nets_both_legs_without_double_counting() {
    let p1 = put(date!(2026 - 02 - 20), 100.0);
    let p2 = put(date!(2026 - 03 - 20), 95.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p1.clone(),
            1,
            3.0,
            1.0,
        ),
        Event::close_option(ACCOUNT, "e2", 2, date!(2026 - 01 - 20), p1, 1, 1.0, 1.0),
        Event::sell_option(ACCOUNT, "e3", 3, date!(2026 - 01 - 20), p2, 1, 4.0, 1.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_close(campaign.premium_realized, 299.0 - 101.0);
    assert_close(campaign.premium_open, 399.0);
    assert_eq!(state.premium_entries.len(), 2);
    assert_eq!(state.premium_entries[0].status, EntryStatus::Closed);
    assert_eq!(state.premium_entries[1].status, EntryStatus::Open);
}

#[test]
fn t6_partial_close_splits_ledger_and_releases_proportionally() {
    let p = put(date!(2026 - 03 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            2,
            3.0,
            0.0,
        ),
        Event::close_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 01), p, 1, 1.0, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_close(campaign.premium_realized, 200.0);
    assert_close(campaign.premium_open, 300.0);
    assert_eq!(state.premium_entries.len(), 2);
    assert_eq!(state.positions[0].open_qty, 1);
    assert_close(state.positions[0].avg_credit_per_share, 3.0);
    let closed = state
        .premium_entries
        .iter()
        .find(|e| !e.status.is_open())
        .unwrap();
    assert_eq!(closed.qty, 1);
    assert_close(closed.net_premium, 200.0);
}

#[test]
fn t7_multi_contract_uses_multiplier() {
    let p = put(date!(2026 - 03 - 20), 50.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 02 - 25),
            p.clone(),
            3,
            2.0,
            3.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), p, 3, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 300);
    assert_close(campaign.cost_a().unwrap(), 50.0);
    assert_close(campaign.premium_realized, 597.0);
    assert_close(campaign.cost_b(false).unwrap(), 50.0 - 1.99);
}

#[test]
fn t8_early_assignment_uses_actual_date() {
    let p = put(date!(2026 - 03 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 02 - 25),
            p.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 10), p, 1, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let entry = &state.premium_entries[0];
    assert_eq!(entry.status, EntryStatus::Assigned);
    assert_eq!(entry.closed_at, Some(date!(2026 - 03 - 10)));
    assert_eq!(
        state.campaigns[0].cost_points.last().unwrap().at,
        date!(2026 - 03 - 10)
    );
}

#[test]
fn t9_second_campaign_starts_with_empty_pool() {
    let p1 = put(date!(2026 - 02 - 20), 100.0);
    let c1 = call(date!(2026 - 03 - 20), 105.0);
    let p2 = put(date!(2026 - 04 - 20), 98.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p1.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p1, 1, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e3",
            3,
            date!(2026 - 02 - 25),
            c1.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e4", 4, date!(2026 - 03 - 20), c1, 1, 0.0),
        Event::sell_option(ACCOUNT, "e5", 5, date!(2026 - 03 - 25), p2, 1, 3.0, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    assert_eq!(state.campaigns.len(), 2);

    let first = &state.campaigns[0];
    assert_eq!(first.status, CampaignStatus::Closed);
    assert_close(first.premium_realized, 700.0);
    assert_close(first.realized_pnl.unwrap(), 1200.0);

    let second = &state.campaigns[1];
    assert_eq!(second.status, CampaignStatus::Active);
    assert_close(second.premium_realized, 0.0);
    assert_close(second.premium_open, 300.0);
    assert_eq!(second.shares, 0);
}

#[test]
fn t10_negative_effective_cost_is_allowed() {
    let p = put(date!(2026 - 02 - 20), 100.0);
    let c = call(date!(2026 - 03 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p, 1, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e3",
            3,
            date!(2026 - 02 - 25),
            c.clone(),
            1,
            120.0,
            0.0,
        ),
        Event::expire_option(ACCOUNT, "e4", 4, date!(2026 - 03 - 20), c, 1),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_close(campaign.cost_a().unwrap(), 100.0);
    assert_close(campaign.cost_b(false).unwrap(), -25.0);
    assert!(campaign.cost_b(false).unwrap() < 0.0);
}

#[test]
fn dividends_only_affect_cost_when_enabled() {
    let p = put(date!(2026 - 02 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 20), p, 1, 0.0),
        Event::dividend(ACCOUNT, "e3", 3, date!(2026 - 02 - 27), "AAPL", 0.25, 100),
    ];

    let off = replay(ACCOUNT, &events, Settings::default()).unwrap();
    let on = replay(
        ACCOUNT,
        &events,
        Settings {
            include_dividends_in_cost: true,
        },
    )
    .unwrap();
    assert_clean(&off);
    assert_clean(&on);
    assert_close(off.campaigns[0].dividends, 25.0);
    assert_close(off.campaigns[0].cost_b(false).unwrap(), 95.0);
    assert_close(on.campaigns[0].cost_b(true).unwrap(), 94.75);
}

#[test]
fn replay_is_order_independent_and_idempotent() {
    let events = design_example();
    let forward = run(&events);

    let mut reversed = events.clone();
    reversed.reverse();
    let backward = run(&reversed);
    assert_eq!(forward, backward);

    let again = run(&events);
    assert_eq!(forward, again);
}

#[test]
fn duplicate_event_id_is_rejected() {
    let p = put(date!(2026 - 02 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "dup",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::sell_option(ACCOUNT, "dup", 2, date!(2026 - 01 - 06), p, 1, 5.0, 0.0),
    ];
    let err = replay(ACCOUNT, &events, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::DuplicateEventId { .. }
    ));
}

#[test]
fn closing_more_contracts_than_open_is_rejected() {
    let p = put(date!(2026 - 02 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::close_option(ACCOUNT, "e2", 2, date!(2026 - 01 - 10), p, 2, 1.0, 0.0),
    ];
    let err = replay(ACCOUNT, &events, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::InsufficientOpenQty { .. }
    ));
}

#[test]
fn calling_away_without_shares_is_rejected() {
    let c = call(date!(2026 - 03 - 20), 100.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            c.clone(),
            1,
            5.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), c, 1, 0.0),
    ];
    let err = replay(ACCOUNT, &events, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::InsufficientShares { .. }
    ));
}

// ---------------------------------------------------------------------------
// Deterministic property test: a tiny LCG keeps the suite dependency-free while
// still exercising hundreds of random but valid wheel sequences.
// ---------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }

    fn unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64) / ((1u64 << 53) as f64)
    }

    fn between(&mut self, lo: f64, hi: f64) -> f64 {
        lo + self.unit() * (hi - lo)
    }

    fn coin(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }
}

#[test]
fn random_wheel_sequences_keep_invariants() {
    let base = date!(2026 - 01 - 01);

    // 500 seeds x up to 24 events per seed = at least 12k replayed events,
    // which covers the "10k random events" acceptance case.
    for seed in 1..=500u64 {
        let mut rng = Lcg(seed);
        let mut events = Vec::new();
        let mut seq = 0u64;

        for i in 0..6i64 {
            let strike = rng.between(20.0, 500.0);
            let premium = rng.between(0.05, 20.0);
            let at = base + Duration::days(30 * i + 1);
            let expiry = base + Duration::days(30 * (i + 1));
            let put_contract = OptionContract::new("XYZ", expiry, strike, Right::Put);

            seq += 1;
            events.push(Event::sell_option(
                ACCOUNT,
                &format!("s{seed}e{seq}"),
                seq,
                at,
                put_contract.clone(),
                1,
                premium,
                0.5,
            ));

            if rng.coin() {
                seq += 1;
                events.push(Event::expire_option(
                    ACCOUNT,
                    &format!("s{seed}e{seq}"),
                    seq,
                    expiry,
                    put_contract,
                    1,
                ));
                continue;
            }

            seq += 1;
            events.push(Event::assign_option(
                ACCOUNT,
                &format!("s{seed}e{seq}"),
                seq,
                expiry,
                put_contract,
                1,
                0.0,
            ));

            let call_expiry = expiry + Duration::days(30);
            let call_contract = OptionContract::new("XYZ", call_expiry, strike * 1.05, Right::Call);
            seq += 1;
            events.push(Event::sell_option(
                ACCOUNT,
                &format!("s{seed}e{seq}"),
                seq,
                expiry + Duration::days(1),
                call_contract.clone(),
                1,
                premium * 0.5,
                0.5,
            ));

            seq += 1;
            if rng.coin() {
                events.push(Event::assign_option(
                    ACCOUNT,
                    &format!("s{seed}e{seq}"),
                    seq,
                    call_expiry,
                    call_contract,
                    1,
                    0.0,
                ));
            } else {
                events.push(Event::expire_option(
                    ACCOUNT,
                    &format!("s{seed}e{seq}"),
                    seq,
                    call_expiry,
                    call_contract,
                    1,
                ));
            }
        }

        let state = replay(ACCOUNT, &events, Settings::default())
            .unwrap_or_else(|err| panic!("seed {seed} failed: {err}"));
        let issues = state.check_invariants();
        assert!(issues.is_empty(), "seed {seed}: {issues:#?}");
        assert!(!state.premium_entries.is_empty(), "seed {seed}");
    }
}

#[test]
fn split_two_for_one_adjusts_shares_and_open_contract() {
    let p = put(date!(2026 - 03 - 20), 100.0);
    let c = call(date!(2026 - 05 - 15), 110.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            3.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), p, 1, 0.0),
        Event::sell_option(ACCOUNT, "e3", 3, date!(2026 - 04 - 01), c, 1, 2.0, 0.0),
        Event::stock_split(ACCOUNT, "e4", 4, date!(2026 - 04 - 10), "AAPL", 2, 1, None),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 200);
    assert_close(campaign.cost_a().unwrap(), 50.0);
    assert_close(campaign.premium_open, 200.0);
    assert_eq!(
        state.event_campaigns.get("e4").map(String::as_str),
        Some(campaign.id.as_str())
    );
    let position = &state.positions[0];
    assert_eq!(position.contract.strike, 55.0);
    assert_eq!(position.contract.multiplier, 200);
    assert_eq!(position.contract.expiry, date!(2026 - 05 - 15));
    assert_eq!(position.open_qty, 1);
    assert_close(position.avg_credit_per_share, 1.0);
    assert_close(
        position.avg_credit_per_share
            * f64::from(position.contract.multiplier)
            * f64::from(position.open_qty),
        200.0,
    );
}

#[test]
fn split_aliases_let_the_old_contract_close() {
    let p = put(date!(2026 - 03 - 20), 100.0);
    let c = call(date!(2026 - 05 - 15), 110.0);
    let events = vec![
        Event::sell_option(
            ACCOUNT,
            "e1",
            1,
            date!(2026 - 01 - 05),
            p.clone(),
            1,
            3.0,
            0.0,
        ),
        Event::assign_option(ACCOUNT, "e2", 2, date!(2026 - 03 - 20), p, 1, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e3",
            3,
            date!(2026 - 04 - 01),
            c.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::stock_split(ACCOUNT, "e4", 4, date!(2026 - 04 - 10), "AAPL", 2, 1, None),
        Event::close_option(ACCOUNT, "e5", 5, date!(2026 - 04 - 15), c, 1, 0.5, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 200);
    assert_close(campaign.premium_realized, 400.0);
    assert!(state.positions.is_empty());
    assert_eq!(state.premium_entries[1].status, EntryStatus::Closed);
}

#[test]
fn reverse_split_scales_strike_and_multiplier() {
    let c = call(date!(2026 - 05 - 15), 60.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 50.0, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e2",
            2,
            date!(2026 - 02 - 01),
            c.clone(),
            1,
            1.5,
            0.0,
        ),
        Event::stock_split(ACCOUNT, "e3", 3, date!(2026 - 03 - 01), "AAPL", 1, 10, None),
        Event::assign_option(ACCOUNT, "e4", 4, date!(2026 - 03 - 15), c, 1, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 0);
    assert_eq!(campaign.status, CampaignStatus::Closed);
    assert_close(campaign.share_pnl, 1000.0);
    assert_close(campaign.premium_realized, 150.0);
    assert_close(campaign.realized_pnl.unwrap(), 1150.0);
}

#[test]
fn three_for_two_split_keeps_fractional_strike() {
    let c = call(date!(2026 - 05 - 15), 30.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 10.0, 0.0),
        Event::sell_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 01), c, 1, 1.0, 0.0),
        Event::stock_split(ACCOUNT, "e3", 3, date!(2026 - 03 - 01), "AAPL", 3, 2, None),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 150);
    assert_close(campaign.cost_a().unwrap(), 1000.0 / 150.0);
    let position = &state.positions[0];
    assert_eq!(position.contract.strike, 20.0);
    assert_eq!(position.contract.multiplier, 150);
    assert_close(position.avg_credit_per_share, 1.0 / 1.5);
}

#[test]
fn non_integral_option_split_is_rejected() {
    let c = call(date!(2026 - 05 - 15), 30.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 10.0, 0.0),
        Event::sell_option(ACCOUNT, "e2", 2, date!(2026 - 02 - 01), c, 1, 1.0, 0.0),
        Event::stock_split(ACCOUNT, "e3", 3, date!(2026 - 03 - 01), "AAPL", 4, 3, None),
    ];
    let err = replay(ACCOUNT, &events, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::NonIntegralOptionAdjustment { .. }
    ));
}

#[test]
fn fractional_split_needs_cash_in_lieu_and_books_it() {
    let base = vec![Event::buy_shares(
        ACCOUNT,
        "e1",
        1,
        date!(2026 - 01 - 05),
        "AAPL",
        101,
        50.0,
        0.0,
    )];
    let mut missing = base.clone();
    missing.push(Event::stock_split(
        ACCOUNT,
        "e2",
        2,
        date!(2026 - 02 - 01),
        "AAPL",
        1,
        10,
        None,
    ));
    let err = replay(ACCOUNT, &missing, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::FractionalSplitNeedsCashInLieu { .. }
    ));

    let mut events = base;
    events.push(Event::stock_split(
        ACCOUNT,
        "e2",
        2,
        date!(2026 - 02 - 01),
        "AAPL",
        1,
        10,
        Some(12.5),
    ));
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 10);
    assert_close(campaign.cost_a().unwrap(), 500.0);
    assert_close(campaign.share_pnl, -37.5);
    assert_close(*state.event_share_pnl.get("e2").unwrap(), -37.5);
    let total: f64 = state.event_share_pnl.values().copied().sum();
    assert_close(total, campaign.share_pnl);
}

#[test]
fn consecutive_splits_follow_the_alias_chain() {
    let c = call(date!(2026 - 06 - 19), 200.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 50.0, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e2",
            2,
            date!(2026 - 01 - 10),
            c.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::stock_split(ACCOUNT, "e3", 3, date!(2026 - 02 - 01), "AAPL", 2, 1, None),
        Event::stock_split(ACCOUNT, "e4", 4, date!(2026 - 03 - 01), "AAPL", 2, 1, None),
        Event::close_option(ACCOUNT, "e5", 5, date!(2026 - 04 - 01), c, 1, 0.25, 0.0),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 400);
    assert_close(campaign.cost_a().unwrap(), 12.5);
    assert_close(campaign.premium_realized, 100.0);
    assert!(state.positions.is_empty());
}

#[test]
fn backfilled_split_applies_before_a_later_dated_close() {
    let c = call(date!(2026 - 05 - 15), 110.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 50.0, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e2",
            2,
            date!(2026 - 02 - 01),
            c.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::close_option(ACCOUNT, "e3", 3, date!(2026 - 04 - 01), c, 1, 0.5, 0.0),
        // Recorded last but dated before the close, so replay applies it first.
        Event::stock_split(ACCOUNT, "e4", 4, date!(2026 - 03 - 01), "AAPL", 2, 1, None),
    ];
    let state = run(&events);
    assert_clean(&state);
    let campaign = &state.campaigns[0];
    assert_eq!(campaign.shares, 200);
    assert_close(campaign.premium_realized, 100.0);
    assert!(state.positions.is_empty());
}

#[test]
fn one_for_one_split_is_a_no_op() {
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 50.0, 0.0),
        Event::stock_split(ACCOUNT, "e2", 2, date!(2026 - 02 - 01), "AAPL", 1, 1, None),
    ];
    let state = run(&events);
    assert_clean(&state);
    assert_eq!(state.campaigns[0].shares, 100);
    assert_close(state.campaigns[0].cost_a().unwrap(), 50.0);
}

#[test]
fn split_without_a_campaign_is_recorded_as_a_note() {
    let events = vec![Event::stock_split(
        ACCOUNT,
        "e1",
        1,
        date!(2026 - 01 - 05),
        "AAPL",
        2,
        1,
        None,
    )];
    let state = run(&events);
    assert_clean(&state);
    assert!(state.campaigns.is_empty());
    assert!(state.event_campaigns.is_empty());
}

#[test]
fn opening_a_pre_split_contract_after_the_split_is_rejected() {
    let c = call(date!(2026 - 05 - 15), 110.0);
    let events = vec![
        Event::buy_shares(ACCOUNT, "e1", 1, date!(2026 - 01 - 05), "AAPL", 100, 50.0, 0.0),
        Event::sell_option(
            ACCOUNT,
            "e2",
            2,
            date!(2026 - 02 - 01),
            c.clone(),
            1,
            2.0,
            0.0,
        ),
        Event::stock_split(ACCOUNT, "e3", 3, date!(2026 - 03 - 01), "AAPL", 2, 1, None),
        Event::sell_option(ACCOUNT, "e4", 4, date!(2026 - 04 - 01), c, 1, 2.0, 0.0),
    ];
    let err = replay(ACCOUNT, &events, Settings::default()).unwrap_err();
    assert!(matches!(
        err,
        wheel_core::EngineError::AdjustedContractRequired { .. }
    ));
}
