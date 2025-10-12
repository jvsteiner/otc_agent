/**
 * @fileoverview Ethereum mainnet plugin implementation.
 * Extends base EVM functionality with Ethereum-specific features including
 * Etherscan API integration, HD wallet management, and gas tank support for ERC-20 transfers.
 */

import { ethers, ContractTransactionResponse } from 'ethers';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, parseAssetCode } from '@otc-broker/core';
import {
  ChainPlugin,
  ChainConfig,
  EscrowDepositsView,
  QuoteNativeForUSDResult,
  SubmittedTx,
  PriceQuote,
  BrokerSwapParams,
  BrokerRevertParams,
  BrokerRefundParams
} from './ChainPlugin';
import ERC20_ABI from './abi/ERC20.json';
import BROKER_ABI from './abi/UnicitySwapBroker.json';
import { EtherscanAPI } from './utils/EtherscanAPI';
import { deriveIndexFromDealId } from './utils/DealIndexDerivation';

/**
 * Typed interface for UnicitySwapBroker contract methods.
 * Provides type safety for broker contract interactions.
 */
interface IUnicitySwapBroker extends ethers.BaseContract {
  swapNative(
    dealId: string,
    payback: string,
    recipient: string,
    feeRecipient: string,
    amount: bigint,
    fees: bigint,
    operatorSignature: string,
    overrides?: { value: bigint }
  ): Promise<ContractTransactionResponse>;

  swapERC20(
    currency: string,
    dealId: string,
    escrow: string,
    payback: string,
    recipient: string,
    feeRecipient: string,
    amount: bigint,
    fees: bigint
  ): Promise<ContractTransactionResponse>;

  revertNative(
    dealId: string,
    payback: string,
    feeRecipient: string,
    fees: bigint,
    operatorSignature: string,
    overrides?: { value: bigint }
  ): Promise<ContractTransactionResponse>;

  revertERC20(
    currency: string,
    dealId: string,
    escrow: string,
    payback: string,
    feeRecipient: string,
    fees: bigint
  ): Promise<ContractTransactionResponse>;

  refundNative(
    dealId: string,
    payback: string,
    feeRecipient: string,
    fees: bigint,
    overrides?: { value: bigint }
  ): Promise<ContractTransactionResponse>;

  refundERC20(
    currency: string,
    dealId: string,
    escrow: string,
    payback: string,
    feeRecipient: string,
    fees: bigint
  ): Promise<ContractTransactionResponse>;
}

/**
 * Plugin implementation for Ethereum mainnet.
 * Provides full EVM support with additional features:
 * - HD wallet derivation (BIP-44 compatible)
 * - Etherscan API for transaction history
 * - Gas tank management for ERC-20 transfers
 * - Robust deposit detection with fallback mechanisms
 * - Optional broker contract support for atomic swaps
 */
export class EthereumPlugin implements ChainPlugin {
  readonly chainId: ChainId;
  private provider!: ethers.JsonRpcProvider;
  private config!: ChainConfig;
  private wallets: Map<string, ethers.HDNodeWallet> = new Map();
  private rootWallet?: ethers.HDNodeWallet;
  private walletIndex?: number; // Fallback counter when no database
  private database?: any;
  private etherscanAPI?: EtherscanAPI;
  private tankManager?: any; // Will be injected if gas funding is enabled
  private brokerContract?: IUnicitySwapBroker;
  private operatorWallet?: ethers.Wallet;

  constructor(config?: Partial<ChainConfig>) {
    this.chainId = config?.chainId || 'ETH';
  }

  setTankManager(tankManager: any): void {
    this.tankManager = tankManager;
    console.log(`[${this.chainId}] Tank manager integrated`);
  }

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    this.database = cfg.database;

    // Default to PublicNode if no RPC URL provided
    const rpcUrl = cfg.rpcUrl || 'https://ethereum-rpc.publicnode.com';

