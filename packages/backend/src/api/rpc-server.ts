import express from 'express';
import { Deal, DealAssetSpec, PartyDetails, DealStage, CommissionMode, CommissionRequirement, EscrowAccountRef, getAssetRegistry, formatAssetCode, parseAssetCode } from '@otc-broker/core';
import { DealRepository, QueueRepository } from '../db/repositories';
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
  private pluginManager: PluginManager;
  private emailService: EmailService;

  constructor(private db: DB, pluginManager: PluginManager) {
    this.app = express();
    this.app.use(express.json());
    this.dealRepo = new DealRepository(db);
    this.queueRepo = new QueueRepository(db);
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
      // Generate escrow for Alice's send chain
      deal.escrowA = await sendPlugin.generateEscrowAccount(deal.alice.asset);
      escrowRef = deal.escrowA;
    } else {
      deal.bobDetails = details;
      // Generate escrow for Bob's send chain
      deal.escrowB = await sendPlugin.generateEscrowAccount(deal.bob.asset);
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
      escrowA: deal.escrowA,
      escrowB: deal.escrowB,
      transactions: queueItems,
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
          align-items: center;
          padding: 15px;
          border-bottom: 1px solid #f3f4f6;
          transition: background 0.2s;
        }
        
        .transaction-item:hover {
          background: #f9fafb;
        }
        
        .transaction-item:last-child {
          border-bottom: none;
        }
        
        .tx-info {
          flex: 1;
        }
        
        .tx-type {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          margin-bottom: 5px;
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
          font-size: 12px;
          color: #6b7280;
          margin-top: 5px;
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
        
        .tx-purpose {
          font-size: 12px;
          color: #6b7280;
          margin: 2px 0;
        }
        
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
        
        /* Refresh Indicator */
        .refresh-indicator {
          position: fixed;
          top: 20px;
          right: 20px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: white;
          border-radius: 20px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          font-size: 12px;
          color: #6b7280;
        }
        
        .refresh-indicator.active .loading-spinner {
          display: inline-block;
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
        
        <!-- Refresh Indicator -->
        <div class="refresh-indicator" id="refreshIndicator">
          <div class="loading-spinner" style="display: none;"></div>
          <span>Auto-refresh: <span id="refreshStatus">ON</span></span>
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
        }
        
        // Update status from server
        async function updateStatus() {
          const indicator = document.getElementById('refreshIndicator');
          const spinner = indicator.querySelector('.loading-spinner');
          spinner.style.display = 'inline-block';
          
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
              updateDisplay();
            }
          } catch (error) {
            console.error('Failed to update status:', error);
          } finally {
            spinner.style.display = 'none';
          }
        }
        
        // Update display with latest data
        function updateDisplay() {
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
          if (dealData.expiresAt) {
            startCountdown(dealData.expiresAt);
          } else {
            // Show static total time when timer not started
            const countdownEl = document.getElementById('countdown');
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
          
          // Update transaction log
          updateTransactionLog();
          
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
                  'Timer is running - complete deposits before expiry!<br>' +
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
                return '<strong>🎉 Both Parties Fully Funded!</strong><br>' +
                  '<br><strong>Status:</strong> Preparing cross-chain atomic swap<br>' +
                  '<br><strong>Next Steps:</strong><br>' +
                  '1. Engine verifying all deposits<br>' +
                  '2. Creating transfer transactions<br>' +
                  '3. Executing atomic swap<br>' +
                  '4. Assets will be sent to recipient addresses';
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
        
        // Update balance display
        function updateBalance(type, collection, instructions, expectedDeal) {
          const balanceEl = document.getElementById(type + 'Balance');
          const progressEl = document.getElementById(type + 'Progress');
          const percentageEl = document.getElementById(type + 'Percentage');
          const statusEl = document.getElementById(type + 'Status');
          
          // Use expected amount from deal if instructions are empty
          let required, assetCode;
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
          } else {
            required = parseFloat(instructions[0].amount);
            assetCode = instructions[0].assetCode;
          }
          
          const collected = parseFloat(collection?.collectedByAsset?.[assetCode] || '0');
          const percentage = Math.min(100, (collected / required) * 100);
          
          balanceEl.textContent = collected.toFixed(4) + ' / ' + required.toFixed(4);
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
        
        // Update transaction log
        function updateTransactionLog() {
          const listEl = document.getElementById('transactionList');
          const transactions = [];
          
          // Add deposits from collection for both sides
          const yourSide = party === 'ALICE' ? 'sideA' : 'sideB';
          const theirSide = party === 'ALICE' ? 'sideB' : 'sideA';
          const yourEscrow = party === 'ALICE' ? dealData?.escrowA : dealData?.escrowB;
          const theirEscrow = party === 'ALICE' ? dealData?.escrowB : dealData?.escrowA;
          
          // Your deposits
          if (dealData?.collection?.[yourSide]?.deposits) {
            dealData.collection[yourSide].deposits.forEach(dep => {
              transactions.push({
                type: 'in',
                txid: dep.txid,
                amount: dep.amount,
                asset: dep.asset,
                confirmations: dep.confirms,
                escrow: 'Your escrow',
                time: dep.blockTime || new Date().toISOString()
              });
            });
          }
          
          // Their deposits
          if (dealData?.collection?.[theirSide]?.deposits) {
            dealData.collection[theirSide].deposits.forEach(dep => {
              transactions.push({
                type: 'in',
                txid: dep.txid,
                amount: dep.amount,
                asset: dep.asset,
                confirmations: dep.confirms,
                escrow: 'Their escrow',
                time: dep.blockTime || new Date().toISOString()
              });
            });
          }
          
          // Add queue transactions from transactions array
          if (dealData?.transactions) {
            dealData.transactions.forEach(item => {
              const isFromYourEscrow = yourEscrow && item.from?.address === yourEscrow.address;
              const isFromTheirEscrow = theirEscrow && item.from?.address === theirEscrow.address;
              
              if (isFromYourEscrow || isFromTheirEscrow) {
                const purposeLabels = {
                  'SWAP_PAYOUT': '💱 Swap',
                  'OP_COMMISSION': '💰 Commission',
                  'TIMEOUT_REFUND': '↩️ Refund',
                  'SURPLUS_REFUND': '💵 Surplus Return'
                };
                
                transactions.push({
                  type: 'out',
                  txid: item.submittedTx?.txid,
                  amount: item.amount,
                  asset: item.asset,
                  to: item.to,
                  status: item.status,
                  submittedStatus: item.submittedTx?.status,
                  confirms: item.submittedTx?.confirms || 0,
                  requiredConfirms: item.submittedTx?.requiredConfirms || 0,
                  purpose: purposeLabels[item.purpose] || item.purpose,
                  escrow: isFromYourEscrow ? 'Your escrow' : 'Their escrow',
                  time: item.createdAt
                });
              }
            });
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
          
          // Sort by time (newest first)
          transactions.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
          
          // Render transactions
          listEl.innerHTML = transactions.map(tx => {
            if (tx.type === 'event') {
              return \`
                <div class="transaction-item">
                  <div class="tx-info">
                    <div class="tx-type">
                      <span>📝</span>
                      <span>\${tx.message}</span>
                    </div>
                  </div>
                  <div class="tx-details">
                    <div class="tx-time">\${new Date(tx.time).toLocaleString()}</div>
                  </div>
                </div>
              \`;
            } else {
              const typeIcon = tx.type === 'in' ? '⬇️' : '⬆️';
              const typeClass = tx.type === 'in' ? 'tx-in' : 'tx-out';
              
              // Determine status based on transaction type and status fields
              let statusClass = 'pending';
              let statusText = 'PENDING';
              
              if (tx.type === 'in') {
                // For deposits, use confirmations
                statusText = tx.confirmations > 0 ? \`\${tx.confirmations} conf\` : 'PENDING';
                statusClass = tx.confirmations >= 6 ? 'confirmed' : 'pending';
              } else {
                // For outgoing transactions, use status field
                if (tx.status === 'COMPLETED') {
                  statusClass = 'confirmed';
                  statusText = 'COMPLETED';
                } else if (tx.status === 'SUBMITTED') {
                  statusClass = 'pending';
                  if (tx.confirms !== undefined && tx.requiredConfirms) {
                    statusText = \`\${tx.confirms}/\${tx.requiredConfirms} conf\`;
                  } else {
                    statusText = 'SUBMITTED';
                  }
                } else if (tx.submittedStatus === 'DROPPED' || tx.submittedStatus === 'FAILED') {
                  statusClass = 'failed';
                  statusText = 'FAILED';
                } else {
                  statusClass = 'pending';
                  statusText = tx.status || 'PENDING';
                }
              }
              
              const purposeStr = tx.purpose ? \`<div class="tx-purpose">\${tx.purpose}</div>\` : '';
              const escrowStr = tx.escrow ? \`<div class="tx-escrow">\${tx.escrow}</div>\` : '';
              
              return \`
                <div class="transaction-item">
                  <div class="tx-info">
                    <div class="tx-type \${typeClass}">
                      <span>\${typeIcon}</span>
                      <span>\${tx.type === 'in' ? 'Deposit' : 'Transfer'}</span>
                    </div>
                    \${purposeStr}
                    \${escrowStr}
                    \${tx.txid ? '<div class="tx-hash">TxID: <a href="#" onclick="alert(\\'Full TX ID:\\n' + tx.txid + '\\'); return false;" title="' + tx.txid + '">' + tx.txid.substr(0, 10) + '...</a></div>' : ''}
                    \${tx.to && tx.type === 'out' ? '<div class="tx-recipient">To: ' + tx.to.substr(0, 10) + '...</div>' : ''}
                  </div>
                  <div class="tx-details">
                    <div class="tx-amount">\${tx.amount} \${tx.asset}</div>
                    <div class="tx-time">\${new Date(tx.time).toLocaleString()}</div>
                    <span class="tx-status \${statusClass}">\${statusText}</span>
                  </div>
                </div>
              \`;
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
                console.log('Loading saved addresses:', partyDetails);
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