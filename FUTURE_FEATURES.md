# Future Features Roadmap

## 1. Dynamic ERC20 Fee Calculation via UniSwap

### Current Implementation
- **Fixed fees** configured per-chain via environment variables
- Example: `POLYGON_ERC20_FEE=0.001` (0.001 USDT for USDT swaps)
- Fee covers gas costs for ERC20 approval + transfer operations
- Fee is paid in the **same currency as the swap** (no mixing of currencies)

### Proposed Enhancement
**Automatic gas cost conversion using UniSwap V3 price feeds**

#### Architecture
```typescript
async function calculateDynamicERC20Fee(
  chainId: ChainId,
  tokenAddress: string,
  swapAsset: AssetCode
): Promise<string> {
  // 1. Get current gas price from chain
  const provider = getProviderForChain(chainId);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;

  // 2. Estimate gas for ERC20 operations
  const APPROVAL_GAS = 50_000n;   // Typical ERC20 approve()
  const TRANSFER_GAS = 65_000n;   // Typical transferFrom()
  const TOTAL_GAS = APPROVAL_GAS + TRANSFER_GAS;

  // 3. Calculate native currency cost
  const nativeCost = gasPrice * TOTAL_GAS;
  const nativeCostEther = ethers.formatEther(nativeCost);

  // 4. Get native → swap token exchange rate from UniSwap V3
  const uniswapRouter = getUniswapV3Router(chainId);
  const quoterContract = getUniswapV3Quoter(chainId);

  const nativeToken = getNativeTokenAddress(chainId); // WMATIC, WETH, etc.
  const path = encodePath([nativeToken, tokenAddress], [3000]); // 0.3% fee tier

  const quote = await quoterContract.quoteExactInput(
    path,
    ethers.parseEther(nativeCostEther)
  );

  // 5. Add safety margin (20%) for price volatility
  const feeWithMargin = (quote * 120n) / 100n;

  return ethers.formatUnits(feeWithMargin, await getTokenDecimals(tokenAddress));
}
```

#### Integration Points
1. **Replace static fees** in `rpc-server.ts: getCommissionRequirement()`
2. **Cache quotes** for 5-10 minutes to avoid excessive RPC calls
3. **Fallback to static fees** if UniSwap query fails
4. **Support multiple DEX sources**: UniSwap V3, QuickSwap (Polygon), PancakeSwap (BSC)

#### Required Dependencies
```json
{
  "@uniswap/v3-sdk": "^3.10.0",
  "@uniswap/smart-order-router": "^3.15.0",
  "@uniswap/sdk-core": "^4.0.0"
}
```

#### Configuration
```bash
# .env additions
POLYGON_UNISWAP_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
POLYGON_UNISWAP_V3_QUOTER=0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
POLYGON_UNISWAP_PRICE_CACHE_SECONDS=300  # Cache quotes for 5 minutes

# Fallback to static if dynamic fails
POLYGON_ERC20_FEE_FALLBACK=0.001
```

#### Benefits
- **Accurate gas cost recovery**: Fees adjust with network conditions
- **Fair pricing**: Users pay actual costs, not arbitrary fixed amounts
- **Multi-token support**: Automatically works with any ERC20 token with UniSwap liquidity

#### Challenges
- **Price volatility**: Token prices can fluctuate during deal creation → COLLECTION
- **Slippage**: Actual gas costs may differ from quoted amounts
- **Liquidity depth**: Some tokens may have poor UniSwap liquidity
- **Multiple hops**: Some token pairs require multi-hop swaps (USDT → WETH → MATIC)

#### Mitigation Strategies
1. **Freeze fee at COLLECTION start** (like existing commission freezing)
2. **Add safety margin** (20%) to cover slippage
3. **Fallback to static fees** if UniSwap price is unavailable or unreasonable
4. **Cache prices** to reduce RPC calls and improve performance
5. **Multi-hop routing**: Use smart-order-router for best price across multiple paths

#### Rollout Plan
**Phase 1**: Implement and test on Sepolia testnet
**Phase 2**: Enable on Polygon mainnet with monitoring
**Phase 3**: Expand to Ethereum mainnet and Base
**Phase 4**: Add alternative DEX support (QuickSwap, SushiSwap, etc.)

---

## 2. Other Future Features

### Gas Refund Automation
- **Status**: Partially implemented (gas_refunds table exists)
- **TODO**: Automatically refund excess gas from ERC20 escrows back to tank wallet
- **Benefit**: Recover unused gas funds after successful swaps

### Multi-Asset Commission Payment
- **Idea**: Allow users to pay commission in different asset than swap currency
- **Example**: Swap USDT but pay commission in USDC or MATIC
- **Benefit**: More flexible for users with diverse asset holdings

### Dynamic Commission Rates
- **Idea**: Adjust commission percentage based on deal size or asset type
- **Example**: Lower commission (0.2%) for deals > $10,000
- **Benefit**: Competitive pricing for high-value deals

### Cross-Chain Gas Estimation
- **Idea**: Estimate total gas costs across both sides of a swap
- **Example**: Show Alice total cost for USDT@POLYGON → ALPHA@UNICITY swap
- **Benefit**: Complete price transparency before deal creation

---

## Implementation Priority
1. **High**: Dynamic ERC20 fees via UniSwap (Phase 1)
2. **Medium**: Gas refund automation
3. **Low**: Multi-asset commission payment
4. **Low**: Dynamic commission rates
5. **Low**: Cross-chain gas estimation

---

## Notes
- All features should maintain backward compatibility with existing deals
- Configuration should default to current behavior (static fees)
- New features should be opt-in via environment variables
- Comprehensive testing required before production deployment
