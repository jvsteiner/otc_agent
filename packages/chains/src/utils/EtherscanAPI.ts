/**
 * @fileoverview Etherscan API V2 wrapper for fetching transaction history.
 * Provides methods to query transaction and token transfer history from Etherscan
 * using the unified V2 API endpoint (https://api.etherscan.io/v2/api).
 *
 * V2 API Features:
 * - Single unified endpoint for all 60+ supported chains
 * - Chain selection via chainid parameter
 * - Backward-compatible response format
 * - Single API key works across all chains
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
 * Wrapper class for Etherscan API V2.
 * Uses the unified V2 endpoint (https://api.etherscan.io/v2/api) with chainid parameter.
 * Supports Ethereum, Polygon, Sepolia, BSC, Base, and 60+ other chains.
 * Handles transaction history queries without requiring an API key for basic operations.
 */
export class EtherscanAPI {
  private apiUrl: string;
  private chainIdNumber: number;
  private apiKey?: string;
  private provider?: ethers.JsonRpcProvider;

  constructor(chainId: string, apiKey?: string, provider?: ethers.JsonRpcProvider) {
    this.provider = provider;
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

    // Etherscan API V2 unified endpoint
    this.apiUrl = 'https://api.etherscan.io/v2/api';

    // Map chain IDs to Etherscan V2 chain ID numbers
    switch (chainId.toUpperCase()) {
      case 'ETH':
      case 'ETHEREUM':
        this.chainIdNumber = 1;
        break;
      case 'SEPOLIA':
        this.chainIdNumber = 11155111;
        break;
      case 'POLYGON':
      case 'MATIC':
        this.chainIdNumber = 137;
        break;
      case 'BASE':
        this.chainIdNumber = 8453;
        break;
      case 'BSC':
        this.chainIdNumber = 56;
        break;
      default:
        // Default to Ethereum mainnet
        this.chainIdNumber = 1;
    }
  }

