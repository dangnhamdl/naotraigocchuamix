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
import { setPipelineState, unlockPipelineUI, Logger, initializeNKTgQuery } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';

const KATEX_JS  = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js';
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';

let katexLoaded = false;

async function ensureKaTeX() {
    if (katexLoaded) return;
    if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = KATEX_CSS;
        document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${KATEX_JS}"]`)) { resolve(); return; }
        const script = document.createElement('script');
        script.src = KATEX_JS;
        script.onload  = () => resolve();
        script.onerror = () => reject(new Error('KaTeX load failed'));
        document.head.appendChild(script);
    });
    katexLoaded = true;
}

function renderSentence(el, sentence) {
    if (!window.katex) {
        el.textContent = sentence;
        return;
    }
    const parts = [];
    const regex = /(\$\$[\s\S]+?\$\$|\$[^\$\n]+?\$)/g;
    let last = 0;
    let match;
    while ((match = regex.exec(sentence)) !== null) {
        if (match.index > last) {
            parts.push({ type: 'text', content: sentence.slice(last, match.index) });
        }
        const raw = match[0];
        const isBlock = raw.startsWith('$$');
        const latex = isBlock ? raw.slice(2, -2) : raw.slice(1, -1);
        parts.push({ type: 'math', latex, block: isBlock });
        last = match.index + raw.length;
    }
    if (last < sentence.length) {
        parts.push({ type: 'text', content: sentence.slice(last) });
    }
    if (parts.length === 0 || parts.every(p => p.type === 'text')) {
        el.textContent = sentence;
        return;
    }
    el.innerHTML = '';
    for (const part of parts) {
        if (part.type === 'text') {
            el.appendChild(document.createTextNode(part.content));
        } else {
            const mathEl = document.createElement(part.block ? 'div' : 'span');
            try {
                window.katex.render(part.latex, mathEl, {
                    throwOnError: false,
                    displayMode: part.block
                });
            } catch {
                mathEl.textContent = part.block ? `$$${part.latex}$$` : `$${part.latex}$`;
            }
            el.appendChild(mathEl);
        }
    }
}

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

    async renderToUI(output) {
        const panel = document.getElementById('outputPanel');
        if (!panel) return;
        panel.innerHTML = '';

        const container = document.createElement('div');
        container.style.cssText = `
            background: #ffffff;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            overflow: hidden;
            font-family: 'Segoe UI', sans-serif;
            color: #1a1a1a;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            background: #f5f5f5;
            padding: 12px 18px;
            border-bottom: 1px solid #d1d5db;
            display: flex;
            align-items: center;
            gap: 10px;
        `;
        const title = document.createElement('span');
        title.style.cssText = 'color: #d97706; font-size: 16px; font-weight: 600;';
        title.textContent = 'NKTg INSIGHT';

        const badge = document.createElement('span');
        const badgeColor = output.state === 'AMPLIFYING' ? '#1f6feb' :
                           output.state === 'DAMPING' ? '#da3633' : '#238636';
        badge.style.cssText = `
            background: ${badgeColor};
            color: #fff;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
        `;
        badge.textContent = output.state;
        header.appendChild(title);
        header.appendChild(badge);
        container.appendChild(header);

        const meta = document.createElement('div');
        meta.style.cssText = `
            padding: 10px 18px;
            border-bottom: 1px solid #d1d5db;
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            font-size: 12px;
            color: #6b7280;
        `;

        const metaItems = [
            { label: 'Analysis', value: output.prefix },
            { label: 'Compression', value: output.compressionRate },
            { label: 'Chars', value: `${output.originalLength} → ${output.optimizedLength}` }
        ];

        for (const item of metaItems) {
            const el = document.createElement('span');
            el.innerHTML = `<strong style="color:#1a1a1a">${item.label}:</strong> ${item.value}`;
            meta.appendChild(el);
        }
        container.appendChild(meta);

        const responseWrap = document.createElement('div');
        responseWrap.style.cssText = 'padding: 16px 18px;';

        try {
            await ensureKaTeX();
        } catch {
            Logger.log('[Step 8] KaTeX load failed — fallback to plain text.', 'warn');
        }

        for (const sentence of output.sentences) {
            const p = document.createElement('p');
            p.style.cssText = `
                margin: 0 0 10px 0;
                padding: 10px 14px;
                background: #ffffff;
                border-left: 3px solid #d97706;
                border-radius: 0 6px 6px 0;
                line-height: 1.7;
                font-size: 14px;
            `;
            renderSentence(p, sentence);
            responseWrap.appendChild(p);
        }

        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 8px 12px;
            border-top: 1px solid #d1d5db;
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: nowrap;
        `;

        const btnStyle = `
            background: transparent;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            color: #6b7280;
            font-size: 11px;
            font-weight: 500;
            padding: 3px 8px;
            cursor: pointer;
            transition: border-color 0.2s, color 0.2s;
            white-space: nowrap;
        `;

        const btnCopy = document.createElement('button');
        btnCopy.style.cssText = btnStyle;
        btnCopy.textContent = '⎘ Copy';
        btnCopy.title = 'Copy kết quả';
        btnCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(output.response).then(() => {
                btnCopy.textContent = '✓ Copied';
                setTimeout(() => { btnCopy.textContent = '⎘ Copy'; }, 1500);
            });
        });

        const btnCondensed = document.createElement('button');
        btnCondensed.style.cssText = btnStyle;
        btnCondensed.textContent = '⌥ Condensed';
        btnCondensed.title = 'Nén thêm 1 vòng';
        btnCondensed.addEventListener('click', async () => {
            btnCondensed.disabled = true;
            btnCondensed.textContent = '...';
            Logger.log('[Step 8] Condensed: running recursion round 2...', 'info');
            await initializeNKTgQuery(output.response, 'text');
        });

        const btnEssence = document.createElement('button');
        btnEssence.style.cssText = btnStyle;
        btnEssence.textContent = '◈ Essence';
        btnEssence.title = 'Nén sâu 4 vòng tiếp theo (tổng 5)';
        btnEssence.addEventListener('click', async () => {
            btnEssence.disabled = true;
            btnEssence.textContent = '...';
            Logger.log('[Step 8] Essence: running recursion rounds 2→5...', 'info');
            let currentText = output.response;
            for (let i = 0; i < 4; i++) {
                Logger.log(`[Step 8] Essence round ${i + 2}/5...`, 'info');
                await initializeNKTgQuery(currentText, 'text');
                currentText = document.getElementById('outputPanel')?.__nktgLastResponse || currentText;
            }
        });

        const btnScrollUp = document.createElement('button');
        btnScrollUp.style.cssText = btnStyle;
        btnScrollUp.textContent = '↑ Top';
        btnScrollUp.title = 'Lên đầu trang';
        btnScrollUp.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        footer.appendChild(btnCopy);
        footer.appendChild(btnCondensed);
        footer.appendChild(btnEssence);
        footer.appendChild(btnScrollUp);
        container.appendChild(responseWrap);
        container.appendChild(footer);
        panel.appendChild(container);
        panel.__nktgLastResponse = output.response;
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
        await outputLayer.renderToUI(context.output);
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
