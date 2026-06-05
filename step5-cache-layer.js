/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 5: CLIENT-SIDE CACHE LAYER
 * ============================================================================
 * File: /nktg-ai/step5-cache-layer.js
 * Purpose: Cache RAG metadata, pass context to Step 6 (Cerebellum)
 * v2: Cache key dùng FNV-1a hash toàn bộ input — tránh HIT nhầm khi
 *     2 văn bản khác ngôn ngữ có cùng 64 ký tự đầu
 */
import { handleSmallAILayer } from './nktg_cerebellum.js';
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';

const CacheStore = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

export const CacheLayer = {

    generateCacheKey(context) {
        const input = context.meta?.rawInput || "";
        // FNV-1a 32-bit hash toàn bộ input — cùng thuật toán với Step 6a
        // 2 văn bản khác nhau dù 1 ký tự → hash khác nhau → không bao giờ HIT nhầm
        let hash = 2166136261 >>> 0;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        const lang = context.textMeta?.language || "unknown";
        return `nktg_cache__${lang}__${hash >>> 0}`;
    },

    async isCacheValid(key) {
        const entry = CacheStore.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            CacheStore.delete(key);
            Logger.log(`[Step 5 Cache] Entry expired and removed: ${key}`, "warn");
            return null;
        }
        return entry.data;
    },

    async saveToCache(key, data) {
        CacheStore.set(key, {
            data: structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data)),
            timestamp: Date.now()
        });
        Logger.log(`[Step 5 Cache] Saved to cache: ${key}`, "info");
    },

    async executeCachePipeline(context) {
        Logger.log("[Step 5 Node] Metadata Cache Layer executing...", "info");

        const key = this.generateCacheKey(context);
        const cachedData = await this.isCacheValid(key);

        if (cachedData) {
            context.rag = cachedData;
            Logger.log(`[Step 5 Cache] Cache HIT: ${key}`, "success");
        } else {
            Logger.log("[Step 5 Cache] Cache MISS: Performing Integrity Check.", "info");
            if (context.rag) {
                await this.saveToCache(key, context.rag);
            }
        }

        Logger.log("[Step 5] Handoff to Step 6 (Cerebellum)...", "info");
        await handleSmallAILayer(context);
    }
};

export async function handleCacheLayer(context) {
    try {
        await CacheLayer.executeCachePipeline(context);
    } catch (err) {
        Logger.log(`[Step 5 Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}

console.log("[Kernel] Step 5 Client-side Cache Layer initialized.");
