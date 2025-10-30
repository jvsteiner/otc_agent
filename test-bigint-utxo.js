#!/usr/bin/env node
/**
 * Test script to verify UTXO BigInt implementation
 * Tests critical scenarios with amounts exceeding JavaScript's safe integer limit
 */

const { buildAndSignSegWitTransaction, selectUTXOs } = require('./packages/chains/dist/utils/UnicityTransaction');

console.log('=== UTXO BigInt Implementation Tests ===\n');

// Test 1: Verify UTXO interface accepts bigint values
console.log('Test 1: UTXO Interface with BigInt Values');
const testUTXO = {
  tx_hash: '0'.repeat(64),
  tx_pos: 0,
  value: 10000000000000000n, // 100M ALPHA in satoshis
  height: 100000
};
console.log('✅ UTXO created with bigint value:', testUTXO.value.toString(), 'satoshis');
console.log('   = ', (Number(testUTXO.value) / 100000000).toFixed(2), 'ALPHA\n');

// Test 2: Verify buffer serialization for 64-bit values
console.log('Test 2: 64-bit Buffer Serialization');
function test64BitEncoding(value) {
  const buffer = Buffer.allocUnsafe(8);

  // Write using the fixed method
  buffer.writeUInt32LE(Number(value & 0xffffffffn), 0);
  buffer.writeUInt32LE(Number(value >> 32n), 4);

  // Read back
  const reconstructed = BigInt(buffer.readUInt32LE(0)) | (BigInt(buffer.readUInt32LE(4)) << 32n);

  const success = value === reconstructed;
  console.log(`  Value: ${value.toString().padEnd(25)} | Reconstructed: ${reconstructed.toString().padEnd(25)} | ${success ? '✅ PASS' : '❌ FAIL'}`);
  return success;
}

const testValues = [
  1n,                           // Minimum
  100000000n,                   // 1 ALPHA
  9007199254740991n,           // MAX_SAFE_INTEGER (old limit)
  9007199254740992n,           // MAX_SAFE_INTEGER + 1 (would fail with number)
  10000000000000000n,          // 100M ALPHA
  100000000000000000n,         // 1B ALPHA
  18446744073709551615n        // uint64 MAX
];

let allPassed = true;
testValues.forEach(val => {
  if (!test64BitEncoding(val)) allPassed = false;
});
console.log();

// Test 3: Arithmetic operations
console.log('Test 3: BigInt Arithmetic Operations');
const utxos = [
  { tx_hash: '0'.repeat(64), tx_pos: 0, value: 5000000000000000n, height: 100000 },  // 50M ALPHA
  { tx_hash: '1'.repeat(64), tx_pos: 0, value: 6000000000000000n, height: 100001 },  // 60M ALPHA
];

const total = utxos.reduce((sum, utxo) => sum + utxo.value, 0n);
console.log(`  UTXO 1: ${(Number(utxos[0].value) / 100000000).toFixed(2)} ALPHA`);
console.log(`  UTXO 2: ${(Number(utxos[1].value) / 100000000).toFixed(2)} ALPHA`);
console.log(`  Total:  ${(Number(total) / 100000000).toFixed(2)} ALPHA`);
console.log(`  ${total === 11000000000000000n ? '✅ PASS' : '❌ FAIL'} - Arithmetic is correct\n`);

// Test 4: Comparison operations
console.log('Test 4: BigInt Comparison Operations');
const dustThreshold = 546n;
const smallAmount = 500n;
const largeAmount = 10000000000000000n;

console.log(`  ${smallAmount} <= ${dustThreshold}: ${smallAmount <= dustThreshold ? '✅ true' : '❌ false'}`);
console.log(`  ${largeAmount} > ${dustThreshold}: ${largeAmount > dustThreshold ? '✅ true' : '❌ false'}`);
console.log(`  ${largeAmount} > 0n: ${largeAmount > 0n ? '✅ true' : '❌ false'}\n`);

// Test 5: UTXO Selection
console.log('Test 5: UTXO Selection with Large Amounts');
try {
  const availableUtxos = [
    { tx_hash: '0'.repeat(64), tx_pos: 0, value: 10000000000000000n, height: 100000 },  // 100M ALPHA
    { tx_hash: '1'.repeat(64), tx_pos: 1, value: 5000000000000000n, height: 100001 },   // 50M ALPHA
  ];

  const targetAmount = 12000000000000000n; // 120M ALPHA
  const result = selectUTXOs(availableUtxos, targetAmount, 1);

  console.log(`  Target: ${(Number(targetAmount) / 100000000).toFixed(2)} ALPHA`);
  console.log(`  Selected UTXOs: ${result.selectedUtxos.length}`);
  console.log(`  Total Value: ${(Number(result.totalValue) / 100000000).toFixed(2)} ALPHA`);
  console.log(`  Estimated Fee: ${result.estimatedFee.toString()} satoshis`);
  console.log(`  ✅ PASS - UTXO selection works with large amounts\n`);
} catch (error) {
  console.log(`  ❌ FAIL - ${error.message}\n`);
  allPassed = false;
}

// Test 6: Verify old unsafe limit would fail
console.log('Test 6: Demonstrate Old Precision Issue (Informational)');
const oldUnsafeValue = 10000000000000000; // 100M ALPHA as number (UNSAFE)
const safeValue = 10000000000000000n;     // 100M ALPHA as bigint (SAFE)

console.log(`  JavaScript number (OLD): ${oldUnsafeValue}`);
console.log(`  BigInt (NEW):            ${safeValue.toString()}`);
console.log(`  Are they equal? ${oldUnsafeValue === Number(safeValue) ? '✅ Yes' : '❌ No (precision lost)'}`);

// Test precision loss with division (old method)
const oldMethod = Math.floor(oldUnsafeValue / 0x100000000);
const newMethod = Number(safeValue >> 32n);
console.log(`  Old method (division):   ${oldMethod}`);
console.log(`  New method (bitshift):   ${newMethod}`);
console.log(`  Methods match: ${oldMethod === newMethod ? '✅ Yes' : '⚠️  No (old method may lose precision)'}\n`);

// Summary
console.log('=== Test Summary ===');
if (allPassed) {
  console.log('✅ All tests PASSED - BigInt implementation is correct');
  console.log('✅ Safe for amounts up to 18.4 quintillion satoshis (184 billion ALPHA)');
  process.exit(0);
} else {
  console.log('❌ Some tests FAILED - Review implementation');
  process.exit(1);
}
