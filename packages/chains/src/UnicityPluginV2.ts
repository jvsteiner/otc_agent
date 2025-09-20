import WebSocket from 'ws';
import * as crypto from 'crypto';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts } from '@otc-broker/core';
import { UnicityKeyManager, UnicityKey } from './utils/UnicityKeyManager';

interface ElectrumRequest {
  id: number;
  method: string;
  params: any[];
}

interface ElectrumResponse {
  id: number;
  result?: any;
  error?: any;
}

export class UnicityPluginV2 implements ChainPlugin {
  readonly chainId: ChainId = 'UNICITY';
  private config!: ChainConfig;
  private ws: WebSocket | null = null;
  private requestId = 1;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private connected = false;
  private keyManager!: UnicityKeyManager;
  private escrowKeys = new Map<string, UnicityKey>();
  private nextKeyIndex = 0;

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    
    // Initialize key manager with seed
    const seed = cfg.hotWalletSeed || 'default-otc-broker-seed-' + Date.now();
    this.keyManager = new UnicityKeyManager(seed);
    
    // Load any existing keys from database (in production, you'd persist these)
    this.loadExistingKeys();
    
    await this.connect();
  }

  private loadExistingKeys() {
    // In production, load from database
    // For now, we'll just derive the first 100 keys
    for (let i = 0; i < 100; i++) {
      const key = this.keyManager.deriveKey(i);
      this.escrowKeys.set(key.address, key);
    }
    this.nextKeyIndex = 100;
  }

  private async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;

    const url = this.config.electrumUrl || 'wss://fulcrum.unicity.network:50004';
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        this.connected = true;
        console.log('Connected to Unicity Electrum server');
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const response: ElectrumResponse = JSON.parse(data.toString());
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error.message || response.error));
            } else {
              pending.resolve(response.result);
            }
          }
        } catch (error) {
          console.error('Failed to parse Electrum response:', error);
        }
      });

      this.ws.on('error', (error) => {
        this.connected = false;
        console.error('Electrum WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        // Auto-reconnect after 5 seconds
        setTimeout(() => this.connect().catch(console.error), 5000);
      });
    });
  }

  private async electrumRequest(method: string, params: any[]): Promise<any> {
    if (!this.connected || !this.ws) {
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });

      const request: ElectrumRequest = { id, method, params };
      this.ws!.send(JSON.stringify(request));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private addressToScriptHash(address: string): string {
    // Convert address to script, then to scripthash for Electrum
    const script = this.addressToScript(address);
    const hash = crypto.createHash('sha256').update(script).digest();
    return hash.reverse().toString('hex');
  }

  private addressToScript(address: string): Buffer {
    // Decode base58 address
    const decoded = this.base58Decode(address);
    
    // Extract public key hash (remove version byte and checksum)
    const pubKeyHash = decoded.slice(1, 21);
    
    // Build P2PKH script
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 <push 20 bytes>
      pubKeyHash,
      Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
    ]);
  }

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

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    // Derive next key
    const key = this.keyManager.deriveKey(this.nextKeyIndex++);
    this.escrowKeys.set(key.address, key);
    
    console.log(`Generated escrow address ${key.address} at index ${key.index}`);
    
    return {
      chainId: this.chainId,
      address: key.address,
      keyRef: `unicity-key-${key.index}`,
    };
  }

  async getManagedAddress(ref: EscrowAccountRef): Promise<string> {
    return ref.address;
  }

  /**
   * Get private key for an escrow address
   */
  getPrivateKey(address: string): UnicityKey | undefined {
    return this.escrowKeys.get(address);
  }

  /**
   * Export all escrow keys
   */
  exportEscrowKeys(): UnicityKey[] {
    return Array.from(this.escrowKeys.values());
  }

  /**
   * Export wallet data compatible with HTML wallet
   */
  exportForHtmlWallet(): {
    masterPrivateKey: string;
    masterPrivateKeyWIF: string;
    masterChainCode: string;
    escrowAddresses: Array<{
      address: string;
      privateKey: string;
      privateKeyWIF: string;
      index: number;
      path: string;
    }>;
  } {
    const walletData = this.keyManager.exportWalletData(this.nextKeyIndex);
    
    return {
      masterPrivateKey: walletData.masterPrivateKey,
      masterPrivateKeyWIF: walletData.masterPrivateKeyWIF,
      masterChainCode: walletData.masterChainCode,
      escrowAddresses: this.exportEscrowKeys().map(key => ({
        address: key.address,
        privateKey: key.privateKey,
        privateKeyWIF: key.wif,
        index: key.index,
        path: key.path
      }))
    };
  }

  async listConfirmedDeposits(
    asset: AssetCode,
    address: string,
    minConf: number,
    since?: string
  ): Promise<EscrowDepositsView> {
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    const scriptHash = this.addressToScriptHash(address);
    
    // Get UTXOs
    const utxos = await this.electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
    
    // Get current block height for confirmation calculation
    const headers = await this.electrumRequest('blockchain.headers.subscribe', []);
    const currentHeight = headers.height;
    
    const deposits: EscrowDeposit[] = [];
    
    for (const utxo of utxos) {
      const confirms = utxo.height > 0 ? currentHeight - utxo.height + 1 : 0;
      
      if (confirms >= minConf) {
        // Get transaction details for block time
        const tx = await this.electrumRequest('blockchain.transaction.get', [utxo.tx_hash, true]);
        
        deposits.push({
          txid: utxo.tx_hash,
          index: utxo.tx_pos,
          amount: (utxo.value / 100000000).toString(), // Convert from satoshis
          asset: 'ALPHA@UNICITY',
          blockHeight: utxo.height,
          blockTime: new Date(tx.time * 1000).toISOString(),
          confirms,
        });
      }
    }
    
    const totalConfirmed = sumAmounts(deposits.map(d => d.amount));
    
    return {
      address,
      asset,
      minConf,
      deposits,
      totalConfirmed,
      updatedAt: new Date().toISOString(),
    };
  }

  async quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult> {
    // For Unicity, we'll use a manual price or could integrate with an oracle
    const alphaPrice = '0.50'; // $0.50 per ALPHA
    const usdAmount = parseFloat(usd);
    const alphaAmount = (usdAmount / parseFloat(alphaPrice)).toFixed(8);
    
    return {
      nativeAmount: alphaAmount,
      quote: {
        pair: 'ALPHA/USD',
        price: alphaPrice,
        asOf: new Date().toISOString(),
        source: 'MANUAL',
      },
    };
  }

  async send(
    asset: AssetCode,
    from: EscrowAccountRef,
    to: string,
    amount: string
  ): Promise<SubmittedTx> {
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    // Get private key for the escrow address
    const key = this.escrowKeys.get(from.address);
    if (!key) {
      throw new Error(`No private key found for address ${from.address}`);
    }

    // Get UTXOs for the address
    const scriptHash = this.addressToScriptHash(from.address);
    const utxos = await this.electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
    
    if (!utxos.length) {
      throw new Error('No UTXOs available for spending');
    }
    
    // Build and sign transaction (simplified - needs real implementation)
    // In production, you'd use a proper Bitcoin/Unicity transaction builder
    const rawTx = await this.buildAndSignTransaction(key, utxos, to, amount);
    
    // Broadcast transaction
    const txid = await this.electrumRequest('blockchain.transaction.broadcast', [rawTx]);
    
    return {
      txid,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: JSON.stringify(utxos.map((u: any) => `${u.tx_hash}:${u.tx_pos}`)),
    };
  }

  private async buildAndSignTransaction(
    key: UnicityKey,
    utxos: any[],
    to: string,
    amount: string
  ): Promise<string> {
    // This is a placeholder - real implementation needs proper transaction building
    // You would use a library like bitcoinjs-lib or similar for Unicity
    // For now, return a dummy transaction
    console.log(`Building transaction from ${key.address} to ${to} for ${amount} ALPHA`);
    
    // In production:
    // 1. Select UTXOs for input
    // 2. Calculate change
    // 3. Build transaction structure
    // 4. Sign with private key
    // 5. Return serialized transaction
    
    return '01000000...'; // Placeholder raw transaction
  }

  async ensureFeeBudget(
    from: EscrowAccountRef,
    asset: AssetCode,
    intent: 'NATIVE' | 'TOKEN',
    minNative: string
  ): Promise<void> {
    if (intent === 'TOKEN') {
      throw new Error('Unicity does not support token transfers');
    }
    
    const deposits = await this.listConfirmedDeposits(
      'ALPHA@UNICITY',
      from.address,
      1,
    );
    
    const available = parseFloat(deposits.totalConfirmed);
    const required = parseFloat(minNative);
    
    if (available < required) {
      throw new Error(`Insufficient ALPHA for fees: have ${available}, need ${required}`);
    }
  }

  async getTxConfirmations(txid: string): Promise<number> {
    try {
      const tx = await this.electrumRequest('blockchain.transaction.get', [txid, true]);
      
      if (!tx || !tx.confirmations) {
        return 0;
      }
      
      return tx.confirmations;
    } catch (error) {
      console.error(`Failed to get confirmations for ${txid}:`, error);
      return 0;
    }
  }

  validateAddress(address: string): boolean {
    try {
      const decoded = this.base58Decode(address);
      
      // Check version byte (0x00 for mainnet P2PKH)
      if (decoded[0] !== 0x00) return false;
      
      // Check length (25 bytes: 1 version + 20 pubkey hash + 4 checksum)
      if (decoded.length !== 25) return false;
      
      // Verify checksum
      const payload = decoded.slice(0, 21);
      const checksum = decoded.slice(21, 25);
      
      const hash1 = crypto.createHash('sha256').update(payload).digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest();
      const expectedChecksum = hash2.slice(0, 4);
      
      return checksum.equals(expectedChecksum);
    } catch (error) {
      return false;
    }
  }
}