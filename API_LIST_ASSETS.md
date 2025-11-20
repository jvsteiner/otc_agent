# otc.listAssets API Endpoint

## Overview

The `otc.listAssets` JSON-RPC endpoint returns a list of all trading-enabled assets across supported blockchains. This endpoint respects production mode filtering and provides comprehensive asset metadata required for UI display and trading operations.

## Endpoint Details

- **Method**: `otc.listAssets`
- **Protocol**: JSON-RPC 2.0
- **URL**: `POST https://unicity-swap.dyndns.org/rpc`
- **Content-Type**: `application/json`

## Request Format

### Basic Request (All Assets)

```json
{
  "jsonrpc": "2.0",
  "method": "otc.listAssets",
  "params": {},
  "id": 1
}
```

### Request with Chain Filter

```json
{
  "jsonrpc": "2.0",
  "method": "otc.listAssets",
  "params": {
    "chainId": "POLYGON"
  },
  "id": 1
}
```

## Parameters

| Parameter | Type   | Required | Description                                    |
|-----------|--------|----------|------------------------------------------------|
| `chainId` | string | No       | Filter assets by specific blockchain (e.g., "ETH", "POLYGON", "UNICITY") |

## Response Structure

```json
{
  "jsonrpc": "2.0",
  "result": {
    "assets": [
      {
        "chainId": "ETH",
        "assetName": "Ethereum",
        "assetSymbol": "ETH",
        "native": true,
        "type": "NATIVE",
        "contractAddress": null,
        "decimals": 18,
        "icon": "Ξ",
        "refundable": true,
        "assetCode": "ETH",
        "maxAmount": "0.04"
      }
    ],
    "productionMode": true,
    "chains": [
      {
        "chainId": "ETH",
        "name": "Ethereum",
        "icon": "Ξ"
      }
    ]
  },
  "id": 1
}
```

## Response Fields

### Asset Object

| Field             | Type    | Description                                           |
|-------------------|---------|-------------------------------------------------------|
| `chainId`         | string  | Blockchain identifier (e.g., "ETH", "POLYGON")        |
| `assetName`       | string  | Full display name of the asset                        |
| `assetSymbol`     | string  | Trading symbol (e.g., "ETH", "USDC")                  |
| `native`          | boolean | Whether this is the native token of its chain         |
| `type`            | string  | Token standard: "NATIVE", "ERC20", "SPL"              |
| `contractAddress` | string\|null | Smart contract address (null for native tokens)  |
| `decimals`        | number  | Number of decimal places for this asset              |
| `icon`            | string  | Unicode/emoji icon for display                        |
| `refundable`      | boolean | Whether eligible for automatic refunds                |
| `assetCode`       | string  | Canonical asset identifier used in deal creation      |
| `maxAmount`       | string\|null | Maximum trade amount in production mode (null = unlimited) |

### Root Result Fields

| Field            | Type    | Description                                              |
|------------------|---------|----------------------------------------------------------|
| `assets`         | array   | Array of asset objects (see above)                       |
| `productionMode` | boolean | Whether production mode filtering is active              |
| `chains`         | array   | Array of supported chain objects                         |

## Examples

### Example 1: List All Available Assets

**Request:**
```bash
curl -X POST https://unicity-swap.dyndns.org/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "otc.listAssets",
    "params": {},
    "id": 1
  }'
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "assets": [
      {
        "chainId": "UNICITY",
        "assetName": "Alpha",
        "assetSymbol": "ALPHA",
        "native": true,
        "type": "NATIVE",
        "contractAddress": null,
        "decimals": 8,
        "icon": "🪙",
        "refundable": true,
        "assetCode": "ALPHA",
        "maxAmount": "50"
      },
      {
        "chainId": "ETH",
        "assetName": "Ethereum",
        "assetSymbol": "ETH",
        "native": true,
        "type": "NATIVE",
        "contractAddress": null,
        "decimals": 18,
        "icon": "Ξ",
        "refundable": true,
        "assetCode": "ETH",
        "maxAmount": "0.04"
      },
      {
        "chainId": "ETH",
        "assetName": "USD Coin",
        "assetSymbol": "USDC",
        "native": false,
        "type": "ERC20",
        "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "decimals": 6,
        "icon": "$",
        "refundable": true,
        "assetCode": "ERC20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "maxAmount": null
      },
      {
        "chainId": "POLYGON",
        "assetName": "Polygon",
        "assetSymbol": "MATIC",
        "native": true,
        "type": "NATIVE",
        "contractAddress": null,
        "decimals": 18,
        "icon": "Ⓜ",
        "refundable": true,
        "assetCode": "MATIC",
        "maxAmount": "500"
      }
    ],
    "productionMode": true,
    "chains": [
      {
        "chainId": "UNICITY",
        "name": "Unicity",
        "icon": "🔷"
      },
      {
        "chainId": "ETH",
        "name": "Ethereum",
        "icon": "Ξ"
      },
      {
        "chainId": "POLYGON",
        "name": "Polygon",
        "icon": "Ⓜ"
      }
    ]
  },
  "id": 1
}
```

### Example 2: List Assets for Specific Chain (Polygon)

