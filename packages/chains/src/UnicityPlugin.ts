import WebSocket from 'ws';
import * as crypto from 'crypto';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts } from '@otc-broker/core';
import { generateDeterministicKey, deriveChildPrivateKey, privateKeyToAddress } from './utils/UnicityAddress';
import { buildAndSignSegWitTransaction, selectUTXOs, UTXO } from './utils/UnicityTransaction';

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

export class UnicityPlugin implements ChainPlugin {
  readonly chainId: ChainId = 'UNICITY';
  private config!: ChainConfig;
  private ws: WebSocket | null = null;
  private requestId = 1;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private connected = false;
  private wallets = new Map<string, { privateKey: string; address: string; index: number; wif: string }>();
  private nextWalletIndex = 0;
  private masterPrivateKey?: string;

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    
    // Initialize master private key from seed
    if (cfg.hotWalletSeed) {
      // Create a deterministic master key from the seed
      this.masterPrivateKey = crypto.createHash('sha256')
        .update(cfg.hotWalletSeed)
        .digest('hex');
      console.log('UnicityPlugin: Initialized with deterministic master key');
    } else {
      console.warn('UnicityPlugin: No hot wallet seed provided, using random keys');
    }
    
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;

    const url = this.config.electrumUrl || process.env.UNICITY_ELECTRUM || 'wss://fulcrum.unicity.network:50004';
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      
      this.ws.on('open', () => {
        this.connected = true;
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
    try {
      // Import bech32 module
      const bech32Module = require('bech32');
      
      // Decode the bech32 address to get the witness program
      const decoded = bech32Module.bech32.decode(address);
      
      if (!decoded) {
        throw new Error('Failed to decode bech32 address');
      }
      
      // First word is the witness version
      const witnessVersion = decoded.words[0];
      
      // Convert remaining words from 5-bit to 8-bit (excluding witness version)
      const witnessProgram = bech32Module.bech32.fromWords(decoded.words.slice(1));
      
      // Create the scriptPubKey for P2WPKH
      const scriptPubKey: number[] = [];
      
      // Add witness version (OP_0 for version 0, OP_1-16 for versions 1-16)
      if (witnessVersion === 0) {
        scriptPubKey.push(0x00); // OP_0
      } else if (witnessVersion <= 16) {
        scriptPubKey.push(0x50 + witnessVersion); // OP_1 through OP_16
      } else {
        throw new Error('Unsupported witness version');
      }
      
      // Add push opcode for witness program length
      scriptPubKey.push(witnessProgram.length);
      
      // Add witness program
      scriptPubKey.push(...witnessProgram);
      
      // Convert to Buffer and hash
      const script = Buffer.from(scriptPubKey);
      const hash = crypto.createHash('sha256').update(script).digest();
      
      // Reverse for Electrum (little-endian)
      return hash.reverse().toString('hex');
    } catch (error) {
      console.error('Error converting address to scripthash:', error);
      // Fallback to empty string
      return '';
    }
  }

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    console.log('UnicityPlugin.generateEscrowAccount called with asset:', asset);
    
    // Accept both ALPHA and ALPHA@UNICITY formats
    if (asset !== 'ALPHA@UNICITY' && asset !== 'ALPHA') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    let privateKey: string;
    let address: string;
    let wif: string;
    let keyRef: string;
    
    if (this.masterPrivateKey) {
      // Use deterministic derivation from master key
      const index = this.nextWalletIndex++;
      const walletInfo = generateDeterministicKey(this.masterPrivateKey, index);
      
      privateKey = walletInfo.privateKey;
      address = walletInfo.address;
      wif = walletInfo.wif;
      keyRef = `unicity-hd-${index}`;
      
      // Store wallet info for later use
      this.wallets.set(keyRef, {
        privateKey,
        address,
        index,
        wif
      });
      
      console.log(`Generated HD wallet at index ${index}: ${address}`);
    } else {
      // Generate random key if no master key
      const randomBytes = crypto.randomBytes(32);
      privateKey = randomBytes.toString('hex');
      address = privateKeyToAddress(privateKey);
      
      // Generate unique keyRef
      keyRef = `unicity-random-${Date.now()}`;
      
      // Store wallet info
      this.wallets.set(keyRef, {
        privateKey,
        address,
        index: -1,
        wif: '' // Will generate if needed
      });
      
      console.log(`Generated random wallet: ${address}`);
    }
    
    return {
      chainId: this.chainId,
      address,
      keyRef,
    };
  }

  async getManagedAddress(ref: EscrowAccountRef): Promise<string> {
    return ref.address;
  }

