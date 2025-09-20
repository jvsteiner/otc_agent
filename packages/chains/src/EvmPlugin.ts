import { ethers } from 'ethers';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts } from '@otc-broker/core';

export class EvmPlugin implements ChainPlugin {
  readonly chainId: ChainId;
  private config!: ChainConfig;
  private provider!: ethers.JsonRpcProvider;
  private wallets = new Map<string, ethers.Wallet>();

  constructor(chainId: ChainId) {
    this.chainId = chainId;
  }

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  }

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    // Generate deterministic wallet from seed
    const seed = this.config.hotWalletSeed || 'default-seed';
    const index = Date.now();
    const wallet = ethers.Wallet.createRandom();
    
    this.wallets.set(wallet.address, wallet as any);
    
    return {
      chainId: this.chainId,
      address: wallet.address,
      keyRef: `evm-key-${index}`,
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
    const currentBlock = await this.provider.getBlockNumber();
    const deposits: EscrowDeposit[] = [];
    
    // For native asset (ETH/MATIC)
    if (asset === 'ETH' || asset === 'MATIC') {
      // Get transaction history (simplified - real implementation needs event logs)
      const balance = await this.provider.getBalance(address);
      
      // This is a placeholder - real implementation needs to track actual deposits
      if (balance > 0n) {
        deposits.push({
          txid: '0x' + '0'.repeat(64), // placeholder
          amount: ethers.formatEther(balance),
          asset,
          blockHeight: currentBlock,
          blockTime: new Date().toISOString(),
          confirms: 1,
        });
      }
    } else if (asset.startsWith('ERC20:')) {
      // Handle ERC20 tokens
      const tokenAddress = asset.substring(6);
      // Need to implement ERC20 balance and transfer tracking
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
    // Placeholder - real implementation would use Chainlink or other oracle
    const ethPrice = this.chainId === 'ETH' ? '3000' : '0.80'; // ETH or MATIC
    const usdAmount = parseFloat(usd);
    const nativeAmount = (usdAmount / parseFloat(ethPrice)).toFixed(18);
    
    return {
      nativeAmount,
      quote: {
        pair: `${this.chainId}/USD`,
        price: ethPrice,
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
    const wallet = this.wallets.get(from.address);
    if (!wallet) {
      throw new Error('Wallet not found for address: ' + from.address);
    }
    
    const connectedWallet = wallet.connect(this.provider);
    
    let tx;
    if (asset === 'ETH' || asset === 'MATIC') {
      // Native transfer
      tx = await connectedWallet.sendTransaction({
        to,
        value: ethers.parseEther(amount),
      });
    } else if (asset.startsWith('ERC20:')) {
      // ERC20 transfer - needs implementation
      throw new Error('ERC20 transfers not yet implemented');
    } else {
      throw new Error(`Unsupported asset: ${asset}`);
    }
    
    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
    };
  }

  async ensureFeeBudget(
    from: EscrowAccountRef,
    asset: AssetCode,
    intent: 'NATIVE' | 'TOKEN',
    minNative: string
  ): Promise<void> {
    const balance = await this.provider.getBalance(from.address);
    const required = ethers.parseEther(minNative);
    
    if (balance < required) {
      throw new Error(`Insufficient native balance for fees: have ${balance}, need ${required}`);
    }
  }

  async getTxConfirmations(txid: string): Promise<number> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txid);
      if (!receipt) return 0;
      
      const currentBlock = await this.provider.getBlockNumber();
      return currentBlock - receipt.blockNumber + 1;
    } catch (error) {
      return 0;
    }
  }

  validateAddress(address: string): boolean {
    return ethers.isAddress(address);
  }
}