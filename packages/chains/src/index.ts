/**
 * @fileoverview Main export file for the chains package.
 * Provides access to all chain plugins, interfaces, and utilities for blockchain integration.
 */

// Core interface and types
export * from './ChainPlugin';
export * from './types';

// Plugin implementations
export * from './UnicityPlugin';
export * from './EvmPlugin';
export * from './EthereumPlugin';
export * from './PolygonPlugin';
export * from './BasePlugin';

// Plugin management
export * from './PluginManager';

// Utilities
export * from './utils/UnicityKeyManager';