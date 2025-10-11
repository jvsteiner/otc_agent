/**
 * @fileoverview Base EVM (Ethereum Virtual Machine) blockchain plugin implementation.
 * Provides generic support for EVM-compatible chains using ethers.js library.
 * Handles native currency and ERC-20 token transfers with deterministic HD wallet generation.
 */

import { ethers } from 'ethers';
import { ChainPlugin, ChainConfig, EscrowDepositsView, QuoteNativeForUSDResult, SubmittedTx, BrokerSwapParams, BrokerRevertParams } from './ChainPlugin';
import { ChainId, AssetCode, EscrowAccountRef, EscrowDeposit, sumAmounts, parseAssetCode } from '@otc-broker/core';
import BROKER_ABI from './abi/UnicitySwapBroker.json';

/**
 * Minimal ERC-20 ABI for token interaction.
 * Includes only the methods needed for balance queries and transfers.
 */
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

/**
 * Generic plugin implementation for EVM-compatible blockchains.
 * Can be used directly or extended for chain-specific implementations.
 * Supports both native currency and ERC-20 token operations.
 */
export class EvmPlugin implements ChainPlugin {
  readonly chainId: ChainId;
  private config!: ChainConfig;
  private provider!: ethers.JsonRpcProvider;
  private wallets = new Map<string, ethers.Wallet>();
  private brokerContract?: ethers.Contract;

  constructor(chainId: ChainId) {
    this.chainId = chainId;
  }

  async init(cfg: ChainConfig): Promise<void> {
    this.config = cfg;
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl);

    // Initialize broker contract if address provided
    if (cfg.brokerAddress) {
      this.brokerContract = new ethers.Contract(cfg.brokerAddress, BROKER_ABI, this.provider);
      console.log(`[${this.chainId}] Initialized broker contract at ${cfg.brokerAddress}`);
    }
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
    amount: string,
    options?: {
      nonce?: number;
      gasPrice?: string;  // For gas bumping
      maxFeePerGas?: string;  // For EIP-1559
      maxPriorityFeePerGas?: string;  // For EIP-1559
    }
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

    // Build transaction parameters with explicit nonce if provided
    const txParams: any = {
      to,
      nonce: options?.nonce,  // Use explicit nonce if provided
    };

    // Add gas price parameters if provided (for gas bumping)
    if (options?.gasPrice) {
      txParams.gasPrice = ethers.parseUnits(options.gasPrice, 'gwei');
    } else if (options?.maxFeePerGas && options?.maxPriorityFeePerGas) {
      // EIP-1559 style
      txParams.maxFeePerGas = ethers.parseUnits(options.maxFeePerGas, 'gwei');
      txParams.maxPriorityFeePerGas = ethers.parseUnits(options.maxPriorityFeePerGas, 'gwei');
    }

