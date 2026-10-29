//! The complementary error function. Rust's standard library has none (Go has `math.Erfc`) and BR-42's p-value
//! is `erfc(|z| / sqrt 2)`. The usual textbook approximation (Abramowitz and Stegun 7.1.26) is only good to about
//! 1.5e-7, which would change the 7th digit of `pValue` and `significant` near 0.05, so this implementation is
//! held to tests/vectors/erfc.json instead (1e-12 absolute / 1e-9 relative).

use std::f64::consts::PI;

/// Below this the Taylor series is accurate; from here up the continued fraction converges quickly.
const SERIES_LIMIT: f64 = 2.0;
const FRACTION_DEPTH: u32 = 150;

/// erf(x) by its Taylor series: 2/sqrt(pi) * sum of (-1)^n x^(2n+1) / (n! (2n+1)).
fn erf_series(x: f64) -> f64 {
    let x2 = x * x;
    let mut power = x; // x^(2n+1) / n!
    let mut sum = x;
    for n in 1..200u32 {
        power *= x2 / f64::from(n);
        let term = power / f64::from(2 * n + 1);
        if n % 2 == 0 {
            sum += term;
        } else {
            sum -= term;
        }
        if term.abs() < 1e-17 * sum.abs() {
            break;
        }
    }
    2.0 / PI.sqrt() * sum
}

/// erfc(x) for x >= `SERIES_LIMIT` by the continued fraction
/// exp(-x^2) / sqrt(pi) / (x + (1/2) / (x + (2/2) / (x + (3/2) / (x + ...)))), evaluated from the tail.
fn erfc_fraction(x: f64) -> f64 {
    let mut tail = x;
    for k in (1..=FRACTION_DEPTH).rev() {
        tail = x + f64::from(k) / 2.0 / tail;
    }
    (-x * x).exp() / (PI.sqrt() * tail)
}

/// erfc(x) = 1 - erf(x). Defined for every real x; NaN for NaN.
pub fn erfc(x: f64) -> f64 {
    if x.is_nan() {
        f64::NAN
    } else if x < 0.0 {
        2.0 - erfc(-x)
    } else if x == f64::INFINITY {
        0.0
    } else if x < SERIES_LIMIT {
        1.0 - erf_series(x)
    } else {
        erfc_fraction(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_values() {
        assert_eq!(erfc(0.0), 1.0);
        assert_eq!(erfc(f64::INFINITY), 0.0);
        assert!((erfc(f64::NEG_INFINITY) - 2.0).abs() < 1e-15);
        assert!(erfc(f64::NAN).is_nan());
        assert!((erfc(-0.7) - (2.0 - erfc(0.7))).abs() < 1e-15);
        assert!(erfc(30.0).abs() < 1e-300);
    }

    #[test]
    fn continuous_across_the_switch_of_method() {
        assert!((erfc(2.0 - 1e-12) - erfc(2.0 + 1e-12)).abs() < 1e-13);
    }

    #[test]
    fn the_textbook_approximation_would_not_pass_the_vectors() {
        // Abramowitz and Stegun 7.1.26. If this stops failing the vectors are too loose to protect the p-value.
        let x = 1.0_f64;
        let t = 1.0 / (1.0 + 0.327_591_1 * x);
        let approx = ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736) * t
            + 0.254_829_592)
            * t
            * (-x * x).exp();
        assert!((approx - erfc(x)).abs() > 1e-9);
    }
}
