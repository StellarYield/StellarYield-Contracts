use soroban_sdk::{Env, I256};

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
