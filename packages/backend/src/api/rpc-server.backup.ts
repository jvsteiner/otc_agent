import express from 'express';
import { Deal, DealAssetSpec, PartyDetails, DealStage, CommissionMode, CommissionRequirement, EscrowAccountRef, getAssetRegistry, formatAssetCode, parseAssetCode } from '@otc-broker/core';
import { DealRepository } from '../db/repositories';
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
  private pluginManager: PluginManager;
  private emailService: EmailService;

  constructor(private db: DB, pluginManager: PluginManager) {
    this.app = express();
    this.app.use(express.json());
    this.dealRepo = new DealRepository(db);
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
      name: `Deal ${new Date().toISOString()}`, // Default name for backup
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
    
    // Build instructions
    const instructions = {
      sideA: [] as any[],
      sideB: [] as any[],
    };
    
    if (deal.escrowA) {
      instructions.sideA.push({
        assetCode: deal.alice.asset,
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
      instructions.sideB.push({
        assetCode: deal.bob.asset,
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
      expiresAt: deal.expiresAt,
      instructions,
      collection: {
        sideA: deal.sideAState || {},
        sideB: deal.sideBState || {},
      },
      events: deal.events,
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
          .status {
            background: #f9f9f9;
            padding: 20px;
            margin: 20px 0;
            border-radius: 8px;
          }
          .copy-btn {
            display: inline-block;
            padding: 4px 8px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            margin-left: 8px;
          }
          .copy-btn:hover {
            background: #5a67d8;
          }
          .address-field {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #f0f0f0;
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            word-break: break-all;
            font-family: monospace;
            font-size: 13px;
          }
          .success-message {
            color: #10b981;
            font-size: 12px;
            margin-left: 10px;
            display: none;
          }
          .chain-badge {
            display: inline-block;
            padding: 3px 8px;
            background: #667eea;
            color: white;
            border-radius: 4px;
            font-weight: 600;
            font-size: 12px;
            margin-left: 5px;
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
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${partyIcon} ${partyLabel}</h1>
          
          <div id="detailsForm">
            <div class="deal-summary">
              <h3 style="margin-top: 0; margin-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 10px;">📊 Deal Summary</h3>
              <p><strong>You Send:</strong> ${dealInfo.sendAmount} ${dealInfo.sendAsset} <span class="chain-badge">${dealInfo.sendChainIcon} ${dealInfo.sendChain}</span></p>
              <p><strong>You Receive:</strong> ${dealInfo.receiveAmount} ${dealInfo.receiveAsset} <span class="chain-badge">${dealInfo.receiveChainIcon} ${dealInfo.receiveChain}</span></p>
            </div>
            
            <h3>Enter Your Wallet Addresses:</h3>
            
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
            
            <button onclick="submitDetails()">Submit Details</button>
          </div>
          
          <div class="status" id="status" style="display:none;">
            <h3>Deal Status</h3>
            <div id="escrowAddresses" style="display:none;">
              <h4>Escrow Addresses:</h4>
              <div id="escrowContent"></div>
            </div>
            <div id="statusContent"></div>
          </div>
        </div>
        
        <script>
          const dealId = '${dealId}';
          const token = '${token}';
          const party = '${party}';
          
          async function submitDetails() {
            const payback = document.getElementById('payback').value;
            const recipient = document.getElementById('recipient').value;
            const email = document.getElementById('email').value;
            
            console.log('Submitting details:', {
              dealId,
              party,
              token,
              paybackAddress: payback,
              recipientAddress: recipient
            });
            
            if (!payback || !recipient) {
              alert('Please enter both payback and recipient addresses');
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
              console.log('Server response:', result);
              
              if (result.result?.ok) {
                document.getElementById('detailsForm').style.display = 'none';
                document.getElementById('status').style.display = 'block';
                updateStatus();
                setInterval(updateStatus, 5000);
              } else {
                console.error('Error from server:', result.error);
                alert('Error: ' + (result.error?.message || 'Unknown error'));
              }
            } catch (error) {
              console.error('Request failed:', error);
              alert('Failed to submit details: ' + error.message);
            }
          }
          
          function copyAddress(addressId) {
            const addressElement = document.getElementById(addressId);
            const address = addressElement.textContent;
            
            navigator.clipboard.writeText(address).then(() => {
              const successMsg = document.getElementById(addressId + '-success');
              successMsg.style.display = 'inline';
              setTimeout(() => {
                successMsg.style.display = 'none';
              }, 3000);
            }).catch(() => {
              // Fallback for older browsers
              const textArea = document.createElement('textarea');
              textArea.value = address;
              document.body.appendChild(textArea);
              textArea.select();
              document.execCommand('copy');
              document.body.removeChild(textArea);
              
              const successMsg = document.getElementById(addressId + '-success');
              successMsg.style.display = 'inline';
              setTimeout(() => {
                successMsg.style.display = 'none';
              }, 3000);
            });
          }
          
          async function updateStatus() {
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
              // Display escrow addresses with copy functionality
              if (result.result.instructions && result.result.instructions.${party === 'ALICE' ? 'sideA' : 'sideB'}?.length > 0) {
                const instructions = result.result.instructions.${party === 'ALICE' ? 'sideA' : 'sideB'};
                let escrowHtml = '';
                instructions.forEach((instr, index) => {
                  const addressId = 'escrow-' + index;
                  escrowHtml += '<div class="address-field">' +
                    '<span id="' + addressId + '">' + instr.to + '</span>' +
                    '<button class="copy-btn" onclick="copyAddress(\\'' + addressId + '\\')">📋 Copy</button>' +
                    '<span id="' + addressId + '-success" class="success-message">✓ Copied!</span>' +
                    '</div>' +
                    '<small>Send ' + instr.amount + ' ' + instr.assetCode + ' to this address</small>';
                });
                document.getElementById('escrowContent').innerHTML = escrowHtml;
                document.getElementById('escrowAddresses').style.display = 'block';
              }
              
              // Display full status
              document.getElementById('statusContent').innerHTML = 
                '<h4>Full Status:</h4><pre>' + JSON.stringify(result.result, null, 2) + '</pre>';
            }
          }
          
          // Check initial status and if details already filled
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
                const status = result.result;
                
                // Check if this party has already filled details
                const partyDetails = party === 'ALICE' ? status.aliceDetails : status.bobDetails;
                const hasFilledDetails = partyDetails && partyDetails.paybackAddress && partyDetails.recipientAddress;
                
                if (hasFilledDetails) {
                  // Already filled, show status dashboard and populate fields
                  document.getElementById('payback').value = partyDetails.paybackAddress;
                  document.getElementById('recipient').value = partyDetails.recipientAddress;
                  if (partyDetails.email) {
                    document.getElementById('email').value = partyDetails.email;
                  }
                  
                  // Show status instead of form
                  document.getElementById('detailsForm').style.display = 'none';
                  document.getElementById('status').style.display = 'block';
                  
                  // Start regular status updates
                  setInterval(updateStatus, 5000);
                }
                
                // Update status display
                updateStatus();
              }
            } catch (error) {
              console.error('Failed to check initial status:', error);
            }
          }
          
          // Check on page load
          window.addEventListener('DOMContentLoaded', checkInitialStatus);
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