//! Simple verification test for issue #104 fixes.

extern crate std;

use soroban_sdk::{Address, Env};

#[test]
fn test_error_variant_exists() {
    let env = Env::default();
    
    // Test that our new error variant compiles
    let _error = stellar_yield_contracts::Error::InsufficientVaultBalance;
    
    // This is just a compilation test
    assert!(true);
}
