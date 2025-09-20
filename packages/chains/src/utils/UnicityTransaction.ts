import * as crypto from 'crypto';
import * as secp256k1 from 'secp256k1';
import { bech32 } from 'bech32';

interface UTXO {
  tx_hash: string;
  tx_pos: number;
  value: number; // in satoshis
  height: number;
}

interface TxOutput {
  address: string;
  value: number; // in satoshis
}

interface SignedTransaction {
  hex: string;
  txid: string;
}

/**
 * Convert bits for bech32 decoding
 */
function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    acc = (acc << fromBits) | value;
    bits += fromBits;
    
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  
  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  }
  
  return ret;
}

/**
 * Decode a bech32 address to get the witness program
 */
function decodeBech32Address(address: string): { witnessVersion: number; witnessProgram: Buffer } {
  const decoded = bech32.decode(address);
  const words = decoded.words;
  
  if (words.length === 0) {
    throw new Error('Invalid bech32 address');
  }
  
  const witnessVersion = words[0];
  const witnessProgram = Buffer.from(convertBits(words.slice(1), 5, 8, false));
  
  return { witnessVersion, witnessProgram };
}

/**
 * Create a P2WPKH scriptPubKey from a bech32 address
 */
function createScriptPubKey(address: string): Buffer {
  const { witnessVersion, witnessProgram } = decodeBech32Address(address);
  
  // P2WPKH: OP_0 <20-byte-key-hash>
  if (witnessVersion !== 0 || witnessProgram.length !== 20) {
    throw new Error('Only P2WPKH addresses are supported');
  }
  
  // OP_0 (0x00) + push 20 bytes (0x14) + key hash
  return Buffer.concat([
    Buffer.from([0x00, 0x14]),
    witnessProgram
  ]);
}

/**
 * Create a variable-length integer
 */
function createVarInt(value: number): Buffer {
  if (value < 0xfd) {
    return Buffer.from([value]);
  } else if (value <= 0xffff) {
    return Buffer.concat([
      Buffer.from([0xfd]),
      Buffer.from([(value & 0xff), ((value >> 8) & 0xff)])
    ]);
  } else if (value <= 0xffffffff) {
    return Buffer.concat([
      Buffer.from([0xfe]),
      Buffer.from([
        (value & 0xff),
        ((value >> 8) & 0xff),
        ((value >> 16) & 0xff),
        ((value >> 24) & 0xff)
      ])
    ]);
  } else {
    throw new Error('Value too large for varint');
  }
}

/**
 * Build and sign a SegWit transaction
 */
