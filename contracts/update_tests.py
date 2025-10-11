#!/usr/bin/env python3
"""
Script to update UnicitySwapBroker tests to include signature generation
"""

import re

def add_signature_to_swap_native(match):
    """Add signature generation before swapNative call"""
    indent = match.group(1)
    prank_line = match.group(2)
    call_block = match.group(3)

    # Extract parameters from the call
    # Pattern: dealId, payback, recipient, feeRecipient, amount, fees
    param_match = re.search(
        r'DEAL_ID_(\w+),\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+)',
        call_block
    )

    if not param_match:
        return match.group(0)  # Return original if can't parse

    deal_id = f"DEAL_ID_{param_match.group(1)}"
    payback = param_match.group(2)
    recipient_param = param_match.group(3)
    fee_recipient = param_match.group(4)
    amount = param_match.group(5)
    fees = param_match.group(6)

    # Extract the caller from vm.prank
    caller_match = re.search(r'vm\.prank\((\w+)\)', prank_line)
    caller = caller_match.group(1) if caller_match else "operator"

    # Generate signature code
    sig_code = f"""{indent}// Generate signature
{indent}bytes memory signature = sigHelper.signSwapNative(
{indent}    operatorPrivateKey,
{indent}    address(broker),
{indent}    {deal_id},
{indent}    {payback},
{indent}    {recipient_param},
{indent}    {fee_recipient},
{indent}    {amount},
{indent}    {fees},
{indent}    {caller}
{indent});

{indent}{prank_line}
{indent}{call_block},
{indent}    signature
{indent});"""

    return sig_code


def add_signature_to_revert_native(match):
    """Add signature generation before revertNative call"""
    indent = match.group(1)
    prank_line = match.group(2)
    call_block = match.group(3)

    # Extract parameters from the call
    # Pattern: dealId, payback, feeRecipient, fees
    param_match = re.search(
        r'(\w+),\s*(\w+),\s*(\w+),\s*(\w+)',
        call_block
    )

    if not param_match:
        return match.group(0)  # Return original if can't parse

    deal_id = param_match.group(1)
    payback = param_match.group(2)
    fee_recipient = param_match.group(3)
    fees = param_match.group(4)

    # Extract the caller from vm.prank
    caller_match = re.search(r'vm\.prank\((\w+)\)', prank_line)
    caller = caller_match.group(1) if caller_match else "operator"

    # Generate signature code
    sig_code = f"""{indent}// Generate signature
{indent}bytes memory signature = sigHelper.signRevertNative(
{indent}    operatorPrivateKey,
{indent}    address(broker),
{indent}    {deal_id},
{indent}    {payback},
{indent}    {fee_recipient},
{indent}    {fees},
{indent}    {caller}
{indent});

{indent}{prank_line}
{indent}{call_block},
{indent}    signature
{indent});"""

    return sig_code


# Read the test file
with open('/home/vrogojin/otc_agent/contracts/test/UnicitySwapBroker.t.sol', 'r') as f:
    content = f.read()

print("Updating swapNative calls...")
print("Updating revertNative calls...")

print("\nDone! Manual review required - Python script limitations prevent automatic update.")
print("Please use the Edit tool to update each test function individually.")
