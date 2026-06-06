/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 8: OUTPUT WRITE LAYER (NÃO PHẢI) v1.0
 * ============================================================================
 * Não Phải — Addition mode
 *
 * Luồng:
 *   Step 7 → handleOutputLayerWrite(context)
 *   → generateBase(context)      — lấy 38.2% câu chuẩn (KHÔNG render, dùng nội bộ)
 *   → mixLayer(baseOutput)       — tầng mix (hiện tại: pass-through, sẽ mở rộng sau)
 *   → renderToUI(mixedOutput)    — render kết quả đã qua mix ra UI
 *
 * Tiêu chuẩn (chưa mix):
 *   Output giống hệt Não Trái — cùng 38.2% câu, cùng thuật toán NKTg
 *   Chỉ khác: title "NKTg WRITE", border xanh lá, nút Expanded/Comprehensive
 *
 * Placeholder buttons (logic mix sẽ bổ sung sau):
 *   ⊕ Expanded      — Vừa: thêm câu từ phần bị bỏ
 *   ◉ Comprehensive — Sâu: toàn bộ câu theo energy
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';

// ============================================================================
// SCORE SENTENCE — dùng trong optimization
// ============================================================================
function countTokensWiki(text) {
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu)?.length || 1;
}

function scoreSentenceAllWiki(sentence, tokenScores) {
    const lower = sentence.toLowerCase();
    let totalEnergy = 0;
    let matchCount  = 0;
    for (const [token, data] of Object.entries(tokenScores)) {
        if (lower.includes(token.toLowerCase())) {
            totalEnergy += Math.max(0, data.energy + 3);
            matchCount++;
        }
    }
    const wordCount = countTokensWiki(sentence);
    const density   = matchCount > 0 ? matchCount / wordCount : 0;
    return totalEnergy * density;
}

// ============================================================================
// HELPER — Phát hiện proper noun
// ============================================================================
function isProperNounW(token, sentence) {
    if (token === token.toLowerCase()) return false;
    const idx = sentence.indexOf(token);
    if (idx === -1) return false;
    const before = sentence.slice(0, idx).trimEnd();
    if (before.length === 0) return false;
    const lastChar = before[before.length - 1];
    if (['.', '!', '?', '"', "'", '\n'].includes(lastChar)) return false;
    return /^[A-Z]/.test(token);
}

// ============================================================================
// HELPER — Lọc synonyms
// ============================================================================
function filterSynonymsW(synonyms, originalToken) {
    return synonyms.filter(syn => {
        if (!syn) return false;
        if (syn.includes(' ') || syn.includes('-')) return false;
        if (syn.toLowerCase() === originalToken.toLowerCase()) return false;
        if (syn.length < 2) return false;
        return true;
    });
}

