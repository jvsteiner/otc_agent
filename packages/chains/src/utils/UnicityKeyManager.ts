import * as crypto from 'crypto';
import { createHash } from 'crypto';
import * as elliptic from 'elliptic';

const ec = new elliptic.ec('secp256k1');

export interface UnicityKey {
  privateKey: string;  // hex format
  publicKey: string;   // hex format
  address: string;     // Unicity address
  wif: string;        // Wallet Import Format
  index: number;
  path: string;
}

export class UnicityKeyManager {
  private masterSeed: Buffer;
  private masterPrivateKey: string;
  private masterChainCode: string;

  constructor(seedPhrase: string) {
    // Generate master seed from seed phrase
    this.masterSeed = createHash('sha256').update(seedPhrase).digest();
    
    // Split into private key and chain code
    const seedHash = createHash('sha512').update(this.masterSeed).digest();
    this.masterPrivateKey = seedHash.slice(0, 32).toString('hex');
    this.masterChainCode = seedHash.slice(32, 64).toString('hex');
  }

  /**
   * Derive a key at a specific index using BIP32-like derivation
   */
  deriveKey(index: number, isChange: boolean = false): UnicityKey {
    const changeIndex = isChange ? 1 : 0;
    const path = `m/44'/0'/${changeIndex}/${index}`;
    
    // Simplified HD derivation (not full BIP32, but compatible with the wallet)
    const data = Buffer.concat([
      Buffer.from(this.masterPrivateKey, 'hex'),
      Buffer.from(this.masterChainCode, 'hex'),
      Buffer.from([changeIndex]),
      Buffer.from(index.toString())
    ]);
    
    const childHash = createHash('sha256').update(data).digest();
    const childPrivateKey = childHash.toString('hex');
    
    // Generate public key
    const keyPair = ec.keyFromPrivate(childPrivateKey);
    const publicKey = keyPair.getPublic('hex');
    const publicKeyCompressed = keyPair.getPublic(true, 'hex');
    
    // Generate Unicity address
    const address = this.publicKeyToAddress(publicKeyCompressed);
    
    // Convert to WIF
    const wif = this.hexToWIF(childPrivateKey);
    
    return {
      privateKey: childPrivateKey,
      publicKey: publicKeyCompressed,
      address,
      wif,
      index,
      path
    };
  }

  /**
   * Convert hex private key to WIF format (compatible with HTML wallet)
   */
  hexToWIF(hexPrivateKey: string): string {
    // Version byte for mainnet private key
    const versionByte = Buffer.from([0x80]);
    
    // Private key as buffer
    const privateKey = Buffer.from(hexPrivateKey, 'hex');
    
    // Add compression flag
    const compressionFlag = Buffer.from([0x01]);
    
    // Combine version + private key + compression flag
    const extendedKey = Buffer.concat([versionByte, privateKey, compressionFlag]);
    
    // Double SHA256 for checksum
    const hash1 = createHash('sha256').update(extendedKey).digest();
    const hash2 = createHash('sha256').update(hash1).digest();
    const checksum = hash2.slice(0, 4);
    
    // Final WIF
    const wifBytes = Buffer.concat([extendedKey, checksum]);
    return this.base58Encode(wifBytes);
  }

  /**
   * Convert WIF to hex private key
   */
  wifToHex(wif: string): string {
    const decoded = this.base58Decode(wif);
    
    // Remove version byte (first byte)
    // Remove checksum (last 4 bytes)
    // Remove compression flag if present (0x01 before checksum)
    let privateKeyEnd = decoded.length - 4; // Remove checksum
    if (decoded[privateKeyEnd - 1] === 0x01) {
      privateKeyEnd -= 1; // Remove compression flag
    }
    
    const privateKey = decoded.slice(1, privateKeyEnd);
    return privateKey.toString('hex');
  }

  /**
   * Generate Unicity address from public key
   */
  private publicKeyToAddress(publicKeyHex: string): string {
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    
    // SHA256 hash of public key
    const sha256Hash = createHash('sha256').update(publicKey).digest();
    
    // RIPEMD160 hash of the SHA256 hash
    const ripemd160Hash = createHash('ripemd160').update(sha256Hash).digest();
    
    // Add version byte (0x00 for mainnet P2PKH)
    const versionedPayload = Buffer.concat([Buffer.from([0x00]), ripemd160Hash]);
    
    // Double SHA256 for checksum
    const hash1 = createHash('sha256').update(versionedPayload).digest();
    const hash2 = createHash('sha256').update(hash1).digest();
    const checksum = hash2.slice(0, 4);
    
    // Final address bytes
    const addressBytes = Buffer.concat([versionedPayload, checksum]);
    
    // Base58 encode
    return this.base58Encode(addressBytes);
  }

  /**
   * Base58 encoding (Bitcoin/Unicity alphabet)
   */
  private base58Encode(buffer: Buffer): string {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + buffer.toString('hex'));
    let result = '';
    
    while (num > 0n) {
      const remainder = num % 58n;
      num = num / 58n;
      result = alphabet[Number(remainder)] + result;
    }
    
    // Add leading '1's for each leading zero byte
    for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
      result = '1' + result;
    }
    
    return result;
  }

  /**
   * Base58 decoding
   */
  private base58Decode(str: string): Buffer {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = 0n;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const value = alphabet.indexOf(char);
      if (value === -1) {
        throw new Error(`Invalid base58 character: ${char}`);
      }
      num = num * 58n + BigInt(value);
    }
    
    // Convert to hex and pad if necessary
    let hex = num.toString(16);
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    
    // Count leading '1's and add zero bytes
    let leadingZeros = 0;
    for (let i = 0; i < str.length && str[i] === '1'; i++) {
      leadingZeros++;
    }
    
    const zeros = Buffer.alloc(leadingZeros);
    const decoded = Buffer.from(hex, 'hex');
    
    return Buffer.concat([zeros, decoded]);
  }

  /**
   * Get master private key in hex format
   */
  getMasterPrivateKey(): string {
    return this.masterPrivateKey;
  }

  /**
   * Get master private key in WIF format
   */
  getMasterPrivateKeyWIF(): string {
    return this.hexToWIF(this.masterPrivateKey);
  }

  /**
   * Export wallet data compatible with HTML wallet
   */
  exportWalletData(addresses: number = 10): {
    masterPrivateKey: string;
    masterPrivateKeyWIF: string;
    masterChainCode: string;
    addresses: UnicityKey[];
  } {
    const derivedAddresses: UnicityKey[] = [];
    
    for (let i = 0; i < addresses; i++) {
      derivedAddresses.push(this.deriveKey(i));
    }
    
    return {
      masterPrivateKey: this.masterPrivateKey,
      masterPrivateKeyWIF: this.getMasterPrivateKeyWIF(),
      masterChainCode: this.masterChainCode,
      addresses: derivedAddresses
    };
  }
}