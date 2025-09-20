import express from 'express';
import { Deal, DealAssetSpec, PartyDetails, DealStage, CommissionMode, CommissionRequirement } from '@otc-broker/core';
import { DealRepository } from '../db/repositories';
import { DB } from '../db/database';
import { PluginManager } from '@otc-broker/chains';
import * as crypto from 'crypto';

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

export class RpcServer {
  private app: express.Application;
  private dealRepo: DealRepository;
  private pluginManager: PluginManager;
  private tokens = new Map<string, { dealId: string; party: 'ALICE' | 'BOB' }>();

  constructor(private db: DB, pluginManager: PluginManager) {
    this.app = express();
    this.app.use(express.json());
    this.dealRepo = new DealRepository(db);
    this.pluginManager = pluginManager;
    
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
    
    // Store tokens
    this.tokens.set(tokenA, { dealId: deal.id, party: 'ALICE' });
    this.tokens.set(tokenB, { dealId: deal.id, party: 'BOB' });
    
    const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
    
    return {
      dealId: deal.id,
      linkA: `${baseUrl}/d/${deal.id}/a/${tokenA}`,
      linkB: `${baseUrl}/d/${deal.id}/b/${tokenB}`,
    };
  }

  private getCommissionRequirement(spec: DealAssetSpec): CommissionRequirement {
    // Simplified commission logic
    // Real implementation would check chain config
    if (spec.asset.startsWith('ERC20:') || spec.asset.startsWith('SPL:')) {
      // Unknown token - use fixed USD in native
      return {
        mode: 'FIXED_USD_NATIVE',
        currency: 'NATIVE',
        usdFixed: '10',
        coveredBySurplus: true,
      };
    } else {
      // Known asset - use percentage
      return {
        mode: 'PERCENT_BPS',
        currency: 'ASSET',
        percentBps: 30, // 0.3%
        coveredBySurplus: true,
      };
    }
  }

  private async fillPartyDetails(params: FillPartyDetailsParams) {
    // Verify token
    const tokenInfo = this.tokens.get(params.token);
    if (!tokenInfo || tokenInfo.dealId !== params.dealId || tokenInfo.party !== params.party) {
      throw new Error('Invalid token');
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
    
    if (params.party === 'ALICE') {
      deal.aliceDetails = details;
      // Generate escrow for Alice's send chain
      deal.escrowA = await sendPlugin.generateEscrowAccount(deal.alice.asset);
    } else {
      deal.bobDetails = details;
      // Generate escrow for Bob's send chain
      deal.escrowB = await sendPlugin.generateEscrowAccount(deal.bob.asset);
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

  private renderCreateDealPage(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Create OTC asset swap deal</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 50px auto; }
          input, select { width: 100%; padding: 8px; margin: 5px 0; }
          button { background: #4CAF50; color: white; padding: 10px 20px; border: none; cursor: pointer; }
        </style>
      </head>
      <body>
        <h1>Create OTC asset swap deal</h1>
        <form id="dealForm">
          <h3>Asset A:</h3>
          <select name="aliceChain">
            <option value="UNICITY">Unicity</option>
            <option value="ETH">Ethereum</option>
            <option value="POLYGON">Polygon</option>
          </select>
          <input name="aliceAsset" placeholder="Asset (e.g., ALPHA@UNICITY)" required>
          <input name="aliceAmount" type="number" step="0.00000001" placeholder="Amount" required>
          
          <h3>Asset B:</h3>
          <select name="bobChain">
            <option value="ETH">Ethereum</option>
            <option value="UNICITY">Unicity</option>
            <option value="POLYGON">Polygon</option>
          </select>
          <input name="bobAsset" placeholder="Asset (e.g., ETH)" required>
          <input name="bobAmount" type="number" step="0.00000001" placeholder="Amount" required>
          
          <h3>Timeout (seconds):</h3>
          <input name="timeout" type="number" value="3600" required>
          
          <button type="submit">Create Deal</button>
        </form>
        
        <script>
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
                    chainId: formData.get('aliceChain'),
                    asset: formData.get('aliceAsset'),
                    amount: formData.get('aliceAmount')
                  },
                  bob: {
                    chainId: formData.get('bobChain'),
                    asset: formData.get('bobAsset'),
                    amount: formData.get('bobAmount')
                  },
                  timeoutSeconds: parseInt(formData.get('timeout'))
                },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result) {
              alert('Deal created! Links:\\n\\nAlice: ' + result.result.linkA + '\\n\\nBob: ' + result.result.linkB);
            } else {
              alert('Error: ' + (result.error?.message || 'Unknown error'));
            }
          };
        </script>
      </body>
      </html>
    `;
  }

  private renderPartyPage(dealId: string, token: string, party: 'ALICE' | 'BOB'): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${party} - OTC Deal</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 50px auto; }
          input { width: 100%; padding: 8px; margin: 5px 0; }
          button { background: #4CAF50; color: white; padding: 10px 20px; border: none; cursor: pointer; }
          .status { background: #f0f0f0; padding: 20px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <h1>${party} - OTC Deal</h1>
        
        <div id="detailsForm">
          <h3>Enter Your Details:</h3>
          <input id="payback" placeholder="Payback Address (on your send chain)" required>
          <input id="recipient" placeholder="Recipient Address (on other chain)" required>
          <input id="email" type="email" placeholder="Email (optional)">
          <button onclick="submitDetails()">Submit Details</button>
        </div>
        
        <div class="status" id="status" style="display:none;">
          <h3>Deal Status</h3>
          <div id="statusContent"></div>
        </div>
        
        <script>
          const dealId = '${dealId}';
          const token = '${token}';
          const party = '${party}';
          
          async function submitDetails() {
            const response = await fetch('/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'otc.fillPartyDetails',
                params: {
                  dealId,
                  party,
                  paybackAddress: document.getElementById('payback').value,
                  recipientAddress: document.getElementById('recipient').value,
                  email: document.getElementById('email').value,
                  token
                },
                id: 1
              })
            });
            
            const result = await response.json();
            if (result.result?.ok) {
              document.getElementById('detailsForm').style.display = 'none';
              document.getElementById('status').style.display = 'block';
              updateStatus();
              setInterval(updateStatus, 5000);
            } else {
              alert('Error: ' + (result.error?.message || 'Unknown error'));
            }
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
              document.getElementById('statusContent').innerHTML = 
                '<pre>' + JSON.stringify(result.result, null, 2) + '</pre>';
            }
          }
          
          // Check initial status
          updateStatus();
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