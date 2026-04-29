use soroban_sdk::{panic_with_error, Env, I256};

use crate::errors::Error;

/// Guards a public entry-point against negative amount inputs.
///
/// Panics with `Error::ZeroAmount` when `amount < 0`. A value of `0` is
/// permitted — callers that need to reject zero alongside negatives should
/// add their own zero-check appropriate to the call site (e.g. distinct
/// error codes for "below minimum" vs. "non-negative required").
///
/// Centralising this check keeps amount validation consistent across
/// deposit, mint, withdraw, redeem, transfer, burn, and yield-distribution
/// paths so that integrators see the same error code regardless of which
/// signed-amount entry point they hit with bad input.
pub fn assert_nonnegative(e: &Env, amount: i128) {
    if amount < 0 {
        panic_with_error!(e, Error::ZeroAmount);
    }
}

/// Calculate (a * b) / c using I256 intermediate to prevent overflow.
/// Panics if c == 0 or if the result exceeds i128::MAX.
pub fn mul_div(e: &Env, a: i128, b: i128, c: i128) -> i128 {
    if c == 0 {
        panic!("division by zero");
    }

    let a_q = I256::from_i128(e, a);
    let b_q = I256::from_i128(e, b);
    let c_q = I256::from_i128(e, c);

    let res = a_q.mul(&b_q).div(&c_q);

    res.to_i128().expect("result exceeds i128 range")
}

/// Calculate (a * b + c - 1) / c using I256 intermediate to prevent overflow.
/// This performs ceiling division.
/// Panics if c == 0 or if the result exceeds i128::MAX.
pub fn mul_div_ceil(e: &Env, a: i128, b: i128, c: i128) -> i128 {
    if c == 0 {
        panic!("division by zero");
    }

    let a_q = I256::from_i128(e, a);
    let b_q = I256::from_i128(e, b);
    let c_q = I256::from_i128(e, c);

    let one = I256::from_i128(e, 1);
    let res = a_q.mul(&b_q).add(&c_q).sub(&one).div(&c_q);

    res.to_i128().expect("result exceeds i128 range")
}