  async getTransactionsByAddress(
    address: string,
    startBlock: number = 0,
    endBlock: number = 99999999
  ): Promise<Transaction[]> {
    try {
      const params = new URLSearchParams({
        chainid: this.chainIdNumber.toString(),
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

      // Check for V2 API deprecation message - throw error to trigger fallback
      // The deprecation message can be in data.message OR data.result (when result is a string)
      const deprecationMsg =
        (data.message && data.message.includes('deprecated V1 endpoint')) ||
        (typeof data.result === 'string' && data.result.includes('deprecated V1 endpoint'));

      if (deprecationMsg) {
        const errorMsg = typeof data.result === 'string' ? data.result : data.message;
        console.warn(`[EtherscanAPI] ${errorMsg} - will fall back to RPC`);
        throw new Error(errorMsg);
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
        chainid: this.chainIdNumber.toString(),
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

      // Check for V2 API deprecation message - throw error to trigger fallback
      // The deprecation message can be in data.message OR data.result (when result is a string)
      const deprecationMsg =
        (data.message && data.message.includes('deprecated V1 endpoint')) ||
        (typeof data.result === 'string' && data.result.includes('deprecated V1 endpoint'));

      if (deprecationMsg) {
        const errorMsg = typeof data.result === 'string' ? data.result : data.message;
        console.warn(`[EtherscanAPI] ${errorMsg} - will fall back to RPC`);
        throw new Error(errorMsg);
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
   * Get ALL token transfers for an address (discover all ERC20 tokens).
   * Unlike getERC20Transfers(), this does not filter by token contract address.
   * Used for discovering what tokens have been sent to an escrow address.
   *
   * @param address - Address to fetch token transfers for
   * @param startBlock - Starting block number (default: 0)
   * @returns Array of token transfer records including contract addresses
   */
  async getTokenTransfers(
    address: string,
    startBlock: number = 0
  ): Promise<Array<{
    txid: string;
    contractAddress: string;
    from: string;
    to: string;
    amount: string;
    tokenSymbol?: string;
    tokenDecimals?: number;
    blockHeight: number;
    blockTime: string;
  }>> {
    try {
      const params = new URLSearchParams({
        chainid: this.chainIdNumber.toString(),
        module: 'account',
        action: 'tokentx',
        address: address,  // No contractaddress filter - get ALL tokens
        startblock: startBlock.toString(),
        endblock: '99999999',
        sort: 'desc',
      });

      if (this.apiKey) {
        params.append('apikey', this.apiKey);
      }

      const response = await fetch(`${this.apiUrl}?${params.toString()}`);
      const data = await response.json() as any;

      // Check for V2 API deprecation message - throw error to trigger fallback
      // The deprecation message can be in data.message OR data.result (when result is a string)
      const deprecationMsg =
        (data.message && data.message.includes('deprecated V1 endpoint')) ||
        (typeof data.result === 'string' && data.result.includes('deprecated V1 endpoint'));

      if (deprecationMsg) {
        const errorMsg = typeof data.result === 'string' ? data.result : data.message;
        console.warn(`[EtherscanAPI] ${errorMsg} - will fall back to RPC`);
        throw new Error(errorMsg);
      }

      if (data.status === '1' && Array.isArray(data.result)) {
        return data.result.map((tx: any) => ({
          txid: tx.hash,
          contractAddress: tx.contractAddress,
          from: tx.from,
          to: tx.to,
          amount: ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal || '18')),
          tokenSymbol: tx.tokenSymbol,
          tokenDecimals: parseInt(tx.tokenDecimal || '18'),
          blockHeight: parseInt(tx.blockNumber),
          blockTime: new Date(parseInt(tx.timeStamp) * 1000).toISOString()
        }));
      }

      return [];
    } catch (error: any) {
      // Re-throw deprecation errors so they can trigger the RPC fallback
      if (error.message && error.message.includes('deprecated V1 endpoint')) {
        throw error;
      }
      console.error('Failed to fetch token transfers:', error);
      return [];
    }
  }

  /**
   * Fetch ERC20 Transfer events for a specific transaction hash.
   * Parses Transfer events from ERC20 token contracts to decode broker operations.
   *
   * @param txHash - Transaction hash to fetch ERC20 transfers for
   * @param tokenAddress - ERC20 token contract address (optional filter)
   * @returns Array of ERC20 transfers with decoded amounts
   */
  async getERC20TransfersByTxHash(
    txHash: string,
    tokenAddress?: string
  ): Promise<Array<{
    from: string;
    to: string;
    value: string;      // Raw value as hex string
    tokenAddress: string;
    logIndex: number;
  }>> {
    try {
      // Get transaction receipt logs
      let logs: readonly any[] | any[];

      if (this.provider) {
        // Use RPC provider directly (preferred method)
        console.log(`Fetching transaction receipt via RPC provider for ${txHash}`);
        const receipt = await this.provider.getTransactionReceipt(txHash);

        if (!receipt || !receipt.logs) {
          return [];
        }

        logs = receipt.logs;
      } else {
        // Fallback to Etherscan proxy API V2
        console.warn('Using Etherscan API proxy module - consider providing an RPC provider for better performance');
        const params = new URLSearchParams({
          chainid: this.chainIdNumber.toString(),
          module: 'proxy',
          action: 'eth_getTransactionReceipt',
          txhash: txHash,
        });

        if (this.apiKey) {
          params.append('apikey', this.apiKey);
        }

        const response = await fetch(`${this.apiUrl}?${params.toString()}`);
        const data = await response.json() as any;

        if (!data.result || !data.result.logs) {
          return [];
        }

        logs = data.result.logs;
      }

      // ERC20 Transfer event signature: Transfer(address indexed from, address indexed to, uint256 value)
      const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

      const transfers: Array<{
        from: string;
        to: string;
        value: string;
        tokenAddress: string;
        logIndex: number;
      }> = [];

      for (const log of logs) {
        // Check if this is a Transfer event
        if (log.topics && log.topics[0] === TRANSFER_EVENT_TOPIC) {
          // Filter by token address if specified
          if (tokenAddress && log.address.toLowerCase() !== tokenAddress.toLowerCase()) {
            continue;
          }

          // Decode Transfer event
          // topics[0] = event signature
          // topics[1] = from address (padded)
          // topics[2] = to address (padded)
          // data = value (uint256)
          if (log.topics.length >= 3) {
            const from = '0x' + log.topics[1].slice(26); // Remove padding
            const to = '0x' + log.topics[2].slice(26);   // Remove padding
            const value = log.data; // Keep as hex string for now

            // Handle logIndex - RPC provider returns number, Etherscan returns hex string
            const logIndex = typeof log.logIndex === 'number'
              ? log.logIndex
              : (typeof log.logIndex === 'string' ? parseInt(log.logIndex, 16) : log.index);

            transfers.push({
              from,
              to,
              value,
              tokenAddress: log.address,
              logIndex
            });
          }
        }
      }

      return transfers;
    } catch (error) {
      console.error('Failed to fetch ERC20 transfers from Etherscan:', error);
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
        chainid: this.chainIdNumber.toString(),
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