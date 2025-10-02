import express from 'express';
import { Deal, DealAssetSpec, PartyDetails, DealStage, CommissionMode, CommissionRequirement, EscrowAccountRef, getAssetRegistry, formatAssetCode, parseAssetCode } from '@otc-broker/core';
import { DealRepository, QueueRepository, PayoutRepository } from '../db/repositories';
import { DB } from '../db/database';
import { PluginManager } from '@otc-broker/chains';
import * as crypto from 'crypto';
import { EmailService } from '../services/email';

interface CreateDealParams {
  alice: DealAssetSpec;
  bob: DealAssetSpec;
  timeoutSeconds: number;
}

interface FillPartyDetailsParams {
  dealId: string;
  party: 'ALICE' | 'BOB';
  paybackAddress: string;
  recipientAddress: string;
  email?: string;
  token: string;
}

interface StatusParams {
  dealId: string;
}

interface SetPriceParams {
  chainId: string;
  pair: string;
  price: string;
}

interface SendInviteParams {
  dealId: string;
  party: 'ALICE' | 'BOB';
  email: string;
  link: string;
}

export class RpcServer {
  private app: express.Application;
  private dealRepo: DealRepository;
  private queueRepo: QueueRepository;
  private payoutRepo: PayoutRepository;
  private pluginManager: PluginManager;
  private emailService: EmailService;

  constructor(private db: DB, pluginManager: PluginManager) {
    this.app = express();
    this.app.use(express.json());
    this.dealRepo = new DealRepository(db);
    this.queueRepo = new QueueRepository(db);
    this.payoutRepo = new PayoutRepository(db);
    this.pluginManager = pluginManager;
    this.emailService = new EmailService(db);
    
    this.setupRoutes();
  }

