/**
 * @fileoverview Tank Manager for automated gas funding on EVM chains.
 * Ensures escrow accounts have sufficient gas for transaction execution,
 * monitors balances, and handles refunds to the tank wallet.
 */

import { ethers } from 'ethers';
import { DB } from '../db/database';

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  totalCostWei: bigint;
  totalCostEth: string;
}

export interface TankConfig {
  privateKey: string;
  fundAmounts: {
    ETH: string;
    POLYGON: string;
  };
  lowThresholds: {
    ETH: string;
    POLYGON: string;
  };
}

/**
 * Manages gas funding for EVM chain escrow accounts.
 * Automatically funds escrows when they need gas for transactions
 * and monitors tank balance levels.
 */
export class TankManager {
  private wallets: Map<string, ethers.Wallet> = new Map();
  private providers: Map<string, ethers.Provider> = new Map();
  private db: DB;
  private config: TankConfig;

  constructor(db: DB, config: TankConfig) {
    this.db = db;
    this.config = config;
  }

  async init(chainConfigs: Map<string, { rpcUrl: string }>) {
    for (const [chainId, config] of chainConfigs) {
      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const wallet = new ethers.Wallet(this.config.privateKey, provider);
      
      this.providers.set(chainId, provider);
      this.wallets.set(chainId, wallet);
      
      console.log(`[TankManager] Initialized tank wallet for ${chainId}: ${wallet.address}`);
      
      // Check initial balance
      const balance = await provider.getBalance(wallet.address);
      const balanceEth = ethers.formatEther(balance);
      console.log(`[TankManager] ${chainId} tank balance: ${balanceEth}`);
      
      // Store initial balance
      this.updateTankBalance(chainId, balanceEth);
    }
  }

  getTankAddress(): string {
    const wallet = new ethers.Wallet(this.config.privateKey);
    return wallet.address;
  }

  async getGasBalance(chainId: string, address: string): Promise<bigint> {
    const provider = this.providers.get(chainId);
    if (!provider) {
      throw new Error(`No provider for chain ${chainId}`);
    }
    return await provider.getBalance(address);
  }