  async listConfirmedDeposits(
    asset: AssetCode,
    address: string,
    minConf: number,
    since?: string
  ): Promise<EscrowDepositsView> {
    // Accept both ALPHA and ALPHA@UNICITY formats
    if (asset !== 'ALPHA@UNICITY' && asset !== 'ALPHA') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    console.log(`[UnicityPlugin] listConfirmedDeposits called:`, {
      asset,
      address,
      minConf,
      since
    });

    const scriptHash = this.addressToScriptHash(address);
    console.log(`[UnicityPlugin] Script hash for ${address}: ${scriptHash}`);
    
    // Get UTXOs
    const utxos = await this.electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
    console.log(`[UnicityPlugin] Found ${utxos.length} UTXOs for address ${address}`);
    
    // Get current block height for confirmation calculation
    const headers = await this.electrumRequest('blockchain.headers.subscribe', []);
    const currentHeight = headers.height;
    console.log(`[UnicityPlugin] Current block height: ${currentHeight}`);
    
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
          asset: 'ALPHA@UNICITY', // Fully qualified asset name
          blockHeight: utxo.height,
          blockTime: new Date(tx.time * 1000).toISOString(),
          confirms,
        });
      }
    }
    
    const totalConfirmed = sumAmounts(deposits.map(d => d.amount));
    
    return {
      address,
      asset, // Return the original asset parameter
      minConf,
      deposits,
      totalConfirmed,
      updatedAt: new Date().toISOString(),
    };
  }

  async quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult> {
    // For Unicity, we'll use a manual price or could integrate with an oracle
    // This is a placeholder - real implementation would fetch from price feed
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
    // For UNICITY, when we need to send the total amount from multiple UTXOs,
    // we need to create multiple transactions (one per UTXO)
    // This method will handle the first transaction and queue the rest
    // Accept both ALPHA and ALPHA@UNICITY formats
    if (asset !== 'ALPHA@UNICITY' && asset !== 'ALPHA') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    // Get the wallet info for this escrow account
    let walletInfo = this.wallets.get(from.keyRef || '');
    if (!walletInfo && from.keyRef) {
      // Try to recreate wallet if it's an HD wallet
      if (from.keyRef.startsWith('unicity-hd-') && this.masterPrivateKey) {
        const index = parseInt(from.keyRef.replace('unicity-hd-', ''));
        const regeneratedWallet = generateDeterministicKey(this.masterPrivateKey, index);
        walletInfo = {
          privateKey: regeneratedWallet.privateKey,
          address: regeneratedWallet.address,
          index,
          wif: regeneratedWallet.wif
        };
        this.wallets.set(from.keyRef, walletInfo);
        console.log(`Recreated HD wallet at index ${index}: ${regeneratedWallet.address}`);
      }
    }
    
    if (!walletInfo) {
      throw new Error(`No wallet found for escrow account ${from.address}`);
    }

    // Get UTXOs for the address
    const scriptHash = this.addressToScriptHash(from.address);
    const utxos = await this.electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
    
    if (!utxos.length) {
      throw new Error('No UTXOs available for spending');
    }
    
    // Convert amount to satoshis
    const amountSatoshis = Math.floor(parseFloat(amount) * 100000000);
    
    // Check if we're trying to send the entire balance (for escrow returns)
    const totalAvailable = utxos.reduce((sum: number, utxo: UTXO) => sum + utxo.value, 0);
    const totalAvailableAlpha = totalAvailable / 100000000;
    
    // For UNICITY: each transaction can only use ONE input UTXO
    // If we need to send from multiple UTXOs, we need multiple transactions
    
    if (Math.abs(totalAvailableAlpha - parseFloat(amount)) < 0.000001) {
      // We're trying to send ALL funds from ALL UTXOs
      // We'll need to create multiple transactions, one per UTXO
      console.log(`[UNICITY] Sending entire balance from ${utxos.length} UTXOs requires ${utxos.length} transactions`);
      
      if (utxos.length === 0) {
        throw new Error('No UTXOs available to send');
      }
      
      // Process UTXOs one by one, sending each to the recipient
      let totalSent = 0;
      const txids: string[] = [];
      
      for (let i = 0; i < utxos.length; i++) {
        const utxo = utxos[i];
        console.log(`[UNICITY] Processing UTXO ${i + 1}/${utxos.length}: ${utxo.value} satoshis`);
        
        // Calculate fee for this single-input transaction
        const feeRate = 1; // 1 satoshi per byte
        const baseSize = 10 + 34; // overhead + 1 output (no change since we're sending all)
        const inputSize = 148;
        const estimatedSize = baseSize + inputSize;
        const fee = Math.ceil(estimatedSize * feeRate);
        
        // Amount to send from this UTXO (minus fee)
        const sendAmount = utxo.value - fee;
        
        if (sendAmount <= 0) {
          console.log(`[UNICITY] Skipping dust UTXO ${utxo.tx_hash}:${utxo.tx_pos} (value ${utxo.value} <= fee ${fee})`);
          continue;
        }
        
        console.log(`[UNICITY] Sending ${sendAmount / 100000000} ALPHA from UTXO ${utxo.tx_hash}:${utxo.tx_pos}`);
        
        // Build and sign transaction for this single UTXO
        const { hex: rawTx, txid } = buildAndSignSegWitTransaction(
          [utxo],
          [{ address: to, value: sendAmount }],
          walletInfo.privateKey,
          '', // No change output - sending entire UTXO minus fee
          feeRate
        );
        
        console.log(`[UNICITY] Broadcasting transaction ${txid}...`);
        
        // Broadcast transaction
        try {
          const broadcastResult = await this.electrumRequest('blockchain.transaction.broadcast', [rawTx]);
          
          if (broadcastResult !== txid) {
            console.warn(`Broadcast returned different txid: expected ${txid}, got ${broadcastResult}`);
          }
          
          console.log(`[UNICITY] Transaction ${txid} broadcast successfully`);
          txids.push(txid);
          totalSent += sendAmount;
        } catch (error) {
          console.error(`[UNICITY] Failed to broadcast transaction ${i + 1}:`, error);
          // Continue with remaining UTXOs even if one fails
        }
      }
      
      if (txids.length === 0) {
        throw new Error('Failed to send any transactions');
      }
      
      console.log(`[UNICITY] Sent ${txids.length} transactions, total ${totalSent / 100000000} ALPHA`);
      
      // Return the first transaction ID (we can't return all of them in current interface)
      return {
        txid: txids[0],
        submittedAt: new Date().toISOString(),
        nonceOrInputs: JSON.stringify(txids), // Store all txids in nonceOrInputs field
      };
      
    } else {
      // Normal send - find a single UTXO that can cover the amount
      const feeRate = 1; // 1 satoshi per byte
      
      // Find the smallest UTXO that can cover amount + fees
      let selectedUtxo = null;
      let estimatedFee = 0;
      
      for (const utxo of utxos.sort((a: UTXO, b: UTXO) => a.value - b.value)) {
        const baseSize = 10 + 34 + 34; // overhead + 1 output + 1 change output
        const inputSize = 148;
        const estimatedSize = baseSize + inputSize;
        estimatedFee = Math.ceil(estimatedSize * feeRate);
        
        if (utxo.value >= amountSatoshis + estimatedFee) {
          selectedUtxo = utxo;
          break;
        }
      }
      
      if (!selectedUtxo) {
        throw new Error(`No single UTXO large enough to cover ${amount} ALPHA plus fees`);
      }
      
      console.log(`[UNICITY] Sending ${amount} ALPHA using single UTXO`);
      console.log(`Selected UTXO with value ${selectedUtxo.value} satoshis`);
      console.log(`Estimated fee: ${estimatedFee} satoshis`);
      
      // Build and sign transaction
      const { hex: rawTx, txid } = buildAndSignSegWitTransaction(
        [selectedUtxo],
        [{ address: to, value: amountSatoshis }],
        walletInfo.privateKey,
        from.address, // Send change back to same address
        feeRate
      );
      
      console.log(`Built transaction ${txid}, broadcasting...`);
      
      // Broadcast transaction
      const broadcastResult = await this.electrumRequest('blockchain.transaction.broadcast', [rawTx]);
      
      // Electrum returns the txid on success, or throws on error
      if (broadcastResult !== txid) {
        console.warn(`Broadcast returned different txid: expected ${txid}, got ${broadcastResult}`);
      }
      
      console.log(`Transaction ${txid} broadcast successfully`);
      
      return {
        txid,
        submittedAt: new Date().toISOString(),
        nonceOrInputs: JSON.stringify([`${selectedUtxo.tx_hash}:${selectedUtxo.tx_pos}`]),
      };
    }
  }


  async ensureFeeBudget(
    from: EscrowAccountRef,
    asset: AssetCode,
    intent: 'NATIVE' | 'TOKEN',
    minNative: string
  ): Promise<void> {
    // For Unicity, we need ALPHA for fees
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
    // Support both bech32 (alpha...) and legacy (UNI...) formats
    // Bech32 format: alpha + 39 characters = 44 total
    // Legacy format: UNI + 30 characters = 33 total
    if (address.startsWith('alpha') && !address.startsWith('alpha1')) {
      // Basic bech32 validation for Unicity addresses
      // Only lowercase letters and numbers after the prefix (excluding 1, b, i, o)
      const bech32Chars = /^alpha[ac-hj-np-z02-9]{38,}$/;
      return bech32Chars.test(address.toLowerCase());
    }
    
    // Also support alpha1 format for compatibility
    if (address.startsWith('alpha1') && address.length === 45) {
      const bech32Chars = /^alpha1[a-z0-9]{39}$/;
      return bech32Chars.test(address);
    }
    
    // Legacy format validation
    if (address.startsWith('UNI') && address.length === 33) {
      return true;
    }
    
    return false;
  }

  getOperatorAddress(): string {
    return this.config?.operator?.address || 'alpha1qv003pgutceeewj4fzvpdy58rem3xf6lnlv88ku';
  }
}