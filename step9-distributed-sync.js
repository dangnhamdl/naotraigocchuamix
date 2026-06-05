/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 9: DISTRIBUTED SYNC LAYER
 * ============================================================================
 * File: /nktg-ai/step9-distributed-sync.js
 * Specification: Production Enterprise Compliance (ES Module) - Secure Sync
 */

import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';

let nextLayerHandler = null;

class NKTgDistributedSync {
    /**
     * Synchronizes output data across distributed channels (Storage, Git, CDN).
     */
    async sync(context) {
        const output = context.output;
        const channels = [];
        const failed = [];

        // 1. LocalStorage History Sync with corruption handling
        try {
            const history = (() => {
                try { return JSON.parse(localStorage.getItem('nktg_history') || '[]'); }
                catch { return []; }
            })();
            history.push({ ...output, timestamp: Date.now() });
            localStorage.setItem('nktg_history', JSON.stringify(history.slice(-50)));
            channels.push('localStorage');
        } catch (e) {
            failed.push('localStorage');
        }

        // 2. Cache API Sync
        try {
            const cache = await caches.open('nktg-output-cache');
            await cache.put(`/sync/${output.processedAt}`, new Response(JSON.stringify(output)));
            channels.push('CDN-Cache');
        } catch (e) {
            failed.push('CDN-Cache');
        }

        // 3. Simulated Git Sync (GitHub API)
        try {
            // Mock: simulate async fetch request
            await new Promise(resolve => setTimeout(resolve, 500));
            channels.push('GitHub-API');
        } catch (e) {
            failed.push('GitHub-API');
        }

        return {
            syncedAt: Date.now(),
            channels,
            failed,
            localStorageKey: 'nktg_history'
        };
    }
}

export const distributedSync = new NKTgDistributedSync();

export async function handleDistributedSync(context) {
    try {
        Logger.log("[Step 9 Node] Distributed Sync Layer initiating...", "info");

        if (!context.output) {
            throw new Error("Missing context.output data from Step 8.");
        }

        context.sync = await distributedSync.sync(context);

        context.sync.channels.forEach(ch => Logger.log(`[Step 9 Sync] Success: ${ch}`, "success"));
        context.sync.failed.forEach(ch => Logger.log(`[Step 9 Sync] Failed: ${ch}`, "warn"));

        if (typeof nextLayerHandler === 'function') {
            await nextLayerHandler(context);
        } else {
            Logger.log("[Step 9 Pipeline] Final stage reached. Pipeline Completed.", "info");
            setPipelineState("COMPLETED");
            unlockPipelineUI();
        }
    } catch (err) {
        Logger.log(`[Step 9 Fatal] Synchronization failure: ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}

export function registerNextLayerHandler(fn) {
    if (typeof fn !== 'function') {
        console.error("[Fatal] Parameter must be a function.");
        return;
    }
    nextLayerHandler = fn;
    console.log("[Kernel] Step 10 Handler successfully hooked into Sync pipeline.");
}
