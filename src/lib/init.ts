/**
 * Server Initialization
 * 
 * This module handles initialization tasks when the Next.js server starts,
 * including starting the probe scheduler.
 */

import { startScheduler } from './scheduler';
import { initDatabase } from './database';

let initialized = false;

/**
 * Initialize the server and start background services
 */
export async function initializeServer(): Promise<void> {
  if (initialized) {
    console.log('[Init] Server already initialized');
    return;
  }

  console.log('[Init] Initializing ClearPing server...');

  try {
    // Initialize database
    await initDatabase();
    console.log('[Init] Database initialized');

    // Start the probe scheduler
    await startScheduler();
    console.log('[Init] Probe scheduler started');

    initialized = true;
    console.log('[Init] Server initialization complete');
  } catch (error) {
    console.error('[Init] Server initialization failed:', error);
    throw error;
  }
}

/**
 * Check if server is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}
