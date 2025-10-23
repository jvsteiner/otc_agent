# Production Configuration Guide

## Overview

The OTC Broker Engine includes a production mode validation system that allows administrators to restrict which chains, assets, and amounts can be traded. This is essential for:

- **Gradual rollout**: Start with a limited set of well-tested assets
- **Risk management**: Set maximum trade amounts to limit exposure
- **Compliance**: Restrict certain assets or chains based on regulatory requirements
- **Testing**: Run production systems with controlled parameters

## Configuration

Production mode is configured through environment variables. When `PRODUCTION_MODE=true`, the system enforces restrictions on:

1. **Allowed blockchain chains**
2. **Allowed assets/tokens**
3. **Maximum trade amounts per asset**

### Environment Variables

#### Core Settings

```bash
# Enable/disable production mode (default: false)
PRODUCTION_MODE=true
```

#### Chain Restrictions

```bash
# Comma-separated list of allowed chain IDs
# Leave empty to allow all chains
ALLOWED_CHAINS=UNICITY,ETH,POLYGON

# Supported values:
# - UNICITY (Unicity blockchain)
# - ETH (Ethereum mainnet)
# - POLYGON (Polygon/Matic network)
# - BASE (Base L2)
# - BSC (Binance Smart Chain)
# - SEPOLIA (Ethereum testnet)
# - SOLANA (Solana - if plugin enabled)
# - BTC (Bitcoin - if plugin enabled)
```

#### Asset Restrictions

```bash
# Comma-separated list of allowed assets (case-insensitive)
# Leave empty to allow all assets
ALLOWED_ASSETS=ALPHA,ETH,MATIC,USDC,USDT

# Asset formats supported:
# - Native tokens: ETH, MATIC, ALPHA, BNB, SOL
# - With chain suffix: ETH@ETH, MATIC@POLYGON
# - ERC20 by address: ERC20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
# - ERC20 by symbol: USDC, USDT (matches configured tokens)
```

#### Amount Limits

You can set maximum amounts using two methods:

**Method 1: Combined variable**
```bash
# Format: ASSET=AMOUNT,ASSET=AMOUNT
MAX_AMOUNTS=ETH=10,MATIC=10000,ALPHA=100000,USDC=50000
```

**Method 2: Individual variables**
```bash
# These override values in MAX_AMOUNTS
MAX_AMOUNT_ETH=10
MAX_AMOUNT_MATIC=10000
MAX_AMOUNT_ALPHA=100000
MAX_AMOUNT_USDC=50000
MAX_AMOUNT_USDT=50000
```

## How It Works

### Validation Flow

1. When a deal is created via the `otc.createDeal` RPC method
2. The system checks if `PRODUCTION_MODE=true`
3. If enabled, it validates:
   - Both chains are in `ALLOWED_CHAINS` (or list is empty)
   - Both assets are in `ALLOWED_ASSETS` (or list is empty)
   - Both amounts are within configured limits
4. If any validation fails, the deal creation is rejected with a clear error message

### Error Messages

Users receive specific error messages when validation fails:

- `"Chain SOLANA is not currently supported in production mode"`
- `"Asset DOGE is not currently supported in production mode"`
- `"Maximum amount for ETH is 10, you requested 15"`

### Development vs Production

- **Development mode** (`PRODUCTION_MODE=false`): No restrictions, all assets and chains allowed
- **Production mode** (`PRODUCTION_MODE=true`): Only configured assets/chains/amounts allowed

## Examples

### Example 1: Basic Production Setup

```bash
# Enable production mode
PRODUCTION_MODE=true

# Only allow Unicity, Ethereum, and Polygon
ALLOWED_CHAINS=UNICITY,ETH,POLYGON

# Only allow major tokens
ALLOWED_ASSETS=ALPHA,ETH,MATIC,USDC,USDT

# Set reasonable limits
MAX_AMOUNT_ETH=10
MAX_AMOUNT_MATIC=10000
MAX_AMOUNT_USDC=100000
MAX_AMOUNT_USDT=100000
MAX_AMOUNT_ALPHA=1000000
```

### Example 2: ERC20 Token Restrictions

```bash
PRODUCTION_MODE=true

# Allow specific ERC20 tokens by contract address
ALLOWED_ASSETS=ETH,MATIC,ERC20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,ERC20:0xdAC17F958D2ee523a2206206994597C13D831ec7

# The above allows:
# - Native ETH and MATIC
# - USDC (0xA0b86991...)
# - USDT (0xdAC17F95...)
```

