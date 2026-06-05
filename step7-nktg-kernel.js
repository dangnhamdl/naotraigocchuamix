/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 7: MAPPING LAYER & NKTg LAW KERNEL
 * ============================================================================
 * Update: energy = log10(|NKTg1|/mean) + log10(|NKTg2|/mean) + log10(|P|/mean)
 *         Logarithmic signal scaling — loại bỏ thứ nguyên, cộng hợp lệ
 *         sentenceScores: tiếp nhận từ Step 6b
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleOutputLayer } from './step8-output-layer.js';

class NKTgKernel {
    processKernel(aiResult) {
        const tokens = aiResult.tokens;
        const metrics = aiResult.metrics;

        // ------------------------------------------------------------------
        // Tính mean tham chiếu toàn văn bản — chuẩn hóa theo ngữ cảnh
        // ------------------------------------------------------------------
        const n = tokens.length;
        const EPS = 1e-9;
        const meanNKTg1 = tokens.reduce((s, t) => s + Math.abs(t.NKTg1), 0) / n;
        const meanNKTg2 = tokens.reduce((s, t) => s + Math.abs(t.NKTg2), 0) / n;
        const meanP     = tokens.reduce((s, t) => s + Math.abs(t.P),     0) / n;

        // ------------------------------------------------------------------
        // tokenScores: energy logarithmic (Bel scaling)
        // energy = log10(|NKTg1|/mean) + log10(|NKTg2|/mean) + log10(|P|/mean)
        // Loại bỏ thứ nguyên → 3 đại lượng khác đơn vị cộng hợp lệ
        // ------------------------------------------------------------------
        const tokenScores = {};
        for (const t of tokens) {
            const energy =
                Math.log10((Math.abs(t.NKTg1) + EPS) / (meanNKTg1 + EPS)) +
                Math.log10((Math.abs(t.NKTg2) + EPS) / (meanNKTg2 + EPS)) +
                Math.log10((Math.abs(t.P)     + EPS) / (meanP     + EPS));
            tokenScores[t.token] = {
                state:  t.state,
                energy,
                NKTg1:  t.NKTg1,
                NKTg2:  t.NKTg2,
                P:      t.P
            };
        }

        // ------------------------------------------------------------------
        // Phân loại token theo 3 trạng thái
        // ------------------------------------------------------------------
        const dominantTokens = tokens
            .filter(t => t.state === 'AMPLIFYING')
            .map(t => t.token);
        const filteredTokens = tokens
            .filter(t => t.state === 'DAMPING')
            .map(t => t.token);
        const stableTokens = tokens
            .filter(t => t.state === 'STABLE')
            .map(t => t.token);

        // ------------------------------------------------------------------
        // Xu hướng toàn văn bản
        // ------------------------------------------------------------------
        let state = 'STABLE';
        if (n === 0 || isNaN(metrics.amplifying_ratio)) state = 'STABLE';
        else if (metrics.amplifying_ratio > metrics.damping_ratio && metrics.amplifying_ratio > metrics.stable_ratio) state = 'AMPLIFYING';
        else if (metrics.damping_ratio > metrics.amplifying_ratio && metrics.damping_ratio > metrics.stable_ratio) state = 'DAMPING';
        else state = 'STABLE';

        return {
            state,
            sumP:              metrics.sumP,
            amplifying_ratio:  metrics.amplifying_ratio,
            damping_ratio:     metrics.damping_ratio,
            stable_ratio:      metrics.stable_ratio,
            dominantTokens,
            filteredTokens,
            stableTokens,
            tokenScores,
            sentenceScores:  aiResult.sentenceScores,
            processedAt: Date.now()
        };
    }
}

export const kernel = new NKTgKernel();

export async function handleKernelLayer(context) {
    try {
        Logger.log("[Step 7 Node] NKTg Kernel executing...", "info");
        if (!context.ai) throw new Error("Missing context.ai data.");

        context.kernel = kernel.processKernel(context.ai);

        Logger.log(
            `[Step 7 Kernel] State: ${context.kernel.state} | Dominant: ${context.kernel.dominantTokens.length} | Filtered: ${context.kernel.filteredTokens.length} | Stable: ${context.kernel.stableTokens.length} | Tokens scored: ${Object.keys(context.kernel.tokenScores).length} | Sentences: ${Object.keys(context.kernel.sentenceScores).length}`,
            "success"
        );

        await handleOutputLayer(context);
    } catch (err) {
        Logger.log(`[Step 7 Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}