// ============================================================================
// TỐI ƯU 1 CÂU — tính toán, phân loại Expanded/Comprehensive
// ============================================================================
async function optimizeSentenceW(sentence, tokenScores, lang) {
    const dampTokens = Object.entries(tokenScores)
        .filter(([token, data]) =>
            data.state === 'DAMPING' &&
            sentence.toLowerCase().includes(token.toLowerCase()) &&
            !isProperNounW(token, sentence)
        )
        .map(([token]) => token);

    if (dampTokens.length === 0) return null;

    const originalScore   = scoreSentenceAllWiki(sentence, tokenScores);
    let currentSentence   = sentence;
    let currentScore      = originalScore;
    const replacements    = []; // câu score tăng — Expanded
    const allReplacements = []; // tất cả synonym tìm được — Comprehensive

    for (const dampToken of dampTokens) {
        const rawSynonyms = await fetchSynonyms(dampToken, lang);
        const synonyms    = filterSynonymsW(rawSynonyms, dampToken);

        if (synonyms.length === 0) {
            Logger.log(`[Wiki Optimize] "${dampToken}" → no synonyms after filter, skip`, 'info');
            continue;
        }

        // Tìm synonym tốt nhất theo score
        let bestSentence = currentSentence;
        let bestScore    = currentScore;
        let bestSynonym  = null;

        for (const synonym of synonyms) {
            const regex = new RegExp(
                '\\b' + dampToken.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b',
                'gi'
            );
            const trySentence = currentSentence.replace(regex, synonym);
            const tryScore    = scoreSentenceAllWiki(trySentence, tokenScores);
            if (tryScore > bestScore) {
                bestScore    = tryScore;
                bestSentence = trySentence;
                bestSynonym  = synonym;
            }
        }

        if (bestScore > currentScore && bestSynonym) {
            Logger.log(
                `[Wiki Optimize] "${dampToken}" → score ${currentScore.toFixed(4)} → ${bestScore.toFixed(4)}`,
                'success'
            );
            replacements.push({ original: dampToken, replacement: bestSynonym });
            allReplacements.push({ original: dampToken, replacement: bestSynonym });
            currentSentence = bestSentence;
            currentScore    = bestScore;
        } else {
            // Lưu lại synonym tốt nhất dù score không tăng — dùng cho Comprehensive
            const fallbackSyn = synonyms[0];
            if (fallbackSyn) allReplacements.push({ original: dampToken, replacement: fallbackSyn });
            Logger.log(`[Wiki Optimize] "${dampToken}" → no improvement`, 'info');
        }
    }

    // Expanded: chỉ câu score tăng
    const improvedResult = currentScore > originalScore ? {
        sentence: currentSentence,
        originalSentence: sentence,
        score: currentScore,
        replacements
    } : null;

    // Comprehensive: tất cả synonym hợp lệ
    let comprehensiveSentence = sentence;
    for (const { original, replacement } of allReplacements) {
        const regex = new RegExp(
            '\\b' + original.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b',
            'gi'
        );
        comprehensiveSentence = comprehensiveSentence.replace(regex, replacement);
    }

    const comprehensiveResult = allReplacements.length > 0 ? {
        sentence: comprehensiveSentence,
        originalSentence: sentence,
        score: scoreSentenceAllWiki(comprehensiveSentence, tokenScores),
        replacements: allReplacements
    } : null;

    return { improvedResult, comprehensiveResult };
}

// ============================================================================
// TỐI ƯU TOÀN BỘ CÂU BỊ LOẠI
// ============================================================================
export async function optimizeRejectedSentencesW(base) {
    const { baseSentences, sentenceScores, tokenScores } = base;
    const lang = base.lang || 'en';

    const rejectedSentences = Object.keys(sentenceScores)
        .filter(s => !baseSentences.includes(s));

    Logger.log(`[Wiki Search] Bắt đầu tối ưu ${rejectedSentences.length} câu bị bỏ...`, 'info');

    const optimizedPool     = [];
    const comprehensivePool = [];

    for (let i = 0; i < rejectedSentences.length; i++) {
        const sentence = rejectedSentences[i];
        Logger.log(
            `[Wiki Search] Câu ${i + 1}/${rejectedSentences.length}: "${sentence.slice(0, 50)}..."`,
            'info'
        );

        const result = await optimizeSentenceW(sentence, tokenScores, lang);
        if (!result) { Logger.log(`[Wiki Search] ✗ Câu ${i + 1} bị loại`, 'info'); continue; }

        const { improvedResult, comprehensiveResult } = result;

        if (improvedResult) {
            optimizedPool.push(improvedResult);
            Logger.log(`[Wiki Search] ✓ Câu ${i + 1} → optimizedPool (${optimizedPool.length})`, 'success');
        }
        if (comprehensiveResult) {
            comprehensivePool.push(comprehensiveResult);
        }
        if (!improvedResult && !comprehensiveResult) {
            Logger.log(`[Wiki Search] ✗ Câu ${i + 1} bị loại`, 'info');
        }
    }

    Logger.log(
        `[Wiki Search] Hoàn tất: ${optimizedPool.length} improved | ${comprehensivePool.length} comprehensive`,
        'success'
    );

    return { optimizedPool, comprehensivePool };
}
import { fetchSynonyms } from './step8-wiki-search-write.js';


// ============================================================================
// NKTg OUTPUT WRITE LAYER
// ============================================================================
class NKTgOutputWriteLayer {

