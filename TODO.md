# OTC Broker Engine - TODO List

This document tracks improvement opportunities and technical debt identified during the documentation and frontend updates.

---

## 🎯 High Priority

### Frontend Architecture Refactoring

**Issue**: The `renderPartyPage()` method in `rpc-server.ts` is 3,700+ lines of embedded JavaScript strings, losing all TypeScript benefits.

**Tasks**:
- [ ] Extract client-side code into separate TypeScript files
- [ ] Create proper frontend build process (webpack/vite)
- [ ] Move to `packages/web/src/` as standalone application
- [ ] Add proper type definitions for all client-side functions
- [ ] Implement proper module bundling

**Impact**: Maintainability, type safety, developer experience
**Effort**: Large (1-2 weeks)
**Files**: `packages/backend/src/api/rpc-server.ts:1376-5088`

---

### Performance Optimization - RPC Call Batching

**Issue**: Multiple sequential RPC calls create N+1 query problem.

**Tasks**:
- [ ] Implement request batching for blockchain queries
- [ ] Use Promise.all() for parallel balance fetching
- [ ] Batch Electrum requests when possible
- [ ] Add connection pooling for RPC providers

**Current Behavior**:
```javascript
// Sequential (slow)
const balanceA = await getBalance(addressA);
const balanceB = await getBalance(addressB);
```

**Desired Behavior**:
```javascript
// Parallel (fast)
const [balanceA, balanceB] = await Promise.all([
  getBalance(addressA),
  getBalance(addressB)
]);
```

**Impact**: Response time reduction (50-70%)
**Effort**: Medium (2-3 days)
**Files**: `packages/backend/src/api/rpc-server.ts:3983-4265`

---

### Cache Optimization

**Issue**: Cache TTL (10s) vs polling interval (5s) causes unnecessary RPC calls.

**Tasks**:
- [ ] Align cache TTL with polling intervals
- [ ] Implement smarter cache invalidation
- [ ] Add cache warming on page load
- [ ] Use WebSocket subscriptions instead of polling where available

**Current**: 10s cache, 5s polling = 50% cache hit rate
**Target**: Aligned intervals = 90%+ cache hit rate

**Impact**: RPC load reduction, faster responses
**Effort**: Small (1 day)
**Files**: `packages/backend/src/api/rpc-server.ts:4000-4020`

---

## 🔧 Medium Priority

### Browser Compatibility

**Issue**: No polyfills or compatibility checks for modern ES features.

**Tasks**:
- [ ] Add browser compatibility detection
- [ ] Include polyfills for ES2017+ features (async/await, Promise, etc.)
- [ ] Test on older browser versions (IE11, older Safari)
- [ ] Add feature detection before using WebSocket/ethers.js
- [ ] Provide graceful degradation messages

**Impact**: Broader browser support
**Effort**: Medium (2-3 days)
**Files**: `packages/backend/src/api/rpc-server.ts` (client-side code)

---

### Error Handling Enhancement

**Issue**: Limited error context and recovery strategies.

**Tasks**:
- [ ] Add structured error types for different failure modes
- [ ] Implement retry logic with exponential backoff
- [ ] Add better error messages for users
- [ ] Log errors to backend for monitoring
- [ ] Create error recovery flows (e.g., switch to backup RPC)

**Current**:
```javascript
catch (error) {
  console.error('Failed:', error);
  // Fallback to backend
}
```

**Desired**:
```javascript
catch (error) {
  if (isNetworkError(error)) {
    await retryWithBackoff();
  } else if (isRPCError(error)) {
    await switchToBackupRPC();
  }
  logErrorToBackend(error);
  showUserFriendlyMessage(error);
}
```

**Impact**: Better user experience, easier debugging
**Effort**: Medium (3-4 days)
**Files**: All RPC query functions in `rpc-server.ts`

---

### Security Improvements

**Issue**: Tokens exposed in URLs, potential XSS in dynamic content.

**Tasks**:
- [ ] Move tokens from URL query params to POST body or headers
- [ ] Implement token rotation mechanism
- [ ] Add CSP (Content Security Policy) headers
- [ ] Sanitize all dynamic content before rendering
- [ ] Add rate limiting for party pages
- [ ] Implement CSRF protection

