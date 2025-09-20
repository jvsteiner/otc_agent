import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit } from '@otc-broker/core';
import * as crypto from 'crypto';

/**
 * Mock Unicity plugin for development/testing when Electrum is not available
 */
export class UnicityMockPlugin implements ChainPlugin {
  readonly chainId: ChainId = 'UNICITY';
  private config!: ChainConfig;
  private nextAddressIndex = 0;
  private mockBalances = new Map<string, string>();
  private mockDeposits = new Map<string, EscrowDeposit[]>();

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    console.log('🎭 Unicity Mock Plugin initialized (development mode)');
  }

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    if (asset !== 'ALPHA@UNICITY') {
      throw new Error(`Unicity plugin only supports ALPHA, not ${asset}`);
    }

    const seed = this.config.hotWalletSeed || 'default-seed';
    const index = this.nextAddressIndex++;
    const keyMaterial = crypto.createHash('sha256')
      .update(`${seed}-${index}`)
      .digest();
    
    // Generate mock address
    const address = 'UNI' + keyMaterial.toString('hex').substring(0, 30).toUpperCase();
    
    console.log(`🎭 Generated mock escrow address: ${address}`);
    
    return {
      chainId: this.chainId,
      address,
      keyRef: `unicity-mock-key-${index}`,
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

    // Return mock deposits if any
    const deposits = this.mockDeposits.get(address) || [];
    const confirmedDeposits = deposits.filter(d => d.confirms >= minConf);
    
    const totalConfirmed = confirmedDeposits.reduce((sum, d) => {
      return (parseFloat(sum) + parseFloat(d.amount)).toString();
    }, '0');
    
    return {
      address,
      asset,
      minConf,
      deposits: confirmedDeposits,
      totalConfirmed,
      updatedAt: new Date().toISOString(),
    };
  }

  async quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult> {
    // Mock price: $0.50 per ALPHA
    const alphaPrice = '0.50';
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

    // Generate mock transaction ID
    const txid = crypto.randomBytes(32).toString('hex');
    
    console.log(`🎭 Mock transaction: ${from.address} -> ${to}: ${amount} ALPHA`);
    console.log(`   TX ID: ${txid}`);
    
    return {
      txid,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: JSON.stringify(['mock-utxo-1']),
    };
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
    
    // In mock mode, always pass
    console.log(`🎭 Mock fee budget check passed for ${from.address}`);
  }

  async getTxConfirmations(txid: string): Promise<number> {
    // Return mock confirmations (simulate confirmed after some time)
    const mockConfirms = Math.floor(Math.random() * 10) + 1;
    console.log(`🎭 Mock confirmations for ${txid}: ${mockConfirms}`);
    return mockConfirms;
  }

  validateAddress(address: string): boolean {
    // Simple validation for mock addresses
    return address.startsWith('UNI') && address.length === 33;
  }

  // Mock method to simulate deposits (for testing)
  addMockDeposit(address: string, amount: string, confirms: number = 10) {
    const deposits = this.mockDeposits.get(address) || [];
    deposits.push({
      txid: crypto.randomBytes(32).toString('hex'),
      index: deposits.length,
      amount,
      asset: 'ALPHA@UNICITY',
      blockHeight: 1000000 + deposits.length,
      blockTime: new Date().toISOString(),
      confirms,
    });
    this.mockDeposits.set(address, deposits);
    console.log(`🎭 Added mock deposit: ${amount} ALPHA to ${address} (${confirms} confirms)`);
  }
}