**Request:**
```bash
curl -X POST https://unicity-swap.dyndns.org/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "otc.listAssets",
    "params": {
      "chainId": "POLYGON"
    },
    "id": 1
  }'
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "assets": [
      {
        "chainId": "POLYGON",
        "assetName": "Polygon",
        "assetSymbol": "MATIC",
        "native": true,
        "type": "NATIVE",
        "contractAddress": null,
        "decimals": 18,
        "icon": "Ⓜ",
        "refundable": true,
        "assetCode": "MATIC",
        "maxAmount": "500"
      },
      {
        "chainId": "POLYGON",
        "assetName": "Tether USD (Polygon)",
        "assetSymbol": "USDT",
        "native": false,
        "type": "ERC20",
        "contractAddress": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        "decimals": 6,
        "icon": "₮",
        "refundable": true,
        "assetCode": "ERC20:0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        "maxAmount": null
      },
      {
        "chainId": "POLYGON",
        "assetName": "USD Coin (Polygon)",
        "assetSymbol": "USDC",
        "native": false,
        "type": "ERC20",
        "contractAddress": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "decimals": 6,
        "icon": "$",
        "refundable": true,
        "assetCode": "ERC20:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "maxAmount": null
      }
    ],
    "productionMode": true,
    "chains": [
      {
        "chainId": "UNICITY",
        "name": "Unicity",
        "icon": "🔷"
      },
      {
        "chainId": "ETH",
        "name": "Ethereum",
        "icon": "Ξ"
      },
      {
        "chainId": "POLYGON",
        "name": "Polygon",
        "icon": "Ⓜ"
      }
    ]
  },
  "id": 1
}
```

### Example 3: Using with JavaScript/Node.js

```javascript
const fetch = require('node-fetch');

async function listAssets(chainId = null) {
  const response = await fetch('https://unicity-swap.dyndns.org/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'otc.listAssets',
      params: chainId ? { chainId } : {},
      id: 1
    })
  });

  const data = await response.json();
  return data.result;
}

// Usage
listAssets().then(result => {
  console.log('Production Mode:', result.productionMode);
  console.log('Total Assets:', result.assets.length);
  console.log('Supported Chains:', result.chains.map(c => c.name).join(', '));

  result.assets.forEach(asset => {
    console.log(`${asset.icon} ${asset.assetName} (${asset.assetSymbol}) on ${asset.chainId}`);
    if (asset.maxAmount) {
      console.log(`  Max Amount: ${asset.maxAmount}`);
    }
  });
});

// Filter by chain
listAssets('POLYGON').then(result => {
  console.log('Polygon Assets:', result.assets.length);
});
```

### Example 4: Using with Python

```python
import requests
import json

def list_assets(chain_id=None):
    url = "https://unicity-swap.dyndns.org/rpc"

    payload = {
        "jsonrpc": "2.0",
        "method": "otc.listAssets",
        "params": {"chainId": chain_id} if chain_id else {},
        "id": 1
    }

    headers = {
        "Content-Type": "application/json"
    }

    response = requests.post(url, json=payload, headers=headers)
    return response.json()["result"]

# Usage
result = list_assets()
print(f"Production Mode: {result['productionMode']}")
print(f"Total Assets: {len(result['assets'])}")

for asset in result['assets']:
    print(f"{asset['icon']} {asset['assetName']} ({asset['assetSymbol']}) on {asset['chainId']}")
    if asset['maxAmount']:
        print(f"  Max Amount: {asset['maxAmount']}")

# Filter by chain
polygon_result = list_assets('POLYGON')
print(f"\nPolygon Assets: {len(polygon_result['assets'])}")
```

## Use Cases

1. **Trading UI**: Populate asset dropdowns for deal creation
2. **Asset Discovery**: Display all available trading pairs
3. **Validation**: Check if an asset is supported before creating a deal
4. **Chain-Specific Views**: Filter assets by blockchain for multi-chain interfaces
5. **Limit Enforcement**: Display maximum trade amounts to users
6. **Asset Metadata**: Get decimals, icons, and display names for formatting

## Production Mode Behavior

When `productionMode: true`:
- Only assets configured in `ALLOWED_ASSETS` are returned
- Only chains configured in `ALLOWED_CHAINS` are included
- `maxAmount` limits are enforced per asset (from `MAX_AMOUNT_*` env vars)
- Ensures safety and compliance for production deployments

When `productionMode: false` (development):
- All configured assets from `assets.json` are returned
- No maximum amount restrictions
- All chains are available for testing

## Error Handling

Standard JSON-RPC 2.0 error responses:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32603,
    "message": "Internal error description"
  },
  "id": 1
}
```

## Notes

- The `assetCode` field should be used when creating deals via `otc.createDeal`
- For ERC20/SPL tokens, `assetCode` format is `TYPE:CONTRACT_ADDRESS`
- For native tokens, `assetCode` is the asset symbol (e.g., "ETH", "ALPHA")
- The `refundable` flag indicates whether automatic refunds are enabled for this asset
- `maxAmount` is `null` for unlimited assets or when not in production mode
- Response always includes all supported chains, even when filtering by `chainId`

## Related Endpoints

- `otc.createDeal`: Create a new deal using asset codes from this endpoint
- `otc.getChainConfig`: Get detailed blockchain configuration
- `otc.status`: Query deal status and progress
