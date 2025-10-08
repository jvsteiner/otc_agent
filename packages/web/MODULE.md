# packages/web Module Documentation

## Overview

The `packages/web` module provides the user-facing web interface for the OTC Broker Engine. While the module structure exists as a placeholder for future static/SSR pages, the current implementation embeds the web interface directly within the RPC server in the backend package. This architectural decision creates a self-contained application where the API and web UI are served from the same Express server.

## Module Purpose

The web module is designed to deliver three critical user interfaces for OTC deal management:

1. **Deal Creation Interface** - Public page for initiating new swap deals
2. **Party A (Alice) Personal Page** - Secure interface for the asset A seller
3. **Party B (Bob) Personal Page** - Secure interface for the asset B seller

## Current Implementation Architecture

### Embedded HTML Generation

Currently, the web interface is implemented as server-rendered HTML pages generated directly by the RPC server (`packages/backend/src/api/rpc-server.ts`). This approach:

- Eliminates the need for a separate frontend build process
- Ensures tight integration with the backend API
- Simplifies deployment by creating a single service
- Provides immediate access to deal data without additional API calls

### Key Components

#### 1. Deal Creation Page (`/`)

**Purpose**: Allow users to create new OTC swap deals without authentication

**Features**:
- Dual-column layout for Asset A and Asset B configuration
- Chain selection dropdowns (Unicity, Ethereum, Polygon, etc.)
- Asset selection with native and token support
- Amount input with decimal precision
- Configurable timeout (5 minutes to 24 hours)
- Auto-generated or custom deal names
- Modal dialog showing generated party links after creation

**Technical Details**:
- Dynamically populates asset dropdowns based on chain selection
- Client-side validation before submission
- Generates unique access tokens for each party
- Creates shareable links in format: `/d/{dealId}/a/{token}` and `/d/{dealId}/b/{token}`

#### 2. Party Personal Pages (`/d/:dealId/[a|b]/:token`)

**Purpose**: Secure interfaces for deal participants to manage their side of the swap

**Features**:
- Real-time deal status monitoring
- Wallet address collection (payback and recipient)
- Optional email notification signup
- Escrow address display with copy functionality
- Live balance tracking with progress indicators
- Transaction history log
- Countdown timer for deal expiration
- Deal cancellation (when no assets locked)

**Technical Implementation**:
- Token-based authentication (no user accounts required)
- WebSocket-like polling for real-time updates (30-second intervals)
- Direct blockchain queries via ethers.js for balance verification
- Responsive design optimized for mobile devices

### RPC Integration

The web pages communicate with the backend through JSON-RPC calls to the `/rpc` endpoint:

```javascript
// Example from party page
const response = await fetch('/rpc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'otc.fillPartyDetails',
    params: {
      dealId: dealId,
      party: 'ALICE',
      token: token,
      details: {
        paybackAddress: payback,
        payoutAddress: recipient,
        email: email
      }
    },
    id: 1
  })
});
```

### Visual Design System

The interface uses a consistent design language:

- **Color Palette**:
  - Primary: #667eea (purple gradient)
  - Success: #10b981 (green)
  - Warning: #ffc107 (yellow)
  - Error: #dc3545 (red)
  - Background: #f8f9fa (light gray)

- **Component Styling**:
  - Rounded corners (10px border-radius)
  - Card-based layouts with shadows
  - Emoji icons for visual clarity
  - Progress bars for balance tracking
  - Animated loading spinners

## Data Flow

```
User Journey:
1. Create Deal (/)
   → Generate dealId + tokens
   → Display party links

2. Share Links
   → Party A receives /d/{dealId}/a/{tokenA}
   → Party B receives /d/{dealId}/b/{tokenB}

3. Party Pages
   → Submit wallet addresses
   → Monitor escrow deposits
   → Track deal progress
   → Receive payouts on completion
```

## Security Considerations

1. **Token-Based Access**: Each party receives a unique, unguessable token
2. **No Cross-Party Access**: Tokens are validated server-side
3. **Read-Only Blockchain Queries**: Direct ethers.js queries are read-only
4. **HTTPS Enforcement**: All production deployments should use HTTPS
5. **Input Validation**: Both client and server-side validation

## Future Migration Path

The current embedded implementation can evolve to a separate static/SSR application:

### Phase 1: Static Asset Extraction
- Extract CSS into separate stylesheets
- Move JavaScript to external modules
- Create reusable component templates

### Phase 2: Build Process
- Set up webpack/vite configuration
- Implement hot-reload development server
- Add TypeScript compilation for frontend code

### Phase 3: Framework Integration
- Migrate to React/Vue/Svelte for component architecture
- Implement proper state management (Redux/Pinia/stores)
- Add unit and integration tests

### Phase 4: Performance Optimization
- Implement code splitting
- Add PWA capabilities
- Enable offline mode for read operations
- Implement proper WebSocket connections

## API Dependencies

The web interface relies on these RPC methods:

- `otc.createDeal` - Initialize new swap deal
- `otc.fillPartyDetails` - Submit party wallet addresses
- `otc.status` - Get current deal status
- `otc.listDeals` - Retrieve deal list (future admin interface)

## Environment Requirements

- Modern browser with ES6+ support
- JavaScript enabled
- Cookies enabled (for future session management)
- Screen width ≥ 320px (responsive design)

## Development Guidelines

When extending the web interface:

1. **Maintain Simplicity**: The interface should be usable by non-technical users
2. **Preserve Token Security**: Never expose tokens in URLs visible to third parties
3. **Ensure Mobile Compatibility**: Test on various device sizes
4. **Follow Progressive Enhancement**: Core functionality should work without JavaScript
5. **Implement Graceful Degradation**: Handle API failures with clear user feedback

## Testing Considerations

### Manual Testing Checklist
- [ ] Deal creation with all chain combinations
- [ ] Token validation (invalid tokens show error)
- [ ] Address validation per chain
- [ ] Countdown timer accuracy
- [ ] Balance update frequency
- [ ] Transaction log population
- [ ] Mobile responsive design
- [ ] Cross-browser compatibility

### Automated Testing (Future)
- Unit tests for form validation
- Integration tests for RPC communication
- E2E tests for complete user journeys
- Performance tests for real-time updates
- Security tests for token validation

## Performance Metrics

Target metrics for web interface:

- **Initial Load**: < 2 seconds
- **RPC Response**: < 500ms
- **Balance Update**: Every 30 seconds
- **Countdown Accuracy**: ±1 second
- **Mobile Performance**: 60 FPS scrolling

## Accessibility

Current accessibility features:

- Semantic HTML structure
- High contrast colors
- Descriptive button labels
- Form field labels and placeholders
- Error messages with clear instructions

Future improvements needed:

- ARIA labels for dynamic content
- Keyboard navigation support
- Screen reader optimization
- Focus management for modals
- Reduced motion options

## Conclusion

The packages/web module represents the user-facing layer of the OTC Broker Engine. While currently implemented as embedded HTML within the RPC server, the architecture supports future evolution into a standalone application. The focus on simplicity, security, and real-time updates ensures users can confidently execute cross-chain asset swaps without technical expertise.

The module's success lies in its ability to abstract complex blockchain operations behind an intuitive interface, making decentralized OTC trading accessible to a broader audience while maintaining the security and transparency benefits of on-chain settlement.