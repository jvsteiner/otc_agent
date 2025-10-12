/**
 * @fileoverview Etherscan API wrapper for fetching transaction history.
 * Provides methods to query transaction and token transfer history from Etherscan
 * and compatible block explorers (Polygonscan, Basescan, etc).
 */

import { ethers } from 'ethers';

/**
 * Transaction data structure returned by Etherscan API.
 */
interface Transaction {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  gasUsed: string;
  confirmations: string;
}

/**
 * Internal transaction data structure returned by Etherscan API.
 */
interface InternalTransaction {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  type: string;
  traceId: string;
  isError: string;
  errCode: string;
}

/**
 * Etherscan API response structure.
 */
interface EtherscanResponse {
  status: string;
  message: string;
  result: Transaction[] | string;
}

/**
 * Wrapper class for Etherscan and compatible APIs.
 * Handles transaction history queries without requiring an API key for basic operations.
 */
export class EtherscanAPI {
  private apiUrl: string;
  private apiKey?: string;

  constructor(chainId: string, apiKey?: string) {
    // Try to get API key from environment variables if not provided
    const envKeyMap: Record<string, string> = {
      'ETH': 'ETHERSCAN_API_KEY',
      'ETHEREUM': 'ETHERSCAN_API_KEY',
      'SEPOLIA': 'ETHERSCAN_API_KEY',
      'POLYGON': 'POLYGONSCAN_API_KEY',
      'MATIC': 'POLYGONSCAN_API_KEY',
      'BASE': 'BASESCAN_API_KEY',
      'BSC': 'BSCSCAN_API_KEY'
    };

    const envKey = envKeyMap[chainId.toUpperCase()];
    this.apiKey = apiKey || (envKey && process.env[envKey]) || undefined;

    // Map chain IDs to Etherscan API endpoints
    switch (chainId.toUpperCase()) {
      case 'ETH':
      case 'ETHEREUM':
        this.apiUrl = 'https://api.etherscan.io/api';
        break;
      case 'SEPOLIA':
        this.apiUrl = 'https://api-sepolia.etherscan.io/api';
        break;
      case 'POLYGON':
      case 'MATIC':
        this.apiUrl = 'https://api.polygonscan.com/api';
        break;
      case 'BASE':
        this.apiUrl = 'https://api.basescan.org/api';
        break;
      case 'BSC':
        this.apiUrl = 'https://api.bscscan.com/api';
        break;
      default:
        // Default to Ethereum
        this.apiUrl = 'https://api.etherscan.io/api';
    }
  }

  async getTransactionsByAddress(
    address: string,
    startBlock: number = 0,
    endBlock: number = 99999999
  ): Promise<Transaction[]> {
    try {
      const params = new URLSearchParams({
        module: 'account',
        action: 'txlist',
        address: address,
        startblock: startBlock.toString(),
        endblock: endBlock.toString(),
        sort: 'desc',
      });

      // Add API key if available (not required for basic queries)
      if (this.apiKey) {
        params.append('apikey', this.apiKey);
      }

      const response = await fetch(`${this.apiUrl}?${params.toString()}`);
      const data = await response.json() as EtherscanResponse;

      // Check for V2 API deprecation message
      if (data.message && data.message.includes('deprecated V1 endpoint')) {
        console.error(`Etherscan API error: ${data.message}. API key required for V2.`);
        if (!this.apiKey) {
          console.error(`Please set ${this.apiUrl.includes('polygon') ? 'POLYGONSCAN_API_KEY' : 'ETHERSCAN_API_KEY'} environment variable`);
        }
        return [];
      }

      if (data.status === '1' && Array.isArray(data.result)) {
        return data.result;
      } else if (data.message === 'No transactions found') {
        return [];
      } else {
        console.warn('Etherscan API response:', data.message);
        return [];
      }
    } catch (error) {
      console.error('Failed to fetch transactions from Etherscan:', error);
      return [];
    }
  }

  async getIncomingTransactions(
    address: string,
    minValue: bigint = 0n,
    startBlock: number = 0
  ): Promise<Array<{
    txid: string;
    amount: string;
    blockHeight: number;
    blockTime: string;
    confirmations: number;
    from: string;
  }>> {
    const transactions = await this.getTransactionsByAddress(address, startBlock);

    const incoming = transactions
      .filter(tx => {
        // Filter for incoming transactions
        if (tx.to?.toLowerCase() !== address.toLowerCase()) return false;

        // Filter by minimum value
        const value = BigInt(tx.value);
        return value >= minValue;
      })
      .map(tx => ({
        txid: tx.hash,
        amount: ethers.formatEther(tx.value),
        blockHeight: parseInt(tx.blockNumber),
        blockTime: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        confirmations: parseInt(tx.confirmations),
        from: tx.from
      }));

    return incoming;
  }