    if (assetConfig && assetConfig.native) {
      // Native transfer
      txParams.value = ethers.parseEther(amount);
      tx = await connectedWallet.sendTransaction(txParams);
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

        // For ERC20, we need to call the transfer function with explicit nonce
        if (options?.nonce !== undefined) {
          // Build override object for the contract call
          const overrides: any = {
            nonce: options.nonce
          };

          if (options.gasPrice) {
            overrides.gasPrice = ethers.parseUnits(options.gasPrice, 'gwei');
          } else if (options.maxFeePerGas && options.maxPriorityFeePerGas) {
            overrides.maxFeePerGas = ethers.parseUnits(options.maxFeePerGas, 'gwei');
            overrides.maxPriorityFeePerGas = ethers.parseUnits(options.maxPriorityFeePerGas, 'gwei');
          }

          tx = await tokenContract.transfer(to, amountWei, overrides);
        } else {
          // No explicit nonce, use default behavior
          tx = await tokenContract.transfer(to, amountWei);
        }
      } else {
        throw new Error(`Unsupported asset: ${asset}`);
      }
    }

    if (!tx) {
      throw new Error('Transaction creation failed');
    }

    return {
      txid: tx.hash,
      submittedAt: new Date().toISOString(),
      nonceOrInputs: tx.nonce?.toString(),
      gasPrice: tx.gasPrice ? ethers.formatUnits(tx.gasPrice, 'gwei') : undefined,
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

  /**
   * Get the current nonce for an address from the network
   * Used for initializing nonce tracking
   */
  async getCurrentNonce(address: string): Promise<number> {
    return await this.provider.getTransactionCount(address, 'pending');
  }

  /**
   * Get current gas price from the network
   * Returns gas price in gwei as string
   */
  async getCurrentGasPrice(): Promise<{ gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string }> {
    const feeData = await this.provider.getFeeData();

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      // EIP-1559 network
      return {
        maxFeePerGas: ethers.formatUnits(feeData.maxFeePerGas, 'gwei'),
        maxPriorityFeePerGas: ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')
      };
    } else if (feeData.gasPrice) {
      // Legacy gas price
      return {
        gasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei')
      };
    }

    // Fallback
    return { gasPrice: '20' }; // 20 gwei default
  }

  /**
   * Check if a transaction is stuck in the mempool
   * Returns true if transaction exists but has 0 confirmations
   */
  async isTransactionStuck(txid: string): Promise<boolean> {
    try {
      const tx = await this.provider.getTransaction(txid);
      if (!tx) return false;  // Transaction not found

      const receipt = await this.provider.getTransactionReceipt(txid);
      return receipt === null;  // Transaction exists but not mined
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if a transfer has already been executed on-chain.
   * Stub implementation - returns null (not implemented for generic EVM plugin).
   * Override this in chain-specific plugins like EthereumPlugin.
   */
  async checkExistingTransfer(
    from: string,
    to: string,
    asset: AssetCode,
    amount: string
  ): Promise<{ txid: string; blockNumber: number } | null> {
    console.warn(`[${this.chainId}] checkExistingTransfer not implemented for generic EVM plugin`);
    return null;
  }

  validateAddress(address: string): boolean {
    return ethers.isAddress(address);
  }

  getOperatorAddress(): string {
    return this.config?.operator?.address || '0x0000000000000000000000000000000000000000';
  }

  /**
   * Approve the broker contract to spend ERC20 tokens from an escrow address.
   * Grants unlimited allowance for gas optimization.
   */
  async approveBrokerForERC20(escrowRef: EscrowAccountRef, tokenAddress: string): Promise<SubmittedTx> {
    if (!this.brokerContract) {
      throw new Error(`Broker contract not configured for ${this.chainId}`);
    }

    const wallet = this.wallets.get(escrowRef.address);
    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${escrowRef.address}`);
    }

    const connectedWallet = wallet.connect(this.provider);
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, connectedWallet);

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

    const wallet = this.wallets.get(params.escrow.address);
    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${params.escrow.address}`);
    }

    const connectedWallet = wallet.connect(this.provider);
    const brokerWithSigner = this.brokerContract.connect(connectedWallet);

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

      tx = await brokerWithSigner.swapNative(
        dealIdBytes32,
        params.payback,
        params.recipient,
        params.feeRecipient,
        amountWei,
        feesWei,
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

    const wallet = this.wallets.get(params.escrow.address);
    if (!wallet) {
      throw new Error(`Wallet not found for escrow address: ${params.escrow.address}`);
    }

    const connectedWallet = wallet.connect(this.provider);
    const brokerWithSigner = this.brokerContract.connect(connectedWallet);

    // Convert dealId to bytes32
    const dealIdBytes32 = ethers.id(params.dealId);

    let tx;

    if (!params.currency) {
      // Native currency revert
      const balance = await this.provider.getBalance(params.escrow.address);
      const feesWei = ethers.parseEther(params.fees);

      tx = await brokerWithSigner.revertNative(
        dealIdBytes32,
        params.payback,
        params.feeRecipient,
        feesWei,
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
}