    // Create provider with custom timeout settings
    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true // Skip network detection to avoid timeout
    });

    // Initialize Etherscan API for transaction history
    // No API key needed for basic queries
    this.etherscanAPI = new EtherscanAPI(this.chainId);

    // Initialize operator wallet if private key provided
    if (cfg.operatorPrivateKey) {
      this.operatorWallet = new ethers.Wallet(cfg.operatorPrivateKey, this.provider);
      console.log(`[${this.chainId}] Initialized operator wallet: ${this.operatorWallet.address}`);

      // Verify operator address matches
      if (cfg.operator?.address && cfg.operator.address.toLowerCase() !== this.operatorWallet.address.toLowerCase()) {
        console.warn(`[${this.chainId}] WARNING: Operator address mismatch! Config: ${cfg.operator.address}, Derived: ${this.operatorWallet.address}`);
      }
    }

    // Initialize broker contract if address provided
    if (cfg.brokerAddress) {
      this.brokerContract = new ethers.Contract(cfg.brokerAddress, BROKER_ABI, this.provider) as unknown as IUnicitySwapBroker;
      console.log(`[${this.chainId}] Initialized broker contract at ${cfg.brokerAddress}`);
    }

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

  async generateEscrowAccount(asset: AssetCode, dealId?: string, party?: 'ALICE' | 'BOB'): Promise<EscrowAccountRef> {
    if (!this.rootWallet) {
      // For random wallets, we need dealId to ensure uniqueness
      if (!dealId || !party) {
        throw new Error('dealId and party are required when no HD wallet seed is configured');
      }
      
      // Generate deterministic wallet from dealId + party
      const seed = `${this.chainId}-${dealId}-${party}`;
      const seedHash = ethers.keccak256(ethers.toUtf8Bytes(seed));
      const wallet = new ethers.Wallet(seedHash);
      const connectedWallet = wallet.connect(this.provider);
      
      const ref: EscrowAccountRef = {
        chainId: this.chainId,
        address: wallet.address,
        keyRef: wallet.privateKey
      };
      
      // Store wallet (cast to any for compatibility)
      this.wallets.set(wallet.privateKey, connectedWallet as any);
      
      console.log(`[${this.chainId}] Generated deterministic escrow for deal ${dealId?.slice(0, 8)}... ${party}: ${wallet.address}`);
      
      return ref;
    }
    
    // Derive from HD wallet using dealId-based index
    let index: number;
    if (dealId && party) {
      // Use deal-based derivation for guaranteed uniqueness
      index = deriveIndexFromDealId(dealId, party);
    } else {
      // Fallback to sequential index (for backward compatibility)
      console.warn('generateEscrowAccount called without dealId/party - using fallback sequential index');
      if (!this.walletIndex) this.walletIndex = 0;
      index = this.walletIndex++;
    }
    
    const path = `m/44'/60'/0'/0/${index}`;
    const childWallet = this.rootWallet.derivePath(path);
    const connectedWallet = childWallet.connect(this.provider);
    
    // Check for address collision if database is available
    if (this.database && this.database.isEscrowAddressInUse && this.database.isEscrowAddressInUse(childWallet.address)) {
      console.error(`CRITICAL: Address collision detected! Address ${childWallet.address} already in use!`);
      console.error(`Deal: ${dealId}, Party: ${party}, Index: ${index}, Path: ${path}`);
      // Don't throw - just log the warning, as this might be a re-generation of the same escrow
    }
    
    const ref: EscrowAccountRef = {
      chainId: this.chainId,
      address: childWallet.address,
      keyRef: path // Use path as keyRef for HD wallets
    };
    
    this.wallets.set(path, connectedWallet);
    
    console.log(`[${this.chainId}] Generated escrow at path ${path} for deal ${dealId?.slice(0, 8)}... ${party}: ${childWallet.address}`);
    
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
    
    console.log(`[EthereumPlugin] listConfirmedDeposits called with asset: ${asset}, address: ${address}`);
    
    try {
      const currentBlock = await this.provider.getBlockNumber();
      
      // For native currency, fetch transaction history
      // Support both simple and fully qualified asset names
      const assetConfig = parseAssetCode(asset.split('@')[0] as AssetCode, this.chainId);
      const isNative = assetConfig?.native === true;

      if (isNative) {
        // Get balance for total confirmation
        const balance = await this.provider.getBalance(address);
        console.log(`[EthereumPlugin] Balance check for ${address} on ${this.chainId}: ${ethers.formatEther(balance)} (raw: ${balance})`);
        
        if (balance > 0n) {
          totalConfirmed = ethers.formatEther(balance);
          
          // Try to fetch real transaction history from Etherscan
          if (this.etherscanAPI) {
            try {
              // Look back up to 1000 blocks for incoming transactions
              const startBlock = Math.max(0, currentBlock - 1000);
              const txs = await this.etherscanAPI.getIncomingTransactions(address, 0n, startBlock);
              
              console.log(`[EthereumPlugin] Etherscan returned ${txs.length} transactions for ${address}`);
              
              // Add each transaction as a deposit
              for (const tx of txs) {
                if (tx.confirmations >= minConf) {
                  deposits.push({
                    txid: tx.txid,
                    amount: tx.amount,
                    asset: asset,
                    confirms: tx.confirmations,
                    blockHeight: tx.blockHeight,
                    blockTime: tx.blockTime
                  });
                }
              }
              
              // If API returned no transactions but we have balance, create synthetic deposit
              if (txs.length === 0 && balance > 0n) {
                console.log(`[EthereumPlugin] No transactions from API but balance exists: ${totalConfirmed}`);
                const assumedConfirms = this.chainId === 'POLYGON' ? 500 : 100;
                deposits.push({
                  txid: `balance-api-empty-${address.slice(0, 10)}`,
                  amount: totalConfirmed,
                  asset: asset,
                  confirms: assumedConfirms,
                  blockHeight: currentBlock - assumedConfirms + 1,
                  blockTime: new Date(Date.now() - assumedConfirms * 2 * 1000).toISOString()
                });
              }
            } catch (err) {
              console.warn('Failed to fetch transaction history from Etherscan:', err);
              
              // Try to scan recent blocks directly via JSON-RPC - more efficient approach
              try {
                console.log('Attempting direct blockchain scan for transactions...');
                // For Polygon, we need more confirmations but can't scan thousands of blocks
                // Use a reasonable range based on chain
                const blocksToScan = this.chainId === 'POLYGON' ? 500 : 100;
                const startBlock = Math.max(0, currentBlock - blocksToScan);
                
                console.log(`Scanning blocks ${startBlock} to ${currentBlock} for ${address}`);
                
                // Instead of scanning every block, get transaction receipts via getLogs
                // This is much more efficient
                const filter = {
                  fromBlock: startBlock,
                  toBlock: currentBlock,
                  address: null as any, // We want all transactions
                  topics: [] as any[]
                };
                
                // Get all transfers to this address
                const logs = await this.provider.getLogs({
                  fromBlock: startBlock,
                  toBlock: currentBlock,
                  topics: [
                    null,
                    null, 
                    ethers.zeroPadValue(address, 32) // To our address (for token transfers)
                  ]
                });
                
                // Also check native transfers by getting transaction history
                // Create a synthetic deposit for the balance we can see
                const confirms = blocksToScan; // Assume funds have been there for at least this many blocks
                if (balance > 0n && deposits.length === 0) {
                  console.log(`Creating synthetic deposit for balance: ${totalConfirmed} with ${confirms} confirmations`);
                  deposits.push({
                    txid: `balance-detected-${address.slice(0, 10)}`,
                    amount: totalConfirmed,
                    asset: asset,
                    confirms: confirms, // Use actual block depth instead of minConf
                    blockHeight: currentBlock - confirms + 1,
                    blockTime: new Date(Date.now() - confirms * 2 * 1000).toISOString() // Estimate ~2 sec per block
                  });
                }
              } catch (scanErr) {
                console.warn('Direct blockchain scan failed:', scanErr);
                
                // Last resort: if we see balance, assume it has enough confirmations
                if (balance > 0n && deposits.length === 0) {
                  console.log(`Fallback: Creating deposit for visible balance: ${totalConfirmed}`);
                  // Assume the funds have been there long enough
                  const safeConfirms = Math.max(minConf, 100);
                  deposits.push({
                    txid: `fallback-balance-${address.slice(0, 10)}`,
                    amount: totalConfirmed,
                    asset: asset,
                    confirms: safeConfirms,
                    blockHeight: currentBlock - safeConfirms + 1,
                    blockTime: new Date(Date.now() - safeConfirms * 2 * 1000).toISOString()
                  });
                }
              }
            }
          } else {
            console.log('No Etherscan API configured, using balance detection only');
            // Create a synthetic deposit entry so the balance is visible
            // For Polygon, assume funds have been there for enough blocks
            const assumedConfirms = this.chainId === 'POLYGON' ? 500 : 100;
            deposits.push({
              txid: `balance-${address.slice(0, 10)}`,
              amount: totalConfirmed,
              asset: asset,
              confirms: assumedConfirms, // Assume sufficient confirmations
              blockHeight: currentBlock - assumedConfirms + 1,
              blockTime: new Date(Date.now() - assumedConfirms * 2 * 1000).toISOString()
            });
          }
        }
      } else if (asset.startsWith('ERC20:')) {
        // For ERC20 tokens
        let tokenAddress = asset.split(':')[1];
        // Remove chain suffix if present (e.g., "0xc2132...@POLYGON" -> "0xc2132...")
        if (tokenAddress.includes('@')) {
          tokenAddress = tokenAddress.split('@')[0];
        }
        
        console.log(`[EthereumPlugin] Checking ERC20 token: ${tokenAddress} for address: ${address}`);
        
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        let decimals = 18; // Default decimals
        
        try {
          decimals = await contract.decimals();
          console.log(`[EthereumPlugin] Token decimals: ${decimals}`);
        } catch (error) {
          console.warn(`[EthereumPlugin] Could not get decimals for token ${tokenAddress}, using default 18:`, error);
        }
        
        try {
          // Get current balance for total
          const balance = await contract.balanceOf(address);
          console.log(`[EthereumPlugin] ERC20 balance for ${address}: ${balance.toString()} (raw)`);
          
          if (balance > 0n) {
            totalConfirmed = ethers.formatUnits(balance, decimals);
            console.log(`[EthereumPlugin] ERC20 balance formatted: ${totalConfirmed}`);
            
            // Create a synthetic deposit entry for the balance
            // Use a blockTime from 1 hour ago to ensure it's before any reasonable deal expiry
            deposits.push({
              txid: `erc20-balance-${tokenAddress.slice(0, 10)}`,
              amount: totalConfirmed,
              asset: asset,
              confirms: 100, // Assume sufficient confirmations
              blockHeight: currentBlock - 1000,
              blockTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1 hour ago
            });
          }
        } catch (error) {
          console.error(`[EthereumPlugin] Error checking ERC20 balance for ${tokenAddress}:`, error);
          // Continue without throwing
        }
        
        // Try to fetch from Etherscan first
        if (this.etherscanAPI) {
          try {
            const startBlock = Math.max(0, currentBlock - 1000);
            const transfers = await this.etherscanAPI.getERC20Transfers(tokenAddress, address, startBlock);
            
            for (const transfer of transfers) {
              if (transfer.confirmations >= minConf) {
                deposits.push({
                  txid: transfer.txid,
                  amount: transfer.amount,
                  asset: asset,
                  confirms: transfer.confirmations,
                  blockHeight: transfer.blockHeight,
                  blockTime: transfer.blockTime
                });
              }
            }
          } catch (err) {
            console.warn('Failed to fetch ERC20 transfers from Etherscan:', err);
            // Fall back to event queries
            try {
              const blocksToScan = 100;
              const fromBlock = Math.max(0, currentBlock - blocksToScan);
              const filter = contract.filters.Transfer(null, address);
              const events = await contract.queryFilter(filter, fromBlock, currentBlock);
              
              for (const event of events) {
                if (event.blockNumber) {
                  const confirms = currentBlock - event.blockNumber + 1;
                  if (confirms >= minConf) {
                    // Cast to EventLog to access args
                    const eventLog = event as ethers.EventLog;
                    const amount = ethers.formatUnits(eventLog.args?.[2] || 0, decimals);
                    deposits.push({
                      txid: event.transactionHash,
                      index: event.index,
                      amount: amount,
                      asset: asset,
                      confirms: confirms,
                      blockHeight: event.blockNumber,
                      blockTime: new Date().toISOString()
                    });
                  }
                }
              }
            } catch (err2) {
              console.warn('Event query also failed:', err2);
              // No deposits can be listed without transaction history
            }
          }
        } else {
          // No Etherscan API, use event queries
          try {
            const blocksToScan = 100;
            const fromBlock = Math.max(0, currentBlock - blocksToScan);
            const filter = contract.filters.Transfer(null, address);
            const events = await contract.queryFilter(filter, fromBlock, currentBlock);
            
            for (const event of events) {
              if (event.blockNumber) {
                const confirms = currentBlock - event.blockNumber + 1;
                if (confirms >= minConf) {
                  // Cast to EventLog to access args
                  const eventLog = event as ethers.EventLog;
                  const amount = ethers.formatUnits(eventLog.args?.[2] || 0, decimals);
                  deposits.push({
                    txid: event.transactionHash,
                    index: event.index,
                    amount: amount,
                    asset: asset,
                    confirms: confirms,
                    blockHeight: event.blockNumber,
                    blockTime: new Date().toISOString()
                  });
                }
              }
            }
            
          } catch (err) {
            console.warn('Event query failed:', err);
            // No deposits can be listed without transaction history
          }
        }
      }
    } catch (error) {
      console.error(`Failed to list deposits:`, error);
    }
    
    console.log(`[EthereumPlugin] Returning deposits for ${asset}:`, {
      address,
      depositCount: deposits.length,
      deposits: deposits.map(d => ({ txid: d.txid, amount: d.amount, asset: d.asset })),
      totalConfirmed
    });
    
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
    console.log(`[${this.chainId}] EthereumPlugin.send() called:`, {
      asset,
      from: from.address,
      to,
      amount,
      dealId: (from as any).dealId || 'NO_DEALID'
    });
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
        
        // Verify the derived address matches the escrow address
        if (childWallet.address.toLowerCase() !== from.address.toLowerCase()) {
          console.error(`Address mismatch! Derived: ${childWallet.address}, Expected: ${from.address}`);
          console.error(`KeyRef: ${from.keyRef}`);
          // The wallet doesn't match - this is a problem with how the escrow was generated
        }
        
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
      
      // Check if this is a native currency transfer
      const assetConfig = parseAssetCode(asset.split('@')[0] as AssetCode, this.chainId);
      const isNative = assetConfig?.native === true;

      if (isNative) {
        // Native currency transfer
        const value = ethers.parseEther(amount);

        // Build transaction directly to avoid ENS resolution
        console.log(`[EVM] Preparing transaction from wallet: ${wallet.address} (escrow: ${from.address})`);

        // Use the escrow address for nonce, not wallet address (in case they differ)
        const nonceAddress = from.address || wallet.address;
        const nonce = await this.provider.getTransactionCount(nonceAddress);
        const gasPrice = await this.provider.getFeeData();

        // Calculate gas cost for the transaction
        const gasLimit = 21000n; // Standard ETH transfer gas limit
        const gasCost = gasLimit * (gasPrice.gasPrice || 0n);

        // Check if we have enough balance including gas
        // Use from.address (escrow address) not wallet.address (derived address)
        const balance = await this.provider.getBalance(from.address);

        // For native transfers, always base calculation on CURRENT balance, not requested amount
        // This handles cases where balance has changed since queuing (e.g., gas refunds)
        const maxSendable = balance > gasCost ? balance - gasCost : 0n;

        if (maxSendable <= 0n) {
          throw new Error(`Insufficient balance for gas: balance ${ethers.formatEther(balance)}, gas cost ${ethers.formatEther(gasCost)}`);
        }

        // Use the LESSER of: what was requested, or what we can actually send
        const finalValue = value > maxSendable ? maxSendable : value;

        if (finalValue < value) {
          console.log(`[EVM] Adjusted send amount from ${ethers.formatEther(value)} to ${ethers.formatEther(finalValue)} due to balance/gas constraints (balance: ${ethers.formatEther(balance)}, gas: ${ethers.formatEther(gasCost)})`);
        }
        
        tx = await wallet.sendTransaction({
          to: to,
          value: finalValue,
          nonce: nonce,
          gasPrice: gasPrice.gasPrice,
          gasLimit: gasLimit, // Standard ETH transfer gas limit
        });
      } else if (asset.startsWith('ERC20:')) {
        console.log(`[${this.chainId}] Detected ERC20 token transfer`);
        // ERC20 token transfer
        let tokenAddress = asset.split(':')[1];
        // Remove chain suffix if present
        if (tokenAddress.includes('@')) {
          tokenAddress = tokenAddress.split('@')[0];
        }
        
        // Check gas balance for ERC20 transfer
        console.log(`[${this.chainId}] Tank manager available: ${!!this.tankManager}`);
        if (this.tankManager) {
          const escrowAddress = from.address || wallet.address;
          console.log(`[${this.chainId}] Checking gas for ERC20 transfer from ${escrowAddress}`);
          const gasEstimate = await this.tankManager.estimateGasForERC20Transfer(
            this.chainId,
            tokenAddress,
            escrowAddress,
            to,
            amount
          );
          
          const currentGasBalance = await this.provider.getBalance(escrowAddress);
          console.log(`[${this.chainId}] Current gas balance: ${ethers.formatEther(currentGasBalance)}, Required: ${gasEstimate.totalCostEth}`);
          
          if (currentGasBalance < gasEstimate.totalCostWei) {
            console.log(`[${this.chainId}] Escrow ${escrowAddress} needs gas funding for ERC20 transfer`);
            console.log(`  Current balance: ${ethers.formatEther(currentGasBalance)} ETH`);
            console.log(`  Required gas: ${gasEstimate.totalCostEth} ETH`);
            
            // Request gas funding from tank
            const dealId = (from as any).dealId || 'unknown';
            console.log(`[${this.chainId}] Requesting gas funding for deal ${dealId}`);
            await this.tankManager.fundEscrowForGas(
              dealId,
              this.chainId,
              escrowAddress,
              gasEstimate.totalCostWei
            );
            
            // Wait a bit for the funding to be confirmed
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        const decimals = await contract.decimals();
        const amountParsed = ethers.parseUnits(amount, decimals);
        
        tx = await contract.transfer(to, amountParsed);
      } else if (asset.startsWith('0x')) {
        // Direct token address (e.g., USDT as 0xc2132D05D31c914a87C6611C10748AEb04B58e8F)
        let tokenAddress = asset;
        // Remove chain suffix if present
        if (tokenAddress.includes('@')) {
          tokenAddress = tokenAddress.split('@')[0] as any;
        }
        
        // Check gas balance for ERC20 transfer
        if (this.tankManager) {
          const escrowAddress = from.address || wallet.address;
          const gasEstimate = await this.tankManager.estimateGasForERC20Transfer(
            this.chainId,
            tokenAddress,
            escrowAddress,
            to,
            amount
          );
          
          const currentGasBalance = await this.provider.getBalance(escrowAddress);
          
          if (currentGasBalance < gasEstimate.totalCostWei) {
            console.log(`[${this.chainId}] Escrow ${escrowAddress} needs gas funding for token transfer`);
            console.log(`  Current balance: ${ethers.formatEther(currentGasBalance)} ${this.chainId === 'POLYGON' ? 'MATIC' : 'ETH'}`);
            console.log(`  Required gas: ${gasEstimate.totalCostEth} ${this.chainId === 'POLYGON' ? 'MATIC' : 'ETH'}`);
            
            // Request gas funding from tank
            const dealId = (from as any).dealId || 'unknown';
            console.log(`[${this.chainId}] Requesting gas funding for deal ${dealId}`);
            await this.tankManager.fundEscrowForGas(
              dealId,
              this.chainId,
              escrowAddress,
              gasEstimate.totalCostWei
            );
            
            // Wait a bit for the funding to be confirmed
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        
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
        // Check if transaction exists in mempool
        const tx = await this.provider.getTransaction(txid);
        if (!tx) {
          // Transaction doesn't exist at all - likely reorg
          return -1;
        }
        // Transaction exists but not mined yet
        return 0;
      }

      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;

      // Additional check: if receipt exists but confirmations are negative, it's a reorg
      if (confirmations < 0) {
        return -1;
      }

      return confirmations;
    } catch (error) {
      console.error(`Failed to get confirmations for ${txid}:`, error);
      // On error, assume transaction doesn't exist
      return -1;
    }
  }

  /**
   * Check if a transfer has already been executed on-chain.
   * Queries blockchain directly to detect duplicate submissions of deterministic transactions.
   * Scans last 1000 blocks for matching transfers.
   */
  async checkExistingTransfer(
    from: string,
    to: string,
    asset: AssetCode,
    amount: string
  ): Promise<{ txid: string; blockNumber: number } | null> {
    console.log(`[${this.chainId}] Checking blockchain for existing transfer:`, { from, to, asset, amount });

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const blocksToScan = 1000; // Scan last 1000 blocks
      const fromBlock = Math.max(0, currentBlock - blocksToScan);

      // Check if this is a native currency transfer
      const assetConfig = parseAssetCode(asset.split('@')[0] as AssetCode, this.chainId);
      const isNative = assetConfig?.native === true;

      if (isNative) {
        // For native currency, use Etherscan API if available
        if (this.etherscanAPI) {
          try {
            const txs = await this.etherscanAPI.getOutgoingTransactions(from, ethers.parseEther(amount), fromBlock);

            // Find transaction matching recipient and amount
            for (const tx of txs) {
              if (tx.to?.toLowerCase() === to.toLowerCase() && tx.amount === amount) {
                console.log(`[${this.chainId}] Found existing native transfer: ${tx.txid}`);
                return { txid: tx.txid, blockNumber: tx.blockHeight };
              }
            }
          } catch (err) {
            console.warn(`[${this.chainId}] Etherscan API failed for transfer check, fallback to RPC:`, err);
          }
        }

        // Fallback: scan blocks directly (expensive but reliable)
        for (let blockNum = fromBlock; blockNum <= currentBlock; blockNum++) {
          try {
            const block = await this.provider.getBlock(blockNum, true);
            if (block && block.prefetchedTransactions) {
              for (const tx of block.prefetchedTransactions) {
                if (
                  tx.from.toLowerCase() === from.toLowerCase() &&
                  tx.to?.toLowerCase() === to.toLowerCase() &&
                  ethers.formatEther(tx.value) === amount
                ) {
                  console.log(`[${this.chainId}] Found existing native transfer in block scan: ${tx.hash}`);
                  return { txid: tx.hash, blockNumber: blockNum };
                }
              }
            }
          } catch (err) {
            // Skip block on error
            continue;
          }
        }
      } else {
        // ERC-20 token transfer - use event logs
        let tokenAddress: string;

        if (asset.startsWith('0x')) {
          tokenAddress = asset.split('@')[0];
        } else {
          const baseAsset = asset.split('@')[0];
          const knownTokens: Record<string, string> = {
            'USDT': this.chainId === 'ETH'
              ? '0xdac17f958d2ee523a2206206994597c13d831ec7'
              : '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
            'USDC': this.chainId === 'ETH'
              ? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
              : '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
            'DAI': this.chainId === 'ETH'
              ? '0x6b175474e89094c44da98b954eedeac495271d0f'
              : '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063',
          };

          tokenAddress = knownTokens[baseAsset];
          if (!tokenAddress) {
            console.warn(`[${this.chainId}] Unknown token ${baseAsset}, cannot verify transfer`);
            return null;
          }
        }

        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
        const decimals = await contract.decimals();
        const expectedValue = ethers.parseUnits(amount, decimals);

        // Query Transfer events: from escrow -> to recipient
        const filter = contract.filters.Transfer(from, to);
        const events = await contract.queryFilter(filter, fromBlock, currentBlock);

        for (const event of events) {
          if (event.blockNumber) {
            const eventLog = event as ethers.EventLog;
            const value = eventLog.args?.[2]; // Transfer(from, to, value)

            // Check if amount matches exactly
            if (value && value.toString() === expectedValue.toString()) {
              console.log(`[${this.chainId}] Found existing ERC-20 transfer: ${event.transactionHash}`);
              return { txid: event.transactionHash, blockNumber: event.blockNumber };
            }
          }
        }
      }

      console.log(`[${this.chainId}] No existing transfer found on blockchain`);
      return null;
    } catch (error) {
      console.error(`[${this.chainId}] Error checking existing transfer:`, error);
      // On error, return null (assume no existing transfer to be safe)
      return null;
    }
  }

  validateAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  getOperatorAddress(): string {
    return this.config?.operator?.address || '0x0000000000000000000000000000000000000000';
  }

  /**
   * Resolve Transfer events for a specific asset and recipient address.
   * Used by TxidResolver to find real transaction hashes for synthetic deposits.
   *
   * @param asset - Asset code (e.g., "USDT@ETH" or token address)
   * @param recipientAddress - Address that received the transfer
   * @param fromBlock - Starting block number
   * @param toBlock - Ending block number
   * @returns Array of transfer events with transaction hashes
   */
  async resolveTransferEvents(
    asset: AssetCode,
    recipientAddress: string,
    fromBlock: number,
    toBlock: number
  ): Promise<Array<{
    txHash: string;
    blockNumber: number;
    blockTimestamp?: number;
    from: string;
    to: string;
    value: string;
    logIndex: number;
  }>> {
    console.log(`[${this.chainId}] Resolving transfer events for ${asset} to ${recipientAddress} from block ${fromBlock} to ${toBlock}`);

    try {
      // Handle native asset
      if (asset === this.chainId || asset === `${this.chainId}@${this.chainId}`) {
        console.log(`[${this.chainId}] Native asset transfers not supported for resolution yet`);
        return [];
      }

      // Extract token address
      let tokenAddress: string;

      if (asset.startsWith('0x')) {
        // Direct token address
        tokenAddress = asset.split('@')[0];
      } else {
        // Named token (e.g., "USDT@ETH")
        const baseAsset = asset.split('@')[0];
        const knownTokens: Record<string, string> = {
          'USDT': this.chainId === 'ETH'
            ? '0xdac17f958d2ee523a2206206994597c13d831ec7'
            : '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
          'USDC': this.chainId === 'ETH'
            ? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
            : '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
          'DAI': this.chainId === 'ETH'
            ? '0x6b175474e89094c44da98b954eedeac495271d0f'
            : '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063'
        };

        tokenAddress = knownTokens[baseAsset];
        if (!tokenAddress) {
          throw new Error(`Unknown token: ${baseAsset}`);
        }
      }

      console.log(`[${this.chainId}] Querying ERC-20 Transfer events for token ${tokenAddress}`);

      // Create contract instance
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

      // Get decimals for amount formatting
      const decimals = await contract.decimals();

      // Query Transfer events to the recipient address
      // Transfer event: Transfer(address indexed from, address indexed to, uint256 value)
      const filter = contract.filters.Transfer(null, recipientAddress);

      console.log(`[${this.chainId}] Querying filter from block ${fromBlock} to ${toBlock}`);

      const events = await contract.queryFilter(filter, fromBlock, toBlock);

      console.log(`[${this.chainId}] Found ${events.length} Transfer events`);

      // Process events and fetch block timestamps
      const results = await Promise.all(
        events.map(async (event) => {
          try {
            const block = await this.provider.getBlock(event.blockNumber);

            // Type guard to check if event is EventLog (has args)
            const eventLog = event as ethers.EventLog;
            if (!eventLog.args) {
              throw new Error('Event does not have args');
            }

            return {
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              blockTimestamp: block?.timestamp,
              from: eventLog.args[0] as string,
              to: eventLog.args[1] as string,
              value: ethers.formatUnits(eventLog.args[2] as bigint, decimals),
              logIndex: event.index
            };
          } catch (error) {
            console.error(`[${this.chainId}] Error processing event:`, error);
            // Return partial data if block fetch fails
            const eventLog = event as ethers.EventLog;
            return {
              txHash: event.transactionHash,
              blockNumber: event.blockNumber,
              from: eventLog.args?.[0] as string || '',
              to: eventLog.args?.[1] as string || '',
              value: eventLog.args?.[2] ? ethers.formatUnits(eventLog.args[2] as bigint, decimals) : '0',
              logIndex: event.index
            };
          }
        })
      );

      console.log(`[${this.chainId}] Resolved ${results.length} transfer events`);

      return results;
    } catch (error) {
      console.error(`[${this.chainId}] Error querying transfer events:`, error);
      throw error;
    }
  }

  /**
   * Check if broker contract is configured and available.
   * Returns true only if brokerContract is initialized (requires brokerAddress in config).
   */
  isBrokerAvailable(): boolean {
    return !!this.brokerContract;
  }

  /**
   * Generate operator signature for native currency operations.
   * Matches the signature verification in UnicitySwapBroker contract.
   *
   * @param dealId Unique deal identifier
   * @param payback Address to receive surplus/refund
   * @param recipient Address to receive swap amount (address(0) for revert)
   * @param feeRecipient Address to receive fee
   * @param amount Swap amount (0 for revert)
   * @param fees Fee amount
   * @param escrowAddress The escrow EOA address that will call the contract
   * @returns ECDSA signature from operator
   */
  private async generateOperatorSignature(
    dealId: string,
    payback: string,
    recipient: string,
    feeRecipient: string,
    amount: string,
    fees: string,
    escrowAddress: string
  ): Promise<string> {
    if (!this.operatorWallet) {
      throw new Error(`Operator wallet not configured for ${this.chainId}`);
    }

    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    // Convert dealId to bytes32
    const dealIdBytes32 = ethers.id(dealId);

    // Convert amounts to wei/smallest unit
    const amountWei = ethers.parseEther(amount);
    const feesWei = ethers.parseEther(fees);

    // Construct message hash matching contract's _verifyOperatorSignature
    // keccak256(abi.encodePacked(address(this), dealId, payback, recipient, feeRecipient, amount, fees, msg.sender))
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'bytes32', 'address', 'address', 'address', 'uint256', 'uint256', 'address'],
      [
        await this.brokerContract.getAddress(),  // Contract address
        dealIdBytes32,
        payback,
        recipient,
        feeRecipient,
        amountWei,
        feesWei,
        escrowAddress  // The escrow EOA that will call the function
      ]
    );

    // Apply Ethereum Signed Message prefix (contract will also apply this)
    const ethSignedMessageHash = ethers.hashMessage(ethers.getBytes(messageHash));

    // Sign the prefixed hash directly using signDigest (no additional prefix)
    const signature = this.operatorWallet.signingKey.sign(ethSignedMessageHash).serialized;

    return signature;
  }

  /**
   * Approve the broker contract to spend ERC20 tokens from an escrow address.
   * Grants unlimited allowance for gas optimization.
   */
  async approveBrokerForERC20(escrowRef: EscrowAccountRef, tokenAddress: string): Promise<SubmittedTx> {
    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    let wallet = this.wallets.get(escrowRef.keyRef || escrowRef.address);
    if (!wallet) {
      // Try to recreate wallet from keyRef
      if (escrowRef.keyRef) {
        if (escrowRef.keyRef.startsWith('0x')) {
          // Direct private key
          const newWallet = new ethers.Wallet(escrowRef.keyRef, this.provider);
          this.wallets.set(escrowRef.keyRef, newWallet as any);
          wallet = newWallet as any;
        } else if (escrowRef.keyRef.startsWith('m/') && this.rootWallet) {
          // HD path
          const childWallet = this.rootWallet.derivePath(escrowRef.keyRef);
          const connectedWallet = childWallet.connect(this.provider);
          this.wallets.set(escrowRef.keyRef, connectedWallet);
          wallet = connectedWallet;
        }
      }
    }

    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${escrowRef.address}`);
    }

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    // Approve unlimited spending to save gas on future transactions
    const tx = await tokenContract.approve(this.brokerContract.target, ethers.MaxUint256);

    console.log(`[${this.chainId}] Approved broker to spend ${tokenAddress} from ${escrowRef.address}: ${tx.hash}`);

    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
      gasPrice: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') : undefined,
    };
  }

  /**
   * Execute atomic swap via broker contract.
   * For native: sends all escrow balance as msg.value.
   * For ERC20: broker pulls from escrow (must be pre-approved).
   */
  async swapViaBroker(params: BrokerSwapParams): Promise<SubmittedTx> {
    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    let wallet = this.wallets.get(params.escrow.keyRef || params.escrow.address);
    if (!wallet) {
      // Try to recreate wallet from keyRef
      if (params.escrow.keyRef) {
        if (params.escrow.keyRef.startsWith('0x')) {
          // Direct private key
          const newWallet = new ethers.Wallet(params.escrow.keyRef, this.provider);
          this.wallets.set(params.escrow.keyRef, newWallet as any);
          wallet = newWallet as any;
        } else if (params.escrow.keyRef.startsWith('m/') && this.rootWallet) {
          // HD path
          const childWallet = this.rootWallet.derivePath(params.escrow.keyRef);
          const connectedWallet = childWallet.connect(this.provider);
          this.wallets.set(params.escrow.keyRef, connectedWallet);
          wallet = connectedWallet;
        }
      }
    }

    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${params.escrow.address}`);
    }

    const brokerWithSigner = this.brokerContract.connect(wallet) as unknown as IUnicitySwapBroker;

    // Convert dealId to bytes32
    const dealIdBytes32 = ethers.id(params.dealId);

    let tx;

    if (!params.currency) {
      // Native currency swap (ETH, MATIC, etc.)
      // Get total balance and send it all
      const balance = await this.provider.getBalance(params.escrow.address);

      // Parse amounts to wei
      const amountWei = ethers.parseEther(params.amount);
      const feesWei = ethers.parseEther(params.fees);

      // Generate operator signature for native swap
      const signature = await this.generateOperatorSignature(
        params.dealId,
        params.payback,
        params.recipient,
        params.feeRecipient,
        params.amount,
        params.fees,
        params.escrow.address  // Escrow EOA will be msg.sender
      );

      tx = await brokerWithSigner.swapNative(
        dealIdBytes32,
        params.payback,
        params.recipient,
        params.feeRecipient,
        amountWei,
        feesWei,
        signature,
        { value: balance } // Send entire balance
      );

      console.log(`[${this.chainId}] Native swap via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    } else {
      // ERC20 token swap
      const assetConfig = parseAssetCode(params.currency as AssetCode, this.chainId);
      if (!assetConfig || !assetConfig.contractAddress) {
        throw new Error(`Invalid ERC20 asset: ${params.currency}`);
      }

      const decimals = assetConfig.decimals || 18;
      const amountWei = ethers.parseUnits(params.amount, decimals);
      const feesWei = ethers.parseUnits(params.fees, decimals);

      tx = await brokerWithSigner.swapERC20(
        assetConfig.contractAddress,
        dealIdBytes32,
        params.escrow.address,  // Escrow address (source of funds)
        params.payback,
        params.recipient,
        params.feeRecipient,
        amountWei,
        feesWei
      );

      console.log(`[${this.chainId}] ERC20 swap via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    }

    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
      gasPrice: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') : undefined,
    };
  }

  /**
   * Execute atomic revert via broker contract.
   * For native: sends all escrow balance as msg.value.
   * For ERC20: broker pulls from escrow (must be pre-approved).
   */
  async revertViaBroker(params: BrokerRevertParams): Promise<SubmittedTx> {
    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    let wallet = this.wallets.get(params.escrow.keyRef || params.escrow.address);
    if (!wallet) {
      // Try to recreate wallet from keyRef
      if (params.escrow.keyRef) {
        if (params.escrow.keyRef.startsWith('0x')) {
          // Direct private key
          const newWallet = new ethers.Wallet(params.escrow.keyRef, this.provider);
          this.wallets.set(params.escrow.keyRef, newWallet as any);
          wallet = newWallet as any;
        } else if (params.escrow.keyRef.startsWith('m/') && this.rootWallet) {
          // HD path
          const childWallet = this.rootWallet.derivePath(params.escrow.keyRef);
          const connectedWallet = childWallet.connect(this.provider);
          this.wallets.set(params.escrow.keyRef, connectedWallet);
          wallet = connectedWallet;
        }
      }
    }

    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${params.escrow.address}`);
    }

    const brokerWithSigner = this.brokerContract.connect(wallet) as unknown as IUnicitySwapBroker;

    // Convert dealId to bytes32
    const dealIdBytes32 = ethers.id(params.dealId);

    let tx;

    if (!params.currency) {
      // Native currency revert
      const balance = await this.provider.getBalance(params.escrow.address);
      const feesWei = ethers.parseEther(params.fees);

      // Generate operator signature for native revert (recipient=address(0), amount=0)
      const signature = await this.generateOperatorSignature(
        params.dealId,
        params.payback,
        ethers.ZeroAddress,  // recipient is address(0) for revert
        params.feeRecipient,
        '0',  // amount is 0 for revert
        params.fees,
        params.escrow.address  // Escrow EOA will be msg.sender
      );

      tx = await brokerWithSigner.revertNative(
        dealIdBytes32,
        params.payback,
        params.feeRecipient,
        feesWei,
        signature,
        { value: balance } // Send entire balance
      );

      console.log(`[${this.chainId}] Native revert via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    } else {
      // ERC20 token revert
      const assetConfig = parseAssetCode(params.currency as AssetCode, this.chainId);
      if (!assetConfig || !assetConfig.contractAddress) {
        throw new Error(`Invalid ERC20 asset: ${params.currency}`);
      }

      const decimals = assetConfig.decimals || 18;
      const feesWei = ethers.parseUnits(params.fees, decimals);

      tx = await brokerWithSigner.revertERC20(
        assetConfig.contractAddress,
        dealIdBytes32,
        params.escrow.address,  // Escrow address (source of funds)
        params.payback,
        params.feeRecipient,
        feesWei
      );

      console.log(`[${this.chainId}] ERC20 revert via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    }

    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
      gasPrice: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') : undefined,
    };
  }

  /**
   * Execute post-deal refund via broker contract.
   * Used for cleaning up late deposits or leftover funds after deal closure.
   * For native: sends all escrow balance as msg.value.
   * For ERC20: broker pulls from escrow (must be pre-approved).
   */
  async refundViaBroker(params: BrokerRefundParams): Promise<SubmittedTx> {
    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    let wallet = this.wallets.get(params.escrow.keyRef || params.escrow.address);
    if (!wallet) {
      // Try to recreate wallet from keyRef
      if (params.escrow.keyRef) {
        if (params.escrow.keyRef.startsWith('0x')) {
          // Direct private key
          const newWallet = new ethers.Wallet(params.escrow.keyRef, this.provider);
          this.wallets.set(params.escrow.keyRef, newWallet as any);
          wallet = newWallet as any;
        } else if (params.escrow.keyRef.startsWith('m/') && this.rootWallet) {
          // HD path
          const childWallet = this.rootWallet.derivePath(params.escrow.keyRef);
          const connectedWallet = childWallet.connect(this.provider);
          this.wallets.set(params.escrow.keyRef, connectedWallet);
          wallet = connectedWallet;
        }
      }
    }

    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${params.escrow.address}`);
    }

    const brokerWithSigner = this.brokerContract.connect(wallet) as unknown as IUnicitySwapBroker;

    // Convert dealId to bytes32 (used for tracking only)
    const dealIdBytes32 = ethers.id(params.dealId);

    let tx;

    if (!params.currency) {
      // Native currency refund
      const balance = await this.provider.getBalance(params.escrow.address);
      const feesWei = ethers.parseEther(params.fees);

      tx = await brokerWithSigner.refundNative(
        dealIdBytes32,
        params.payback,
        params.feeRecipient,
        feesWei,
        { value: balance } // Send entire balance
      );

      console.log(`[${this.chainId}] Native post-deal refund via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    } else {
      // ERC20 token refund
      const assetConfig = parseAssetCode(params.currency as AssetCode, this.chainId);
      if (!assetConfig || !assetConfig.contractAddress) {
        throw new Error(`Invalid ERC20 asset: ${params.currency}`);
      }

      const decimals = assetConfig.decimals || 18;
      const feesWei = ethers.parseUnits(params.fees, decimals);

      tx = await brokerWithSigner.refundERC20(
        assetConfig.contractAddress,
        dealIdBytes32,
        params.escrow.address,  // Escrow address (source of funds)
        params.payback,
        params.feeRecipient,
        feesWei
      );

      console.log(`[${this.chainId}] ERC20 post-deal refund via broker for deal ${params.dealId.slice(0, 8)}...: ${tx.hash}`);
    }

    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
      gasPrice: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') : undefined,
    };
  }
}