### Example 3: Testnet Configuration

```bash
PRODUCTION_MODE=true

# Only allow testnet chains
ALLOWED_CHAINS=SEPOLIA

# Allow test tokens
ALLOWED_ASSETS=ETH,USDC,USDT

# Higher limits for testing
MAX_AMOUNT_ETH=1000
MAX_AMOUNT_USDC=1000000
```

## Asset Matching

The system uses intelligent matching for assets:

1. **Native tokens**: Matches by symbol (ETH, MATIC, ALPHA)
2. **Chain-suffixed**: Matches with or without suffix (MATIC@POLYGON = MATIC)
3. **ERC20 addresses**: Case-insensitive matching
4. **Known tokens**: Matches USDC/USDT by symbol or contract address

## Monitoring

When the server starts, it logs the current production configuration:

```
🔐 PRODUCTION MODE ENABLED
-------------------------------------
Allowed Chains: UNICITY, ETH, POLYGON
Allowed Assets: ALPHA, ETH, MATIC, USDC, USDT
Max Amounts: {ETH: 10, MATIC: 10000, USDC: 50000}
=====================================
```

## Testing

The configuration can be tested using the provided test suite:

```bash
# Run production config tests
npm test -- production-config.test.ts
```

## Security Considerations

1. **Configuration validation**: Always test configuration in a staging environment first
2. **Gradual rollout**: Start with conservative limits and gradually increase
3. **Monitoring**: Monitor rejected deals to identify legitimate use cases
4. **Backup plans**: Have procedures to quickly update configuration if needed

## API Integration

The validation happens transparently in the RPC API. Clients don't need any changes:

```javascript
// This request will be validated against production rules
const response = await fetch('/rpc', {
  method: 'POST',
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'otc.createDeal',
    params: {
      alice: {
        chainId: 'ETH',
        asset: 'ETH',
        amount: '5'  // Will be checked against MAX_AMOUNT_ETH
      },
      bob: {
        chainId: 'POLYGON',
        asset: 'MATIC',
        amount: '5000'
      },
      timeoutSeconds: 3600
    },
    id: 1
  })
});
```

## Best Practices

1. **Start conservative**: Begin with low limits and well-known assets
2. **Monitor closely**: Track rejected deals and adjust configuration
3. **Document changes**: Keep a log of configuration changes
4. **Test thoroughly**: Verify configuration in staging before production
5. **Plan for growth**: Have procedures to add new assets/chains as needed

## Troubleshooting

### Common Issues

1. **"Asset not supported"**: Check if asset is in `ALLOWED_ASSETS`
2. **"Chain not supported"**: Check if chain is in `ALLOWED_CHAINS`
3. **"Maximum amount exceeded"**: Check `MAX_AMOUNT_*` settings
4. **ERC20 not recognized**: Use full address format: `ERC20:0x...`

### Debug Commands

```bash
# Check current configuration
grep "PRODUCTION_MODE\|ALLOWED_\|MAX_AMOUNT" .env

# View server startup logs
docker logs otc-backend 2>&1 | grep -A5 "PRODUCTION MODE"

# Test specific validation
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"otc.createDeal","params":{...},"id":1}'
```

## Migration Guide

### Enabling Production Mode

1. **Audit current usage**: Identify all assets and chains currently in use
2. **Set initial configuration**: Start with currently used assets
3. **Test in staging**: Verify all existing workflows still function
4. **Deploy with monitoring**: Watch for rejected deals
5. **Iterate**: Adjust configuration based on real usage

### Adding New Assets

1. **Test the asset**: Verify it works in development mode
2. **Add to staging config**: Test in staging environment
3. **Update production config**: Add to `ALLOWED_ASSETS`
4. **Set appropriate limits**: Add `MAX_AMOUNT_*` if needed
5. **Monitor initial trades**: Watch for any issues

## Configuration Reference

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `PRODUCTION_MODE` | Enable production restrictions | `false` | `true` |
| `ALLOWED_CHAINS` | Comma-separated chain IDs | (empty = all) | `ETH,POLYGON` |
| `ALLOWED_ASSETS` | Comma-separated asset codes | (empty = all) | `ETH,USDC` |
| `MAX_AMOUNTS` | Asset limits (ASSET=AMOUNT) | (empty = no limits) | `ETH=10,USDC=50000` |
| `MAX_AMOUNT_*` | Individual asset limit | (none) | `MAX_AMOUNT_ETH=10` |