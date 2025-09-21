import { ethers } from 'ethers';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit } from '@otc-broker/core';
import { 
  ChainPlugin, 
  ChainConfig,
  EscrowDepositsView,
  QuoteNativeForUSDResult,
  SubmittedTx,
  PriceQuote
} from './ChainPlugin';
import ERC20_ABI from './abi/ERC20.json';

export class EthereumPlugin implements ChainPlugin {
  readonly chainId: ChainId;
  private provider!: ethers.JsonRpcProvider;
  private config!: ChainConfig;
  private wallets: Map<string, ethers.HDNodeWallet> = new Map();
  private rootWallet?: ethers.HDNodeWallet;
  private walletIndex: number = 0;

  constructor(config?: Partial<ChainConfig>) {
    this.chainId = config?.chainId || 'ETH';
  }

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    
    // Default to PublicNode if no RPC URL provided
    const rpcUrl = cfg.rpcUrl || 'https://ethereum-rpc.publicnode.com';
    
    // Create provider with custom timeout settings
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true // Skip network detection to avoid timeout
    });
    
    // Initialize hot wallet if seed provided
    if (cfg.hotWalletSeed) {
      try {
        // Try to parse as BIP39 mnemonic phrase
        this.rootWallet = ethers.HDNodeWallet.fromPhrase(cfg.hotWalletSeed);
      } catch (e) {
        // If not a valid mnemonic, use it as a seed to derive a deterministic wallet
        // Create a deterministic private key from the seed string
        const seedHash = ethers.keccak256(ethers.toUtf8Bytes(cfg.hotWalletSeed));
        const wallet = new ethers.Wallet(seedHash);
        // Convert to HDNodeWallet for compatibility
        this.rootWallet = ethers.HDNodeWallet.fromSeed(ethers.getBytes(seedHash));
      }
    }
    
    // Test connection with retry logic
    let retries = 3;
    while (retries > 0) {
      try {
        const network = await Promise.race([
          this.provider.getNetwork(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Network detection timeout')), 5000))
        ]);
        console.log(`Connected to ${this.chainId} network`);
        break;
      } catch (error) {
        retries--;
        if (retries === 0) {
          console.error(`Failed to connect to ${this.chainId} after 3 attempts:`, error);
          // Don't throw - allow the plugin to initialize but log the warning
          console.warn(`WARNING: ${this.chainId} plugin initialized but network connectivity may be limited`);
        } else {
          console.warn(`Failed to connect to ${this.chainId}, retrying... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
  }

  async generateEscrowAccount(asset: AssetCode): Promise<EscrowAccountRef> {
    if (!this.rootWallet) {
      // Generate a new random wallet if no root wallet
      const wallet = ethers.Wallet.createRandom();
      const connectedWallet = wallet.connect(this.provider);
      
      const ref: EscrowAccountRef = {
        chainId: this.chainId,
        address: wallet.address,
        keyRef: wallet.privateKey
      };
      
      // Store wallet
      this.wallets.set(wallet.privateKey, connectedWallet as ethers.HDNodeWallet);
      
      return ref;
    }
    
    // Derive from HD wallet
    const index = this.walletIndex++;
    const path = `m/44'/60'/0'/0/${index}`;
    const childWallet = this.rootWallet.derivePath(path);
    const connectedWallet = childWallet.connect(this.provider);
    
    const ref: EscrowAccountRef = {
      chainId: this.chainId,
      address: childWallet.address,
      keyRef: path // Use path as keyRef for HD wallets
    };
    
    this.wallets.set(path, connectedWallet);
    
    return ref;
  }

  async getManagedAddress(ref: EscrowAccountRef): Promise<string> {
    if (ref.address) {
      return ref.address;
    }
    
    if (ref.keyRef) {
      const wallet = this.wallets.get(ref.keyRef);
      if (wallet) {
        return wallet.address;
      }
    }
    
    throw new Error(`No wallet found for ref: ${JSON.stringify(ref)}`);
  }

  async listConfirmedDeposits(
    asset: AssetCode,
    address: string,
    minConf: number,
    since?: string
  ): Promise<EscrowDepositsView> {
    const deposits: EscrowDeposit[] = [];
    let totalConfirmed = '0';
    
    try {
      const currentBlock = await this.provider.getBlockNumber();
      
      // For native currency, check balance
      // Support both simple and fully qualified asset names
      const isNative = asset === 'ETH' || asset === 'ETH@ETH' || 
                      asset === 'MATIC' || asset === 'MATIC@POLYGON';
      if (isNative) {
        const balance = await this.provider.getBalance(address);
        if (balance > 0n) {
          deposits.push({
            txid: 'balance',
            amount: ethers.formatEther(balance),
            asset: asset,
            confirms: minConf + 1 // Consider balance as confirmed
          });
          totalConfirmed = ethers.formatEther(balance);
        }
      } else if (asset.startsWith('ERC20:')) {
        // For ERC20 tokens
        const tokenAddress = asset.split(':')[1];
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const balance = await contract.balanceOf(address);
        const decimals = await contract.decimals();
        
        if (balance > 0n) {
          const formattedBalance = ethers.formatUnits(balance, decimals);
          deposits.push({
            txid: 'balance',
            amount: formattedBalance,
            asset: asset,
            confirms: minConf + 1
          });
          totalConfirmed = formattedBalance;
        }
      }
    } catch (error) {
      console.error(`Failed to list deposits:`, error);
    }
    
    return {
      address,
      asset,
      minConf,
      deposits,
      totalConfirmed,
      updatedAt: new Date().toISOString()
    };
  }

  async quoteNativeForUSD(usd: string): Promise<QuoteNativeForUSDResult> {
    // For demo purposes, using fixed rates
    // In production, this should fetch from Chainlink or another oracle
    const ethPriceUSD = this.chainId === 'POLYGON' ? 0.8 : 2000; // MATIC vs ETH
    const nativeAmount = parseFloat(usd) / ethPriceUSD;
    
    return {
      nativeAmount: nativeAmount.toFixed(8),
      quote: {
        pair: this.chainId === 'POLYGON' ? 'MATIC/USD' : 'ETH/USD',
        price: ethPriceUSD.toString(),
        asOf: new Date().toISOString(),
        source: 'MANUAL'
      }
    };
  }

  async send(
    asset: AssetCode,
    from: EscrowAccountRef,
    to: string,
    amount: string
  ): Promise<SubmittedTx> {
    if (!from.keyRef) {
      throw new Error(`No keyRef in EscrowAccountRef: ${JSON.stringify(from)}`);
    }
    
    let wallet = this.wallets.get(from.keyRef);
    if (!wallet) {
      // Try to recreate wallet from private key if it's a direct key
      if (from.keyRef.startsWith('0x')) {
        const newWallet = new ethers.Wallet(from.keyRef, this.provider);
        this.wallets.set(from.keyRef, newWallet as any);
        wallet = newWallet as any;
      } else if (from.keyRef.startsWith('m/') && this.rootWallet) {
        // Recreate HD wallet from path
        const childWallet = this.rootWallet.derivePath(from.keyRef);
        const connectedWallet = childWallet.connect(this.provider);
        this.wallets.set(from.keyRef, connectedWallet);
        wallet = connectedWallet;
      } else {
        throw new Error(`No wallet found for keyRef: ${from.keyRef}`);
      }
    }

    try {
      let tx: ethers.TransactionResponse;
      
      if (!wallet) {
        throw new Error(`Wallet not initialized`);
      }
      
      if (asset === 'ETH' || asset === 'MATIC') {
        // Native currency transfer
        const value = ethers.parseEther(amount);
        
        // Build transaction directly to avoid ENS resolution
        const nonce = await this.provider.getTransactionCount(wallet.address);
        const gasPrice = await this.provider.getFeeData();
        
        tx = await wallet.sendTransaction({
          to: to,
          value: value,
          nonce: nonce,
          gasPrice: gasPrice.gasPrice,
          gasLimit: 21000, // Standard ETH transfer gas limit
        });
      } else if (asset.startsWith('ERC20:')) {
        // ERC20 token transfer
        const tokenAddress = asset.split(':')[1];
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const decimals = await contract.decimals();
        const amountParsed = ethers.parseUnits(amount, decimals);
        
        tx = await contract.transfer(to, amountParsed);
      } else {
        throw new Error(`Unsupported asset: ${asset}`);
      }
      
      return {
        txid: tx.hash,
        submittedAt: new Date().toISOString(),
        nonceOrInputs: tx.nonce?.toString()
      };
    } catch (error) {
      console.error(`Failed to send transaction:`, error);
      throw error;
    }
  }

  async ensureFeeBudget(
    from: EscrowAccountRef,
    asset: AssetCode,
    intent: 'NATIVE' | 'TOKEN',
    minNative: string
  ): Promise<void> {
    const address = await this.getManagedAddress(from);
    const balance = await this.provider.getBalance(address);
    const balanceEth = ethers.formatEther(balance);
    
    if (parseFloat(balanceEth) < parseFloat(minNative)) {
      throw new Error(`Insufficient gas: have ${balanceEth}, need ${minNative}`);
    }
  }

  async getTxConfirmations(txid: string): Promise<number> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txid);
      if (!receipt) {
        return 0;
      }
      
      const currentBlock = await this.provider.getBlockNumber();
      return currentBlock - receipt.blockNumber + 1;
    } catch (error) {
      console.error(`Failed to get confirmations:`, error);
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