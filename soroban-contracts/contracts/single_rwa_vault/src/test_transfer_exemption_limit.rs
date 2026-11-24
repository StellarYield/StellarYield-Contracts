//! Tests that adding more than MAX_TRANSFER_EXEMPTIONS (50) addresses panics (#1365).

use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

use crate::test_helpers::setup_with_kyc_bypass;
use crate::MAX_TRANSFER_EXEMPTIONS;

#[test]
fn test_add_transfer_exemptions_up_to_limit() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    for _ in 0..MAX_TRANSFER_EXEMPTIONS {
        let addr = Address::generate(&ctx.env);
        vault.set_transfer_exempt(&ctx.admin, &addr, &true);
    }

    let list = vault.get_transfer_exempt_addresses();
    assert_eq!(list.len(), MAX_TRANSFER_EXEMPTIONS);
}

#[test]
#[should_panic(expected = "Error(Contract, #49)")]
fn test_add_transfer_exemption_over_limit_panics() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    for _ in 0..MAX_TRANSFER_EXEMPTIONS {
        let addr = Address::generate(&ctx.env);
        vault.set_transfer_exempt(&ctx.admin, &addr, &true);
    }

    // One more — must panic with #49.
    let extra = Address::generate(&ctx.env);
    vault.set_transfer_exempt(&ctx.admin, &extra, &true);
}

#[test]
fn test_removing_exemption_frees_slot() {
    let ctx = setup_with_kyc_bypass();
    let vault = ctx.vault();

    let mut addrs: soroban_sdk::Vec<Address> = soroban_sdk::Vec::new(&ctx.env);
    for _ in 0..MAX_TRANSFER_EXEMPTIONS {
        let addr = Address::generate(&ctx.env);
        vault.set_transfer_exempt(&ctx.admin, &addr, &true);
        addrs.push_back(addr);
    }

    // Remove one and re-add a fresh address — must succeed.
    vault.set_transfer_exempt(&ctx.admin, &addrs.get(0).unwrap(), &false);
    let new_addr = Address::generate(&ctx.env);
    vault.set_transfer_exempt(&ctx.admin, &new_addr, &true);

    assert_eq!(vault.get_transfer_exempt_addresses().len(), MAX_TRANSFER_EXEMPTIONS);
}
