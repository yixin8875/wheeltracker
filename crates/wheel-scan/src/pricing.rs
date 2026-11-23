//! Black–Scholes pricing used for delta, probability and implied volatility.
//!
//! The chain itself is never priced from this model: it only fills the columns
//! the provider omits (Nasdaq returns no Greeks and no IV). Every candidate the
//! UI shows as "estimated" is labelled.

use std::f64::consts::{PI, SQRT_2};

use wheel_core::Right;

/// Standard normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation
/// (absolute error below 1.5e-7, far below what option quotes justify).
pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / SQRT_2))
}

fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / (2.0 * PI).sqrt()
}

fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let poly = ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736)
        * t
        + 0.254_829_592)
        * t;
    sign * (1.0 - poly * (-x * x).exp())
}

fn d1_d2(
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    vol: f64,
) -> Option<(f64, f64)> {
    if !(spot > 0.0 && strike > 0.0 && years > 0.0 && vol > 0.0) {
        return None;
    }
    let sqrt_t = years.sqrt();
    let d1 =
        ((spot / strike).ln() + (rate - dividend_yield + 0.5 * vol * vol) * years) / (vol * sqrt_t);
    Some((d1, d1 - vol * sqrt_t))
}

/// Theoretical European price per share. `years` is time to expiry, so 30 days
/// is `30.0 / 365.0`.
pub fn price(
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    vol: f64,
    right: Right,
) -> Option<f64> {
    let (d1, d2) = d1_d2(spot, strike, years, rate, dividend_yield, vol)?;
    let discount_rate = (-rate * years).exp();
    let discount_yield = (-dividend_yield * years).exp();
    Some(match right {
        Right::Call => spot * discount_yield * norm_cdf(d1) - strike * discount_rate * norm_cdf(d2),
        Right::Put => {
            strike * discount_rate * norm_cdf(-d2) - spot * discount_yield * norm_cdf(-d1)
        }
    })
}

pub fn delta(
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    vol: f64,
    right: Right,
) -> Option<f64> {
    let (d1, _) = d1_d2(spot, strike, years, rate, dividend_yield, vol)?;
    let discount_yield = (-dividend_yield * years).exp();
    Some(match right {
        Right::Call => discount_yield * norm_cdf(d1),
        Right::Put => -discount_yield * norm_cdf(-d1),
    })
}

/// Risk-neutral probability of finishing in the money, `N(d2)` for calls.
/// Used as a scenario label only, never as a recommendation.
pub fn prob_itm(
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    vol: f64,
    right: Right,
) -> Option<f64> {
    let (_, d2) = d1_d2(spot, strike, years, rate, dividend_yield, vol)?;
    Some(match right {
        Right::Call => norm_cdf(d2),
        Right::Put => norm_cdf(-d2),
    })
}

/// Solve for the volatility that reproduces `market` per share. Returns `None`
/// when the quote is at or below intrinsic value, which usually means a stale
/// or crossed quote rather than a real zero-volatility market.
pub fn implied_vol(
    market: f64,
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    right: Right,
) -> Option<f64> {
    if !(market > 0.0 && spot > 0.0 && strike > 0.0 && years > 0.0) {
        return None;
    }
    let discount_rate = (-rate * years).exp();
    let discount_yield = (-dividend_yield * years).exp();
    let intrinsic = match right {
        Right::Call => (spot * discount_yield - strike * discount_rate).max(0.0),
        Right::Put => (strike * discount_rate - spot * discount_yield).max(0.0),
    };
    if market <= intrinsic + 1e-9 {
        return None;
    }
    let mut low = 1e-4;
    let mut high = 5.0;
    if price(spot, strike, years, rate, dividend_yield, high, right)? < market {
        return None;
    }
    for _ in 0..200 {
        let mid = 0.5 * (low + high);
        let theoretical = price(spot, strike, years, rate, dividend_yield, mid, right)?;
        if (theoretical - market).abs() < 1e-8 {
            return Some(mid);
        }
        if theoretical < market {
            low = mid;
        } else {
            high = mid;
        }
    }
    Some(0.5 * (low + high))
}

/// Vega per share, for display only (per 1.00 change in vol).
pub fn vega(
    spot: f64,
    strike: f64,
    years: f64,
    rate: f64,
    dividend_yield: f64,
    vol: f64,
) -> Option<f64> {
    let (d1, _) = d1_d2(spot, strike, years, rate, dividend_yield, vol)?;
    Some(spot * (-dividend_yield * years).exp() * norm_pdf(d1) * years.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPOT: f64 = 100.0;
    const STRIKE: f64 = 100.0;
    const YEARS: f64 = 1.0;
    const RATE: f64 = 0.05;
    const VOL: f64 = 0.2;

    fn close(left: f64, right: f64, tolerance: f64) {
        assert!(
            (left - right).abs() < tolerance,
            "expected {right}, got {left}"
        );
    }

    #[test]
    fn matches_textbook_atm_prices() {
        let call = price(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, Right::Call).unwrap();
        let put = price(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, Right::Put).unwrap();
        close(call, 10.4506, 1e-3);
        close(put, 5.5735, 1e-3);
        // Put–call parity: C − P = S − K e^{-rT}
        close(call - put, SPOT - STRIKE * (-RATE * YEARS).exp(), 1e-9);
    }

    #[test]
    fn delta_and_probability_are_sane() {
        let call_delta = delta(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, Right::Call).unwrap();
        close(call_delta, 0.6368, 1e-3);
        let put_delta = delta(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, Right::Put).unwrap();
        close(put_delta, call_delta - 1.0, 1e-9);
        let itm = prob_itm(SPOT, STRIKE, YEARS, RATE, 0.0, VOL, Right::Call).unwrap();
        assert!(itm > 0.4 && itm < 0.6);
    }

    #[test]
    fn implied_vol_round_trips() {
        for right in [Right::Call, Right::Put] {
            let market = price(SPOT, 105.0, 0.25, 0.04, 0.01, 0.37, right).unwrap();
            let solved = implied_vol(market, SPOT, 105.0, 0.25, 0.04, 0.01, right).unwrap();
            close(solved, 0.37, 1e-4);
        }
    }

    #[test]
    fn rejects_degenerate_inputs() {
        assert!(price(SPOT, STRIKE, 0.0, RATE, 0.0, VOL, Right::Call).is_none());
        assert!(implied_vol(0.0, SPOT, STRIKE, YEARS, RATE, 0.0, Right::Call).is_none());
        // A quote below intrinsic cannot be inverted.
        assert!(implied_vol(1.0, 200.0, 100.0, YEARS, 0.0, 0.0, Right::Call).is_none());
    }
}