**Current**: `/d/{dealId}/a/{token}` - token in URL
**Target**: Token in secure HTTP-only cookie or Authorization header

**Impact**: Security hardening
**Effort**: Medium (3-5 days)
**Files**: `packages/backend/src/api/rpc-server.ts:1376-1450`

---

### TypeScript Type Safety

**Issue**: Client-side code is JavaScript strings, no compile-time checking.

**Tasks**:
- [ ] Create TypeScript definitions for all client-side types
- [ ] Add interfaces for RPC responses
- [ ] Type blockchain query results
- [ ] Add strict null checks
- [ ] Enable strict mode for client code

**Impact**: Fewer runtime errors, better IDE support
**Effort**: Medium (3-4 days)
**Files**: `packages/backend/src/api/rpc-server.ts` (entire client-side section)

---

## 📋 Low Priority / Future Enhancements

### WebSocket-Based Real-time Updates

**Tasks**:
- [ ] Replace polling with WebSocket subscriptions
- [ ] Implement server-side event streaming
- [ ] Use blockchain WebSocket APIs (Alchemy, Infura subscriptions)
- [ ] Add reconnection logic
- [ ] Fallback to polling if WebSocket unavailable

**Impact**: Lower latency, reduced server load
**Effort**: Large (1-2 weeks)

---

### Progressive Web App (PWA) Support

**Tasks**:
- [ ] Add service worker for offline support
- [ ] Implement app manifest
- [ ] Cache blockchain data for offline viewing
- [ ] Add install prompt
- [ ] Support push notifications for deal updates

**Impact**: Better mobile experience, offline capability
**Effort**: Medium (1 week)

---

### Multi-Language Support (i18n)

**Tasks**:
- [ ] Extract all user-facing strings
- [ ] Add i18n library (e.g., i18next)
- [ ] Create translation files
- [ ] Add language selector
- [ ] Support RTL languages

**Impact**: Global accessibility
**Effort**: Medium (1-2 weeks)

---

### Enhanced Analytics

**Tasks**:
- [ ] Add client-side performance monitoring
- [ ] Track RPC call success rates
- [ ] Monitor balance update latency
- [ ] Add user behavior analytics (privacy-preserving)
- [ ] Create dashboard for system health

**Impact**: Better operational visibility
**Effort**: Medium (1 week)

---

### Accessibility (a11y) Improvements

**Tasks**:
- [ ] Add ARIA labels to all interactive elements
- [ ] Ensure keyboard navigation works properly
- [ ] Add screen reader support
- [ ] Improve color contrast ratios
- [ ] Add focus indicators
- [ ] Test with accessibility tools (axe, WAVE)

**Impact**: Accessibility compliance, broader user base
**Effort**: Medium (3-5 days)

---

### Documentation Improvements

**Tasks**:
- [ ] Add inline code examples in MODULE.md files
- [ ] Create video tutorials for common tasks
- [ ] Add architecture decision records (ADRs)
- [ ] Document all environment variables
- [ ] Create troubleshooting guide
- [ ] Add contribution guidelines

**Impact**: Easier onboarding, better maintainability
**Effort**: Medium (ongoing)

---

### Testing Infrastructure

**Tasks**:
- [ ] Add unit tests for client-side functions
- [ ] Create E2E tests for party pages
- [ ] Add integration tests for RPC calls
- [ ] Set up visual regression testing
- [ ] Add performance benchmarks
- [ ] Create mock blockchain responses for testing

**Impact**: Code quality, regression prevention
**Effort**: Large (2-3 weeks)

---

### Code Splitting & Lazy Loading

**Tasks**:
- [ ] Split JavaScript by deal stage
- [ ] Lazy load blockchain libraries (ethers.js)
- [ ] Implement code splitting for different chains
- [ ] Add preloading for critical resources
- [ ] Optimize bundle size

**Impact**: Faster initial page load
**Effort**: Medium (3-5 days)

---

## 🔍 Technical Debt

### Large Method Refactoring

**Issue**: Single 3,700-line method violates single responsibility principle.

