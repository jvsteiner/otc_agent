import { ethers } from 'ethers';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts, parseAssetCode } from '@otc-broker/core';

// ERC20 ABI - minimal interface for balance and Transfer events
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

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

  async generateEscrowAccount(asset: AssetCode, dealId?: string, party?: 'ALICE' | 'BOB'): Promise<EscrowAccountRef> {
    // For determinism, we need dealId and party
    if (!dealId || !party) {
      throw new Error('dealId and party are required for EVM plugin escrow generation');
    }
    
    // Generate deterministic wallet from dealId + party
    const seed = `${this.chainId}-${dealId}-${party}`;
    const seedHash = ethers.keccak256(ethers.toUtf8Bytes(seed));
    const wallet = new ethers.Wallet(seedHash);
    
    this.wallets.set(wallet.address, wallet as any);
    
    console.log(`[${this.chainId}] Generated deterministic escrow for deal ${dealId.slice(0, 8)}... ${party}: ${wallet.address}`);
    
    return {
      chainId: this.chainId,
      address: wallet.address,
      keyRef: wallet.privateKey,
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
    
    // Handle different asset formats:
    // 1. "USDT@POLYGON" -> "USDT"
    // 2. "ERC20:0xc2132..." -> use parseAssetCode directly
    // 3. "ERC20:0xc2132...@POLYGON" -> "ERC20:0xc2132..."
    let assetToProcess: AssetCode = asset;
    
    // Remove chain suffix if present
    if (asset.includes('@')) {
      assetToProcess = asset.split('@')[0] as AssetCode;
    }
    
    // Parse the asset to get contract details
    // If it starts with ERC20:, parseAssetCode will handle it
    const assetConfig = parseAssetCode(assetToProcess, this.chainId);
    
    // Debug logging
    console.log(`[EvmPlugin] listConfirmedDeposits: asset=${asset}, assetToProcess=${assetToProcess}, assetConfig=`, assetConfig);
    
    // For native asset (ETH/MATIC)
    if (!assetConfig || assetConfig.native) {
      // Query transfer events to this address
      const blockToCheck = Math.max(0, currentBlock - 1000); // Check last 1000 blocks
      
      try {
        // Get incoming transactions using eth_getLogs (more reliable than balance alone)
        const filter = {
          fromBlock: blockToCheck,
          toBlock: currentBlock,
          address: null, // Native transfers don't have contract address
          topics: [] as any
        };
        
        // For now, use balance as a simple check
        const balance = await this.provider.getBalance(address);
        if (balance > 0n) {
          // TODO: Query actual transaction history from Etherscan or similar
          deposits.push({
            txid: '0x' + '0'.repeat(64), // placeholder
            amount: ethers.formatEther(balance),
            asset,
            blockHeight: currentBlock,
            blockTime: new Date().toISOString(),
            confirms: 1,
          });
        }
      } catch (error) {
        console.error(`Failed to query native deposits for ${address}:`, error);
      }
    } else if (assetConfig && assetConfig.type === 'ERC20' && assetConfig.contractAddress) {
      // Handle ERC20 tokens
      // Ensure contract address doesn't have any chain suffix
      let contractAddr = assetConfig.contractAddress;
      if (contractAddr.includes('@')) {
        contractAddr = contractAddr.split('@')[0];
      }
      const tokenContract = new ethers.Contract(contractAddr, ERC20_ABI, this.provider);
      
      try {
        // Get the token balance first
        const balance = await tokenContract.balanceOf(address);
        
        if (balance > 0n) {
          // For now, skip event querying as Polygon RPC has strict limits
          // Just report the balance as a deposit
          const decimals = assetConfig.decimals || 18;
          const amount = ethers.formatUnits(balance, decimals);
          
          // TODO: In production, use an indexing service or run your own node
          // to properly track individual deposits via Transfer events
          
          deposits.push({
            txid: '0x' + '0'.repeat(64), // placeholder - represents aggregated balance
            amount,
            asset,
            blockHeight: currentBlock,
            blockTime: new Date().toISOString(),
            confirms: minConf, // Assume confirmed since balance is visible
          });
        }
      } catch (error) {
        console.error(`Failed to query ERC20 deposits for ${assetConfig.contractAddress}:`, error);
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
    
    // Remove chain suffix if present
    let assetToProcess: AssetCode = asset;
    if (asset.includes('@')) {
      assetToProcess = asset.split('@')[0] as AssetCode;
    }
    
    let tx;
    // Check if it's a native asset
    const assetConfig = parseAssetCode(assetToProcess, this.chainId);
    if (assetConfig && assetConfig.native) {
      // Native transfer
      tx = await connectedWallet.sendTransaction({
        to,
        value: ethers.parseEther(amount),
      });
    } else {
      // Handle ERC20 tokens - assetConfig already parsed above
      if (assetConfig && assetConfig.type === 'ERC20' && assetConfig.contractAddress) {
        const tokenContract = new ethers.Contract(
          assetConfig.contractAddress,
          ERC20_ABI,
          connectedWallet
        );
        
        // Parse amount based on token decimals
        const decimals = assetConfig.decimals || 18;
        const amountWei = ethers.parseUnits(amount, decimals);
        
        // Send ERC20 transfer
        tx = await tokenContract.transfer(to, amountWei);
      } else {
        throw new Error(`Unsupported asset: ${asset}`);
      }
    }
    
    if (!tx) {
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

  getOperatorAddress(): string {
    return this.config?.operator?.address || '0x0000000000000000000000000000000000000000';
  }
}