import * as crypto from 'crypto';
import { bech32 } from 'bech32';
import * as secp256k1 from 'secp256k1';
// bs58 v5.0.0 exports directly
const bs58 = require('bs58');

/**
 * Convert hex string to bytes
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert bits for bech32 encoding
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
 * Derive a child private key using HMAC-SHA512 (for non-BIP32 wallets)
 * This matches the HTML wallet's derivation method
 */
export function deriveChildPrivateKey(masterPrivateKey: string, index: number): string {
  // Use the same path format as the HTML wallet
  const derivationPath = `m/44'/0'/${index}'`;
  
  // HMAC-SHA512 with master key as input and path as key
  const hmac = crypto.createHmac('sha512', derivationPath);
  hmac.update(Buffer.from(masterPrivateKey, 'hex'));
  const hmacOutput = hmac.digest('hex');
  
  // Take first 32 bytes (64 hex chars) as the child private key
  return hmacOutput.substring(0, 64);
}

/**
 * Generate a Unicity bech32 address from a private key
 * This matches the HTML wallet's address generation
 */
export function privateKeyToAddress(privateKey: string): string {
  // Get public key (compressed)
  const privateKeyBytes = Buffer.from(privateKey, 'hex');
  const publicKeyBytes = secp256k1.publicKeyCreate(privateKeyBytes, true);
  
  // SHA256 of public key
  const sha256Hash = crypto.createHash('sha256').update(publicKeyBytes).digest();
  
  // RIPEMD160 of SHA256
  const ripemd160Hash = crypto.createHash('ripemd160').update(sha256Hash).digest();
  
  // Create bech32 address with witness version 0
  const witnessVersion = 0;
  const data5bit = convertBits(Array.from(ripemd160Hash), 8, 5, true);
  const words = [witnessVersion, ...data5bit];
  
  // Encode as bech32 (note: using 'alpha' prefix, not 'alpha1')
  const address = bech32.encode('alpha', words);
  
  return address;
}

/**
 * Convert private key to WIF format (for import/export compatibility)
 */
export function privateKeyToWIF(privateKey: string): string {
  // Version byte for mainnet
  const versionByte = '80';
  
  // Add version byte
  let extendedKey = versionByte + privateKey;
  
  // Add compression flag (for compressed public keys)
  const compressionFlag = '01';
  extendedKey = extendedKey + compressionFlag;
  
  // Calculate double SHA-256 for checksum
  const firstSHA = crypto.createHash('sha256').update(Buffer.from(extendedKey, 'hex')).digest();
  const secondSHA = crypto.createHash('sha256').update(firstSHA).digest();
  
  // Get checksum (first 4 bytes)
  const checksum = secondSHA.slice(0, 4).toString('hex');
  
  // Append checksum
  const finalKey = extendedKey + checksum;
  
  // Convert to base58
  return bs58.encode(Buffer.from(finalKey, 'hex'));
}

/**
 * Convert WIF to private key hex
 */
export function wifToPrivateKey(wif: string): string {
  const decoded = bs58.decode(wif);
  
  // Remove version byte (1 byte), compression flag (1 byte), and checksum (4 bytes)
  // Private key is bytes 1-33 (32 bytes)
  const privateKey = decoded.slice(1, 33);
  
  return privateKey.toString('hex');
}

/**
 * Generate a deterministic private key from a seed and index
 * This is used for HD wallet derivation
 */
export function generateDeterministicKey(seed: string, index: number): {
  privateKey: string;
  address: string;
  wif: string;
} {
  // Derive the child private key
  const childPrivateKey = deriveChildPrivateKey(seed, index);
  
  // Generate address
  const address = privateKeyToAddress(childPrivateKey);
  
  // Generate WIF
  const wif = privateKeyToWIF(childPrivateKey);
  
  return {
    privateKey: childPrivateKey,
    address,
    wif
  };
}