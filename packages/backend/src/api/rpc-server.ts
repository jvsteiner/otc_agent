import express from 'express';
import { Deal, DealAssetSpec, PartyDetails, DealStage, CommissionMode, CommissionRequirement, getAssetRegistry, formatAssetCode, parseAssetCode } from '@otc-broker/core';
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
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Create OTC Asset Swap Deal</h1>
          
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
              alert('✅ Deal created successfully!\\n\\n📎 Personal Links:\\n\\nAlice: ' + result.result.linkA + '\\n\\nBob: ' + result.result.linkB);
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