  async getOutgoingTransactions(
    address: string,
    minValue: bigint = 0n,
    startBlock: number = 0
  ): Promise<Array<{
    txid: string;
    to: string | null;
    amount: string;
    blockHeight: number;
    blockTime: string;
    confirmations: number;
  }>> {
    const transactions = await this.getTransactionsByAddress(address, startBlock);

    const outgoing = transactions
      .filter(tx => {
        // Filter for outgoing transactions
        if (tx.from?.toLowerCase() !== address.toLowerCase()) return false;

        // Filter by minimum value
        const value = BigInt(tx.value);
        return value >= minValue;
      })
      .map(tx => ({
        txid: tx.hash,
        to: tx.to || null,
        amount: ethers.formatEther(tx.value),
        blockHeight: parseInt(tx.blockNumber),
        blockTime: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        confirmations: parseInt(tx.confirmations)
      }));

    return outgoing;
  }

  async getERC20Transfers(
    tokenAddress: string,
    toAddress: string,
    startBlock: number = 0
  ): Promise<Array<{
    txid: string;
    amount: string;
    blockHeight: number;
    blockTime: string;
    confirmations: number;
    from: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
  }>> {
    try {
      const params = new URLSearchParams({
        module: 'account',
        action: 'tokentx',
        contractaddress: tokenAddress,
        address: toAddress,
        startblock: startBlock.toString(),
        endblock: '99999999',
        sort: 'desc',
      });

      if (this.apiKey) {
        params.append('apikey', this.apiKey);
      }

      const response = await fetch(`${this.apiUrl}?${params.toString()}`);
      const data = await response.json() as any;

      // Check for V2 API deprecation message
      if (data.message && data.message.includes('deprecated V1 endpoint')) {
        console.error(`Etherscan API error: ${data.message}. API key required for V2.`);
        if (!this.apiKey) {
          console.error(`Please set ${this.apiUrl.includes('polygon') ? 'POLYGONSCAN_API_KEY' : 'ETHERSCAN_API_KEY'} environment variable`);
        }
        return [];
      }

      if (data.status === '1' && Array.isArray(data.result)) {
        return data.result
          .filter((tx: any) => tx.to?.toLowerCase() === toAddress.toLowerCase())
          .map((tx: any) => ({
            txid: tx.hash,
            amount: ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal || '18')),
            blockHeight: parseInt(tx.blockNumber),
            blockTime: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
            confirmations: parseInt(tx.confirmations || '0'),
            from: tx.from,
            tokenSymbol: tx.tokenSymbol,
            tokenDecimals: parseInt(tx.tokenDecimal || '18')
          }));
      }

      return [];
    } catch (error) {
      console.error('Failed to fetch ERC20 transfers:', error);
      return [];
    }
  }

  /**
   * Fetch internal transactions for a specific transaction hash.
   * Internal transactions are transfers that occur within smart contract execution.
   * Used to decode broker contract calls into individual transfer operations.
   *
   * @param txHash - Transaction hash to fetch internal transactions for
   * @returns Array of internal transactions
   */
  async getInternalTransactions(
    txHash: string
  ): Promise<Array<{
    from: string;
    to: string;
    value: string;
    type: string;
    isError: boolean;
  }>> {
    try {
      const params = new URLSearchParams({
        module: 'account',
        action: 'txlistinternal',
        txhash: txHash,
      });

      if (this.apiKey) {
        params.append('apikey', this.apiKey);
      }

      const response = await fetch(`${this.apiUrl}?${params.toString()}`);
      const data = await response.json() as EtherscanResponse;

      // Check for API errors
      if (data.message && data.message.includes('deprecated V1 endpoint')) {
        console.error(`Etherscan API error: ${data.message}. API key required for V2.`);
        if (!this.apiKey) {
          console.error(`Please set API key environment variable for ${this.apiUrl}`);
        }
        return [];
      }

      if (data.status === '1' && Array.isArray(data.result)) {
        return (data.result as unknown as InternalTransaction[]).map((tx: InternalTransaction) => ({
          from: tx.from,
          to: tx.to,
          value: ethers.formatEther(tx.value),
          type: tx.type,
          isError: tx.isError === '1'
        }));
      } else if (data.message === 'No transactions found') {
        return [];
      } else {
        console.warn('Etherscan API response for internal transactions:', data.message);
        return [];
      }
    } catch (error) {
      console.error('Failed to fetch internal transactions from Etherscan:', error);
      return [];
    }
  }
}