**Tasks**:
- [ ] Extract balance fetching into separate service
- [ ] Create dedicated UI update handlers
- [ ] Separate blockchain connection logic
- [ ] Create helper utilities for common operations
- [ ] Split by concern: rendering, state management, blockchain queries

**Suggested Structure**:
```
packages/web/src/
├── services/
│   ├── blockchain/
│   │   ├── UnicityService.ts
│   │   ├── EVMService.ts
│   │   └── BalanceService.ts
│   └── api/
│       └── DealService.ts
├── components/
│   ├── ProgressBar.ts
│   ├── BalanceDisplay.ts
│   └── StatusMessage.ts
├── utils/
│   ├── formatters.ts
│   └── validators.ts
└── pages/
    ├── PartyPage.ts
    └── CreateDealPage.ts
```

**Impact**: Maintainability, testability, reusability
**Effort**: Large (2 weeks)
**Files**: `packages/backend/src/api/rpc-server.ts`

---

### Database Query Optimization

**Tasks**:
- [ ] Add database indexes for frequently queried fields
- [ ] Optimize JOIN queries
- [ ] Add query result caching
- [ ] Review N+1 query patterns
- [ ] Add query performance monitoring

**Impact**: Database performance
**Effort**: Medium (3-5 days)
**Files**: `packages/backend/src/db/repositories/*.ts`

---

### Configuration Management

**Tasks**:
- [ ] Centralize RPC endpoints configuration
- [ ] Add environment-specific configs (dev/staging/prod)
- [ ] Support runtime configuration updates
- [ ] Add configuration validation
- [ ] Document all configuration options

**Impact**: Easier deployment, better configuration management
**Effort**: Small (2-3 days)

---

## 📝 Documentation Gaps

### Missing Documentation

**Tasks**:
- [ ] Add deployment guide
- [ ] Create operator manual
- [ ] Document disaster recovery procedures
- [ ] Add monitoring setup guide
- [ ] Create security audit checklist
- [ ] Document backup/restore procedures

**Impact**: Operational readiness
**Effort**: Medium (1 week)

---

## 🎨 UI/UX Improvements

### User Experience Enhancements

**Tasks**:
- [ ] Add loading skeletons instead of spinners
- [ ] Implement optimistic UI updates
- [ ] Add animations for state transitions
- [ ] Improve mobile responsiveness
- [ ] Add dark mode support
- [ ] Create better empty states
- [ ] Add inline help tooltips

**Impact**: User satisfaction
**Effort**: Medium (1-2 weeks)

---

### Error State Improvements

**Tasks**:
- [ ] Design better error pages
- [ ] Add actionable error messages
- [ ] Implement error recovery suggestions
- [ ] Add "Copy error details" button
- [ ] Create error state illustrations

**Impact**: Better error handling UX
**Effort**: Small (2-3 days)

---

## 🔐 Security Hardening

### Additional Security Tasks

**Tasks**:
- [ ] Add rate limiting per IP address
- [ ] Implement request signing
- [ ] Add audit logging for all party page accesses
- [ ] Create security headers middleware
- [ ] Add DDoS protection
- [ ] Implement IP whitelisting option

**Impact**: Enhanced security posture
**Effort**: Medium (1 week)

---

## 🚀 Performance Monitoring

### Observability Tasks

**Tasks**:
- [ ] Add OpenTelemetry instrumentation
- [ ] Create custom metrics for RPC calls
- [ ] Set up alerts for slow queries
- [ ] Add transaction tracing
- [ ] Create performance dashboard

**Impact**: Better operational visibility
**Effort**: Medium (1 week)

---

## Priority Matrix

| Priority | Tasks | Total Effort |
|----------|-------|--------------|
| High     | 3     | 2-3 weeks    |
| Medium   | 6     | 3-4 weeks    |
| Low      | 10    | 6-8 weeks    |

---

## Notes

- All tasks should be reviewed and prioritized based on business needs
- Effort estimates are rough and may vary based on team size/experience
- Some tasks can be done in parallel
- Regular review of this TODO list is recommended (monthly/quarterly)

---

**Last Updated**: 2025-10-08
**Reviewed By**: AI Documentation Agents
**Next Review**: TBD
