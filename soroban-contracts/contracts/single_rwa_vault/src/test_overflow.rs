#[cfg(test)]
mod test {
    use crate::math;
    use soroban_sdk::Env;

    #[test]
    fn test_mul_div_overflow_safe() {
        let e = Env::default();

        // Product = 10^48, which is > i128::MAX (~1.7 * 10^38)
        let a = 1_000_000_000_000_000_000_000_000i128; // 10^24
        let b = 1_000_000_000_000_000_000_000_000i128; // 10^24
        let c = 1_000_000_000_000_000_000_000_000i128; // 10^24

        let res = math::mul_div(&e, a, b, c);
        assert_eq!(res, 1_000_000_000_000_000_000_000_000i128);
    }

    #[test]
    fn test_mul_div_near_max() {
        let e = Env::default();

        let a = i128::MAX - 10;
        let b = 2i128;
        let c = 2i128;
        let res = math::mul_div(&e, a, b, c);
        assert_eq!(res, a);
    }

    #[test]
    fn test_mul_div_ceil() {
        let e = Env::default();

        // (10 * 3 + 4 - 1) / 4 = 33 / 4 = 8.25 -> 8 (in integer div)
        // Actually, (10*3 + 4 - 1) / 4 = 33 / 4 = 8.
        // Wait, ceiling of 30/4 is 8.
        // 30 / 4 = 7 rem 2. Ceiling is 8.
        // Formula (a*b + c - 1) / c: (30 + 3) / 4 = 33 / 4 = 8. Correct.

        let res = math::mul_div_ceil(&e, 10, 3, 4);
        assert_eq!(res, 8);

        // (11 * 3 + 4 - 1) / 4 = (33 + 3) / 4 = 9.
        // 33 / 4 = 8 rem 1. Ceiling is 9. Correct.
        let res = math::mul_div_ceil(&e, 11, 3, 4);
        assert_eq!(res, 9);

        // Exact: (10 * 2 + 4 - 1) / 4 = 23 / 4 = 5.
        // 20 / 4 = 5. Ceiling is 5. Correct.
        let res = math::mul_div_ceil(&e, 10, 2, 4);
        assert_eq!(res, 5);
    }

    #[test]
    #[should_panic(expected = "result exceeds i128 range")]
    fn test_mul_div_result_too_large() {
        let e = Env::default();
        let a = i128::MAX;
        let b = 2i128;
        let c = 1i128;
        math::mul_div(&e, a, b, c);
    }
}
