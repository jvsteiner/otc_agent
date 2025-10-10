# ============================================================================
# Multi-stage Dockerfile for Playwright JSON-RPC Service
# ============================================================================

# Stage 1: Build stage
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy TypeScript config and source files
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript application
RUN npm run build

# Remove devDependencies to reduce size
RUN npm prune --production

# ============================================================================
# Stage 2: Production stage
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS production

# Install curl for healthcheck
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user and group
RUN groupadd -r pwuser && \
    useradd -r -g pwuser -u 1001 pwuser && \
    mkdir -p /app && \
    chown -R pwuser:pwuser /app

# Set working directory
WORKDIR /app

# Copy built artifacts from builder stage
COPY --from=builder --chown=pwuser:pwuser /app/dist ./dist
COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/package*.json ./

# Switch to non-root user
USER pwuser

# Set Node.js environment to production
ENV NODE_ENV=production

# Expose service port
EXPOSE 3337

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3337/health || exit 1

# Set resource limits and security options
# These are hints for runtime configuration
LABEL org.opencontainers.image.title="Playwright JSON-RPC Service" \
      org.opencontainers.image.description="Headless browser automation microservice with JSON-RPC 2.0 API" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.vendor="OTC Agent" \
      org.opencontainers.image.licenses="MIT"

# Start the application with graceful shutdown handling
CMD ["node", "--max-old-space-size=1536", "dist/server.js"]

# ============================================================================
# Stage 3: Development stage (optional)
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.47.2-jammy AS development

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src
COPY test ./test

# Create non-root user
RUN groupadd -r pwuser && \
    useradd -r -g pwuser -u 1001 pwuser && \
    chown -R pwuser:pwuser /app

USER pwuser

ENV NODE_ENV=development

EXPOSE 3337

# Development command with hot reload
CMD ["npm", "run", "dev"]