import WebSocket from 'ws';
import * as crypto from 'crypto';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts } from '@otc-broker/core';

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

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;

    const url = this.config.electrumUrl || 'wss://fulcrum.unicity.network:50004';
    
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
    // Convert Unicity address to scripthash for Electrum
    // This is a simplified version - real implementation needs proper address decoding
    const script = this.addressToScript(address);
    const hash = crypto.createHash('sha256').update(script).digest();
    return hash.reverse().toString('hex');
  }

  private addressToScript(address: string): Buffer {
    // Simplified P2PKH script creation
    // Real implementation needs proper base58 decoding and script building
    // For now, return a dummy script
    const pubKeyHash = crypto.createHash('sha256').update(address).digest().slice(0, 20);
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 <push 20 bytes>
      pubKeyHash,
      Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
    ]);
  }

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    // Generate deterministic address from seed
    const seed = this.config.hotWalletSeed || 'default-seed';
    const index = Date.now(); // Simple index, should use proper HD derivation
    const keyMaterial = crypto.createHash('sha256')
      .update(`${seed}-${index}`)
      .digest();
    
    // Generate address (simplified - real implementation needs proper key derivation)
    const address = 'UNI' + keyMaterial.toString('hex').substring(0, 30);
    
    return {
      chainId: this.chainId,
      address,
      keyRef: `unicity-key-${index}`,
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
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    // Build and sign transaction
    // This is a simplified version - real implementation needs proper transaction building
    const scriptHash = this.addressToScriptHash(from.address);
    const utxos = await this.electrumRequest('blockchain.scripthash.listunspent', [scriptHash]);
    
    if (!utxos.length) {
      throw new Error('No UTXOs available for spending');
    }
    
    // Build raw transaction (simplified - needs real implementation)
    const rawTx = this.buildRawTransaction(utxos, to, amount);
    
    // Broadcast transaction
    const txid = await this.electrumRequest('blockchain.transaction.broadcast', [rawTx]);
    
    return {
      txid,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: JSON.stringify(utxos.map((u: any) => `${u.tx_hash}:${u.tx_pos}`)),
    };
  }

  private buildRawTransaction(utxos: any[], to: string, amount: string): string {
    // This is a placeholder - real implementation needs proper transaction building
    // including input selection, change calculation, signing, etc.
    return '0x' + crypto.randomBytes(200).toString('hex');
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
    // Simplified validation - check if it starts with UNI and has right length
    // Real implementation needs proper base58 validation
    return address.startsWith('UNI') && address.length === 33;
  }
}