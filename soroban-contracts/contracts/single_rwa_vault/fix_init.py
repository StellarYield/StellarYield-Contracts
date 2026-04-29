import re

files = [
    "src/fuzz_tests.rs",
    "src/test_access_control.rs",
    "src/test_constructor_validation.rs",
    "src/test_funding_deadline.rs",
    "src/test_rbac.rs",
    "src/test_redemption.rs",
    "src/test_rwa_setters.rs",
    "src/test_token.rs",
    "src/test_vault_state_guards.rs",
    "src/tests.rs"
]

pattern = re.compile(r'(?<!->)(?<!->\s)InitParams\s*\{\s*')

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    parts = pattern.split(content)
    if len(parts) > 1:
        new_content = parts[0]
        changed = False
        for part in parts[1:]:
            inside = part.split('}')[0]
            if 'yield_vesting_period:' not in inside:
                new_content += 'InitParams {\n            yield_vesting_period: 0,\n        ' + part
                changed = True
            else:
                new_content += 'InitParams {' + part
        
        if changed:
            with open(file, 'w') as f:
                f.write(new_content)
            print(f'Fixed {file}')