export function buildAndSignSegWitTransaction(
  utxos: UTXO[],
  outputs: TxOutput[],
  privateKeyHex: string,
  changeAddress: string,
  feeRate: number = 1 // satoshis per byte
): SignedTransaction {
  // Get key pair
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  const publicKeyBytes = Buffer.from(secp256k1.publicKeyCreate(privateKeyBytes, true));
  
  // Calculate total input value
  const totalInput = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  
  // Calculate total output value
  const totalOutput = outputs.reduce((sum, out) => sum + out.value, 0);
  
  // Estimate transaction size (approximate)
  // Base size: ~10 bytes overhead + (148 bytes per input) + (34 bytes per output)
  const estimatedSize = 10 + (utxos.length * 148) + ((outputs.length + 1) * 34); // +1 for change output
  const fee = Math.ceil(estimatedSize * feeRate);
  
  // Calculate change
  const change = totalInput - totalOutput - fee;
  
  if (change < 0) {
    throw new Error('Insufficient funds: total input less than output + fees');
  }
  
  // Add change output if significant (more than dust threshold)
  const dustThreshold = 546; // satoshis
  if (change > dustThreshold) {
    outputs.push({
      address: changeAddress,
      value: change
    });
  }
  
  // Build the transaction
  let tx = Buffer.alloc(0);
  
  // Version (4 bytes, little-endian)
  tx = Buffer.concat([tx, Buffer.from([0x02, 0x00, 0x00, 0x00])]);
  
  // Marker and flag for SegWit
  tx = Buffer.concat([tx, Buffer.from([0x00, 0x01])]);
  
  // Input count
  tx = Buffer.concat([tx, createVarInt(utxos.length)]);
  
  // Inputs
  for (const utxo of utxos) {
    // Previous tx hash (32 bytes, reversed for little-endian)
    const txidBytes = Buffer.from(utxo.tx_hash, 'hex').reverse();
    tx = Buffer.concat([tx, txidBytes]);
    
    // Previous output index (4 bytes, little-endian)
    const vout = Buffer.allocUnsafe(4);
    vout.writeUInt32LE(utxo.tx_pos, 0);
    tx = Buffer.concat([tx, vout]);
    
    // Script length (0 for witness transactions)
    tx = Buffer.concat([tx, Buffer.from([0x00])]);
    
    // Sequence
    tx = Buffer.concat([tx, Buffer.from([0xfe, 0xff, 0xff, 0xff])]);
  }
  
  // Output count
  tx = Buffer.concat([tx, createVarInt(outputs.length)]);
  
  // Outputs
  for (const output of outputs) {
    // Amount (8 bytes, little-endian)
    const amount = Buffer.allocUnsafe(8);
    // JavaScript can't handle 64-bit integers directly, so we need to be careful
    amount.writeUInt32LE(output.value & 0xffffffff, 0);
    amount.writeUInt32LE(Math.floor(output.value / 0x100000000), 4);
    tx = Buffer.concat([tx, amount]);
    
    // Script pubkey
    const scriptPubKey = createScriptPubKey(output.address);
    tx = Buffer.concat([tx, createVarInt(scriptPubKey.length)]);
    tx = Buffer.concat([tx, scriptPubKey]);
  }
  
  // Witness data for each input
  for (const utxo of utxos) {
    // Create signature hash (BIP143)
    const sigHash = createBIP143SignatureHash(
      utxos,
      outputs,
      utxos.indexOf(utxo),
      utxo.value,
      publicKeyBytes
    );
    
    // Sign the hash
    const signature = secp256k1.ecdsaSign(sigHash, privateKeyBytes);
    
    // Create DER-encoded signature
    const derSignature = Buffer.from(secp256k1.signatureExport(signature.signature));
    
    // Add SIGHASH_ALL flag
    const sigWithHashType = Buffer.concat([derSignature, Buffer.from([0x01])]);
    
    // Build witness: 2 items (signature and public key)
    tx = Buffer.concat([tx, Buffer.from([0x02])]); // 2 stack items
    tx = Buffer.concat([tx, createVarInt(sigWithHashType.length)]);
    tx = Buffer.concat([tx, sigWithHashType]);
    tx = Buffer.concat([tx, createVarInt(publicKeyBytes.length)]);
    tx = Buffer.concat([tx, publicKeyBytes]);
  }
  
  // Locktime (4 bytes)
  tx = Buffer.concat([tx, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
  
  // Calculate transaction ID (without witness data)
  const txidData = createNonWitnessData(utxos, outputs);
  const txidHash1 = crypto.createHash('sha256').update(txidData).digest();
  const txidHash2 = crypto.createHash('sha256').update(txidHash1).digest();
  const txid = txidHash2.reverse().toString('hex');
  
  return {
    hex: tx.toString('hex'),
    txid
  };
}

/**
 * Create non-witness transaction data for txid calculation
 */
function createNonWitnessData(utxos: UTXO[], outputs: TxOutput[]): Buffer {
  let data = Buffer.alloc(0);
  
  // Version
  data = Buffer.concat([data, Buffer.from([0x02, 0x00, 0x00, 0x00])]);
  
  // Input count
  data = Buffer.concat([data, createVarInt(utxos.length)]);
  
  // Inputs
  for (const utxo of utxos) {
    // Previous tx hash (reversed)
    const txidBytes = Buffer.from(utxo.tx_hash, 'hex').reverse();
    data = Buffer.concat([data, txidBytes]);
    
    // Previous output index
    const vout = Buffer.allocUnsafe(4);
    vout.writeUInt32LE(utxo.tx_pos, 0);
    data = Buffer.concat([data, vout]);
    
    // Script sig (empty for P2WPKH)
    data = Buffer.concat([data, Buffer.from([0x00])]);
    
    // Sequence
    data = Buffer.concat([data, Buffer.from([0xfe, 0xff, 0xff, 0xff])]);
  }
  
  // Output count
  data = Buffer.concat([data, createVarInt(outputs.length)]);
  
  // Outputs
  for (const output of outputs) {
    // Amount
    const amount = Buffer.allocUnsafe(8);
    amount.writeUInt32LE(output.value & 0xffffffff, 0);
    amount.writeUInt32LE(Math.floor(output.value / 0x100000000), 4);
    data = Buffer.concat([data, amount]);
    
    // Script pubkey
    const scriptPubKey = createScriptPubKey(output.address);
    data = Buffer.concat([data, createVarInt(scriptPubKey.length)]);
    data = Buffer.concat([data, scriptPubKey]);
  }
  
  // Locktime
  data = Buffer.concat([data, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
  
  return data;
}

/**
 * Create BIP143 signature hash for SegWit
 */
function createBIP143SignatureHash(
  utxos: UTXO[],
  outputs: TxOutput[],
  inputIndex: number,
  amount: number,
  publicKey: Buffer
): Buffer {
  let preimage = Buffer.alloc(0);
  
  // 1. nVersion (4 bytes, little-endian)
  preimage = Buffer.concat([preimage, Buffer.from([0x02, 0x00, 0x00, 0x00])]);
  
  // 2. hashPrevouts (32 bytes)
  let prevouts = Buffer.alloc(0);
  for (const utxo of utxos) {
    const txidBytes = Buffer.from(utxo.tx_hash, 'hex').reverse();
    prevouts = Buffer.concat([prevouts, txidBytes]);
    const vout = Buffer.allocUnsafe(4);
    vout.writeUInt32LE(utxo.tx_pos, 0);
    prevouts = Buffer.concat([prevouts, vout]);
  }
  const hashPrevouts = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(prevouts).digest()
  ).digest();
  preimage = Buffer.concat([preimage, hashPrevouts]);
  
  // 3. hashSequence (32 bytes)
  let sequences = Buffer.alloc(0);
  for (let i = 0; i < utxos.length; i++) {
    sequences = Buffer.concat([sequences, Buffer.from([0xfe, 0xff, 0xff, 0xff])]);
  }
  const hashSequence = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(sequences).digest()
  ).digest();
  preimage = Buffer.concat([preimage, hashSequence]);
  
  // 4. outpoint (36 bytes)
  const currentUtxo = utxos[inputIndex];
  const outpointTxid = Buffer.from(currentUtxo.tx_hash, 'hex').reverse();
  preimage = Buffer.concat([preimage, outpointTxid]);
  const outpointVout = Buffer.allocUnsafe(4);
  outpointVout.writeUInt32LE(currentUtxo.tx_pos, 0);
  preimage = Buffer.concat([preimage, outpointVout]);
  
  // 5. scriptCode (for P2WPKH)
  // P2PKH script: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const pubKeyHash = crypto.createHash('ripemd160').update(
    crypto.createHash('sha256').update(publicKey).digest()
  ).digest();
  const scriptCode = Buffer.concat([
    Buffer.from([0x19]), // length
    Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 <push 20>
    pubKeyHash,
    Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
  ]);
  preimage = Buffer.concat([preimage, scriptCode]);
  
  // 6. amount (8 bytes, little-endian)
  const amountBuffer = Buffer.allocUnsafe(8);
  amountBuffer.writeUInt32LE(amount & 0xffffffff, 0);
  amountBuffer.writeUInt32LE(Math.floor(amount / 0x100000000), 4);
  preimage = Buffer.concat([preimage, amountBuffer]);
  
  // 7. nSequence (4 bytes, little-endian)
  preimage = Buffer.concat([preimage, Buffer.from([0xfe, 0xff, 0xff, 0xff])]);
  
  // 8. hashOutputs (32 bytes)
  let outputsBuffer = Buffer.alloc(0);
  for (const output of outputs) {
    const outputAmount = Buffer.allocUnsafe(8);
    outputAmount.writeUInt32LE(output.value & 0xffffffff, 0);
    outputAmount.writeUInt32LE(Math.floor(output.value / 0x100000000), 4);
    outputsBuffer = Buffer.concat([outputsBuffer, outputAmount]);
    
    const scriptPubKey = createScriptPubKey(output.address);
    outputsBuffer = Buffer.concat([outputsBuffer, createVarInt(scriptPubKey.length)]);
    outputsBuffer = Buffer.concat([outputsBuffer, scriptPubKey]);
  }
  const hashOutputs = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(outputsBuffer).digest()
  ).digest();
  preimage = Buffer.concat([preimage, hashOutputs]);
  
  // 9. nLocktime (4 bytes, little-endian)
  preimage = Buffer.concat([preimage, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
  
  // 10. sighash type (4 bytes, little-endian)
  preimage = Buffer.concat([preimage, Buffer.from([0x01, 0x00, 0x00, 0x00])]); // SIGHASH_ALL
  
  // Double SHA256
  const hash1 = crypto.createHash('sha256').update(preimage).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  
  return hash2;
}

/**
 * Select UTXOs for a transaction
 */
export function selectUTXOs(
  availableUtxos: UTXO[],
  targetAmount: number,
  feeRate: number = 1
): { selectedUtxos: UTXO[]; totalValue: number; estimatedFee: number } {
  // Sort UTXOs by value (largest first for efficiency)
  const sortedUtxos = [...availableUtxos].sort((a, b) => b.value - a.value);
  
  const selectedUtxos: UTXO[] = [];
  let totalValue = 0;
  
  // Estimate base transaction size
  const baseSize = 10 + 34; // overhead + 1 output
  const inputSize = 148; // approximate size per input
  const changeOutputSize = 34;
  
  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    totalValue += utxo.value;
    
    // Calculate estimated fee with current inputs
    const estimatedSize = baseSize + (selectedUtxos.length * inputSize) + changeOutputSize;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    
    // Check if we have enough
    if (totalValue >= targetAmount + estimatedFee) {
      return { selectedUtxos, totalValue, estimatedFee };
    }
  }
  
  // Not enough UTXOs
  throw new Error('Insufficient UTXOs to cover amount and fees');
}