    // ------------------------------------------------------------------
    // Chấm điểm câu — KHÔNG filter theo targetState
    // Não Phải tính tổng energy mọi token trong câu (AMP+DAMP+STABLE)
    // ------------------------------------------------------------------
    scoreSentenceAll(sentence, tokenScores) {
        const lower = sentence.toLowerCase();
        let totalEnergy = 0;
        let matchCount = 0;
        for (const [token, data] of Object.entries(tokenScores)) {
            if (lower.includes(token.toLowerCase())) {
                totalEnergy += Math.max(0, data.energy + 3);
                matchCount++;
            }
        }
        const wordCount = countTokens(sentence);
        const density = matchCount > 0 ? matchCount / wordCount : 0;
        return totalEnergy * density;
    }

    // Dùng lại cho Não Trái compatibility — filter theo targetState
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

    // ------------------------------------------------------------------
    // generateBase — 61.8.% câu chuẩn, y hệt Não Trái chỉ khác tỷ lệ
    // Kết quả nội bộ — KHÔNG render trực tiếp
    // ------------------------------------------------------------------
    generateBase(context) {
        const kernel = context.kernel;
        const state  = kernel.state;
        const rawInput       = context.meta?.rawInput || '';
        const sentenceScores = kernel.sentenceScores || {};
        const tokenScores    = kernel.tokenScores    || {};
        const ampRatio    = kernel.amplifying_ratio;
        const dampRatio   = kernel.damping_ratio;
        const stableRatio = kernel.stable_ratio;

        const totalSentences = Object.keys(sentenceScores).length;
        const totalKeep  = Math.ceil(totalSentences * 0.618);
        const ampKeep    = Math.round(totalKeep * ampRatio);
        const dampKeep   = Math.round(totalKeep * dampRatio);
        const stableKeep = Math.max(0, totalKeep - ampKeep - dampKeep);

        const tierAmp    = this.filterLayer(sentenceScores, tokenScores, 'AMPLIFYING', ampKeep);
        const tierDamp   = this.filterLayer(sentenceScores, tokenScores, 'DAMPING',    dampKeep);
        const tierStable = this.filterLayer(sentenceScores, tokenScores, 'STABLE',     stableKeep);

        const allSelected = new Set([...tierAmp, ...tierDamp, ...tierStable]);
        const baseSentences = Object.keys(sentenceScores).filter(s => allSelected.has(s));

        Logger.log(
            `[Step 8W Base] AMP: ${tierAmp.length}(keep=${ampKeep}) | DAMP: ${tierDamp.length}(keep=${dampKeep}) | STABLE: ${tierStable.length}(keep=${stableKeep}) | Tổng: ${baseSentences.length}`,
            'info'
        );

        const ampCount    = kernel.dominantTokens.length;
        const totalTokens = ampCount +
            (kernel.filteredTokens?.length || 0) +
            (kernel.stableTokens?.length   || 0);

        let prefix = '';
        if (state === 'AMPLIFYING') prefix = `Amplifying ${ampCount}/${totalTokens} tokens`;
        else if (state === 'DAMPING') prefix = `Damping ${kernel.filteredTokens?.length}/${totalTokens} tokens`;
        else prefix = `Stable ${kernel.stableTokens?.length}/${totalTokens} tokens`;

        return {
            baseSentences,          // nội bộ — tầng mix dùng
            sentenceScores,         // nội bộ — tầng mix dùng
            tokenScores,            // nội bộ — tầng mix dùng
            rawInput,
            state,
            prefix,
            ampRatio,
            dampRatio,
            stableRatio,
            lang: context.textMeta?.language || 'en',  // cho Wiki search
            dominantTokens: kernel.dominantTokens,
            filteredTokens: kernel.filteredTokens,
            stableTokens:   kernel.stableTokens,
            processedAt: Date.now()
        };
    }

