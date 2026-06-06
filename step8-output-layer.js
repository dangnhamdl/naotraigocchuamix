/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 8: OUTPUT GENERATION LAYER (OPTIMIZED v18)
 * ============================================================================
 * Update: Tam giác đồng dạng — output tỉ lệ theo token toàn văn bản (Step 7)
 *         compressionRatio = 0.382 (Golden ratio) — giữ 38.2% tổng câu
 *         totalKeep = ceil(totalSentences × 0.382)
 *         ampKeep    = round(totalKeep × ampRatio)
 *         dampKeep   = round(totalKeep × dampRatio)
 *         stableKeep = max(0, totalKeep - ampKeep - dampKeep)
 *                      → clamp về 0 phòng sai lệch làm tròn, không thay đổi thuật toán
 *         Chấm điểm TẤT CẢ câu cho từng targetState — không filter theo nhãn câu
 *         Output: gộp 3 tầng → hiển thị theo thứ tự gốc
 *         v17: wordCount dùng Universal tokenizer — đúng với CJK/RTL/Devanagari
 *         v18: Bỏ convertLatexToText() — dùng KaTeX 0.16.21 render công thức
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';

function countTokens(text) {
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu)?.length || 1;
}

class NKTgOutputLayer {

    scoreSentenceByPhysics(sentence, tokenScores, targetState) {
        const lower = sentence.toLowerCase();
        let totalEnergy = 0;
        let matchCount = 0;
        for (const [token, data] of Object.entries(tokenScores)) {
            if (targetState === 'AMPLIFYING' && data.state !== 'AMPLIFYING') continue;
            if (targetState === 'DAMPING'    && data.state !== 'DAMPING')    continue;
            if (targetState === 'STABLE'     && data.state !== 'STABLE')     continue;
            if (lower.includes(token.toLowerCase())) {
                totalEnergy += Math.max(0, data.energy + 3);
                matchCount++;
            }
        }
        const wordCount = countTokens(sentence);
        const density = matchCount > 0 ? matchCount / wordCount : 0;
        return totalEnergy * density;
    }

    similarity(a, b) {
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = [...setA].filter(w => setB.has(w)).length;
        const union = new Set([...setA, ...setB]).size;
        return union > 0 ? intersection / union : 0;
    }

    deduplicate(scoredSentences) {
        const result = [];
        for (const candidate of scoredSentences) {
            const isDuplicate = result.some(
                kept => this.similarity(kept.sentence, candidate.sentence) > 0.5
            );
            if (!isDuplicate) result.push(candidate);
        }
        return result;
    }

    filterLayer(sentenceScores, tokenScores, targetState, keepCount) {
        if (keepCount <= 0) return [];
        const allSentences = Object.keys(sentenceScores);
        const scored = allSentences.map(s => ({
            sentence: s,
            score: this.scoreSentenceByPhysics(s, tokenScores, targetState)
        }));
        const sorted = [...scored].sort((a, b) => b.score - a.score);
        const deduped = this.deduplicate(sorted);
        const top = deduped.slice(0, keepCount);
        const topSet = new Set(top.map(t => t.sentence));
        return Object.keys(sentenceScores).filter(s => topSet.has(s));
    }

    extractImportantSentences(sentenceScores, tokenScores, globalState, ampRatio, dampRatio, stableRatio) {
        const totalSentences = Object.keys(sentenceScores).length;
        const totalKeep  = Math.ceil(totalSentences * 0.382);
        const ampKeep    = Math.round(totalKeep * ampRatio);
        const dampKeep   = Math.round(totalKeep * dampRatio);
        const stableKeep = Math.max(0, totalKeep - ampKeep - dampKeep);
        const tierAmp    = this.filterLayer(sentenceScores, tokenScores, 'AMPLIFYING', ampKeep);
        const tierDamp   = this.filterLayer(sentenceScores, tokenScores, 'DAMPING',    dampKeep);
        const tierStable = this.filterLayer(sentenceScores, tokenScores, 'STABLE',     stableKeep);
        const allSelected = new Set([...tierAmp, ...tierDamp, ...tierStable]);
        const ordered = Object.keys(sentenceScores).filter(s => allSelected.has(s));
        Logger.log(
            `[Step 8 Filter] AMP: ${tierAmp.length}(keep=${ampKeep}) | DAMP: ${tierDamp.length}(keep=${dampKeep}) | STABLE: ${tierStable.length}(keep=${stableKeep}) | Tổng: ${ordered.length} | GlobalState: ${globalState}`,
            "info"
        );
        return ordered;
    }

    generateResponse(context) {
        const kernel = context.kernel;
        const state = kernel.state;
        const rawInput = context.meta?.rawInput || "";
        const sentenceScores = kernel.sentenceScores || {};
        const tokenScores    = kernel.tokenScores    || {};
        const ampRatio    = kernel.amplifying_ratio;
        const dampRatio   = kernel.damping_ratio;
        const stableRatio = kernel.stable_ratio;
        const sentences = this.extractImportantSentences(
            sentenceScores, tokenScores, state,
            ampRatio, dampRatio, stableRatio
        );
        const optimizedText = sentences.join(' ');
        const displaySentences = [];
        for (const sentence of sentences) {
            const lines = sentence.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            displaySentences.push(...lines);
        }
        const ampCount = kernel.dominantTokens.length;
        const totalTokens = ampCount +
            (kernel.filteredTokens?.length || 0) +
            (kernel.stableTokens?.length   || 0);
        let prefix = "";
        if (state === 'AMPLIFYING') {
            prefix = `Amplifying ${ampCount}/${totalTokens} tokens`;
        } else if (state === 'DAMPING') {
            prefix = `Damping ${kernel.filteredTokens?.length}/${totalTokens} tokens`;
        } else {
            prefix = `Stable ${kernel.stableTokens?.length}/${totalTokens} tokens`;
        }
        return {
            sentences: displaySentences,
            response: optimizedText,
            prefix,
            state,
            sumP: kernel.sumP,
            originalLength: rawInput.length,
            optimizedLength: optimizedText.length,
            compressionRate: rawInput.length > 0
                ? ((1 - optimizedText.length / rawInput.length) * 100).toFixed(1) + '%'
                : '0%',
            dominantTokens: kernel.dominantTokens,
            filteredTokens: kernel.filteredTokens,
            stableTokens:   kernel.stableTokens,
            processedAt: Date.now()
        };
    }
}

export const outputLayer = new NKTgOutputLayer();

export async function handleOutputLayer(context) {
    try {
        Logger.log("[Step 8 Node] Output Generation Layer processing...", "info");
        if (!context.kernel) {
            throw new Error("Missing context.kernel data from Step 7.");
        }
        context.output = outputLayer.generateResponse(context);
        context.output.outputType = 'extraction';  // tag để step 9 biết render Não Trái
        Logger.log(
            `[Step 8 Output] State: ${context.output.state} | Compression: ${context.output.compressionRate}`,
            "success"
        );
        await handleDistributedSync(context);
    } catch (err) {
        Logger.log(`[Step 8 Fatal] Output generation failure: ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}