  async estimateGasForERC20Transfer(
    chainId: string,
    tokenAddress: string,
    from: string,
    to: string,
    amount: string
  ): Promise<GasEstimate> {
    const provider = this.providers.get(chainId);
    if (!provider) {
      throw new Error(`No provider for chain ${chainId}`);
    }

    // Standard ERC20 transfer gas limit with 20% safety margin
    const baseGasLimit = 65000n;
    const gasLimit = (baseGasLimit * 120n) / 100n; // 20% safety margin

    // Get current gas price
    const feeData = await provider.getFeeData();
    
    let totalCostWei: bigint;
    let gasPrice = feeData.gasPrice || 0n;
    
    // Use EIP-1559 if available
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      // Add 10% to priority fee for faster inclusion
      const priorityFee = (feeData.maxPriorityFeePerGas * 110n) / 100n;
      const maxFee = feeData.maxFeePerGas + priorityFee;
      
      totalCostWei = gasLimit * maxFee;
      
      return {
        gasLimit,
        gasPrice: maxFee, // For compatibility
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        totalCostWei,
        totalCostEth: ethers.formatEther(totalCostWei)
      };
    } else {
      // Legacy gas pricing with 10% buffer
      gasPrice = (gasPrice * 110n) / 100n;
      totalCostWei = gasLimit * gasPrice;
      
      return {
        gasLimit,
        gasPrice,
        totalCostWei,
        totalCostEth: ethers.formatEther(totalCostWei)
      };
    }
  }

  async estimateGasForNativeTransfer(chainId: string): Promise<GasEstimate> {
    const provider = this.providers.get(chainId);
    if (!provider) {
      throw new Error(`No provider for chain ${chainId}`);
    }

    // Standard ETH transfer gas limit
    const gasLimit = 21000n;

    // Get current gas price
    const feeData = await provider.getFeeData();
    
    let totalCostWei: bigint;
    let gasPrice = feeData.gasPrice || 0n;
    
    // Use EIP-1559 if available
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const priorityFee = (feeData.maxPriorityFeePerGas * 110n) / 100n;
      const maxFee = feeData.maxFeePerGas + priorityFee;
      
      totalCostWei = gasLimit * maxFee;
      
      return {
        gasLimit,
        gasPrice: maxFee,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        totalCostWei,
        totalCostEth: ethers.formatEther(totalCostWei)
      };
    } else {
      gasPrice = (gasPrice * 110n) / 100n;
      totalCostWei = gasLimit * gasPrice;
      
      return {
        gasLimit,
        gasPrice,
        totalCostWei,
        totalCostEth: ethers.formatEther(totalCostWei)
      };
    }
  }

  /**
   * Funds an escrow account with gas for transaction execution.
   * @param dealId - Deal identifier for tracking
   * @param chainId - Chain to fund on (ETH, POLYGON)
   * @param escrowAddress - Escrow address to fund
   * @param requiredGasWei - Minimum gas amount required in wei
   * @returns Transaction hash or 'already-funded'
   */
  async fundEscrowForGas(
    dealId: string,
    chainId: string,
    escrowAddress: string,
    requiredGasWei: bigint
  ): Promise<string> {
    console.log(`[TankManager] fundEscrowForGas called:`, {
      dealId,
      chainId,
      escrowAddress,
      requiredGasWei: ethers.formatEther(requiredGasWei)
    });
    
    const wallet = this.wallets.get(chainId);
    const provider = this.providers.get(chainId);
    
    if (!wallet || !provider) {
      throw new Error(`Tank not initialized for chain ${chainId}`);
    }

    // Check escrow current balance
    const currentBalance = await provider.getBalance(escrowAddress);
    
    if (currentBalance >= requiredGasWei) {
      console.log(`[TankManager] Escrow ${escrowAddress} already has sufficient gas`);
      return 'already-funded';
    }

    // Get configured fund amount for this chain
    const fundAmount = chainId === 'POLYGON' 
      ? this.config.fundAmounts.POLYGON 
      : this.config.fundAmounts.ETH;
    
    const fundAmountWei = ethers.parseEther(fundAmount);
    
    // Make sure we send enough to cover the required gas
    const amountToSend = fundAmountWei > requiredGasWei ? fundAmountWei : requiredGasWei * 2n;

    console.log(`[TankManager] Funding escrow ${escrowAddress} with ${ethers.formatEther(amountToSend)} ${chainId === 'POLYGON' ? 'MATIC' : 'ETH'}`);

    // Check tank balance
    const tankBalance = await provider.getBalance(wallet.address);
    console.log(`[TankManager] Tank wallet ${wallet.address} balance on ${chainId}: ${ethers.formatEther(tankBalance)}`);
    if (tankBalance < amountToSend) {
      console.error(`[TankManager] INSUFFICIENT TANK BALANCE!`);
      throw new Error(`Insufficient tank balance: have ${ethers.formatEther(tankBalance)}, need ${ethers.formatEther(amountToSend)}`);
    }

    try {
      // Send gas to escrow
      const tx = await wallet.sendTransaction({
        to: escrowAddress,
        value: amountToSend
      });

      console.log(`[TankManager] Gas funding tx sent: ${tx.hash}`);

      // Record funding in database
      this.recordGasFunding(dealId, chainId, escrowAddress, ethers.formatEther(amountToSend), tx.hash);

      // Wait for confirmation
      await tx.wait();
      
      console.log(`[TankManager] Gas funding confirmed for ${escrowAddress}`);

      // Update tank balance
      const newBalance = await provider.getBalance(wallet.address);
      this.updateTankBalance(chainId, ethers.formatEther(newBalance));

      // Check if tank is below threshold
      this.checkLowBalance(chainId, ethers.formatEther(newBalance));

      return tx.hash;
    } catch (error) {
      console.error(`[TankManager] Failed to fund escrow:`, error);
      throw error;
    }
  }

  private recordGasFunding(
    dealId: string,
    chainId: string,
    escrowAddress: string,
    amount: string,
    txHash: string
  ) {
    const stmt = this.db.prepare(`
      INSERT INTO gas_funding (id, dealId, chainId, escrowAddress, fundingAmount, txHash, createdAt, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const id = `gas-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    stmt.run(id, dealId, chainId, escrowAddress, amount, txHash, new Date().toISOString(), 'CONFIRMED');
  }

  private updateTankBalance(chainId: string, balance: string) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tank_balances (chainId, balance, lastUpdated, lowThreshold)
      VALUES (?, ?, ?, ?)
    `);
    
    const threshold = chainId === 'POLYGON' 
      ? this.config.lowThresholds.POLYGON 
      : this.config.lowThresholds.ETH;
    
    stmt.run(chainId, balance, new Date().toISOString(), threshold);
  }

  private checkLowBalance(chainId: string, balance: string) {
    const threshold = chainId === 'POLYGON' 
      ? this.config.lowThresholds.POLYGON 
      : this.config.lowThresholds.ETH;
    
    if (parseFloat(balance) < parseFloat(threshold)) {
      console.warn(`[TankManager] ⚠️ LOW TANK BALANCE on ${chainId}: ${balance} (threshold: ${threshold})`);
      
      // Record alert
      const stmt = this.db.prepare(`
        INSERT INTO alerts (id, type, severity, payload_json, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      const alertId = `alert-${Date.now()}`;
      const payload = JSON.stringify({
        chainId,
        balance,
        threshold,
        tankAddress: this.getTankAddress()
      });
      
      stmt.run(alertId, 'LOW_TANK_BALANCE', 'HIGH', payload, new Date().toISOString());
    }
  }

  async getTankBalance(chainId: string): Promise<string> {
    const provider = this.providers.get(chainId);
    const wallet = this.wallets.get(chainId);
    
    if (!provider || !wallet) {
      throw new Error(`Tank not initialized for chain ${chainId}`);
    }
    
    const balance = await provider.getBalance(wallet.address);
    return ethers.formatEther(balance);
  }

  async getGasFundingHistory(dealId?: string): Promise<any[]> {
    let query = 'SELECT * FROM gas_funding';
    const params: any[] = [];
    
    if (dealId) {
      query += ' WHERE dealId = ?';
      params.push(dealId);
    }
    
    query += ' ORDER BY createdAt DESC';
    
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }
}