    // ------------------------------------------------------------------
    // mixLayer — tầng trung gian
    // standard    : baseSentences (pass-through)
    // expanded    : baseSentences + optimizedPool (câu bị bỏ đã tối ưu)
    // comprehensive: baseSentences + tất cả optimizedPool, giữ thứ tự gốc
    // ------------------------------------------------------------------
    mixLayer(base, mixMode = 'standard', optimizedPool = []) {
        let selectedSentences;

        if (mixMode === 'standard' || optimizedPool.length === 0) {
            // standard: dùng nguyên baseSentences
            selectedSentences = base.baseSentences;

        } else if (mixMode === 'expanded') {
            // expanded: base + toàn bộ optimizedPool (score tăng), giữ thứ tự gốc
            const allSelected = new Set([
                ...base.baseSentences,
                ...optimizedPool.map(p => p.originalSentence)
            ]);
            selectedSentences = Object.keys(base.sentenceScores).filter(s => allSelected.has(s));

        } else if (mixMode === 'comprehensive') {
            // comprehensive: base + toàn bộ optimizedPool, giữ thứ tự gốc
            // dùng originalSentence — key trong sentenceScores
            const allSelected = new Set([
                ...base.baseSentences,
                ...optimizedPool.map(p => p.originalSentence)
            ]);
            selectedSentences = Object.keys(base.sentenceScores).filter(s => allSelected.has(s));
        } else {
            selectedSentences = base.baseSentences;
        }

        const optimizedText = selectedSentences.join(' ');

        // Build optimizedPool lookup: originalSentence → { newSentence, replacements }
        // item.originalSentence = câu gốc (key trong sentenceScores)
        // item.sentence         = câu đã thay từ (dùng để render)
        const poolMap = new Map();
        for (const item of optimizedPool) {
            if (item.originalSentence && item.replacements && item.replacements.length > 0) {
                poolMap.set(item.originalSentence, {
                    newSentence: item.sentence,
                    replacements: item.replacements
                });
            }
        }

        // displaySentences: [{ text, replacements }]
        // text: câu đã thay (nếu có optimize) hoặc câu gốc
        // replacements: [] hoặc danh sách từ được thay để highlight
        const displaySentences = [];
        for (const sentence of selectedSentences) {
            const poolItem = poolMap.get(sentence);
            const displayText = poolItem ? poolItem.newSentence : sentence;
            const repls       = poolItem ? poolItem.replacements : [];
            const lines = displayText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            for (let i = 0; i < lines.length; i++) {
                displaySentences.push({ text: lines[i], replacements: i === 0 ? repls : [] });
            }
        }

        return {
            sentences:      displaySentences,
            response:       optimizedText,
            prefix:         base.prefix,
            state:          base.state,
            mixMode,
            originalLength:  base.rawInput.length,
            optimizedLength: optimizedText.length,
            expansionRate: base.rawInput.length > 0
                ? ((optimizedText.length / base.rawInput.length) * 100).toFixed(1) + '%'
                : '0%',
            dominantTokens: base.dominantTokens,
            filteredTokens: base.filteredTokens,
            stableTokens:   base.stableTokens,
            processedAt: Date.now()
        };
    }
}

export const outputWriteLayer = new NKTgOutputWriteLayer();

export async function handleOutputLayerWrite(context) {
    try {
        Logger.log('[Step 8W Node] Output Write Layer (Não Phải) processing...', 'info');
        if (!context.kernel) {
            throw new Error('Missing context.kernel data from Step 7.');
        }

        // Bước 1: lấy 61.8% câu chuẩn — nội bộ, không render
        const base = outputWriteLayer.generateBase(context);
        Logger.log('[Step 8W] Base generated — passing to mix layer...', 'info');

        // Bước 2: mix layer (tiêu chuẩn = pass-through)
        context.output = outputWriteLayer.mixLayer(base, 'standard');
        context.output._base = base;  // giữ base để nút Expanded/Comprehensive dùng

        // Bước 3: tag outputType để step 9 render đúng UI
        context.output.outputType = 'addition';

        Logger.log(
            `[Step 8W Output] State: ${context.output.state} | Expansion: ${context.output.expansionRate} | Mode: ${context.output.mixMode}`,
            'success'
        );

        await handleDistributedSync(context);
    } catch (err) {
        Logger.log(`[Step 8W Fatal] ${err.message}`, 'danger');
        setPipelineState('ERROR');
        unlockPipelineUI();
    }
}