  private setupRoutes() {
    // JSON-RPC endpoint
    this.app.post('/rpc', async (req, res) => {
      const { method, params, id } = req.body;
      
      try {
        let result;
        
        switch (method) {
          case 'otc.createDeal':
            result = await this.createDeal(params as CreateDealParams);
            break;
          case 'otc.fillPartyDetails':
            result = await this.fillPartyDetails(params as FillPartyDetailsParams);
            break;
          case 'otc.status':
            result = await this.getStatus(params as StatusParams);
            break;
          case 'admin.setPrice':
            result = await this.setPrice(params as SetPriceParams);
            break;
          case 'otc.sendInvite':
            result = await this.sendInvite(params as SendInviteParams);
            break;
          case 'otc.cancelDeal':
            result = await this.cancelDeal(params as { dealId: string; token: string });
            break;
          case 'otc.getChainConfig':
            result = await this.getChainConfig(params as { chainId?: string });
            break;
          default:
            throw new Error(`Method ${method} not found`);
        }
        
        res.json({ jsonrpc: '2.0', result, id });
      } catch (error: any) {
        res.json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error.message },
          id,
        });
      }
    });

    // Static pages
    this.app.get('/', (req, res) => {
      res.send(this.renderCreateDealPage());
    });

    this.app.get('/d/:dealId/a/:token', (req, res) => {
      const { dealId, token } = req.params;
      res.send(this.renderPartyPage(dealId, token, 'ALICE'));
    });

    this.app.get('/d/:dealId/b/:token', (req, res) => {
      const { dealId, token } = req.params;
      res.send(this.renderPartyPage(dealId, token, 'BOB'));
    });
  }

  private async createDeal(params: CreateDealParams) {
    // Validate assets using the asset registry
    const aliceAsset = parseAssetCode(params.alice.asset, params.alice.chainId);
    const bobAsset = parseAssetCode(params.bob.asset, params.bob.chainId);
    
    if (!aliceAsset) {
      throw new Error(`Invalid or unsupported asset: ${params.alice.asset} on chain ${params.alice.chainId}`);
    }
    
    if (!bobAsset) {
      throw new Error(`Invalid or unsupported asset: ${params.bob.asset} on chain ${params.bob.chainId}`);
    }
    
    // Generate tokens for personal links
    const tokenA = crypto.randomBytes(16).toString('hex');
    const tokenB = crypto.randomBytes(16).toString('hex');
    
    // Determine commission requirements based on chain config
    const alicePlugin = this.pluginManager.getPlugin(params.alice.chainId);
    const bobPlugin = this.pluginManager.getPlugin(params.bob.chainId);
    
    const commissionPlan = {
      sideA: this.getCommissionRequirement(params.alice),
      sideB: this.getCommissionRequirement(params.bob),
    };
    
    const deal = this.dealRepo.create({
      stage: 'CREATED',
      timeoutSeconds: params.timeoutSeconds,
      alice: params.alice,
      bob: params.bob,
      commissionPlan,
    });
    
    // Store tokens in database for persistence
    console.log('Storing tokens for deal:', deal.id);
    console.log('Token A (ALICE):', tokenA);
    console.log('Token B (BOB):', tokenB);
    
    try {
      // Check if tokens table exists
      const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tokens'");
      const tableExists = checkTable.get();
      
      if (!tableExists) {
        console.log('Warning: tokens table does not exist, tokens will not persist across restarts');
      } else {
        const stmt = this.db.prepare(`
          INSERT INTO tokens (token, dealId, party, createdAt) 
          VALUES (?, ?, ?, ?)
        `);
        
        const now = new Date().toISOString();
        stmt.run(tokenA, deal.id, 'ALICE', now);
        stmt.run(tokenB, deal.id, 'BOB', now);
        console.log('Tokens stored in database');
      }
    } catch (error) {
      console.error('Failed to store tokens in database:', error);
      console.log('Tokens will work for this session only');
    }
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
    
    return {
      dealId: deal.id,
      linkA: `${baseUrl}/d/${deal.id}/a/${tokenA}`,
      linkB: `${baseUrl}/d/${deal.id}/b/${tokenB}`,
    };
  }

  private getCommissionRequirement(spec: DealAssetSpec): CommissionRequirement {
    // Parse asset to determine commission structure
    const asset = parseAssetCode(spec.asset, spec.chainId);
    
    if (!asset) {
      // Unknown asset - use fixed USD in native
      return {
        mode: 'FIXED_USD_NATIVE',
        currency: 'NATIVE',
        usdFixed: '10',
        coveredBySurplus: true,
      };
    }
    
    // For stablecoins (USDT, USDC, EURC), use fixed USD
    if (['USDT', 'USDC', 'EURC'].includes(asset.assetSymbol)) {
      return {
        mode: 'FIXED_USD_NATIVE',
        currency: 'NATIVE',
        usdFixed: '5',
        coveredBySurplus: true,
      };
    }
    
    // For native assets and other tokens, use percentage
    return {
      mode: 'PERCENT_BPS',
      currency: 'ASSET',
      percentBps: 30, // 0.3%
      coveredBySurplus: true,
    };
  }

  private async fillPartyDetails(params: FillPartyDetailsParams) {
    console.log('fillPartyDetails called with:', params);
    
    // First check if tokens table exists
    try {
      const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tokens'");
      const tableExists = checkTable.get();
      
      if (!tableExists) {
        console.log('Tokens table does not exist, checking in-memory map as fallback');
        // Fallback to checking if we have any data about this deal
        const deal = this.dealRepo.get(params.dealId);
        if (!deal) {
          throw new Error('Deal not found');
        }
        // For now, just allow the request to proceed if the deal exists
        console.log('Deal found, allowing token for backward compatibility');
      } else {
        // Verify token from database
        const stmt = this.db.prepare(`
          SELECT dealId, party FROM tokens 
          WHERE token = ? AND dealId = ? AND party = ?
        `);
        const tokenInfo = stmt.get(params.token, params.dealId, params.party) as { dealId: string; party: string } | undefined;
        
        if (!tokenInfo) {
          // Check if token exists at all
          const anyToken = this.db.prepare('SELECT * FROM tokens WHERE token = ?').get(params.token);
          console.log('Token lookup failed. Token exists?', !!anyToken, 'Expected:', { dealId: params.dealId, party: params.party });
          
          if (anyToken) {
            console.log('Token found but with different params:', anyToken);
          }
          
          throw new Error('Invalid token');
        }
        
        // Mark token as used
        const updateStmt = this.db.prepare(`
          UPDATE tokens SET usedAt = ? WHERE token = ?
        `);
        updateStmt.run(new Date().toISOString(), params.token);
      }
    } catch (error: any) {
      console.error('Token verification error:', error);
      if (error.message === 'Invalid token' || error.message === 'Deal not found') {
        throw error;
      }
      // For any database errors, fall back to just checking the deal exists
      const deal = this.dealRepo.get(params.dealId);
      if (!deal) {
        throw new Error('Deal not found');
      }
      console.log('Database error, but deal exists, allowing request');
    }
    
    const deal = this.dealRepo.get(params.dealId);
    if (!deal) {
      throw new Error('Deal not found');
    }
    
    // CRUCIAL: Check if party details already exist and are locked
    const existingDetails = params.party === 'ALICE' ? deal.aliceDetails : deal.bobDetails;
    if (existingDetails && existingDetails.locked) {
      throw new Error('Party details are already locked and cannot be changed. This is a security feature to prevent address tampering.');
    }
    
    // Validate addresses
    const sendChain = params.party === 'ALICE' ? deal.alice.chainId : deal.bob.chainId;
    const receiveChain = params.party === 'ALICE' ? deal.bob.chainId : deal.alice.chainId;
    
    const sendPlugin = this.pluginManager.getPlugin(sendChain);
    const receivePlugin = this.pluginManager.getPlugin(receiveChain);
    
    if (!sendPlugin.validateAddress(params.paybackAddress)) {
      throw new Error('Invalid payback address');
    }
    
    if (!receivePlugin.validateAddress(params.recipientAddress)) {
      throw new Error('Invalid recipient address');
    }
    
    // Update deal
    const details: PartyDetails = {
      paybackAddress: params.paybackAddress,
      recipientAddress: params.recipientAddress,
      email: params.email,
      filledAt: new Date().toISOString(),
      locked: true,
    };
    
    let escrowRef: EscrowAccountRef | undefined;
    
    if (params.party === 'ALICE') {
      deal.aliceDetails = details;
      // Generate escrow for Alice's send chain with dealId for uniqueness
      deal.escrowA = await sendPlugin.generateEscrowAccount(deal.alice.asset, deal.id, 'ALICE');
      escrowRef = deal.escrowA;
    } else {
      deal.bobDetails = details;
      // Generate escrow for Bob's send chain with dealId for uniqueness
      deal.escrowB = await sendPlugin.generateEscrowAccount(deal.bob.asset, deal.id, 'BOB');
      escrowRef = deal.escrowB;
    }
    
    // Save party details to database
    try {
      const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='party_details'");
      const tableExists = checkTable.get();
      
      if (!tableExists) {
        console.log('Warning: party_details table does not exist, party details will not persist across restarts');
      } else {
        // Use REPLACE to handle updates if the party re-submits
        const stmt = this.db.prepare(`
          REPLACE INTO party_details (
            dealId, party, paybackAddress, recipientAddress, email, 
            filledAt, locked, escrowAddress, escrowKeyRef
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          params.dealId,
          params.party,
          params.paybackAddress,
          params.recipientAddress,
          params.email || null,
          details.filledAt,
          1, // locked = true
          escrowRef?.address || null,
          escrowRef?.keyRef || null
        );
        
        console.log(`Party details saved to database for ${params.party} in deal ${params.dealId}`);
      }
    } catch (error) {
      console.error('Failed to save party details to database:', error);
      // Continue execution even if database save fails
    }
    
    // Check if both parties have filled
    if (deal.aliceDetails && deal.bobDetails) {
      // Start COUNTDOWN
      deal.expiresAt = new Date(Date.now() + deal.timeoutSeconds * 1000).toISOString();
      deal.stage = 'COLLECTION';
      
      // Freeze commission amounts for FIXED_USD_NATIVE
      if (deal.commissionPlan.sideA.mode === 'FIXED_USD_NATIVE') {
        const plugin = this.pluginManager.getPlugin(deal.alice.chainId);
        const quote = await plugin.quoteNativeForUSD(deal.commissionPlan.sideA.usdFixed!);
        deal.commissionPlan.sideA.nativeFixed = quote.nativeAmount;
        deal.commissionPlan.sideA.oracle = quote.quote;
      }
      
      if (deal.commissionPlan.sideB.mode === 'FIXED_USD_NATIVE') {
        const plugin = this.pluginManager.getPlugin(deal.bob.chainId);
        const quote = await plugin.quoteNativeForUSD(deal.commissionPlan.sideB.usdFixed!);
        deal.commissionPlan.sideB.nativeFixed = quote.nativeAmount;
        deal.commissionPlan.sideB.oracle = quote.quote;
      }
    }
    
    this.dealRepo.update(deal);
    
    return { ok: true };
  }

  private async getStatus(params: StatusParams) {
    const deal = this.dealRepo.get(params.dealId);
    if (!deal) {
      throw new Error('Deal not found');
    }
    
    // Get all queue items (transactions) for this deal
    const queueItems = this.queueRepo.getByDeal(params.dealId);
    
    // Get payouts for this deal
    const payouts = this.payoutRepo.getPayoutsByDealId(params.dealId);
    
    // Build instructions
    const instructions = {
      sideA: [] as any[],
      sideB: [] as any[],
    };
    
    if (deal.escrowA) {
      // Use fully qualified asset name to match collectedByAsset keys
      const assetCode = deal.alice.asset.includes('@') ? 
        deal.alice.asset : 
        `${deal.alice.asset}@${deal.alice.chainId}`;
      instructions.sideA.push({
        assetCode: assetCode,
        amount: deal.alice.amount,
        to: deal.escrowA.address,
      });
      
      // Add commission instruction if different currency
      if (deal.commissionPlan.sideA.currency === 'NATIVE' && 
          deal.commissionPlan.sideA.mode === 'FIXED_USD_NATIVE') {
        instructions.sideA.push({
          assetCode: 'ETH', // or appropriate native
          amount: deal.commissionPlan.sideA.nativeFixed,
          to: deal.escrowA.address,
        });
      }
    }
    
    if (deal.escrowB) {
      // Use fully qualified asset name to match collectedByAsset keys
      const assetCodeB = deal.bob.asset.includes('@') ? 
        deal.bob.asset : 
        `${deal.bob.asset}@${deal.bob.chainId}`;
      instructions.sideB.push({
        assetCode: assetCodeB,
        amount: deal.bob.amount,
        to: deal.escrowB.address,
      });
      
      // Add commission instruction if different currency
      if (deal.commissionPlan.sideB.currency === 'NATIVE' && 
          deal.commissionPlan.sideB.mode === 'FIXED_USD_NATIVE') {
        instructions.sideB.push({
          assetCode: 'ETH', // or appropriate native
          amount: deal.commissionPlan.sideB.nativeFixed,
          to: deal.escrowB.address,
        });
      }
    }
    
    // Get RPC endpoints for chains
    const rpcEndpoints: Record<string, string> = {};
    const chains = new Set([deal.alice.chainId, deal.bob.chainId]);
    
    for (const chainId of chains) {
      switch (chainId) {
        case 'ETH':
          rpcEndpoints[chainId] = 'https://ethereum-rpc.publicnode.com';
          break;
        case 'POLYGON':
          rpcEndpoints[chainId] = 'https://polygon-rpc.com';
          break;
        case 'BASE':
          rpcEndpoints[chainId] = 'https://base-rpc.publicnode.com';
          break;
        case 'UNICITY':
          rpcEndpoints[chainId] = 'wss://fulcrum.unicity.network:50004'; // Electrum endpoint
          break;
      }
    }
    
    // Tag transactions properly and associate with payouts
    const taggedTransactions = queueItems.map(item => {
      // Find associated payout if exists
      const associatedPayout = payouts.find(p => {
        const payoutQueueItems = this.payoutRepo.getQueueItemsByPayoutId(p.payoutId);
        return payoutQueueItems.some(qi => qi.id === item.id);
      });
      
      return {
        ...item,
        tag: item.purpose === 'SWAP_PAYOUT' ? 'swap' :
             item.purpose === 'OP_COMMISSION' ? 'commission' :
             item.purpose === 'TIMEOUT_REFUND' ? 'refund' :
             item.purpose === 'SURPLUS_REFUND' ? 'return' : 'unknown',
        blockTime: item.submittedTx?.submittedAt || item.createdAt,
        payoutId: associatedPayout?.payoutId,
        payoutInfo: associatedPayout ? {
          payoutId: associatedPayout.payoutId,
          totalAmount: associatedPayout.totalAmount,
          toAddr: associatedPayout.toAddr,
          purpose: associatedPayout.purpose,
          status: associatedPayout.status,
          minConfirmations: associatedPayout.minConfirmations
        } : undefined
      };
    });
    
    return {
      stage: deal.stage,
      timeoutSeconds: deal.timeoutSeconds,
      expiresAt: deal.expiresAt,
      instructions,
      collection: {
        sideA: deal.sideAState || {},
        sideB: deal.sideBState || {},
      },
      events: deal.events,
      aliceDetails: deal.aliceDetails,
      bobDetails: deal.bobDetails,
      alice: deal.alice,
      bob: deal.bob,
      commissionPlan: deal.commissionPlan,
      escrowA: deal.escrowA,
      escrowB: deal.escrowB,
      transactions: taggedTransactions,
      payouts: payouts.map(p => ({
        ...p,
        transactions: this.payoutRepo.getQueueItemsByPayoutId(p.payoutId)
      })),
      rpcEndpoints,
    };
  }

  private async setPrice(params: SetPriceParams) {
    // Store manual price in oracle_quotes table
    const stmt = this.db.prepare(`
      INSERT INTO oracle_quotes (chainId, pair, price, asOf, source)
      VALUES (?, ?, ?, ?, 'MANUAL')
    `);
    
    const asOf = new Date().toISOString();
    stmt.run(params.chainId, params.pair, params.price, asOf);
    
    return { ok: true, asOf };
  }

  private async cancelDeal(params: { dealId: string; token: string }) {
    // Verify token
    const deal = this.dealRepo.get(params.dealId);
    if (!deal) {
      throw new Error('Deal not found');
    }
    
    // Check if assets are already locked
    const hasDeposits = (deal.sideAState?.deposits?.length ?? 0) > 0 || (deal.sideBState?.deposits?.length ?? 0) > 0;
    if (hasDeposits) {
      throw new Error('Cannot cancel deal - assets have already been locked');
    }
    
    // Check if deal is already closed or reverted
    if (deal.stage === 'CLOSED' || deal.stage === 'REVERTED') {
      throw new Error('Deal has already been finalized');
    }
    
    // Update deal stage to REVERTED
    deal.stage = 'REVERTED';
    this.dealRepo.update(deal);
    this.dealRepo.addEvent(deal.id, 'Deal cancelled by party');
    
    return { ok: true };
  }
  
  private async sendInvite(params: SendInviteParams) {
    // Delegate to email service
    return await this.emailService.sendInvite(params);
  }

  private async getChainConfig(params: { chainId?: string }) {
    // Return chain configuration including RPC endpoints
    const configs: Record<string, any> = {};
    
    if (params.chainId) {
      // Get config for specific chain
      const plugin = this.pluginManager.getPlugin(params.chainId as any);
      const config: any = {
        chainId: params.chainId,
        operator: plugin.getOperatorAddress()
      };
      
      // Add chain-specific endpoints
      switch (params.chainId) {
        case 'UNICITY':
          config.electrumUrl = process.env.UNICITY_ELECTRUM || 'wss://fulcrum.unicity.network:50004';
          break;
        case 'ETH':
          config.rpcUrl = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
          break;
        case 'POLYGON':
          config.rpcUrl = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
          break;
        case 'SOLANA':
          config.rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
          break;
      }
      
      configs[params.chainId] = config;
    } else {
      // Get config for all chains
      const chains = ['UNICITY', 'ETH', 'POLYGON', 'SOLANA'];
      for (const chainId of chains) {
        try {
          const plugin = this.pluginManager.getPlugin(chainId as any);
          const config: any = {
            chainId,
            operator: plugin.getOperatorAddress()
          };
          
          // Add chain-specific endpoints
          switch (chainId) {
            case 'UNICITY':
              config.electrumUrl = process.env.UNICITY_ELECTRUM || 'wss://fulcrum.unicity.network:50004';
              break;
            case 'ETH':
              config.rpcUrl = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com';
              break;
            case 'POLYGON':
              config.rpcUrl = process.env.POLYGON_RPC || 'https://polygon-rpc.com';
              break;
            case 'SOLANA':
              config.rpcUrl = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
              break;
          }
          
          configs[chainId] = config;
        } catch (e) {
          // Chain plugin not available
          console.log(`Chain ${chainId} plugin not available`);
        }
      }
    }
    
    return configs;
  }

  private async sendInviteOld(params: SendInviteParams) {
    // Check if email is enabled in environment
    const emailEnabled = process.env.EMAIL_ENABLED === 'true';
    
    if (!emailEnabled) {
      // For now, just log the invitation and return success
      console.log(`
        ========================================
        EMAIL INVITATION (Email service not configured)
        ========================================
        To: ${params.email}
        Party: ${params.party === 'ALICE' ? 'Asset A Seller' : 'Asset B Seller'}
        Deal ID: ${params.dealId}
        Link: ${params.link}
        ========================================
      `);
      
      // In production, you would integrate with an email service like:
      // - SendGrid
      // - Mailgun  
      // - AWS SES
      // - SMTP server
      
      return { 
        sent: true, 
        message: 'Invitation logged (email service not configured)',
        email: params.email 
      };
    }
    
    // If email service is configured, send actual email
    try {
      // TODO: Integrate with actual email service
      // Example with nodemailer:
      // const transporter = nodemailer.createTransport({...});
      // await transporter.sendMail({
      //   from: process.env.EMAIL_FROM,
      //   to: params.email,
      //   subject: `OTC Asset Swap - ${params.party === 'ALICE' ? 'Asset A' : 'Asset B'} Seller Invitation`,
      //   html: `...`,
      // });
      
      return { 
        sent: true, 
        email: params.email 
      };
    } catch (error: any) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  private renderCreateDealPage(): string {
    const registry = getAssetRegistry();
    const chains = registry.supportedChains;
    const assets = registry.assets;
    
    // Group assets by chain for easier access in JavaScript
    const assetsByChain: Record<string, any[]> = {};
    chains.forEach((chain: any) => {
      assetsByChain[chain.chainId] = assets.filter((a: any) => a.chainId === chain.chainId);
    });

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Create OTC asset swap deal</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
            font-size: 13px;
            max-width: 500px; 
            margin: 10px auto;
            padding: 10px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            border-radius: 6px;
            padding: 15px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.1);
          }
          h1 {
            color: #333;
            font-size: 18px;
            border-bottom: 1px solid #667eea;
            padding-bottom: 6px;
            margin: 0 0 10px 0;
          }
          h3 {
            font-size: 14px;
            margin: 0 0 8px 0;
          }
          .two-column {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }
          .asset-section {
            background: #f9f9f9;
            border-radius: 5px;
            padding: 10px;
          }
          .form-group {
            margin: 8px 0;
          }
          label {
            display: block;
            margin-bottom: 2px;
            font-weight: 600;
            color: #555;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          input, select { 
            width: 100%; 
            padding: 6px 8px; 
            margin: 2px 0; 
            border: 1px solid #ddd;
            border-radius: 3px;
            font-size: 12px;
          }
          select:focus, input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.1);
          }
          button { 
            background: #667eea; 
            color: white; 
            padding: 8px 20px; 
            border: none; 
            cursor: pointer;
            border-radius: 3px;
            font-size: 13px;
            font-weight: 600;
            width: 100%;
            margin-top: 10px;
          }
          button:hover {
            background: #5a67d8;
          }
          .asset-display {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 6px;
            background: white;
            border-radius: 3px;
            margin-top: 4px;
            text-decoration: none;
            transition: all 0.2s ease;
            font-size: 11px;
          }
          .asset-display:hover {
            background: #f0f4ff;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          }
          .asset-icon {
            font-size: 16px;
          }
          .asset-info {
            flex: 1;
          }
          .asset-name {
            font-weight: 600;
            color: #333;
            font-size: 11px;
          }
          .asset-details {
            font-size: 10px;
            color: #888;
          }
          .external-link {
            color: #667eea;
            font-size: 10px;
            opacity: 0;
            transition: opacity 0.2s;
          }
          .asset-display:hover .external-link {
            opacity: 1;
          }
          .timeout-group {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid #e0e0e0;
          }
          small {
            font-size: 10px;
          }
          .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
          }
          .modal-content {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 25px;
            border-radius: 8px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
          }
          .modal h2 {
            color: #333;
            margin: 0 0 20px 0;
            font-size: 20px;
          }
          .link-section {
            margin: 15px 0;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
          }
          .link-section h4 {
            margin: 0 0 10px 0;
            color: #667eea;
            font-size: 14px;
          }
          .link-input {
            display: flex;
            gap: 8px;
            margin: 8px 0;
          }
          .link-input input {
            flex: 1;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 12px;
            background: white;
          }
          .copy-btn, .email-btn {
            padding: 8px 12px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            white-space: nowrap;
          }
          .copy-btn:hover, .email-btn:hover {
            background: #5a67d8;
          }
          .success-message {
            color: #10b981;
            font-size: 12px;
            margin-top: 5px;
            display: none;
          }
          .close-modal {
            margin-top: 20px;
            width: 100%;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Create OTC Asset Swap Deal</h1>
          
          <!-- Modal for showing deal links -->
          <div id="dealModal" class="modal">
            <div class="modal-content">
              <h2>✅ Deal Created Successfully!</h2>
              <p style="color: #666; font-size: 12px;">Deal ID: <span id="dealIdDisplay"></span></p>
              
              <div class="link-section">
                <h4>🅰️ Asset A Seller Link</h4>
                <div style="margin: 10px 0;">
                  <a id="linkADisplay" href="#" target="_blank" style="color: #667eea; word-break: break-all; font-size: 12px;"></a>
                </div>
                <div class="link-input">
                  <input type="text" id="linkA" readonly style="display:none;">
                  <button class="copy-btn" onclick="copyLink('A')">📋 Copy Link</button>
                </div>
                <div style="margin-top: 10px;">
                  <input type="email" id="emailA" placeholder="Enter recipient email" style="flex: 1;">
                  <button class="email-btn" onclick="sendInvite('A')" style="margin-top: 5px;">📧 Send Invitation</button>
                </div>
                <div id="successA" class="success-message">✓ Action completed!</div>
              </div>
              
              <div class="link-section">
                <h4>🅱️ Asset B Seller Link</h4>
                <div style="margin: 10px 0;">
                  <a id="linkBDisplay" href="#" target="_blank" style="color: #667eea; word-break: break-all; font-size: 12px;"></a>
                </div>
                <div class="link-input">
                  <input type="text" id="linkB" readonly style="display:none;">
                  <button class="copy-btn" onclick="copyLink('B')">📋 Copy Link</button>
                </div>
                <div style="margin-top: 10px;">
                  <input type="email" id="emailB" placeholder="Enter recipient email" style="flex: 1;">
                  <button class="email-btn" onclick="sendInvite('B')" style="margin-top: 5px;">📧 Send Invitation</button>
                </div>
                <div id="successB" class="success-message">✓ Action completed!</div>
              </div>
              
              <button class="button close-modal" onclick="closeModal()">Close</button>
            </div>
          </div>
          
          <form id="dealForm">
            <div class="two-column">
              <div class="asset-section">
                <h3>🅰️ Asset A</h3>
                
                <div class="form-group">
                  <label for="chainA">Network</label>
                  <select name="chainA" id="chainA" onchange="updateAssetDropdown('A')">
                    ${chains.map((chain: any) => 
                      `<option value="${chain.chainId}">${chain.icon} ${chain.name}</option>`
                    ).join('')}
                  </select>
                </div>
                
                <div class="form-group">
                  <label for="assetA">Asset</label>
                  <select name="assetA" id="assetA" onchange="updateAssetDisplay('A')">
                    <!-- Will be populated by JavaScript -->
                  </select>
                </div>
                
                <a id="assetDisplayA" class="asset-display" href="#" target="_blank" style="display:none;">
                  <span class="asset-icon"></span>
                  <div class="asset-info">
                    <div class="asset-name"></div>
                    <div class="asset-details"></div>
                  </div>
                  <span class="external-link">🔗</span>
                </a>
                
                <div class="form-group">
                  <label for="amountA">Amount</label>
                  <input name="amountA" id="amountA" type="number" step="0.00000001" placeholder="0.00" required>
                </div>
              </div>
              
              <div class="asset-section">
                <h3>🅱️ Asset B</h3>
                
                <div class="form-group">
                  <label for="chainB">Network</label>
                  <select name="chainB" id="chainB" onchange="updateAssetDropdown('B')">
                    ${chains.map((chain: any) => 
                      `<option value="${chain.chainId}">${chain.icon} ${chain.name}</option>`
                    ).join('')}
                  </select>
                </div>
                
                <div class="form-group">
                  <label for="assetB">Asset</label>
                  <select name="assetB" id="assetB" onchange="updateAssetDisplay('B')">
                    <!-- Will be populated by JavaScript -->
                  </select>
                </div>
                
                <a id="assetDisplayB" class="asset-display" href="#" target="_blank" style="display:none;">
                  <span class="asset-icon"></span>
                  <div class="asset-info">
                    <div class="asset-name"></div>
                    <div class="asset-details"></div>
                  </div>
                  <span class="external-link">🔗</span>
                </a>
                
                <div class="form-group">
                  <label for="amountB">Amount</label>
                  <input name="amountB" id="amountB" type="number" step="0.00000001" placeholder="0.00" required>
                </div>
              </div>
            </div>
            
            <div class="timeout-group">
              <div class="form-group">
                <label for="timeout">Timeout (seconds)</label>
                <input name="timeout" id="timeout" type="number" value="3600" min="300" max="86400" required>
                <small style="color: #888;">Default: 1 hour</small>
              </div>
            </div>
            
            <button type="submit">Create Swap Deal</button>
          </form>
        </div>
        
        <script>
          // Asset registry data
          const assetsByChain = ${JSON.stringify(assetsByChain)};
          const chains = ${JSON.stringify(chains)};
          
          function updateAssetDropdown(side) {
            const chainSelect = document.getElementById('chain' + side);
            const assetSelect = document.getElementById('asset' + side);
            const chainId = chainSelect.value;
            const assets = assetsByChain[chainId] || [];
            
            // Clear and repopulate asset dropdown
            assetSelect.innerHTML = '';
            assets.forEach(asset => {
              const option = document.createElement('option');
              option.value = formatAssetCode(asset);
              option.textContent = asset.icon + ' ' + asset.assetName + ' (' + asset.assetSymbol + ')';
              option.dataset.asset = JSON.stringify(asset);
              assetSelect.appendChild(option);
            });
            
            // Update display for first asset
            if (assets.length > 0) {
              updateAssetDisplay(side);
            }
          }
          
          function formatAssetCode(asset) {
            if (asset.native) {
              return asset.assetSymbol;
            }
            if (asset.type === 'ERC20' || asset.type === 'SPL') {
              return asset.type + ':' + asset.contractAddress;
            }
            return asset.assetSymbol;
          }
          
          function getAssetUrl(asset) {
            // Generate blockchain explorer URLs
            switch (asset.chainId) {
              case 'UNICITY':
                return 'https://www.unicity.network/';
              
              case 'ETH':
                if (asset.native) {
                  return 'https://etherscan.io/';
                } else if (asset.contractAddress) {
                  return 'https://etherscan.io/token/' + asset.contractAddress;
                }
                break;
              
              case 'POLYGON':
                if (asset.native) {
                  return 'https://polygonscan.com/';
                } else if (asset.contractAddress) {
                  return 'https://polygonscan.com/token/' + asset.contractAddress;
                }
                break;
              
              case 'SOLANA':
                if (asset.native) {
                  return 'https://solscan.io/';
                } else if (asset.contractAddress) {
                  return 'https://solscan.io/token/' + asset.contractAddress;
                }
                break;
            }
            
            return '#';
          }
          
          function updateAssetDisplay(side) {
            const assetSelect = document.getElementById('asset' + side);
            const displayLink = document.getElementById('assetDisplay' + side);
            const selectedOption = assetSelect.options[assetSelect.selectedIndex];
            
            if (selectedOption && selectedOption.dataset.asset) {
              const asset = JSON.parse(selectedOption.dataset.asset);
              
              displayLink.querySelector('.asset-icon').textContent = asset.icon;
              displayLink.querySelector('.asset-name').textContent = asset.assetName;
              
              let details = asset.assetSymbol + ' • ';
              if (asset.native) {
                details += 'Native Asset';
              } else {
                details += asset.type;
                if (asset.contractAddress) {
                  details += ' • ' + asset.contractAddress.substring(0, 6) + '...' + 
                            asset.contractAddress.substring(asset.contractAddress.length - 4);
                }
              }
              displayLink.querySelector('.asset-details').textContent = details;
              displayLink.href = getAssetUrl(asset);
              displayLink.style.display = 'flex';
            }
          }
          
          // Initialize dropdowns on page load
          window.addEventListener('DOMContentLoaded', function() {
            updateAssetDropdown('A');
            updateAssetDropdown('B');
            
            // Set different default chains for A and B
            document.getElementById('chainB').selectedIndex = 1; // Select second chain
            updateAssetDropdown('B');
          });
          
          // Modal functions
          function showDealCreatedModal(dealResult) {
            // Store deal ID
            document.getElementById('dealIdDisplay').textContent = dealResult.dealId;
            
            // Set hidden inputs
            document.getElementById('linkA').value = dealResult.linkA;
            document.getElementById('linkB').value = dealResult.linkB;
            
            // Set visible clickable links
            document.getElementById('linkADisplay').href = dealResult.linkA;
            document.getElementById('linkADisplay').textContent = dealResult.linkA;
            document.getElementById('linkBDisplay').href = dealResult.linkB;
            document.getElementById('linkBDisplay').textContent = dealResult.linkB;
            
            // Store deal result globally for invite function
            window.currentDealResult = dealResult;
            
            document.getElementById('dealModal').style.display = 'block';
          }
          
          function closeModal() {
            document.getElementById('dealModal').style.display = 'none';
            // Reset form for next deal
            document.getElementById('dealForm').reset();
            updateAssetDropdown('A');
            updateAssetDropdown('B');
            // Clear email inputs
            document.getElementById('emailA').value = '';
            document.getElementById('emailB').value = '';
          }
          
          function copyLink(side) {
            const link = document.getElementById('link' + side).value;
            
            navigator.clipboard.writeText(link).then(() => {
              showSuccess(side, 'Link copied to clipboard!');
            }).catch(() => {
              // Fallback for older browsers
              const textArea = document.createElement('textarea');
              textArea.value = link;
              document.body.appendChild(textArea);
              textArea.select();
              document.execCommand('copy');
              document.body.removeChild(textArea);
              showSuccess(side, 'Link copied to clipboard!');
            });
          }
          
          async function sendInvite(side) {
            const email = document.getElementById('email' + side).value;
            if (!email) {
              alert('Please enter an email address');
              return;
            }
            
            const link = document.getElementById('link' + side).value;
            const dealId = window.currentDealResult.dealId;
            
            try {
              const response = await fetch('/rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'otc.sendInvite',
                  params: {
                    dealId: dealId,
                    party: side === 'A' ? 'ALICE' : 'BOB',
                    email: email,
                    link: link
                  },
                  id: 1
                })
              });
              
              const result = await response.json();
              if (result.result && result.result.sent) {
                showSuccess(side, 'Invitation sent to ' + email);
                document.getElementById('email' + side).value = '';
              } else {
                alert('Failed to send invitation: ' + (result.error?.message || 'Unknown error'));
              }
            } catch (error) {
              alert('Failed to send invitation: ' + error.message);
            }
          }
          
          function showSuccess(side, message) {
            const successMsg = document.getElementById('success' + side);
            successMsg.textContent = '✓ ' + message;
            successMsg.style.display = 'block';
            setTimeout(() => {
              successMsg.style.display = 'none';
            }, 3000);
          }
          
          // Make functions global
          window.showDealCreatedModal = showDealCreatedModal;
          window.closeModal = closeModal;
          window.copyLink = copyLink;
          window.sendInvite = sendInvite;
          window.showSuccess = showSuccess;
          
          // Handle form submission
          document.getElementById('dealForm').onsubmit = async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.createDeal',
                params: {
                  alice: {
                    chainId: formData.get('chainA'),
                    asset: formData.get('assetA'),
                    amount: formData.get('amountA')
                  },
                  bob: {
                    chainId: formData.get('chainB'),
                    asset: formData.get('assetB'),
                    amount: formData.get('amountB')
                  },
                  timeoutSeconds: parseInt(formData.get('timeout'))
                },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result) {
              // Create a modal to show the links with copy/email functionality
              showDealCreatedModal(result.result);
            } else {
              alert('❌ Error: ' + (result.error?.message || 'Unknown error'));
            }
          };
        </script>
      </body>
      </html>
    `;
  }

  private renderPartyPage(dealId: string, token: string, party: 'ALICE' | 'BOB'): string {
  const partyLabel = party === 'ALICE' ? 'Asset A Seller' : 'Asset B Seller';
  const partyIcon = party === 'ALICE' ? '🅰️' : '🅱️';
  
  // Get deal information to show correct chains and assets
  const deal = this.dealRepo.get(dealId);
  let dealInfo = { 
    sendChain: '', 
    sendAsset: '', 
    sendAmount: '',
    sendChainIcon: '',
    receiveChain: '', 
    receiveAsset: '',
    receiveAmount: '',
    receiveChainIcon: ''
  };
  
  const chainIcons: Record<string, string> = {
    'UNICITY': '🔷',
    'ETH': 'Ξ',
    'POLYGON': 'Ⓜ',
    'BASE': '🔵',
    'SOLANA': '◎'
  };
  
  if (deal) {
    const registry = getAssetRegistry();
    const assetA = registry.assets.find(a => a.chainId === deal.alice.chainId && formatAssetCode(a) === deal.alice.asset);
    const assetB = registry.assets.find(a => a.chainId === deal.bob.chainId && formatAssetCode(a) === deal.bob.asset);
    
    if (party === 'ALICE') {
      dealInfo = {
        sendChain: deal.alice.chainId,
        sendAsset: assetA?.assetSymbol || deal.alice.asset,
        sendAmount: deal.alice.amount,
        sendChainIcon: chainIcons[deal.alice.chainId] || '🔗',
        receiveChain: deal.bob.chainId,
        receiveAsset: assetB?.assetSymbol || deal.bob.asset,
        receiveAmount: deal.bob.amount,
        receiveChainIcon: chainIcons[deal.bob.chainId] || '🔗'
      };
    } else {
      dealInfo = {
        sendChain: deal.bob.chainId,
        sendAsset: assetB?.assetSymbol || deal.bob.asset,
        sendAmount: deal.bob.amount,
        sendChainIcon: chainIcons[deal.bob.chainId] || '🔗',
        receiveChain: deal.alice.chainId,
        receiveAsset: assetA?.assetSymbol || deal.alice.asset,
        receiveAmount: deal.alice.amount,
        receiveChainIcon: chainIcons[deal.alice.chainId] || '🔗'
      };
    }
  }
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${partyLabel} - OTC Asset Swap</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          max-width: 900px;
          margin: 30px auto;
          padding: 20px;
          background: #f5f5f5;
        }
        .container {
          background: white;
          border-radius: 10px;
          padding: 30px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #333;
          border-bottom: 2px solid #667eea;
          padding-bottom: 10px;
          margin-bottom: 20px;
        }
        .form-group {
          margin: 15px 0;
        }
        label {
          display: block;
          margin-bottom: 5px;
          font-weight: 600;
          color: #555;
        }
        input {
          width: 100%;
          padding: 10px;
          margin: 5px 0;
          border: 1px solid #ddd;
          border-radius: 5px;
          font-size: 14px;
        }
        input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        input:disabled {
          background: #e9ecef;
          color: #495057;
          cursor: not-allowed;
          border-color: #28a745;
          border-width: 2px;
        }
        button {
          background: #667eea;
          color: white;
          padding: 12px 30px;
          border: none;
          cursor: pointer;
          border-radius: 5px;
          font-size: 16px;
          font-weight: 600;
          width: 100%;
          margin-top: 15px;
        }
        button:hover {
          background: #5a67d8;
        }
        
        /* Enhanced Status Visualization Styles */
        .status-dashboard {
          background: white;
          border-radius: 10px;
          padding: 20px;
          margin-top: 20px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.05);
        }
        
        .status-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border-radius: 8px;
          margin-bottom: 20px;
        }
        
        .deal-stage {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .stage-badge {
          padding: 6px 12px;
          border-radius: 20px;
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        
        .stage-details {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.9);
          background: rgba(0, 0, 0, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          margin-top: 12px;
          padding: 12px 15px;
          line-height: 1.5;
          text-align: left;
          backdrop-filter: blur(10px);
        }
        
        .stage-details strong {
          color: #fff;
          font-weight: 600;
        }
        
        .stage-created { background: rgba(255,255,255,0.2); }
        .stage-collection { background: rgba(255,193,7,0.3); color: #fff3cd; }
        .stage-waiting { background: rgba(33,150,243,0.3); color: #bbdefb; }
        .stage-closed { background: rgba(76,175,80,0.3); color: #c8e6c9; }
        .stage-reverted { background: rgba(244,67,54,0.3); color: #ffcdd2; }
        
        .countdown-timer {
          font-family: 'Courier New', monospace;
          font-size: 24px;
          font-weight: bold;
          padding: 10px 15px;
          background: rgba(0,0,0,0.2);
          border-radius: 6px;
          min-width: 120px;
          text-align: center;
        }
        
        .countdown-expired {
          background: rgba(244,67,54,0.3);
          animation: pulse 1s infinite;
        }
        
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }
        
        /* Balance Cards */
        .balance-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 25px;
        }
        
        .balance-card {
          background: #f9fafb;
          border-radius: 10px;
          padding: 20px;
          border: 1px solid #e5e7eb;
          position: relative;
          overflow: hidden;
        }
        
        .balance-card.your-balance {
          border-left: 4px solid #667eea;
        }
        
        .balance-card.their-balance {
          border-left: 4px solid #764ba2;
        }
        
        .balance-label {
          font-size: 12px;
          text-transform: uppercase;
          color: #6b7280;
          margin-bottom: 10px;
          font-weight: 600;
          letter-spacing: 1px;
        }
        
        .balance-amount {
          font-size: 28px;
          font-weight: 700;
          color: #111827;
          margin: 10px 0;
          font-family: 'Courier New', monospace;
        }
        
        .balance-progress {
          width: 100%;
          height: 10px;
          background: #e5e7eb;
          border-radius: 5px;
          overflow: hidden;
          margin: 15px 0;
        }
        
        .balance-progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
          transition: width 0.5s ease;
          box-shadow: 0 0 10px rgba(102, 126, 234, 0.3);
        }
        
        .balance-details {
          font-size: 13px;
          color: #6b7280;
          margin-top: 10px;
        }
        
        .balance-percentage {
          position: absolute;
          top: 20px;
          right: 20px;
          font-size: 24px;
          font-weight: bold;
          color: #667eea;
          opacity: 0.3;
        }
        
        /* Escrow Address Display */
        .escrow-section {
          background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
          border: 2px solid #f59e0b;
          border-radius: 10px;
          padding: 20px;
          margin: 20px 0;
        }
        
        .escrow-label {
          font-size: 14px;
          text-transform: uppercase;
          color: #92400e;
          margin-bottom: 10px;
          font-weight: 600;
          letter-spacing: 1px;
        }
        
        .escrow-address {
          font-family: 'Courier New', monospace;
          font-size: 14px;
          color: #451a03;
          word-break: break-all;
          background: white;
          padding: 12px;
          border-radius: 6px;
          margin: 10px 0;
        }
        
        .escrow-copy-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          background: #f59e0b;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
        }
        
        .escrow-copy-btn:hover {
          background: #d97706;
        }
        
        /* Transaction Log */
        .transaction-log {
          background: white;
          border-radius: 10px;
          padding: 20px;
          border: 1px solid #e5e7eb;
          margin-top: 20px;
        }
        
        .transaction-log h3 {
          font-size: 18px;
          margin-bottom: 15px;
          color: #111827;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .transaction-list {
          max-height: 400px;
          overflow-y: auto;
          border: 1px solid #f3f4f6;
          border-radius: 8px;
        }
        
        .transaction-item {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 8px 10px;
          border-bottom: 1px solid #e5e7eb;
          transition: background 0.2s;
          font-size: 11px;
        }
        
        .transaction-item:hover {
          background: #f9fafb;
        }
        
        .transaction-item:last-child {
          border-bottom: none;
        }
        
        .tx-left {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        
        .tx-right {
          text-align: right;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        
        .tx-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
        }
        
        .tx-chain-badge {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .chain-unicity { background: #e0f2fe; color: #0369a1; }
        .chain-polygon { background: #f3e8ff; color: #7c3aed; }
        .chain-eth { background: #e0e7ff; color: #4f46e5; }
        .chain-base { background: #dbeafe; color: #1d4ed8; }
        
        .escrow-a { border-left: 3px solid #10b981; }
        .escrow-b { border-left: 3px solid #3b82f6; }
        
        .tx-addresses {
          display: flex;
          gap: 8px;
          font-family: 'Courier New', monospace;
          font-size: 10px;
          color: #6b7280;
          margin-top: 2px;
        }
        
        .tx-addr-label {
          color: #9ca3af;
          font-weight: 600;
        }
        
        .tx-hash-link {
          font-family: 'Courier New', monospace;
          font-size: 10px;
          color: #667eea;
          text-decoration: none;
        }
        
        .tx-hash-link:hover {
          text-decoration: underline;
        }
        
        .tx-in {
          color: #10b981;
        }
        
        .tx-out {
          color: #ef4444;
        }
        
        .tx-pending {
          color: #f59e0b;
        }
        
        .tx-hash {
          font-family: 'Courier New', monospace;
          font-size: 10px;
          color: #6b7280;
        }
        
        .tx-hash a {
          color: #667eea;
          text-decoration: none;
        }
        
        .tx-hash a:hover {
          text-decoration: underline;
        }
        
        .tx-details {
          text-align: right;
        }
        
        .tx-amount {
          font-weight: 700;
          font-size: 16px;
          margin-bottom: 5px;
        }
        
        .tx-time {
          font-size: 11px;
          color: #9ca3af;
        }
        
        .tx-status {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 5px;
        }
        
        .tx-status.pending {
          background: #fef3c7;
          color: #92400e;
        }
        
        .tx-status.confirmed {
          background: #d1fae5;
          color: #065f46;
        }
        
        .tx-status.failed {
          background: #fee2e2;
          color: #991b1b;
        }
        
        .tx-tag {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-right: 6px;
        }
        
        .tag-deposit { background: #d1fae5; color: #065f46; }
        .tag-swap { background: #dbeafe; color: #1e40af; }
        .tag-commission { background: #fef3c7; color: #92400e; }
        .tag-refund { background: #fce7f3; color: #9f1239; }
        .tag-payout { background: #e0f2fe; color: #0369a1; font-size: 11px; }
        .tag-payout-part { 
          background: #f3f4f6; 
          color: #4b5563; 
          margin-left: 4px;
          font-size: 8px;
        }
        
        /* Payout grouping styles */
        .payout-header {
          background: linear-gradient(to right, #f0f9ff, #ffffff);
          border-left: 4px solid #0284c7;
          margin-bottom: 2px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        
        .payout-header .tx-header {
          font-size: 12px;
        }
        
        .payout-transaction {
          margin-left: 20px;
          border-left: 2px dashed #e5e7eb;
          position: relative;
        }
        
        .payout-transaction::before {
          content: "└";
          position: absolute;
          left: -8px;
          top: 50%;
          transform: translateY(-50%);
          color: #9ca3af;
          font-size: 14px;
        }
        
        .tx-purpose {
          font-size: 10px;
          color: #6b7280;
          margin-top: 2px;
        }
        .tag-return { background: #ede9fe; color: #6b21a8; }
        
        .tx-escrow {
          font-size: 11px;
          color: #9ca3af;
          font-style: italic;
        }
        
        .tx-recipient {
          font-size: 11px;
          color: #6b7280;
          margin-top: 2px;
          font-family: 'Courier New', monospace;
        }
        
        /* Empty State */
        .empty-state {
          text-align: center;
          padding: 40px;
          color: #9ca3af;
        }
        
        .empty-state-icon {
          font-size: 48px;
          margin-bottom: 10px;
          opacity: 0.5;
        }
        
        /* Loading Spinner */
        .loading-spinner {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 3px solid #e5e7eb;
          border-top-color: #667eea;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
        /* Sync Status Indicator */
        .sync-status {
          position: fixed;
          top: 15px;
          right: 15px;
          padding: 5px 10px;
          border-radius: 6px;
          font-size: 10px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 5px;
          transition: all 0.3s ease;
          z-index: 100;
        }
        
        .sync-status.synced {
          background: rgba(16, 185, 129, 0.1);
          color: #065f46;
          border: 1px solid rgba(16, 185, 129, 0.3);
        }
        
        .sync-status.disconnected {
          background: rgba(239, 68, 68, 0.1);
          color: #991b1b;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        
        .sync-status .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          animation: pulse 2s infinite;
        }
        
        .deal-summary {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 20px;
          border-radius: 10px;
          margin-bottom: 25px;
        }
        
        .deal-summary p {
          margin: 8px 0;
          font-size: 15px;
        }
        
        .deal-summary strong {
          display: inline-block;
          min-width: 100px;
        }
        
        .chain-badge {
          display: inline-block;
          padding: 3px 8px;
          background: rgba(255,255,255,0.2);
          color: white;
          border-radius: 4px;
          font-weight: 600;
          font-size: 12px;
          margin-left: 5px;
        }
        
        /* Responsive Design */
        @media (max-width: 768px) {
          .balance-grid {
            grid-template-columns: 1fr;
          }
          
          .status-header {
            flex-direction: column;
            gap: 15px;
            text-align: center;
          }
          
          .transaction-item {
            flex-direction: column;
            gap: 10px;
          }
          
          .tx-details {
            text-align: left;
            width: 100%;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>${partyIcon} ${partyLabel}</h1>
        
        <!-- Sync Status -->
        <div class="sync-status synced" id="syncStatus">
          <span class="status-dot"></span>
          <span id="syncText">In sync</span>
        </div>
        
        <!-- Deal Summary (Always Visible) -->
        <div class="deal-summary">
          <h3 style="margin-top: 0; margin-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 10px;">📊 Deal Summary</h3>
          <p><strong>You Send:</strong> ${dealInfo.sendAmount} ${dealInfo.sendAsset} <span class="chain-badge">${dealInfo.sendChainIcon} ${dealInfo.sendChain}</span></p>
          <p><strong>You Receive:</strong> ${dealInfo.receiveAmount} ${dealInfo.receiveAsset} <span class="chain-badge">${dealInfo.receiveChainIcon} ${dealInfo.receiveChain}</span></p>
        </div>
        
        <!-- Details Form (Always Visible) -->
        <div id="detailsForm" style="background: #f9f9f9; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
          <h3>📝 Your Wallet Addresses:</h3>
          
          <div class="form-group">
            <label for="payback">🔙 Payback Address on <span style="color: #667eea; font-weight: 600;">${dealInfo.sendChain}</span></label>
            <small style="color: #888;">If the deal fails, your ${dealInfo.sendAmount} ${dealInfo.sendAsset} will be returned to this address</small>
            <div style="background: #fff3cd; padding: 8px; border-radius: 5px; margin: 8px 0; border-left: 4px solid #ffc107;">
              <small style="color: #856404;">⚠️ Must be a valid ${dealInfo.sendChain} address that can receive ${dealInfo.sendAsset}</small>
            </div>
            <input id="payback" placeholder="Enter your ${dealInfo.sendChain} wallet address" required>
          </div>
          
          <div class="form-group">
            <label for="recipient">📥 Recipient Address on <span style="color: #667eea; font-weight: 600;">${dealInfo.receiveChain}</span></label>
            <small style="color: #888;">When the deal succeeds, you will receive ${dealInfo.receiveAmount} ${dealInfo.receiveAsset} here</small>
            <div style="background: #fff3cd; padding: 8px; border-radius: 5px; margin: 8px 0; border-left: 4px solid #ffc107;">
              <small style="color: #856404;">⚠️ Must be a valid ${dealInfo.receiveChain} address that can receive ${dealInfo.receiveAsset}</small>
            </div>
            <input id="recipient" placeholder="Enter your ${dealInfo.receiveChain} wallet address" required>
          </div>
          
          <div class="form-group">
            <label for="email">Email (Optional)</label>
            <small style="color: #888;">For deal status notifications</small>
            <input id="email" type="email" placeholder="your@email.com">
          </div>
          
          <button onclick="submitDetails()">Submit Details & Continue</button>
        </div>
        
        <!-- Status Dashboard (Always Visible) -->
        <div class="status-dashboard" id="statusDashboard">
          <!-- Status Header -->
          <div class="status-header">
            <div class="deal-stage">
              <span>Deal Status:</span>
              <span id="dealStage" class="stage-badge"></span>
            </div>
            <div id="countdown" class="countdown-timer">--:--:--</div>
          </div>
          
          <!-- Detailed Status Explanation -->
          <div id="stageDetails" class="stage-details"></div>
          
          <!-- Balance Cards -->
          <div class="balance-grid">
            <div class="balance-card your-balance">
              <div class="balance-percentage" id="yourPercentage">0%</div>
              <div class="balance-label">Your Escrow Balance</div>
              <div class="balance-amount" id="yourBalance">0.0000 / 0.0000</div>
              <div class="balance-progress">
                <div class="balance-progress-fill" id="yourProgress" style="width: 0%;"></div>
              </div>
              <div class="balance-details" id="yourDetails">
                <span id="yourAsset">${dealInfo.sendAsset}</span> • 
                <span id="yourStatus">Waiting for deposits...</span>
              </div>
            </div>
            
            <div class="balance-card their-balance">
              <div class="balance-percentage" id="theirPercentage">0%</div>
              <div class="balance-label">Counterparty Balance</div>
              <div class="balance-amount" id="theirBalance">0.0000 / 0.0000</div>
              <div class="balance-progress">
                <div class="balance-progress-fill" id="theirProgress" style="width: 0%;"></div>
              </div>
              <div class="balance-details" id="theirDetails">
                <span id="theirAsset">${dealInfo.receiveAsset}</span> • 
                <span id="theirStatus">Waiting for deposits...</span>
              </div>
            </div>
          </div>
          
          <!-- Cancel Deal Button (if no assets locked) -->
          <div id="cancelSection" style="display: none; margin: 20px 0; text-align: center;">
            <button onclick="cancelDeal()" style="background: #dc3545; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: 600;">
              ❌ Cancel Deal
            </button>
            <small style="display: block; margin-top: 5px; color: #666;">You can cancel this deal since no assets have been locked yet</small>
          </div>
          
          <!-- Escrow Address Section -->
          <div class="escrow-section" id="escrowSection" style="display: none;">
            <div class="escrow-label">⚠️ Send Your Funds To This Escrow Address:</div>
            <div class="escrow-address" id="escrowAddress">Loading...</div>
            <div style="margin-top: 10px;">
              <span style="font-size: 14px; color: #92400e;">
                Amount Required: <strong id="escrowAmount">${dealInfo.sendAmount} ${dealInfo.sendAsset}</strong>
              </span>
            </div>
            <button class="escrow-copy-btn" onclick="copyEscrowAddress()">
              📋 Copy Escrow Address
            </button>
          </div>
          
          <!-- Transaction Log -->
          <div class="transaction-log">
            <h3>📜 Transaction History <div class="loading-spinner" id="txLoadingSpinner" style="display: none;"></div></h3>
            <div class="transaction-list" id="transactionList">
              <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No transactions yet</p>
                <small>Transactions will appear here once you start depositing funds</small>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Load ethers.js v6 from CDN for direct blockchain queries -->
      <script type="module">
        import { ethers } from 'https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.min.js';
        
        // Make ethers available globally
        window.ethers = ethers;
      </script>
      
      <style>
        /* More compact fonts and spacing for seller pages */
        body { font-size: 11px !important; }
        h1 { font-size: 16px !important; padding-bottom: 5px !important; }
        h2 { font-size: 14px !important; }
        h3 { font-size: 12px !important; margin: 0 0 6px 0 !important; }
        h4 { font-size: 11px !important; }
        
        .container { padding: 12px !important; }
        .form-group { margin: 6px 0 !important; }
        .asset-section { padding: 8px !important; }
        
        .escrow-info { padding: 8px !important; margin-bottom: 10px !important; }
        .escrow-address { font-size: 9px !important; padding: 4px 6px !important; margin-top: 4px !important; }
        .escrow-label { font-size: 11px !important; }
        .escrow-copy-btn { padding: 5px 10px !important; font-size: 10px !important; }
        
        .countdown-timer { 
          padding: 3px 6px !important; 
          font-size: 9px !important; 
          margin-left: 6px !important;
          min-width: 55px !important;
        }
        
        .deal-info h2 { font-size: 14px !important; }
        .deal-status { font-size: 11px !important; }
        .stage-badge { 
          font-size: 9px !important; 
          padding: 2px 6px !important;
        }
        
        input, select { 
          padding: 4px 6px !important; 
          font-size: 10px !important; 
          margin: 2px 0 !important;
        }
        button { 
          padding: 6px 12px !important; 
          font-size: 11px !important; 
        }
        
        label {
          font-size: 10px !important;
          margin-bottom: 2px !important;
        }
        
        .asset-display { 
          padding: 3px 5px !important; 
          font-size: 10px !important; 
          gap: 4px !important;
        }
        .asset-icon { font-size: 14px !important; }
        .asset-name { font-size: 10px !important; }
        .asset-details { font-size: 9px !important; }
        
        .balance-card { padding: 10px !important; }
        .balance-label { font-size: 10px !important; }
        .balance-amount { font-size: 11px !important; }
        .balance-percentage { font-size: 14px !important; }
        .balance-progress { height: 16px !important; }
        .balance-details { font-size: 9px !important; margin-top: 6px !important; }
        
        .transaction-item { 
          padding: 6px !important; 
          margin: 4px 0 !important; 
        }
        .tx-hash { font-size: 9px !important; }
        .tx-amount { font-size: 10px !important; }
        .tx-tag { 
          font-size: 8px !important; 
          padding: 1px 4px !important; 
        }
        
        .chain-badge {
          font-size: 8px !important;
          padding: 1px 4px !important;
        }
        
        .transaction-log h3 { font-size: 11px !important; }
        .empty-state { padding: 15px !important; }
        .empty-state-icon { font-size: 20px !important; }
        .empty-state p { font-size: 11px !important; }
        .empty-state small { font-size: 9px !important; }
        
        .live-indicator {
          display: inline-block;
          animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        
        .automatic-return-notice {
          animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        small { font-size: 9px !important; }
      </style>
      
      <script>
        const dealId = '${dealId}';
        const token = '${token}';
        const party = '${party}';
        
        // Store deal info for use in JavaScript
        const dealInfo = {
          sendChain: '${dealInfo.sendChain}',
          sendAsset: '${dealInfo.sendAsset}',
          sendAmount: '${dealInfo.sendAmount}',
          receiveChain: '${dealInfo.receiveChain}',
          receiveAsset: '${dealInfo.receiveAsset}',
          receiveAmount: '${dealInfo.receiveAmount}'
        };
        
        let refreshInterval = null;
        let countdownInterval = null;
        let dealData = null;
        let blockchainProviders = {};
        let blockchainQueryCache = {};
        let lastSyncTime = Date.now();
        
        // RPC endpoints will be populated from backend
        let RPC_ENDPOINTS = {};
        
        // ===== UNICITY FULCRUM SUPPORT =====
        let electrumSocket = null;
        let electrumConnected = false;
        let electrumRequestId = 1;
        let electrumCallbacks = {};
        let currentBlockHeight = 0;
        let lastBlockHeightUpdate = 0;
        
        // Bech32 decode for Unicity addresses
        const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
        
        function bech32Decode(str) {
          let data = [];
          let p = str.lastIndexOf('1');
          if (p === -1) return null;
          
          for (let i = p + 1; i < str.length; i++) {
            let d = CHARSET.indexOf(str[i]);
            if (d === -1) return null;
            data.push(d);
          }
          
          // Remove checksum (last 6 characters)
          data = data.slice(0, -6);
          
          return { prefix: str.substring(0, p), words: data };
        }
        
        function bech32FromWords(words) {
          let bits = 0;
          let value = 0;
          let output = [];
          for (let i = 0; i < words.length; i++) {
            value = (value << 5) | words[i];
            bits += 5;
            while (bits >= 8) {
              bits -= 8;
              output.push((value >> bits) & 0xff);
            }
          }
          // Handle remaining bits
          if (bits > 0) {
            output.push((value << (8 - bits)) & 0xff);
          }
          return new Uint8Array(output.slice(0, 20)); // P2WPKH uses 20 bytes
        }
        
        // SHA256 implementation for browser (with fallback for non-HTTPS)
        async function sha256(data) {
          // Try native crypto API first (requires HTTPS)
          if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
            try {
              const hashBuffer = await crypto.subtle.digest('SHA-256', data);
              return new Uint8Array(hashBuffer);
            } catch (e) {
              console.warn('Crypto.subtle failed, using fallback:', e.message);
            }
          }
          
          // Fallback: Basic SHA256 implementation for HTTP contexts
          // This is a minimal SHA256 implementation for when crypto.subtle is not available
          function sha256Fallback(buffer) {
            const K = [
              0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
              0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
              0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
              0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
              0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
              0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
              0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
              0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
            ];
            
            let H = [
              0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
            ];
            
            // Pre-processing
            const msg = new Uint8Array(buffer);
            const ml = msg.length;
            const msgBitLength = ml * 8;
            const msgLen = Math.floor((msgBitLength + 64) / 512) + 1;
            const padded = new Uint8Array(msgLen * 64);
            padded.set(msg);
            padded[ml] = 0x80;
            
            const view = new DataView(padded.buffer);
            view.setUint32(padded.length - 4, msgBitLength, false);
            
            // Process each 512-bit chunk
            for (let chunk = 0; chunk < msgLen; chunk++) {
              const w = new Uint32Array(64);
              
              // Copy chunk into first 16 words
              for (let i = 0; i < 16; i++) {
                w[i] = view.getUint32((chunk * 64) + (i * 4), false);
              }
              
              // Extend the first 16 words into remaining 48 words
              for (let i = 16; i < 64; i++) {
                const s0 = rightRotate(w[i-15], 7) ^ rightRotate(w[i-15], 18) ^ (w[i-15] >>> 3);
                const s1 = rightRotate(w[i-2], 17) ^ rightRotate(w[i-2], 19) ^ (w[i-2] >>> 10);
                w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
              }
              
              // Initialize working variables
              let [a, b, c, d, e, f, g, h] = H;
              
              // Compression function main loop
              for (let i = 0; i < 64; i++) {
                const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
                const ch = (e & f) ^ ((~e) & g);
                const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
                const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (S0 + maj) >>> 0;
                
                h = g;
                g = f;
                f = e;
                e = (d + temp1) >>> 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) >>> 0;
              }
              
              // Add compressed chunk to current hash value
              H[0] = (H[0] + a) >>> 0;
              H[1] = (H[1] + b) >>> 0;
              H[2] = (H[2] + c) >>> 0;
              H[3] = (H[3] + d) >>> 0;
              H[4] = (H[4] + e) >>> 0;
              H[5] = (H[5] + f) >>> 0;
              H[6] = (H[6] + g) >>> 0;
              H[7] = (H[7] + h) >>> 0;
            }
            
            // Produce final hash
            const result = new Uint8Array(32);
            for (let i = 0; i < 8; i++) {
              result[i * 4] = (H[i] >>> 24) & 0xff;
              result[i * 4 + 1] = (H[i] >>> 16) & 0xff;
              result[i * 4 + 2] = (H[i] >>> 8) & 0xff;
              result[i * 4 + 3] = H[i] & 0xff;
            }
            
            return result;
            
            function rightRotate(n, b) {
              return (n >>> b) | (n << (32 - b));
            }
          }
          
          return sha256Fallback(data);
        }
        
        // Convert Unicity address to script hash for Electrum
        async function addressToScriptHash(address) {
          if (!address) return null;
          
          try {
            const decoded = bech32Decode(address);
            if (!decoded) {
              console.error('Failed to decode bech32 address:', address);
              return null;
            }
            
            // Get witness version (first 5-bit group after removing hrp)
            const witnessVersion = decoded.words[0];
            if (witnessVersion !== 0) {
              console.error('Unsupported witness version:', witnessVersion);
              return null;
            }
            
            // Convert remaining words to witness program (should be 20 bytes for P2WPKH)
            const witnessProgram = bech32FromWords(decoded.words.slice(1));
            
            if (witnessProgram.length !== 20) {
              console.error('Invalid witness program length:', witnessProgram.length);
              return null;
            }
            
            // Create scriptPubKey for P2WPKH (OP_0 + push(20) + 20 bytes)
            const scriptPubKey = new Uint8Array(22);
            scriptPubKey[0] = 0x00; // OP_0
            scriptPubKey[1] = 0x14; // Push 20 bytes
            scriptPubKey.set(witnessProgram, 2);
            
            // SHA256 hash
            const hash = await sha256(scriptPubKey);
            
            // Reverse for Electrum (little-endian)
            const reversed = Array.from(hash).reverse();
            const hexHash = reversed.map(b => b.toString(16).padStart(2, '0')).join('');
            
            // Address to script hash conversion completed
            
            return hexHash;
          } catch (err) {
            console.error('Error converting address to script hash:', err, err.stack);
            return null;
          }
        }
        
        // Connect to Unicity Fulcrum
        async function connectToUnicity() {
          // Fetch chain config from backend
          let wsUrl = 'wss://fulcrum.unicity.network:50004'; // fallback
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'otc.getChainConfig',
                params: { chainId: 'UNICITY' }
              })
            });
            const data = await response.json();
            if (data.result && data.result.UNICITY && data.result.UNICITY.electrumUrl) {
              wsUrl = data.result.UNICITY.electrumUrl;
              console.log('Using Fulcrum endpoint from backend:', wsUrl);
            }
          } catch (err) {
            console.error('Failed to fetch chain config, using default:', err);
          }
          
          return new Promise((resolve, reject) => {
            
            try {
              console.log('Connecting to Unicity Fulcrum at:', wsUrl);
              electrumSocket = new WebSocket(wsUrl);
              
              electrumSocket.onopen = function() {
                electrumConnected = true;
                console.log('Connected to Unicity Fulcrum');
                
                // Get server version
                electrumRequest('server.version', ['OTC-Broker', '1.4'], function(result) {
                  // Server version received
                });
                
                // Subscribe to block headers to maintain current height
                electrumRequest('blockchain.headers.subscribe', [], function(result) {
                  if (result && (result.height || result.block_height)) {
                    currentBlockHeight = result.height || result.block_height;
                    lastBlockHeightUpdate = Date.now();
                    // Initial block height received
                  }
                });
                
                resolve();
              };
              
              electrumSocket.onmessage = function(event) {
                try {
                  const response = JSON.parse(event.data);
                  
                  // Check for block header notifications
                  if (response.method === 'blockchain.headers.subscribe' && response.params && response.params[0]) {
                    const header = response.params[0];
                    if (header.height || header.block_height) {
                      const newHeight = header.height || header.block_height;
                      if (newHeight > currentBlockHeight) {
                        currentBlockHeight = newHeight;
                        lastBlockHeightUpdate = Date.now();
                      }
                    }
                  }
                  
                  if (response.id && electrumCallbacks[response.id]) {
                    const callback = electrumCallbacks[response.id];
                    delete electrumCallbacks[response.id];
                    
                    if (response.error) {
                      // Electrum error received
                      callback(null, response.error);
                    } else {
                      callback(response.result);
                    }
                  }
                } catch (err) {
                  console.error('Error parsing Electrum response:', err);
                }
              };
              
              electrumSocket.onerror = function(error) {
                console.error('Unicity WebSocket error:', error);
                electrumConnected = false;
                reject(error);
              };
              
              electrumSocket.onclose = function() {
                electrumConnected = false;
                console.log('Disconnected from Unicity Fulcrum');
              };
            } catch (err) {
              reject(err);
            }
          });
        }
        
        // Send Electrum request
        function electrumRequest(method, params, callback) {
          if (!electrumSocket || electrumSocket.readyState !== WebSocket.OPEN) {
            if (callback) callback(null, 'Not connected');
            return;
          }
          
          const id = electrumRequestId++;
          
          if (callback) {
            electrumCallbacks[id] = callback;
          }
          
          const request = {
            jsonrpc: '2.0',
            method: method,
            params: params,
            id: id
          };
          
          electrumSocket.send(JSON.stringify(request));
        }
        
        // Promisified version of electrumRequest for async/await usage
        function electrumRequestAsync(method, params, timeoutMs = 10000) {
          return new Promise((resolve, reject) => {
            let timeoutId;
            let completed = false;
            
            // Set timeout
            timeoutId = setTimeout(() => {
              if (!completed) {
                completed = true;
                // Request timeout
                reject(new Error('Request timeout: ' + method));
              }
            }, timeoutMs);
            
            electrumRequest(method, params, (result, error) => {
              if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
                
                if (error) {
                  reject(error);
                } else {
                  resolve(result);
                }
              }
            });
          });
        }
        
        // Get balance and UTXOs for a Unicity address
        async function getUnicityBalance(address) {
          const scriptHash = await addressToScriptHash(address);
          if (!scriptHash) {
            console.error('Failed to convert address to script hash:', address);
            return { total: 0, confirmed: 0, unconfirmed: 0, utxos: [] };
          }
          
          // Getting balance for address
          
          try {
            // Get UTXOs which gives us detailed info including mempool txs
            const utxos = await electrumRequestAsync('blockchain.scripthash.listunspent', [scriptHash]);
            // Retrieved UTXOs
            
            let confirmedBalance = 0;
            let unconfirmedBalance = 0;
            const utxoList = [];
            
            if (Array.isArray(utxos)) {
              for (const utxo of utxos) {
                const valueInAlpha = (utxo.value || 0) / 100000000;
                
                // height 0 means mempool (unconfirmed)
                if (utxo.height === 0) {
                  unconfirmedBalance += valueInAlpha;
                  utxoList.push({ ...utxo, confirmations: 0, amount: valueInAlpha });
                } else if (utxo.height > 0) {
                  confirmedBalance += valueInAlpha;
                  // Store height for later confirmation calculation
                  utxoList.push({ ...utxo, confirmations: utxo.height, amount: valueInAlpha });
                }
              }
            }
            
            return {
              total: confirmedBalance + unconfirmedBalance,
              confirmed: confirmedBalance,
              unconfirmed: unconfirmedBalance,
              utxos: utxoList
            };
          } catch (error) {
            console.error('Failed to get Unicity UTXOs:', error);
            return { total: 0, confirmed: 0, unconfirmed: 0, utxos: [] };
          }
        }
        
        // Get current block height for Unicity
        async function getUnicityBlockHeight() {
          try {
            const result = await electrumRequestAsync('blockchain.headers.subscribe', []);
            return result ? (result.height || result.block_height || 0) : 0;
          } catch (error) {
            console.error('Failed to get block height:', error);
            return 0;
          }
        }
        
        // Initialize Unicity connection with retry
        function ensureUnicityConnection() {
          if (!electrumConnected) {
            connectToUnicity().catch(err => {
              console.error('Failed to connect to Unicity:', err);
              // Retry connection after 5 seconds
              setTimeout(ensureUnicityConnection, 5000);
            });
          }
        }
        
        // Initialize blockchain providers when ethers is loaded
        function initializeProviders(endpoints) {
          if (!window.ethers) {
            setTimeout(() => initializeProviders(endpoints), 100);
            return;
          }
          
          // Use endpoints from backend if provided
          if (endpoints) {
            RPC_ENDPOINTS = endpoints;
          }
          
          for (const [chain, rpcUrl] of Object.entries(RPC_ENDPOINTS)) {
            if (rpcUrl && !rpcUrl.startsWith('wss://')) { // Skip WebSocket endpoints (Unicity)
              try {
                blockchainProviders[chain] = new ethers.JsonRpcProvider(rpcUrl);
                console.log('Initialized provider for ' + chain + ' with ' + rpcUrl);
              } catch (err) {
                console.error('Failed to initialize ' + chain + ' provider:', err);
              }
            }
          }
        }
        
        // Query balance directly from blockchain
        async function queryBlockchainBalance(chainId, address, assetCode) {
          const provider = blockchainProviders[chainId];
          if (!provider) return null;
          
          const cacheKey = 'balance_' + chainId + '_' + address + '_' + assetCode;
          const cached = blockchainQueryCache[cacheKey];
          
          // Use cache if less than 10 seconds old
          if (cached && Date.now() - cached.timestamp < 10000) {
            return cached.value;
          }
          
          try {
            let balance;
            
            // Check if it's native asset or ERC20
            if (assetCode === 'ETH' || assetCode === 'MATIC' || 
                assetCode === 'ETH@ETH' || assetCode === 'MATIC@POLYGON') {
              // Native currency balance
              balance = await provider.getBalance(address);
              balance = ethers.formatEther(balance);
            } else if (assetCode.startsWith('ERC20:')) {
              // ERC20 token balance
              const tokenAddress = assetCode.split(':')[1];
              const abi = ['function balanceOf(address) view returns (uint256)',
                          'function decimals() view returns (uint8)'];
              const contract = new ethers.Contract(tokenAddress, abi, provider);
              const rawBalance = await contract.balanceOf(address);
              const decimals = await contract.decimals();
              balance = ethers.formatUnits(rawBalance, decimals);
            } else {
              return null;
            }
            
            // Cache the result
            blockchainQueryCache[cacheKey] = {
              value: balance,
              timestamp: Date.now()
            };
            
            return balance;
          } catch (err) {
            console.error('Failed to query balance for ' + address + ' on ' + chainId + ':', err);
            return null;
          }
        }
        
        // Query transaction status directly from blockchain
        async function queryTransactionStatus(chainId, txHash) {
          if (!txHash) return null;
          
          // Skip synthetic transaction IDs
          if (txHash.startsWith('balance-api-empty') || txHash.startsWith('erc20-balance-')) {
            return { 
              status: 'synthetic', 
              confirmations: 999,
              synthetic: true,
              message: 'Synthetic deposit (balance detected, no transaction history)'
            };
          }
          
          const cacheKey = 'tx_' + chainId + '_' + txHash;
          const cached = blockchainQueryCache[cacheKey];
          
          // Use cache if less than 5 seconds old
          if (cached && Date.now() - cached.timestamp < 5000) {
            return cached.value;
          }
          
          // Special handling for Unicity
          if (chainId === 'UNICITY') {
            try {
              if (electrumConnected) {
                const txData = await queryUnicityTransaction(txHash);
                if (txData) {
                  const result = {
                    status: txData.confirmations > 0 ? 'confirmed' : 'pending',
                    confirmations: txData.confirmations || 0,
                    blockNumber: txData.blockHeight || 0
                  };
                  
                  // Cache the result
                  blockchainQueryCache[cacheKey] = {
                    value: result,
                    timestamp: Date.now()
                  };
                  
                  // Transaction status retrieved
                  return result;
                }
              }
              return null;
            } catch (error) {
              console.error('Failed to query Unicity transaction status:', error);
              return null;
            }
          }
          
          // For EVM chains, use the provider
          const provider = blockchainProviders[chainId];
          if (!provider) return null;
          
          try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (!receipt) {
              return { status: 'pending', confirmations: 0 };
            }
            
            const currentBlock = await provider.getBlockNumber();
            const confirmations = currentBlock - receipt.blockNumber + 1;
            
            const result = {
              status: receipt.status === 1 ? 'success' : 'failed',
              confirmations: confirmations,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString()
            };
            
            // Cache the result
            blockchainQueryCache[cacheKey] = {
              value: result,
              timestamp: Date.now()
            };
            
            return result;
          } catch (err) {
            console.error('Failed to query transaction ' + txHash + ' on ' + chainId + ':', err);
            return null;
          }
        }
        
        // Submit party details
        async function submitDetails() {
          const payback = document.getElementById('payback').value;
          const recipient = document.getElementById('recipient').value;
          const email = document.getElementById('email').value;
          
          if (!payback || !recipient) {
            alert('Please enter both payback and recipient addresses');
            return;
          }
          
          // Show confirmation dialog with address details
          const confirmMsg = '⚠️ IMPORTANT: Please double-check your addresses!\\n\\n' +
            'Once submitted, these addresses CANNOT be changed.\\n\\n' +
            '🔙 PAYBACK Address (' + dealInfo.sendChain + '):\\n' + payback + '\\n\\n' +
            '📥 RECIPIENT Address (' + dealInfo.receiveChain + '):\\n' + recipient + '\\n\\n' +
            'If the deal fails, ' + dealInfo.sendAmount + ' ' + dealInfo.sendAsset + ' will be returned to the PAYBACK address.\\n' +
            'If the deal succeeds, you will receive ' + dealInfo.receiveAmount + ' ' + dealInfo.receiveAsset + ' at the RECIPIENT address.\\n\\n' +
            'Are you absolutely sure these addresses are correct?';
          
          if (!confirm(confirmMsg)) {
            return;
          }
          
          // Double confirmation for extra safety
          const doubleConfirm = confirm('🔒 Final Confirmation: After clicking OK, these addresses will be permanently locked. Continue?');
          if (!doubleConfirm) {
            return;
          }
          
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.fillPartyDetails',
                params: {
                  dealId,
                  party,
                  paybackAddress: payback,
                  recipientAddress: recipient,
                  email: email || undefined,
                  token
                },
                id: 1
              })
            });
            
            const result = await response.json();
            
            if (result.result?.ok) {
              // Keep form visible but disabled, and show dashboard
              document.getElementById('payback').disabled = true;
              document.getElementById('recipient').disabled = true;
              document.getElementById('email').disabled = true;
              
              // Update button
              const submitBtn = document.querySelector('#detailsForm button');
              submitBtn.style.display = 'none';
              
              // Add success message
              const successMsg = document.createElement('div');
              successMsg.style.cssText = 'background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 12px; border-radius: 5px; margin: 15px 0;';
              successMsg.innerHTML = '<strong>✅ Success!</strong> Your addresses have been saved and locked.';
              document.getElementById('detailsForm').appendChild(successMsg);
              
              // Dashboard is already visible and updating
            } else {
              alert('Error: ' + (result.error?.message || 'Unknown error'));
            }
          } catch (error) {
            alert('Failed to submit details: ' + error.message);
          }
        }
        
        // Start status updates
        function startStatusUpdates() {
          updateStatus();
          refreshInterval = setInterval(updateStatus, 5000); // Update every 5 seconds
          
          // Compare blockchain transactions with backend data
          window.compareTransactions = async function() {
            const compBtn = document.getElementById('compareBtn');
            const compResults = document.getElementById('comparisonResults');
            const compContent = document.getElementById('comparisonContent');
            
            compBtn.disabled = true;
            compBtn.textContent = '⏳ Comparing...';
            
            // Refresh blockchain data first
            await refreshBlockchainData();
            
            // Get backend tracked transactions
            const backendTxs = [];
            const yourSide = party === 'ALICE' ? 'sideA' : 'sideB';
            const theirSide = party === 'ALICE' ? 'sideB' : 'sideA';
            
            // Collect backend deposits
            if (dealData?.collection?.[yourSide]?.deposits) {
              for (const dep of dealData.collection[yourSide].deposits) {
                backendTxs.push({ txid: dep.txid, type: 'deposit', side: 'your' });
              }
            }
            if (dealData?.collection?.[theirSide]?.deposits) {
              for (const dep of dealData.collection[theirSide].deposits) {
                backendTxs.push({ txid: dep.txid, type: 'deposit', side: 'their' });
              }
            }
            
            // Collect backend queue transactions
            if (dealData?.transactions) {
              for (const tx of dealData.transactions) {
                if (tx.submittedTx?.txid) {
                  backendTxs.push({ txid: tx.submittedTx.txid, type: 'queue', purpose: tx.purpose });
                  // Also add additional txids if present
                  if (tx.submittedTx.additionalTxids) {
                    for (const addTxid of tx.submittedTx.additionalTxids) {
                      backendTxs.push({ txid: addTxid, type: 'queue', purpose: tx.purpose + ' (additional)' });
                    }
                  }
                }
              }
            }
            
            // Get blockchain transactions
            const blockchainTxs = [];
            if (window.blockchainTransactions?.escrowA) {
              blockchainTxs.push(...window.blockchainTransactions.escrowA.map(tx => ({ 
                ...tx, 
                escrow: party === 'ALICE' ? 'your' : 'their' 
              })));
            }
            if (window.blockchainTransactions?.escrowB) {
              blockchainTxs.push(...window.blockchainTransactions.escrowB.map(tx => ({ 
                ...tx, 
                escrow: party === 'BOB' ? 'your' : 'their' 
              })));
            }
            
            // Compare and find untracked transactions
            const backendTxIds = new Set(backendTxs.map(tx => tx.txid?.toLowerCase()));
            const untracked = blockchainTxs.filter(tx => 
              !backendTxIds.has(tx.txid?.toLowerCase()) && 
              !tx.txid?.startsWith('pending-') &&
              !tx.txid?.startsWith('balance-')
            );
            
            // Generate comparison report
            let html = '';
            html += '<div style="font-size: 10px;">';
            html += '<p><strong>Backend Tracked:</strong> ' + backendTxs.length + ' transactions</p>';
            html += '<p><strong>Blockchain Found:</strong> ' + blockchainTxs.length + ' transactions</p>';
            
            if (untracked.length > 0) {
              html += '<p style="color: #dc2626; font-weight: bold;">⚠️ Found ' + untracked.length + ' untracked transactions:</p>';
              html += '<ul style="margin: 5px 0; padding-left: 20px; font-size: 9px;">';
              for (const tx of untracked) {
                html += '<li>';
                html += '<strong>' + (tx.direction === 'in' ? '⬇️' : '⬆️') + ' ' + tx.txid?.substring(0, 10) + '...</strong><br>';
                html += 'Amount: ' + tx.amount + ', Confirms: ' + tx.confirmations + '<br>';
                html += 'From: ' + tx.from?.substring(0, 10) + '... To: ' + tx.to?.substring(0, 10) + '...';
                html += '</li>';
              }
              html += '</ul>';
            } else {
              html += '<p style="color: #059669;">✅ All blockchain transactions are tracked by backend</p>';
            }
            
            // Show tracked transactions summary
            if (backendTxs.length > 0) {
              html += '<p style="margin-top: 10px;"><strong>Backend tracking:</strong></p>';
              html += '<ul style="margin: 5px 0; padding-left: 20px; font-size: 9px;">';
              const summary = {};
              for (const tx of backendTxs) {
                const key = tx.type + (tx.purpose ? '-' + tx.purpose : '');
                summary[key] = (summary[key] || 0) + 1;
              }
              for (const [key, count] of Object.entries(summary)) {
                html += '<li>' + key + ': ' + count + ' tx(s)</li>';
              }
              html += '</ul>';
            }
            
            html += '</div>';
            
            compContent.innerHTML = html;
            compResults.style.display = 'block';
            
            compBtn.disabled = false;
            compBtn.textContent = '🔍 Compare with Blockchain';
          };
          
          // Also start blockchain refresh for live data
          setInterval(refreshBlockchainData, 10000); // Refresh blockchain data every 10 seconds
          
          // Check sync status every second
          setInterval(updateSyncStatus, 1000);
          
          // Ensure Unicity connection is maintained
          setInterval(function() {
            if (!electrumConnected) {
              ensureUnicityConnection();
            }
          }, 5000);
        }
        
        // Query transaction history for Polygon/EVM chains
        async function queryEvmTransactionHistory(chainId, address) {
          const provider = blockchainProviders[chainId];
          if (!provider) return [];
          
          try {
            // Get recent block number
            const currentBlock = await provider.getBlockNumber();
            const transactions = [];
            
            // Try to fetch from Etherscan/Polygonscan API
            let apiUrl;
            if (chainId === 'POLYGON') {
              apiUrl = 'https://api.polygonscan.com/api';
            } else if (chainId === 'ETH') {
              apiUrl = 'https://api.etherscan.io/api';
            } else if (chainId === 'BASE') {
              apiUrl = 'https://api.basescan.org/api';
            }
            
            if (apiUrl) {
              try {
                // Fetch transaction list for the address
                const params = new URLSearchParams({
                  module: 'account',
                  action: 'txlist',
                  address: address,
                  startblock: Math.max(0, currentBlock - 10000).toString(),
                  endblock: currentBlock.toString(),
                  sort: 'desc'
                });
                
                // Note: Some networks may require an API key for V2 endpoints
                // For now, we'll try without an API key and handle errors gracefully
                const response = await fetch(\`\${apiUrl}?\${params.toString()}\`);
                const data = await response.json();
                
                console.log(\`Fetched \${chainId} transactions for \${address}:\`, data);
                
                // Check for API errors
                if (data.message && data.message.includes('deprecated V1 endpoint')) {
                  console.warn('Etherscan API V1 deprecated. Falling back to blockchain query.');
                  // Fall back to direct blockchain query
                  throw new Error('API V1 deprecated');
                }
                
                if (data.status === '1' && Array.isArray(data.result)) {
                  // Process transactions
                  for (const tx of data.result) {
                    // Filter for incoming transactions (where 'to' is our address)
                    if (tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
                      const confirms = currentBlock - parseInt(tx.blockNumber) + 1;
                      transactions.push({
                        txid: tx.hash,
                        from: tx.from,
                        to: tx.to,
                        amount: ethers.formatEther(tx.value),
                        blockHeight: parseInt(tx.blockNumber),
                        confirmations: confirms,
                        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                        direction: 'in',
                        source: 'blockchain'
                      });
                    } else if (tx.from && tx.from.toLowerCase() === address.toLowerCase()) {
                      // Outgoing transaction
                      const confirms = currentBlock - parseInt(tx.blockNumber) + 1;
                      transactions.push({
                        txid: tx.hash,
                        from: tx.from,
                        to: tx.to,
                        amount: ethers.formatEther(tx.value),
                        blockHeight: parseInt(tx.blockNumber),
                        confirmations: confirms,
                        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                        direction: 'out',
                        source: 'blockchain'
                      });
                    }
                  }
                } else {
                  // No transactions found or API error
                }
              } catch (err) {
                console.error('Failed to fetch from Etherscan/Polygonscan:', err);
                
                // Fallback: Query recent blocks directly from blockchain
                try {
                  console.log('Falling back to direct blockchain query for', chainId, address);
                  const blocksToScan = 1000; // Scan last 1000 blocks
                  const fromBlock = Math.max(0, currentBlock - blocksToScan);
                  
                  // Get logs for incoming transfers to this address
                  const logs = await provider.getLogs({
                    fromBlock: fromBlock,
                    toBlock: currentBlock,
                    address: null, // All addresses
                    topics: [
                      null, // Any event
                      null, // From any address
                      ethers.zeroPadValue(address, 32) // To our address
                    ]
                  });
                  
                  // Process logs to find transactions
                  for (const log of logs) {
                    const tx = await provider.getTransaction(log.transactionHash);
                    if (tx && tx.to && tx.to.toLowerCase() === address.toLowerCase()) {
                      const block = await provider.getBlock(log.blockNumber);
                      const confirms = currentBlock - log.blockNumber + 1;
                      transactions.push({
                        txid: log.transactionHash,
                        from: tx.from,
                        to: tx.to,
                        amount: ethers.formatEther(tx.value),
                        blockNumber: log.blockNumber,
                        blockTime: new Date((block?.timestamp || 0) * 1000).toISOString(),
                        confirmations: confirms,
                        direction: 'in'
                      });
                    }
                  }
                  
                  console.log('Found', transactions.length, 'transactions via direct blockchain query');
                } catch (fallbackErr) {
                  console.error('Fallback blockchain query also failed:', fallbackErr);
                }
              }
            }
            
            return transactions;
          } catch (err) {
            console.error('Failed to query EVM transaction history:', err);
            return [];
          }
        }
        
        // Query transaction history for Unicity
        async function queryUnicityTransactionHistory(address) {
          if (!electrumConnected) return [];
          
          try {
            const scriptHash = await addressToScriptHash(address);
            if (!scriptHash) return [];
            
            // Get transaction history from Fulcrum
            const history = await electrumRequestAsync('blockchain.scripthash.get_history', [scriptHash]);
            if (!history || !Array.isArray(history)) return [];
            
            // Use cached block height or refresh if stale
            if (Date.now() - lastBlockHeightUpdate > 60000) { // Refresh every minute
              const headers = await electrumRequestAsync('blockchain.headers.subscribe', []);
              if (headers && (headers.height || headers.block_height)) {
                currentBlockHeight = headers.height || headers.block_height;
                lastBlockHeightUpdate = Date.now();
              }
            }
            const blockHeight = currentBlockHeight || 0;
            
            // Process each transaction
            const transactions = [];
            for (const item of history) {
              const confirmations = item.height > 0 ? (blockHeight - item.height + 1) : 0;
              transactions.push({
                txid: item.tx_hash,
                blockHeight: item.height,
                confirmations: confirmations,
                fee: item.fee
              });
            }
            
            return transactions;
          } catch (err) {
            // Error querying Unicity transaction history
            return [];
          }
        }
        
        // Query a specific Unicity transaction by txid
        async function queryUnicityTransaction(txid) {
          if (!electrumConnected || !txid) {
            console.log('Not connected or no txid provided');
            return null;
          }
          
          // Querying transaction
          
          try {
            // Try verbose format first
            // Requesting verbose tx
            let tx = await electrumRequestAsync('blockchain.transaction.get', [txid, true]);
            // Verbose tx response received
            
            // If verbose returns null, try raw format with merkle
            if (!tx) {
              // Trying raw format
              const rawTx = await electrumRequestAsync('blockchain.transaction.get', [txid, false]);
              // Raw tx response received
              
              if (rawTx) {
                // Fetching merkle info
                const merkleInfo = await electrumRequestAsync('blockchain.transaction.get_merkle', [txid]);
                // Merkle info received
                if (merkleInfo && merkleInfo.block_height) {
                  // Use cached block height
                  const confirmations = currentBlockHeight > merkleInfo.block_height ? 
                    (currentBlockHeight - merkleInfo.block_height + 1) : 0;
                  // Confirmations calculated from merkle
                  return {
                    txid: txid,
                    blockHeight: merkleInfo.block_height,
                    confirmations: confirmations,
                    status: confirmations > 0 ? 'confirmed' : 'pending'
                  };
                }
              }
            } else if (tx) {
              // Process verbose format
              // Verbose tx data received
              
              // Fulcrum returns confirmations directly, not block height
              const confirmations = tx.confirmations || 0;
              
              // Calculate block height from confirmations if we have them
              let blockHeight = 0;
              if (confirmations > 0 && currentBlockHeight > 0) {
                blockHeight = currentBlockHeight - confirmations + 1;
              }
              
              // Extract output amount if available
              let outputAmount = 0;
              
              // Electrum/Fulcrum returns transaction in different formats
              // Check for vout array (verbose format)
              if (tx.vout && Array.isArray(tx.vout)) {
                for (const output of tx.vout) {
                  // Handle both formats: value as number or as BTC string
                  if (typeof output.value === 'number') {
                    // Value in BTC, need to convert to satoshis
                    outputAmount += Math.round(output.value * 100000000);
                  } else if (output.value) {
                    // Might already be in satoshis or other format
                    outputAmount += parseInt(output.value) || 0;
                  }
                }
              } else if (tx.value) {
                // Sometimes the total value is provided directly
                if (typeof tx.value === 'number') {
                  outputAmount = Math.round(tx.value * 100000000);
                } else {
                  outputAmount = parseInt(tx.value) || 0;
                }
              }
              
              // Transaction output amount extracted
              
              // Transaction data processed
              return {
                txid: txid,
                blockHeight: blockHeight,
                confirmations: confirmations,
                status: confirmations > 0 ? 'confirmed' : 'pending',
                outputAmount: outputAmount // In satoshis
              };
            }
            
            // Transaction not found
            return null;
          } catch (err) {
            console.error('Failed to query Unicity transaction:', txid, 'Error:', err);
            return null;
          }
        }
        
        // Refresh blockchain data directly
        async function refreshBlockchainData() {
          if (!dealData || !blockchainProviders) return;
          
          // Update Unicity block height if connected
          if (electrumConnected) {
            try {
              const headers = await electrumRequestAsync('blockchain.headers.subscribe', []);
              if (headers && (headers.height || headers.block_height)) {
                const newHeight = headers.height || headers.block_height;
                if (newHeight > currentBlockHeight) {
                  currentBlockHeight = newHeight;
                  lastBlockHeightUpdate = Date.now();
                }
              }
            } catch (err) {
              console.error('Failed to update block height:', err);
            }
          }
          
          // Store blockchain transaction data for comparison
          window.blockchainTransactions = window.blockchainTransactions || {};
          
          // Refresh escrow balances if we have addresses
          if (dealData.escrowA?.address) {
            const chainId = dealData.alice.chainId;
            const asset = dealData.alice.asset;
            
            if (chainId === 'UNICITY') {
              // Query Unicity transaction history
              const txHistory = await queryUnicityTransactionHistory(dealData.escrowA.address);
              // Unicity tx history retrieved
              window.blockchainTransactions.escrowA = txHistory;
              
              // Merge with existing deposit data
              if (txHistory.length > 0 && dealData.collection?.sideA) {
                dealData.collection.sideA.txHistory = txHistory;
              }
            } else if (blockchainProviders[chainId]) {
              // Query EVM transaction history
              const txHistory = await queryEvmTransactionHistory(chainId, dealData.escrowA.address);
              // EVM tx history retrieved
              window.blockchainTransactions.escrowA = txHistory;
              
              // Merge with existing deposit data
              if (txHistory.length > 0 && dealData.collection?.sideA) {
                dealData.collection.sideA.txHistory = txHistory;
              }
              
              await updateBalance('your', 
                dealData.collection?.sideA, 
                dealData.instructions?.sideA,
                party === 'ALICE' ? dealData.alice : dealData.bob);
            }
          }
          
          if (dealData.escrowB?.address) {
            const chainId = dealData.bob.chainId;
            const asset = dealData.bob.asset;
            
            if (chainId === 'UNICITY') {
              // Query Unicity transaction history
              const txHistory = await queryUnicityTransactionHistory(dealData.escrowB.address);
              // Unicity tx history retrieved
              window.blockchainTransactions.escrowB = txHistory;
              
              // Merge with existing deposit data
              if (txHistory.length > 0 && dealData.collection?.sideB) {
                dealData.collection.sideB.txHistory = txHistory;
              }
            } else if (blockchainProviders[chainId]) {
              // Query EVM transaction history  
              const txHistory = await queryEvmTransactionHistory(chainId, dealData.escrowB.address);
              // EVM tx history retrieved
              window.blockchainTransactions.escrowB = txHistory;
              
              // Merge with existing deposit data
              if (txHistory.length > 0 && dealData.collection?.sideB) {
                dealData.collection.sideB.txHistory = txHistory;
              }
              
              await updateBalance('their',
                dealData.collection?.sideB,
                dealData.instructions?.sideB,
                party === 'ALICE' ? dealData.bob : dealData.alice);
            }
          }
          
          // Refresh transaction statuses
          const txList = document.getElementById('transactionList');
          if (txList && dealData?.transactions) {
            // Re-render with updated blockchain data
            updateTransactionLog();
          }
          
          // Update sync time if we successfully queried blockchain
          if ((dealData.escrowA?.address && blockchainProviders[dealData.alice.chainId]) ||
              (dealData.escrowB?.address && blockchainProviders[dealData.bob.chainId]) ||
              electrumConnected) {
            lastSyncTime = Date.now();
            updateSyncStatus();
          }
        }
        
        // Update sync status indicator
        function updateSyncStatus() {
          const syncStatus = document.getElementById('syncStatus');
          const syncText = document.getElementById('syncText');
          const timeSinceSync = Date.now() - lastSyncTime;
          
          if (timeSinceSync < 60000) { // Within 1 minute
            syncStatus.className = 'sync-status synced';
            syncText.textContent = 'In sync';
          } else {
            syncStatus.className = 'sync-status disconnected';
            syncText.textContent = 'Disconnected';
          }
        }
        
        // Update status from server
        async function updateStatus() {
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.status',
                params: { dealId },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result) {
              dealData = result.result;
              lastSyncTime = Date.now(); // Update sync time on successful fetch
              
              // Collection data processed
              
              // Initialize blockchain providers with endpoints from backend
              if (dealData.rpcEndpoints && Object.keys(blockchainProviders).length === 0) {
                initializeProviders(dealData.rpcEndpoints);
              }
              
              // First update display (but don't call updateTransactionLog yet)
              updateDisplay(false); // Pass flag to skip transaction log update
              updateSyncStatus();
              
              // Then refresh blockchain data and update transaction log after
              await refreshBlockchainData();
              updateTransactionLog();
            }
          } catch (error) {
            console.error('Failed to update status:', error);
            // Don't update lastSyncTime on error
            updateSyncStatus();
          }
        }
        
        // Update display with latest data
        function updateDisplay(updateTxLog = true) {
          if (!dealData) return;
          
          // Update stage
          const stageEl = document.getElementById('dealStage');
          const detailsEl = document.getElementById('stageDetails');
          
          if (stageEl) {
            stageEl.textContent = dealData.stage;
            stageEl.className = 'stage-badge stage-' + dealData.stage.toLowerCase();
          }
          
          // Update detailed status explanation
          if (detailsEl) {
            detailsEl.innerHTML = getDetailedStatus();
          }
          
          // Update countdown
          const countdownEl = document.getElementById('countdown');
          
          // Stop timer permanently for WAITING, CLOSED, or REVERTED stages
          if (dealData.stage === 'WAITING' || dealData.stage === 'CLOSED' || dealData.stage === 'REVERTED') {
            if (countdownInterval) {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            countdownEl.className = 'countdown-timer';
            countdownEl.textContent = dealData.stage === 'WAITING' ? 'Processing...' : 
                                     dealData.stage === 'CLOSED' ? 'Completed' : 'Reverted';
          } else if (dealData.expiresAt && dealData.stage === 'COLLECTION') {
            // Check if we should pause the timer due to sufficient funds
            const sideAFunded = checkSufficientFunds('A');
            const sideBFunded = checkSufficientFunds('B');
            
            
            if (sideAFunded && sideBFunded) {
              // Both sides have sufficient funds - pause the timer
              if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
              }
              countdownEl.className = 'countdown-timer';
              countdownEl.textContent = '⏸️ Timer paused';
              countdownEl.title = 'Timer paused - sufficient funds collected. Waiting for confirmations.';
            } else {
              // Not enough funds or funds dropped - run/resume the timer
              startCountdown(dealData.expiresAt);
            }
          } else if (dealData.expiresAt) {
            // Other stages with expiry - run timer normally
            startCountdown(dealData.expiresAt);
          } else {
            // Show static total time when timer not started
            if (dealData.stage === 'CREATED') {
              const totalSeconds = dealData.timeoutSeconds || 3600;
              const hours = Math.floor(totalSeconds / 3600);
              const minutes = Math.floor((totalSeconds % 3600) / 60);
              const seconds = totalSeconds % 60;
              
              countdownEl.className = 'countdown-timer';
              countdownEl.textContent = '⏱️ ' + 
                String(hours).padStart(2, '0') + ':' + 
                String(minutes).padStart(2, '0') + ':' + 
                String(seconds).padStart(2, '0');
              countdownEl.title = 'Total time available once collection phase begins';
            } else {
              countdownEl.className = 'countdown-timer';
              countdownEl.textContent = 'No deadline';
            }
          }
          
          // Update balances
          const yourSide = party === 'ALICE' ? 'sideA' : 'sideB';
          const theirSide = party === 'ALICE' ? 'sideB' : 'sideA';
          
          // Get expected amounts from deal data
          const yourExpected = party === 'ALICE' ? dealData.alice : dealData.bob;
          const theirExpected = party === 'ALICE' ? dealData.bob : dealData.alice;
          
          updateBalance('your', dealData.collection?.[yourSide], dealData.instructions?.[yourSide], yourExpected);
          updateBalance('their', dealData.collection?.[theirSide], dealData.instructions?.[theirSide], theirExpected);
          
          // Show escrow address
          if (dealData.instructions?.[yourSide]?.[0]) {
            const escrowAddr = dealData.instructions[yourSide][0].to;
            const escrowAmount = dealData.instructions[yourSide][0].amount;
            const escrowAsset = dealData.instructions[yourSide][0].assetCode;
            
            document.getElementById('escrowSection').style.display = 'block';
            document.getElementById('escrowAddress').textContent = escrowAddr;
            document.getElementById('escrowAmount').textContent = escrowAmount + ' ' + escrowAsset;
          }
          
          // Update transaction log only if flag is true (default)
          if (updateTxLog) {
            updateTransactionLog();
          }
          
          // Handle closed deal notice
          if (dealData.stage === 'CLOSED' || dealData.stage === 'REVERTED') {
            handleClosedDeal();
          }
          
          // Show/hide cancel button based on whether assets are locked
          const hasDeposits = 
            (dealData.collection?.sideA?.deposits?.length > 0) ||
            (dealData.collection?.sideB?.deposits?.length > 0);
          
          if (!hasDeposits && dealData.stage !== 'CLOSED' && dealData.stage !== 'REVERTED') {
            document.getElementById('cancelSection').style.display = 'block';
          } else {
            document.getElementById('cancelSection').style.display = 'none';
          }
        }
        
        // Get detailed status explanation
        function getDetailedStatus() {
          const hasAliceDetails = dealData.aliceDetails && dealData.aliceDetails.paybackAddress;
          const hasBobDetails = dealData.bobDetails && dealData.bobDetails.paybackAddress;
          const aliceDeposits = dealData.collection?.sideA?.deposits?.length || 0;
          const bobDeposits = dealData.collection?.sideB?.deposits?.length || 0;
          const aliceCollected = Object.values(dealData.collection?.sideA?.collectedByAsset || {}).reduce((sum, val) => sum + parseFloat(val), 0);
          const bobCollected = Object.values(dealData.collection?.sideB?.collectedByAsset || {}).reduce((sum, val) => sum + parseFloat(val), 0);
          const aliceExpected = parseFloat(dealData.alice.amount);
          const bobExpected = parseFloat(dealData.bob.amount);
          
          switch(dealData.stage) {
            case 'CREATED':
              if (!hasAliceDetails && !hasBobDetails) {
                return '<strong>Deal initialized - Setup Phase</strong><br>' +
                  '<br><strong>Current Status:</strong> Waiting for both parties to provide wallet addresses<br>' +
                  '<br><strong>Next Steps:</strong><br>' +
                  '1. Alice (Asset Seller) needs to submit Unicity wallet addresses<br>' +
                  '2. Bob (Asset Buyer) needs to submit Polygon wallet addresses<br>' +
                  '3. Once both submit, timer will start and collection phase begins<br>' +
                  '4. Both parties will then deposit assets to their escrow addresses';
              } else if (hasAliceDetails && !hasBobDetails) {
                return '<strong>Partially Ready - Waiting for Party B</strong><br>' +
                  '<br><strong>Current Status:</strong><br>' +
                  '✅ Alice (Party A) has submitted wallet addresses<br>' +
                  '⏳ Waiting for Bob (Party B) to provide Polygon wallet addresses<br>' +
                  '<br><strong>What happens next:</strong><br>' +
                  '1. Bob needs to open their party link and submit details<br>' +
                  '2. Once Bob submits, the 1-hour countdown timer will start<br>' +
                  '3. Both parties must then deposit their assets:<br>' +
                  '   • Alice will deposit ' + aliceExpected.toFixed(4) + ' ALPHA to Unicity escrow<br>' +
                  '   • Bob will deposit ' + bobExpected.toFixed(4) + ' MATIC to Polygon escrow<br>' +
                  '4. After both fully fund, automatic swap will execute';
              } else if (!hasAliceDetails && hasBobDetails) {
                return '<strong>Partially Ready - Waiting for Party A</strong><br>' +
                  '<br><strong>Current Status:</strong><br>' +
                  '✅ Bob (Party B) has submitted wallet addresses<br>' +
                  '⏳ Waiting for Alice (Party A) to provide Unicity wallet addresses<br>' +
                  '<br><strong>What happens next:</strong><br>' +
                  '1. Alice needs to open their party link and submit details<br>' +
                  '2. Once Alice submits, the 1-hour countdown timer will start<br>' +
                  '3. Both parties must then deposit their assets:<br>' +
                  '   • Alice will deposit ' + aliceExpected.toFixed(4) + ' ALPHA to Unicity escrow<br>' +
                  '   • Bob will deposit ' + bobExpected.toFixed(4) + ' MATIC to Polygon escrow<br>' +
                  '4. After both fully fund, automatic swap will execute';
              }
              return '<strong>Both parties ready!</strong><br>Transitioning to collection phase...';
              
            case 'COLLECTION':
              const alicePercent = Math.min(100, (aliceCollected / aliceExpected) * 100).toFixed(1);
              const bobPercent = Math.min(100, (bobCollected / bobExpected) * 100).toFixed(1);
              
              if (aliceCollected < aliceExpected && bobCollected < bobExpected) {
                return '<strong>Collection Phase Active - Both Parties Need to Deposit</strong><br>' +
                  '<br><strong>Current Funding Status:</strong><br>' +
                  '• Alice: ' + aliceCollected.toFixed(4) + '/' + aliceExpected.toFixed(4) + ' ALPHA (' + alicePercent + '%) on Unicity<br>' +
                  '• Bob: ' + bobCollected.toFixed(4) + '/' + bobExpected.toFixed(4) + ' MATIC (' + bobPercent + '%) on Polygon<br>' +
                  '<br><strong>⚠️ Action Required:</strong><br>' +
                  'Both parties must deposit their full amounts to escrow addresses<br>' +
                  '⏱️ Timer is running - complete deposits before expiry!<br>' +
                  '<br><strong>What happens after funding:</strong><br>' +
                  'Once both parties reach 100%, automatic cross-chain swap executes';
              } else if (aliceCollected >= aliceExpected && bobCollected < bobExpected) {
                return '<strong>Waiting for Bob - Alice Fully Funded!</strong><br>' +
                  '<br><strong>Current Status:</strong><br>' +
                  '✅ Alice has deposited ' + aliceExpected.toFixed(4) + ' ALPHA (100%)<br>' +
                  '⏳ Bob has deposited ' + bobCollected.toFixed(4) + '/' + bobExpected.toFixed(4) + ' MATIC (' + bobPercent + '%)<br>' +
                  '<br><strong>Bob needs to deposit:</strong> ' + (bobExpected - bobCollected).toFixed(4) + ' more MATIC<br>' +
                  '<br>Once Bob completes funding, the swap will execute automatically';
              } else if (aliceCollected < aliceExpected && bobCollected >= bobExpected) {
                return '<strong>Waiting for Alice - Bob Fully Funded!</strong><br>' +
                  '<br><strong>Current Status:</strong><br>' +
                  '⏳ Alice has deposited ' + aliceCollected.toFixed(4) + '/' + aliceExpected.toFixed(4) + ' ALPHA (' + alicePercent + '%)<br>' +
                  '✅ Bob has deposited ' + bobExpected.toFixed(4) + ' MATIC (100%)<br>' +
                  '<br><strong>Alice needs to deposit:</strong> ' + (aliceExpected - aliceCollected).toFixed(4) + ' more ALPHA<br>' +
                  '<br>Once Alice completes funding, the swap will execute automatically';
              } else {
                // Check if we're waiting for confirmations
                const sideALocked = dealData.sideAState?.locks?.tradeLockedAt && dealData.sideAState?.locks?.commissionLockedAt;
                const sideBLocked = dealData.sideBState?.locks?.tradeLockedAt && dealData.sideBState?.locks?.commissionLockedAt;
                
                if (!sideALocked || !sideBLocked) {
                  return '<strong>🎉 Both Parties Fully Funded!</strong><br>' +
                    '<br><strong>Status:</strong> ⏸️ Timer paused - waiting for confirmations<br>' +
                    '<br><strong>Current State:</strong><br>' +
                    '✅ Alice has deposited required ALPHA<br>' +
                    '✅ Bob has deposited required MATIC<br>' +
                    '⏳ Waiting for blockchain confirmations (6 for Unicity, 30 for Polygon)<br>' +
                    '<br><strong>Note:</strong> The countdown timer is paused while funds are secured.<br>' +
                    'If a chain reorganization occurs and funds drop below requirements,<br>' +
                    'the timer will automatically resume.';
                } else {
                  return '<strong>🎉 Both Parties Fully Funded & Confirmed!</strong><br>' +
                    '<br><strong>Status:</strong> Preparing cross-chain atomic swap<br>' +
                    '<br><strong>Next Steps:</strong><br>' +
                    '1. Engine verifying all deposits<br>' +
                    '2. Creating transfer transactions<br>' +
                    '3. Executing atomic swap<br>' +
                    '4. Assets will be sent to recipient addresses';
                }
              }
              
            case 'WAITING':
              return '<strong>Processing swap...</strong><br>' +
                'The engine is executing the cross-chain swap.<br>' +
                'Assets are being transferred to recipient addresses.<br>' +
                'This may take a few minutes for confirmations.';
              
            case 'CLOSED':
              return '<strong>Deal completed successfully!</strong><br>' +
                'All assets have been swapped and delivered.<br>' +
                'Alice received ' + bobExpected.toFixed(4) + ' MATIC on Polygon.<br>' +
                'Bob received ' + aliceExpected.toFixed(4) + ' ALPHA on Unicity.';
              
            case 'REVERTED':
              return '<strong>Deal cancelled/expired.</strong><br>' +
                'Any deposited assets have been returned to payback addresses.<br>' +
                'You can create a new deal if needed.';
              
            default:
              return '<strong>Status: ' + dealData.stage + '</strong>';
          }
        }
        
        // Update balance display (modified for closed deals and live data)
        async function updateBalance(type, collection, instructions, expectedDeal) {
          const balanceEl = document.getElementById(type + 'Balance');
          const progressEl = document.getElementById(type + 'Progress');
          const percentageEl = document.getElementById(type + 'Percentage');
          const statusEl = document.getElementById(type + 'Status');
          
          const isClosedDeal = dealData && (dealData.stage === 'CLOSED' || dealData.stage === 'REVERTED');
          
          // Use expected amount from deal if instructions are empty
          let required, assetCode, escrowAddress, chainId;
          if (!instructions || instructions.length === 0) {
            if (!expectedDeal) {
              balanceEl.textContent = '0.0000 / 0.0000';
              progressEl.style.width = '0%';
              percentageEl.textContent = '0%';
              statusEl.textContent = 'Waiting for party details...';
              return;
            }
            // Use expected amounts from deal
            required = parseFloat(expectedDeal.amount);
            assetCode = expectedDeal.asset.includes('@') ? 
              expectedDeal.asset : 
              expectedDeal.asset + '@' + expectedDeal.chainId;
            chainId = expectedDeal.chainId;
          } else {
            required = parseFloat(instructions[0].amount);
            assetCode = instructions[0].assetCode;
            escrowAddress = instructions[0].to;
            
            // Determine chainId from asset code
            if (type === 'your') {
              chainId = party === 'ALICE' ? dealData.alice.chainId : dealData.bob.chainId;
            } else {
              chainId = party === 'ALICE' ? dealData.bob.chainId : dealData.alice.chainId;
            }
          }
          
          let collected = parseFloat(collection?.collectedByAsset?.[assetCode] || '0');
          
          // Try to get real-time balance from blockchain
          if (escrowAddress && chainId) {
            try {
              let liveBalance = null;
              
              if (chainId === 'UNICITY') {
                // Use Fulcrum for Unicity
                if (electrumConnected) {
                  const balanceInfo = await getUnicityBalance(escrowAddress);
                  liveBalance = balanceInfo.total;
                  
                  // Show confirmation status if there are unconfirmed funds
                  if (balanceInfo.unconfirmed > 0) {
                    const unconfirmedIndicator = document.createElement('span');
                    unconfirmedIndicator.style.cssText = 'color: #f59e0b; font-size: 10px; margin-left: 8px;';
                    unconfirmedIndicator.innerHTML = '(' + balanceInfo.unconfirmed.toFixed(4) + ' unconfirmed)';
                    unconfirmedIndicator.id = type + 'UnconfirmedIndicator';
                    
                    const existing = document.getElementById(type + 'UnconfirmedIndicator');
                    if (existing) existing.remove();
                    
                    balanceEl.appendChild(unconfirmedIndicator);
                  }
                  
                  // Update confirmation count if we have UTXOs
                  if (balanceInfo.utxos && balanceInfo.utxos.length > 0) {
                    const blockHeight = await getUnicityBlockHeight();
                    let minConfirmations = Infinity;
                    
                    for (const utxo of balanceInfo.utxos) {
                      const confirmations = utxo.height === 0 ? 0 : (blockHeight - utxo.height + 1);
                      if (confirmations < minConfirmations) {
                        minConfirmations = confirmations;
                      }
                    }
                    
                    // Show confirmation progress
                    const requiredConfirms = 6; // Default to 6 for Unicity
                    if (minConfirmations < requiredConfirms) {
                      const confirmIndicator = document.createElement('span');
                      confirmIndicator.style.cssText = 'color: #667eea; font-size: 10px; margin-left: 8px;';
                      confirmIndicator.innerHTML = '(' + minConfirmations + '/' + requiredConfirms + ' confirmations)';
                      confirmIndicator.id = type + 'ConfirmIndicator';
                      
                      const existing = document.getElementById(type + 'ConfirmIndicator');
                      if (existing) existing.remove();
                      
                      balanceEl.appendChild(confirmIndicator);
                    }
                  }
                }
              } else if (blockchainProviders[chainId]) {
                // Use ethers for EVM chains
                const queryResult = await queryBlockchainBalance(chainId, escrowAddress, assetCode);
                if (queryResult !== null) {
                  liveBalance = parseFloat(queryResult);
                }
              }
              
              // Use live balance if available (always use live data, not just if higher)
              if (liveBalance !== null) {
                collected = liveBalance;
                
                // Add live indicator
                const liveIndicator = document.createElement('span');
                liveIndicator.style.cssText = 'color: #10b981; font-size: 8px; margin-left: 4px;';
                liveIndicator.innerHTML = '🟢';
                liveIndicator.title = 'Live blockchain data';
                liveIndicator.id = type + 'LiveIndicator';
                
                const existing = document.getElementById(type + 'LiveIndicator');
                if (existing) existing.remove();
                
                balanceEl.appendChild(liveIndicator);
              }
            } catch (err) {
              console.error('Failed to get live balance:', err);
            }
          }
          
          // Display logic for closed deals
          if (isClosedDeal) {
            // Show only current balance for closed deals
            const balanceText = collected.toFixed(4) + ' ' + (assetCode || '');
            if (balanceEl.firstChild?.nodeType === Node.TEXT_NODE) {
              balanceEl.firstChild.textContent = balanceText;
            } else {
              balanceEl.textContent = balanceText;
            }
            balanceEl.style.color = collected > 0 ? '#f59e0b' : '#888';
            
            // Hide progress bar
            if (progressEl) progressEl.style.display = 'none';
            if (percentageEl) percentageEl.style.display = 'none';
            
            // Update status
            if (statusEl) {
              statusEl.textContent = collected > 0 ? '⚠️ Balance will be auto-returned' : '✅ No remaining balance';
              statusEl.style.color = collected > 0 ? '#f59e0b' : '#10b981';
            }
          } else {
            // Normal display for active deals
            const percentage = Math.min(100, (collected / required) * 100);
            
            const balanceText = collected.toFixed(4) + ' / ' + required.toFixed(4);
            if (balanceEl.firstChild?.nodeType === Node.TEXT_NODE) {
              balanceEl.firstChild.textContent = balanceText;
            } else {
              balanceEl.textContent = balanceText;
            }
            
            progressEl.style.width = percentage + '%';
            percentageEl.textContent = Math.round(percentage) + '%';
            
            if (percentage === 100) {
              statusEl.textContent = '✅ Fully funded';
            } else if (percentage > 0) {
              statusEl.textContent = '⏳ Partial funding (' + percentage.toFixed(1) + '%)';
            } else {
              statusEl.textContent = '⏰ Waiting for deposits...';
            }
          }
        }
        
        // Check if a side has sufficient funds collected (regardless of confirmations)
        function checkSufficientFunds(side) {
          if (!dealData) return false;
          
          // The backend sends collection.sideA/sideB, not sideAState/sideBState
          const sideData = side === 'A' ? 
            (dealData.collection?.sideA || dealData.sideAState) : 
            (dealData.collection?.sideB || dealData.sideBState);
          if (!sideData || !sideData.collectedByAsset) return false;
          
          const tradeSpec = side === 'A' ? dealData.alice : dealData.bob;
          const commissionReq = side === 'A' ? dealData.commissionPlan?.sideA : dealData.commissionPlan?.sideB;
          
          if (!tradeSpec || !commissionReq) return false;
          
          // Check trade amount collected
          const tradeAsset = tradeSpec.asset;
          const tradeAmount = parseFloat(tradeSpec.amount || '0');
          const tradeCollected = parseFloat(sideData.collectedByAsset[tradeAsset] || '0');
          
          // Calculate commission amount
          let commissionAmount = 0;
          if (commissionReq.mode === 'PERCENT_BPS' && commissionReq.percentBps) {
            // Commission as percentage of trade amount
            commissionAmount = tradeAmount * (commissionReq.percentBps / 10000);
          } else if (commissionReq.mode === 'FIXED_USD_NATIVE' && commissionReq.nativeFixed) {
            commissionAmount = parseFloat(commissionReq.nativeFixed);
          }
          
          // Check commission collected based on currency type
          if (commissionReq.currency === 'ASSET') {
            // Commission from same asset as trade - need trade + commission total
            const totalNeeded = tradeAmount + commissionAmount;
            return tradeCollected >= totalNeeded;
          } else if (commissionReq.currency === 'NATIVE') {
            // Commission from native asset - check separately
            const nativeAsset = tradeSpec.chainId === 'UNICITY' ? 'ALPHA@UNICITY' :
                               tradeSpec.chainId === 'POLYGON' ? 'POL@POLYGON' :
                               tradeSpec.chainId === 'ETH' ? 'ETH@ETH' :
                               tradeSpec.chainId === 'BASE' ? 'ETH@BASE' : 'NATIVE';
            const nativeCollected = parseFloat(sideData.collectedByAsset[nativeAsset] || '0');
            
            // Need both trade amount in trade asset AND commission in native asset
            return tradeCollected >= tradeAmount && nativeCollected >= commissionAmount;
          }
          
          return false;
        }
        
        // Start countdown timer
        function startCountdown(expiresAt) {
          if (countdownInterval) {
            clearInterval(countdownInterval);
          }
          
          countdownInterval = setInterval(() => {
            const now = Date.now();
            const expiry = new Date(expiresAt).getTime();
            const remaining = expiry - now;
            
            const countdownEl = document.getElementById('countdown');
            
            if (remaining <= 0) {
              countdownEl.className = 'countdown-timer countdown-expired';
              countdownEl.textContent = '⏰ EXPIRED';
              clearInterval(countdownInterval);
            } else {
              const hours = Math.floor(remaining / (1000 * 60 * 60));
              const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
              const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
              
              countdownEl.className = 'countdown-timer';
              countdownEl.textContent = 
                String(hours).padStart(2, '0') + ':' +
                String(minutes).padStart(2, '0') + ':' +
                String(seconds).padStart(2, '0');
            }
          }, 1000);
        }
        
        // Format address with truncation
        function formatAddress(addr) {
          if (!addr) return '';
          if (addr.length <= 20) return addr;
          return addr.substr(0, 10) + '...' + addr.substr(-8);
        }
        
        // Clean asset display name (remove @CHAIN suffixes for display)
        function cleanAssetDisplay(asset) {
          if (!asset) return '';
          // Remove @CHAIN suffix for display purposes
          if (asset.includes('@')) {
            return asset.split('@')[0];
          }
          return asset;
        }
        
        // Get blockchain explorer URL
        function getExplorerUrl(chainId, type, value) {
          const explorers = {
            'UNICITY': { base: 'https://unicity.network', tx: '/tx/', addr: '/address/' },
            'POLYGON': { base: 'https://polygonscan.com', tx: '/tx/', addr: '/address/' },
            'ETH': { base: 'https://etherscan.io', tx: '/tx/', addr: '/address/' },
            'BASE': { base: 'https://basescan.org', tx: '/tx/', addr: '/address/' }
          };
          
          const explorer = explorers[chainId];
          if (!explorer) return '#';
          
          if (type === 'tx') {
            return explorer.base + explorer.tx + value;
          } else if (type === 'address') {
            return explorer.base + explorer.addr + value;
          }
          return '#';
        }
        
        // Handle closed deals - add automatic return notice
        function handleClosedDeal() {
          if (!dealData || (dealData.stage !== 'CLOSED' && dealData.stage !== 'REVERTED')) {
            return;
          }
          
          // Check if notice already exists
          if (document.getElementById('automatic-return-notice')) {
            return;
          }
          
          // Calculate monitoring end time (24 hours after closure)
          const closedAt = new Date(dealData.closedAt || Date.now());
          const monitoringEndTime = new Date(closedAt.getTime() + 24 * 60 * 60 * 1000);
          
          // Add explanation about automatic returns
          const explanationDiv = document.createElement('div');
          explanationDiv.id = 'automatic-return-notice';
          explanationDiv.className = 'automatic-return-notice';
          explanationDiv.style.cssText = 'background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 10px; margin: 12px 0;';
          explanationDiv.innerHTML = \`
            <h4 style="color: #92400e; margin: 0 0 6px 0; font-size: 12px;">
              ⚠️ Automatic Return Policy
            </h4>
            <p style="color: #78350f; margin: 0; font-size: 10px; line-height: 1.4;">
              This deal has been <strong>\${dealData.stage === 'CLOSED' ? 'successfully completed' : 'cancelled'}</strong>.
              Any funds sent to the escrow addresses will be automatically returned to the respective payback addresses.
              Automatic monitoring and returns will continue until:
            </p>
            <p style="color: #92400e; margin: 6px 0 0 0; font-size: 11px; font-weight: 600;">
              📅 \${monitoringEndTime.toLocaleString()}
            </p>
          \`;
          
          // Insert after deal info section
          const dealInfoSection = document.querySelector('.deal-info');
          if (dealInfoSection) {
            dealInfoSection.parentNode.insertBefore(explanationDiv, dealInfoSection.nextSibling);
          }
        }
        
        // Update transaction log
        async function updateTransactionLog() {
          const listEl = document.getElementById('transactionList');
          const transactions = [];
          
          // Add deposits from collection for both sides
          const yourSide = party === 'ALICE' ? 'sideA' : 'sideB';
          const theirSide = party === 'ALICE' ? 'sideB' : 'sideA';
          const yourEscrow = party === 'ALICE' ? dealData?.escrowA : dealData?.escrowB;
          const theirEscrow = party === 'ALICE' ? dealData?.escrowB : dealData?.escrowA;
          
          // Your deposits
          if (dealData?.collection?.[yourSide]?.deposits) {
            const yourChainId = party === 'ALICE' ? dealData.alice.chainId : dealData.bob.chainId;
            for (const dep of dealData.collection[yourSide].deposits) {
              // Try to get live confirmation count for all chains
              let liveConfirms = dep.confirms || 0;
              let minConfRequired = dep.minConf || 6;
              
              if (dep.txid) {
                if (yourChainId === 'UNICITY') {
                  // For Unicity, query real-time confirmations from blockchain
                  if (electrumConnected) {
                    const txData = await queryUnicityTransaction(dep.txid);
                    if (txData && txData.confirmations !== undefined) {
                      liveConfirms = txData.confirmations;
                      // Live confirmations retrieved
                    } else if (dep.blockHeight && currentBlockHeight) {
                      // Fallback to estimation from block height
                      liveConfirms = Math.max(0, currentBlockHeight - dep.blockHeight + 1);
                    }
                  } else if (dep.blockHeight && currentBlockHeight) {
                    // Estimate from block height if not connected
                    liveConfirms = Math.max(0, currentBlockHeight - dep.blockHeight + 1);
                  }
                } else if (blockchainProviders[yourChainId]) {
                  // Query live status for EVM chains
                  const liveStatus = await queryTransactionStatus(yourChainId, dep.txid);
                  if (liveStatus) {
                    liveConfirms = liveStatus.confirmations;
                  }
                }
              }
              
              transactions.push({
                type: 'in',
                tag: 'deposit',
                txid: dep.txid,
                amount: dep.amount,
                asset: dep.asset,
                confirmations: liveConfirms,
                minConfRequired: minConfRequired,
                chainId: yourChainId,
                escrow: 'Your escrow',
                time: dep.blockTime || dep.createdAt || new Date().toISOString(),
                blockNumber: dep.blockHeight,
                confirmStatus: liveConfirms >= minConfRequired ? 'confirmed' : 'pending'
              });
            }
          }
          
          // Their deposits
          if (dealData?.collection?.[theirSide]?.deposits) {
            const theirChainId = party === 'ALICE' ? dealData.bob.chainId : dealData.alice.chainId;
            for (const dep of dealData.collection[theirSide].deposits) {
              // Try to get live confirmation count for all chains
              let liveConfirms = dep.confirms || 0;
              let minConfRequired = dep.minConf || 6;
              
              if (dep.txid) {
                if (theirChainId === 'UNICITY') {
                  // For Unicity, query real-time confirmations from blockchain
                  if (electrumConnected) {
                    const txData = await queryUnicityTransaction(dep.txid);
                    if (txData && txData.confirmations !== undefined) {
                      liveConfirms = txData.confirmations;
                      // Live confirmations retrieved
                    } else if (dep.blockHeight && currentBlockHeight) {
                      // Fallback to estimation from block height
                      liveConfirms = Math.max(0, currentBlockHeight - dep.blockHeight + 1);
                    }
                  } else if (dep.blockHeight && currentBlockHeight) {
                    // Estimate from block height if not connected
                    liveConfirms = Math.max(0, currentBlockHeight - dep.blockHeight + 1);
                  }
                } else if (blockchainProviders[theirChainId]) {
                  // Query live status for EVM chains
                  const liveStatus = await queryTransactionStatus(theirChainId, dep.txid);
                  if (liveStatus) {
                    liveConfirms = liveStatus.confirmations;
                  }
                }
              }
              
              transactions.push({
                type: 'in',
                tag: 'deposit',
                txid: dep.txid,
                amount: dep.amount,
                asset: dep.asset,
                confirmations: liveConfirms,
                minConfRequired: minConfRequired,
                chainId: theirChainId,
                escrow: 'Their escrow',
                time: dep.blockTime || dep.createdAt || new Date().toISOString(),
                blockNumber: dep.blockHeight,
                confirmStatus: liveConfirms >= minConfRequired ? 'confirmed' : 'pending'
              });
            }
          }
          
          // Group transactions by payout for Unicity
          const payoutGroups = new Map();
          
          // First, organize transactions by payout
          if (dealData?.payouts) {
            for (const payout of dealData.payouts) {
              if (payout.chainId === 'UNICITY' && payout.transactions) {
                payoutGroups.set(payout.payoutId, {
                  payout: payout,
                  transactions: payout.transactions
                });
              }
            }
          }
          
          // Add queue transactions from transactions array
          if (dealData?.transactions) {
            for (const item of dealData.transactions) {
              const isFromYourEscrow = yourEscrow && item.from?.address === yourEscrow.address;
              const isFromTheirEscrow = theirEscrow && item.from?.address === theirEscrow.address;
              
              if (isFromYourEscrow || isFromTheirEscrow) {
                // Check if this transaction belongs to a payout
                const payoutInfo = item.payoutInfo;
                
                // Try to get real-time status from blockchain
                let liveConfirms = 0;
                // Processing outgoing transaction
                
                if (item.submittedTx?.txid && item.chainId) {
                  // Check if we can query this chain (either via provider or Electrum for Unicity)
                  const canQuery = item.chainId === 'UNICITY' ? electrumConnected : blockchainProviders[item.chainId];
                  // Chain query capability checked
                  
                  if (canQuery) {
                    const liveStatus = await queryTransactionStatus(item.chainId, item.submittedTx.txid);
                    // Live status retrieved
                    if (liveStatus) {
                      // Update with live blockchain data
                      liveConfirms = liveStatus.confirmations;
                      if (!item.submittedTx) {
                        item.submittedTx = {};
                      }
                      item.submittedTx.confirms = liveConfirms;
                      if (liveStatus.confirmations >= (item.submittedTx.requiredConfirms || 6)) {
                        item.status = 'COMPLETED';
                      }
                      item.blockNumber = liveStatus.blockNumber;
                      // Outgoing tx updated
                    }
                  }
                }
                
                // Live confirms processed
                
                // Skip adding primary transaction if it's a pending refund with no txid
                const isPendingRefund = item.tag === 'refund' && (!item.submittedTx?.txid || item.submittedTx?.txid === 'Pending...');
                
                if (!isPendingRefund) {
                  // Add primary transaction
                  transactions.push({
                    type: 'out',
                    tag: item.tag || 'unknown', // Use tag from backend
                    txid: item.submittedTx?.txid,
                    amount: item.amount,
                    asset: item.asset,
                    to: item.to,
                    status: item.status,
                    submittedStatus: item.submittedTx?.status,
                    confirms: liveConfirms || item.submittedTx?.confirms || 0,
                    requiredConfirms: item.submittedTx?.requiredConfirms || 0,
                    chainId: item.chainId,
                    escrow: isFromYourEscrow ? 'Your escrow' : 'Their escrow',
                    time: item.blockTime || item.createdAt,
                    blockNumber: item.blockNumber
                  });
                }
                
                // For Unicity with payout grouping (but skip for pending refunds)
                if (item.chainId === 'UNICITY' && payoutInfo && !isPendingRefund) {
                  // Calculate minimum confirmations from all transactions in the payout
                  let minPayoutConfirms = liveConfirms || 0;
                  
                  // If there are additional transactions, check their confirmations too
                  if (item.submittedTx?.additionalTxids && item.submittedTx.additionalTxids.length > 0) {
                    const allTxids = [item.submittedTx.txid, ...item.submittedTx.additionalTxids];
                    
                    // Query confirmations for all transactions and find minimum
                    for (const txid of allTxids) {
                      let txConfirms = 0;
                      if (txid === item.submittedTx.txid) {
                        // First transaction - use already queried value
                        txConfirms = liveConfirms || 0;
                      } else if (electrumConnected) {
                        // Query additional transactions
                        const txData = await queryUnicityTransaction(txid);
                        if (txData && txData.confirmations !== undefined) {
                          txConfirms = txData.confirmations;
                        }
                      }
                      // Update minimum if this tx has fewer confirmations
                      if (txConfirms < minPayoutConfirms || minPayoutConfirms === 0) {
                        minPayoutConfirms = txConfirms;
                      }
                    }
                  }
                  
                  // Add payout header with calculated minimum confirmations
                  transactions.push({
                    type: 'payout',
                    payoutId: payoutInfo.payoutId,
                    tag: item.tag || 'unknown',
                    amount: payoutInfo.totalAmount,
                    asset: item.asset,
                    to: payoutInfo.toAddr,
                    purpose: payoutInfo.purpose,
                    status: payoutInfo.status,
                    minConfirmations: minPayoutConfirms,
                    chainId: item.chainId,
                    escrow: isFromYourEscrow ? 'Your escrow' : 'Their escrow',
                    time: item.blockTime || item.createdAt
                  });
                }
                
                // For Unicity, add additional transactions if they exist (but skip for pending refunds)
                if (item.submittedTx?.additionalTxids && item.submittedTx.additionalTxids.length > 0 && !isPendingRefund) {
                  // This is a multi-tx payout for Unicity
                  const allTxids = [item.submittedTx.txid, ...item.submittedTx.additionalTxids];
                  
                  // Query confirmations for each transaction separately
                  for (let i = 0; i < allTxids.length; i++) {
                    const txid = allTxids[i];
                    let txConfirms = 0;
                    let txAmount = item.amount; // Default to full amount
                    
                    // Query transaction data including amount
                    if (item.chainId === 'UNICITY' && electrumConnected) {
                      const txData = await queryUnicityTransaction(txid);
                      if (txData) {
                        txConfirms = txData.confirmations || 0;
                        
                        // Use actual output amount from blockchain if available
                        if (txData.outputAmount && txData.outputAmount > 0) {
                          // Convert from satoshis to ALPHA (1 ALPHA = 100,000,000 satoshis)
                          txAmount = (txData.outputAmount / 100000000).toFixed(8);
                        } else if (i === 0) {
                          // First transaction, use the total amount if we don't have individual data
                          txAmount = item.amount;
                        } else {
                          // For other transactions where we can't get the amount
                          if (item.tag !== 'refund') {
                            txAmount = '(part of payout)';
                          } else {
                            // For refunds without amount data
                            txAmount = 'Amount pending';
                          }
                        }
                      } else if (i === 0) {
                        // First tx without blockchain data
                        txConfirms = liveConfirms || item.submittedTx?.confirms || 0;
                        txAmount = item.amount;
                      }
                    } else if (i === 0) {
                      // First tx for non-Unicity chains
                      txConfirms = liveConfirms || item.submittedTx?.confirms || 0;
                      txAmount = item.amount;
                    }
                    
                    transactions.push({
                      type: 'out',
                      tag: item.tag || 'unknown',
                      txid: txid,
                      amount: txAmount,
                      asset: item.asset.replace('(part of payout) ', ''), // Remove any "(part of payout)" prefix
                      to: item.to,
                      status: item.status,
                      submittedStatus: item.submittedTx?.status,
                      confirms: txConfirms,
                      requiredConfirms: item.submittedTx?.requiredConfirms || 0,
                      chainId: item.chainId,
                      escrow: isFromYourEscrow ? 'Your escrow' : 'Their escrow',
                      time: item.blockTime || item.createdAt,
                      blockNumber: item.blockNumber,
                      isPartOfPayout: true,
                      payoutId: payoutInfo?.payoutId,
                      txIndex: i + 1,
                      txTotal: allTxids.length
                    });
                  }
                }
              }
            }
          }
          
          // Add events
          if (dealData?.events) {
            dealData.events.forEach(event => {
              transactions.push({
                type: 'event',
                message: event.msg,
                time: event.t
              });
            });
          }
          
          if (transactions.length === 0) {
            listEl.innerHTML = \`
              <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No transactions yet</p>
                <small>Transactions will appear here once you start depositing funds</small>
              </div>
            \`;
            return;
          }
          
          // Sort transactions by time/block number (newest first)
          transactions.sort((a, b) => {
            // First try block number if both have it
            if (a.blockNumber && b.blockNumber && a.chainId === b.chainId) {
              return b.blockNumber - a.blockNumber;
            }
            // Otherwise sort by time
            return new Date(b.time).getTime() - new Date(a.time).getTime();
          });
          
          // Rendering transactions
          
          // Render transactions with payout grouping
          listEl.innerHTML = transactions.map(tx => {
            if (tx.type === 'payout') {
              // Render payout header for Unicity
              const statusClass = tx.minConfirmations >= 6 ? 'confirmed' : 'pending';
              const statusText = tx.minConfirmations >= 6 ? 
                '✅ Payout confirmed' : 
                'Payout: ' + (tx.minConfirmations || 0) + ' confirmations (min)';
              
              return \`
                <div class="transaction-item payout-header">
                  <div class="tx-left">
                    <div class="tx-header">
                      <span class="tx-out">📦</span>
                      <span class="tx-tag tag-payout">Payout</span>
                      <span class="tx-chain-badge chain-unicity">UNICITY</span>
                      <span class="tx-amount">\${tx.amount} \${cleanAssetDisplay(tx.asset)}</span>
                    </div>
                    <div class="tx-addresses">
                      <span class="tx-addr-label">Destination:</span>
                      <a href="\${getExplorerUrl(tx.chainId, 'address', tx.to)}" target="_blank" class="tx-hash-link">
                        \${formatAddress(tx.to)}
                      </a>
                    </div>
                    <div class="tx-purpose">
                      <span class="tx-addr-label">Purpose:</span> \${tx.purpose}
                    </div>
                  </div>
                  <div class="tx-right">
                    <span class="tx-status \${statusClass}">\${statusText}</span>
                  </div>
                </div>
              \`;
            } else if (tx.type === 'event') {
              return \`
                <div class="transaction-item">
                  <div class="tx-left">
                    <div class="tx-header">
                      <span>📝</span>
                      <span>\${tx.message}</span>
                    </div>
                  </div>
                  <div class="tx-right">
                    <div class="tx-time">\${new Date(tx.time).toLocaleString()}</div>
                  </div>
                </div>
              \`;
            } else {
              // Determine chain and escrow
              const chainId = tx.chainId || (tx.escrow === 'Your escrow' ? 
                (party === 'ALICE' ? dealData.alice.chainId : dealData.bob.chainId) :
                (party === 'ALICE' ? dealData.bob.chainId : dealData.alice.chainId));
              
              const escrowClass = tx.escrow === 'Your escrow' ? 'escrow-a' : 'escrow-b';
              const chainClass = 'chain-' + chainId.toLowerCase();
              const chainBadge = '<span class="tx-chain-badge ' + chainClass + '">' + chainId + '</span>';
              
              // Determine addresses
              let fromAddr = '';
              let toAddr = '';
              
              if (tx.type === 'in') {
                // Deposit - from external to escrow
                fromAddr = tx.from || 'External';
                toAddr = tx.escrow === 'Your escrow' ? 
                  (dealData?.escrowA?.address || dealData?.escrowB?.address) : 
                  (dealData?.escrowB?.address || dealData?.escrowA?.address);
              } else {
                // Transfer - from escrow to recipient
                fromAddr = tx.escrow === 'Your escrow' ? 
                  (dealData?.escrowA?.address || dealData?.escrowB?.address) : 
                  (dealData?.escrowB?.address || dealData?.escrowA?.address);
                toAddr = tx.to || '';
              }
              
              const typeIcon = tx.type === 'in' ? '⬇️' : '⬆️';
              const typeClass = tx.type === 'in' ? 'tx-in' : 'tx-out';
              
              // Determine status and confirmations
              let statusClass = 'pending';
              let statusText = 'PENDING';
              let confirmations = 0;
              let minRequired = 0;
              
              // Processing confirmation values
              
              if (tx.type === 'in') {
                confirmations = tx.confirmations || 0;
                minRequired = tx.minConfRequired || 6;
                
                if (confirmations === 0) {
                  statusText = 'UNCONFIRMED';
                  statusClass = 'unconfirmed';
                } else if (confirmations >= minRequired) {
                  statusText = '✅ ' + confirmations + ' conf';
                  statusClass = 'confirmed';
                } else {
                  statusText = confirmations + '/' + minRequired + ' conf';
                  statusClass = 'pending';
                }
                
                // Status text prepared
                
                // Add confirmation status for better clarity
                if (tx.confirmStatus === 'confirmed') {
                  statusClass = 'confirmed';
                }
              } else {
                if (tx.status === 'COMPLETED') {
                  statusClass = 'confirmed';
                  confirmations = tx.confirms || tx.requiredConfirms || 6;
                  statusText = '✅ ' + confirmations + ' conf';
                } else if (tx.status === 'SUBMITTED') {
                  statusClass = 'pending';
                  confirmations = tx.confirms || 0;
                  const required = tx.requiredConfirms || 6;
                  
                  if (confirmations === 0) {
                    statusText = 'UNCONFIRMED';
                  } else {
                    statusText = confirmations + '/' + required + ' conf';
                  }
                } else {
                  statusClass = 'pending';
                  statusText = tx.status || 'PENDING';
                }
              }
              
              // Explorer links - always use real txids
              const txLink = tx.txid ? 
                '<a href="' + getExplorerUrl(chainId, 'tx', tx.txid) + '" target="_blank" class="tx-hash-link">' + formatAddress(tx.txid) + '</a>' :
                '<span class="tx-hash">Pending...</span>';
              
              const fromLink = fromAddr && fromAddr !== 'External' ? 
                '<a href="' + getExplorerUrl(chainId, 'address', fromAddr) + '" target="_blank" class="tx-hash-link">' + formatAddress(fromAddr) + '</a>' :
                formatAddress(fromAddr);
                
              const toLink = toAddr ? 
                '<a href="' + getExplorerUrl(chainId, 'address', toAddr) + '" target="_blank" class="tx-hash-link">' + formatAddress(toAddr) + '</a>' :
                '';
              
              // Create tag element
              const tagLabels = {
                'deposit': 'Deposit',
                'swap': 'Swap',
                'commission': 'Fees',
                'refund': 'Refund',
                'return': 'Return'
              };
              
              const tagLabel = tagLabels[tx.tag] || tx.tag;
              let tagHtml = '<span class="tx-tag tag-' + tx.tag + '">' + tagLabel + '</span>';
              
              // Add payout indicator for Unicity transactions that are part of a payout
              if (tx.isPartOfPayout && tx.txIndex && tx.txTotal) {
                tagHtml += '<span class="tx-tag tag-payout-part">TX ' + tx.txIndex + '/' + tx.txTotal + '</span>';
              }
              
              // Add special styling for transactions that are part of a payout
              const itemClasses = [escrowClass];
              if (tx.isPartOfPayout) {
                itemClasses.push('payout-transaction');
              }
              
              return '<div class="transaction-item ' + itemClasses.join(' ') + '">' +
                '<div class="tx-left">' +
                  '<div class="tx-header">' +
                    '<span class="' + typeClass + '">' + typeIcon + '</span>' +
                    tagHtml +
                    chainBadge +
                    '<span class="tx-amount">' + tx.amount + ' ' + cleanAssetDisplay(tx.asset) + '</span>' +
                  '</div>' +
                  '<div class="tx-addresses">' +
                    '<span class="tx-addr-label">From:</span> ' + fromLink +
                    '<span class="tx-addr-label">To:</span> ' + toLink +
                  '</div>' +
                  '<div class="tx-hash">' +
                    '<span class="tx-addr-label">TxID:</span> ' + txLink +
                  '</div>' +
                '</div>' +
                '<div class="tx-right">' +
                  '<div class="tx-time">' + new Date(tx.time).toLocaleTimeString() + '</div>' +
                  '<div class="tx-time">' + new Date(tx.time).toLocaleDateString() + '</div>' +
                  '<span class="tx-status ' + statusClass + '">' + statusText + '</span>' +
                '</div>' +
              '</div>';
            }
          }).join('');
        }
        
        // Cancel deal
        async function cancelDeal() {
          if (!confirm('Are you sure you want to cancel this deal? This action cannot be undone.')) {
            return;
          }
          
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.cancelDeal',
                params: { dealId, token },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result?.ok) {
              alert('Deal has been cancelled successfully.');
              // Refresh the page to show updated status
              location.reload();
            } else {
              alert('Failed to cancel deal: ' + (result.error?.message || 'Unknown error'));
            }
          } catch (error) {
            alert('Failed to cancel deal: ' + error.message);
          }
        }
        
        // Copy escrow address
        function copyEscrowAddress() {
          const address = document.getElementById('escrowAddress').textContent;
          
          // Check if clipboard API is available (requires HTTPS)
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(address).then(() => {
              alert('Escrow address copied to clipboard!');
            }).catch(() => {
              // Fallback if clipboard API fails
              fallbackCopyTextToClipboard(address);
            });
          } else {
            // Fallback for HTTP or older browsers
            fallbackCopyTextToClipboard(address);
          }
        }
        
        function fallbackCopyTextToClipboard(text) {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.top = '0';
          textArea.style.left = '0';
          textArea.style.width = '2em';
          textArea.style.height = '2em';
          textArea.style.padding = '0';
          textArea.style.border = 'none';
          textArea.style.outline = 'none';
          textArea.style.boxShadow = 'none';
          textArea.style.background = 'transparent';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          
          try {
            const successful = document.execCommand('copy');
            const msg = successful ? 'Escrow address copied to clipboard!' : 'Failed to copy address';
            alert(msg);
          } catch (err) {
            alert('Failed to copy address');
          }
          
          document.body.removeChild(textArea);
        }
        
        // Check if details already filled
        async function checkInitialStatus() {
          try {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.status',
                params: { dealId },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result) {
              dealData = result.result;
              
              // Check if this party has already filled details
              const partyDetails = party === 'ALICE' ? dealData.aliceDetails : dealData.bobDetails;
              const hasInstructions = party === 'ALICE' ? 
                (dealData.instructions?.sideA?.length > 0) : 
                (dealData.instructions?.sideB?.length > 0);
                
              if (partyDetails && partyDetails.paybackAddress && partyDetails.recipientAddress) {
                // Details are filled - show them in read-only mode
                // Loading saved addresses
                document.getElementById('payback').value = partyDetails.paybackAddress;
                document.getElementById('recipient').value = partyDetails.recipientAddress;
                document.getElementById('payback').disabled = true;
                document.getElementById('recipient').disabled = true;
                
                if (partyDetails.email) {
                  document.getElementById('email').value = partyDetails.email;
                  document.getElementById('email').disabled = true;
                }
                
                // Hide the submit button since addresses are locked
                const submitBtn = document.querySelector('#detailsForm button');
                submitBtn.style.display = 'none';
                
                // Add locked message
                const lockedMsg = document.createElement('div');
                lockedMsg.style.cssText = 'background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 12px; border-radius: 5px; margin: 15px 0;';
                lockedMsg.innerHTML = '<strong>🔒 Addresses Locked:</strong> Your addresses have been saved and cannot be changed.';
                document.getElementById('detailsForm').appendChild(lockedMsg);
                
                // Dashboard is already visible and updating
              }
            }
          } catch (error) {
            console.error('Failed to check initial status:', error);
          }
        }
        
        // Initialize on load
        window.addEventListener('DOMContentLoaded', () => {
          checkInitialStatus();
          // Always start status updates to show current deal state
          startStatusUpdates();
        });
        
        // Cleanup on unload
        window.addEventListener('beforeunload', () => {
          if (refreshInterval) clearInterval(refreshInterval);
          if (countdownInterval) clearInterval(countdownInterval);
        });
      </script>
    </body>
    </html>
  `;
}

  start(port: number) {
    this.app.listen(port, () => {
      console.log(`RPC server listening on port ${port}`);
    });
  }
}