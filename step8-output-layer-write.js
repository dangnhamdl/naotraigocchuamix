/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 8: OUTPUT WRITE LAYER (NÃO PHẢI) v4.0
 * ============================================================================
 * Não Phải — Addition mode
 *
 * Tư duy: Não Phải là mở rộng của Não Trái
 *   - Cùng thuật toán extractImportantSentences() — chỉ đổi tỉ lệ
 *   - Standard      → 0.382 (tham chiếu, output = Não Trái)
 *   - Expanded      → 0.618
 *   - Comprehensive → 1.0  (100% câu, gạch chân từ DAMPING phần mới)
 *
 * Comprehensive:
 *   - 100% câu giữ thứ tự gốc
 *   - Phần câu mới (ngoài 61.8%) → gạch chân từ DAMPING
 *   - Panel bên phải: tự động tra HF và hiện tất cả gợi ý synonym ngay sau render
 *   - KHÔNG thay vào văn bản
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';
import { fetchSynonyms } from './step8-wiki-search-write.js';

const KATEX_JS  = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js';
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
let katexLoaded = false;

async function ensureKaTeX() {
    if (katexLoaded) return;
    if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = KATEX_CSS;
        document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${KATEX_JS}"]`)) { resolve(); return; }
        const script = document.createElement('script');
        script.src = KATEX_JS;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('KaTeX load failed'));
        document.head.appendChild(script);
    });
    katexLoaded = true;
}

function renderSentence(el, sentence) {
    if (!window.katex) { el.textContent = sentence; return; }
    const parts = [];
    const regex = /(\$\$[\s\S]+?\$\$|\$[^\$\n]+?\$)/g;
    let last = 0, match;
    while ((match = regex.exec(sentence)) !== null) {
        if (match.index > last) parts.push({ type: 'text', content: sentence.slice(last, match.index) });
        const raw = match[0];
        const isBlock = raw.startsWith('$$');
        parts.push({ type: 'math', latex: isBlock ? raw.slice(2, -2) : raw.slice(1, -1), block: isBlock });
        last = match.index + raw.length;
    }
    if (last < sentence.length) parts.push({ type: 'text', content: sentence.slice(last) });
    if (parts.length === 0 || parts.every(p => p.type === 'text')) { el.textContent = sentence; return; }
    el.innerHTML = '';
    for (const part of parts) {
        if (part.type === 'text') {
            el.appendChild(document.createTextNode(part.content));
        } else {
            const mathEl = document.createElement(part.block ? 'div' : 'span');
            try { window.katex.render(part.latex, mathEl, { throwOnError: false, displayMode: part.block }); }
            catch { mathEl.textContent = part.block ? `$$${part.latex}$$` : `$${part.latex}$`; }
            el.appendChild(mathEl);
        }
    }
}

function countTokens(text) {
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu)?.length || 1;
}

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

// Tìm vị trí match đúng word boundary
function findWordMatch(text, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + escaped + '\\b', 'i');
    const match = regex.exec(text);
    return match ? { idx: match.index, len: match[0].length } : null;
}

// ============================================================================
// NKTg OUTPUT WRITE LAYER
// ============================================================================
class NKTgOutputWriteLayer {

    scoreSentenceByPhysics(sentence, tokenScores, targetState) {
        const lower = sentence.toLowerCase();
        let totalEnergy = 0, matchCount = 0;
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
            const isDup = result.some(k => this.similarity(k.sentence, candidate.sentence) > 0.5);
            if (!isDup) result.push(candidate);
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

    extractImportantSentences(sentenceScores, tokenScores, globalState, ampRatio, dampRatio, stableRatio, ratio) {
        // Comprehensive: lấy thẳng toàn bộ câu gốc, không score, không deduplicate
        if (ratio >= 1.0) {
            const all = Object.keys(sentenceScores);
            Logger.log(`[Step 8W Filter] Comprehensive — toàn bộ ${all.length} câu theo thứ tự gốc`, 'info');
            return all;
        }
        const totalSentences = Object.keys(sentenceScores).length;
        const totalKeep  = Math.ceil(totalSentences * ratio);
        const ampKeep    = Math.round(totalKeep * ampRatio);
        const dampKeep   = Math.round(totalKeep * dampRatio);
        const stableKeep = Math.max(0, totalKeep - ampKeep - dampKeep);
        const tierAmp    = this.filterLayer(sentenceScores, tokenScores, 'AMPLIFYING', ampKeep);
        const tierDamp   = this.filterLayer(sentenceScores, tokenScores, 'DAMPING',    dampKeep);
        const tierStable = this.filterLayer(sentenceScores, tokenScores, 'STABLE',     stableKeep);
        const allSelected = new Set([...tierAmp, ...tierDamp, ...tierStable]);
        const ordered = Object.keys(sentenceScores).filter(s => allSelected.has(s));
        Logger.log(
            `[Step 8W Filter] AMP: ${tierAmp.length}(keep=${ampKeep}) | DAMP: ${tierDamp.length}(keep=${dampKeep}) | STABLE: ${tierStable.length}(keep=${stableKeep}) | Tổng: ${ordered.length} | ratio: ${ratio}`,
            'info'
        );
        return ordered;
    }

    generateResponse(context, ratio = 0.382, baseSet = null) {
        const kernel         = context.kernel;
        const state          = kernel.state;
        const rawInput       = context.meta?.rawInput || '';
        const sentenceScores = kernel.sentenceScores  || {};
        const tokenScores    = kernel.tokenScores     || {};
        const ampRatio       = kernel.amplifying_ratio;
        const dampRatio      = kernel.damping_ratio;
        const stableRatio    = kernel.stable_ratio;
        const lang           = context.meta?.language || context.textMeta?.language || 'en';

        const sentences = this.extractImportantSentences(
            sentenceScores, tokenScores, state,
            ampRatio, dampRatio, stableRatio, ratio
        );

        const newSentenceSet = baseSet
            ? new Set(sentences.filter(s => !baseSet.has(s)))
            : new Set();

        const optimizedText = sentences.join(' ');
        const displaySentences = [];

        for (const sentence of sentences) {
            const isNew = newSentenceSet.has(sentence);
            const dampTokens = isNew
                ? Object.entries(tokenScores)
                    .filter(([token, data]) =>
                        data.state === 'DAMPING' &&
                        findWordMatch(sentence, token) !== null &&
                        !isProperNounW(token, sentence)
                    )
                    .map(([token]) => token)
                : [];

            const lines = sentence.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            for (let i = 0; i < lines.length; i++) {
                displaySentences.push({
                    text: lines[i],
                    dampTokens: i === 0 ? dampTokens : [],
                    isNew
                });
            }
        }

        const ampCount    = kernel.dominantTokens.length;
        const totalTokens = ampCount + (kernel.filteredTokens?.length || 0) + (kernel.stableTokens?.length || 0);
        let prefix = '';
        if (state === 'AMPLIFYING')   prefix = `Amplifying ${ampCount}/${totalTokens} tokens`;
        else if (state === 'DAMPING') prefix = `Damping ${kernel.filteredTokens?.length}/${totalTokens} tokens`;
        else                          prefix = `Stable ${kernel.stableTokens?.length}/${totalTokens} tokens`;

        return {
            sentences: displaySentences,
            response:  optimizedText,
            prefix, state, lang, tokenScores,
            originalLength:  rawInput.length,
            optimizedLength: optimizedText.length,
            expansionRate: rawInput.length > 0
                ? ((optimizedText.length / rawInput.length) * 100).toFixed(1) + '%'
                : '0%',
            dominantTokens: kernel.dominantTokens,
            filteredTokens: kernel.filteredTokens,
            stableTokens:   kernel.stableTokens,
            processedAt: Date.now()
        };
    }

    async renderToUI(output, mode = 'standard') {
        const panel = document.getElementById('outputPanel');
        if (!panel) return;
        panel.innerHTML = '';

        // Comprehensive: mở rộng full width giống Claude.ai
        const nav           = document.querySelector('.nktg-nav-desktop');
        const mainContainer = document.querySelector('.container');

        if (mode === 'comprehensive') {
            // Thu sidebar về 48px
            if (nav) {
                nav.style.width = '48px';
                nav.style.overflow = 'hidden';
                nav.querySelectorAll('.nav-item span:not(.nav-icon)').forEach(el => el.style.display = 'none');
            }
            document.body.style.paddingLeft = '48px';
            if (mainContainer) {
                mainContainer.style.maxWidth = '100%';
                mainContainer.style.padding = '0';
            }
        } else {
            // Restore sidebar
            if (nav) {
                nav.style.width = '';
                nav.style.overflow = '';
                nav.querySelectorAll('.nav-item span:not(.nav-icon)').forEach(el => el.style.display = '');
            }
            document.body.style.paddingLeft = '';
            if (mainContainer) {
                mainContainer.style.maxWidth = '';
                mainContainer.style.padding = '';
            }
        }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex; align-items:stretch; width:100%;';

        const container = document.createElement('div');
        container.style.cssText = `
            flex:1; min-width:0; background:var(--color-background-primary);
            border:0.5px solid var(--color-border-tertiary); border-radius:8px;
            overflow:hidden; font-family:'Segoe UI',sans-serif; color:var(--color-text-primary);
            display:flex; flex-direction:column;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `background:#f5f5f5; padding:12px 18px; border-bottom:1px solid #d1d5db; display:flex; align-items:center; gap:10px;`;
        const title = document.createElement('span');
        title.style.cssText = 'color:#4A9B2F; font-size:16px; font-weight:600;';
        title.textContent = 'NKTg Addition';
        const badgeColor = output.state === 'AMPLIFYING' ? '#1f6feb' : output.state === 'DAMPING' ? '#da3633' : '#238636';
        const badge = document.createElement('span');
        badge.style.cssText = `background:${badgeColor};color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;`;
        badge.textContent = output.state;
        const modeBadge = document.createElement('span');
        modeBadge.style.cssText = `background:#f0fdf4;color:#4A9B2F;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;border:1px solid #86efac;margin-left:auto;`;
        modeBadge.textContent = mode === 'standard' ? 'Refined' : mode === 'expanded' ? 'Expanded' : 'Comprehensive';
        header.appendChild(title); header.appendChild(badge); header.appendChild(modeBadge);
        container.appendChild(header);

        // Meta
        const meta = document.createElement('div');
        meta.style.cssText = `padding:10px 18px; border-bottom:1px solid #d1d5db; display:flex; gap:20px; flex-wrap:wrap; font-size:12px; color:#6b7280;`;
        for (const item of [
            { label: 'Analysis',  value: output.prefix },
            { label: 'Expansion', value: output.expansionRate },
            { label: 'Chars',     value: `${output.originalLength} → ${output.optimizedLength}` }
        ]) {
            const el = document.createElement('span');
            el.innerHTML = `<strong style="color:#1a1a1a">${item.label}:</strong> ${item.value}`;
            meta.appendChild(el);
        }
        container.appendChild(meta);

        // Body
        const responseWrap = document.createElement('div');
        responseWrap.style.cssText = 'padding:16px 18px;';
        try { await ensureKaTeX(); } catch { Logger.log('[Step 8W] KaTeX load failed.', 'warn'); }

        // Panel gợi ý bên phải — chỉ Comprehensive
        let suggestionPanel = null;
        if (mode === 'comprehensive') {
            suggestionPanel = document.createElement('div');
            suggestionPanel.style.cssText = `
                flex:1; min-width:0; background:var(--color-background-primary);
                border-left:0.5px solid var(--color-border-tertiary);
                font-family:'Segoe UI',sans-serif;
                display:flex; flex-direction:column;
                position:sticky; top:0; height:100%; max-height:100vh;
                align-self:stretch;
            `;
            const sugBodyOuter = document.createElement('div');
            sugBodyOuter.style.cssText = 'flex:1; overflow-y:auto;';
            const sugHeader = document.createElement('div');
            sugHeader.style.cssText = `background:var(--color-background-secondary); padding:10px 14px; border-bottom:0.5px solid var(--color-border-tertiary); font-weight:500; color:#4A9B2F; font-size:13px; flex-shrink:0;`;
            sugHeader.textContent = '💡 Gợi ý từ đồng nghĩa';
            const sugBody = document.createElement('div');
            sugBody.id = 'nktg-suggestion-body';
            sugBody.style.cssText = `padding:10px 14px; font-size:12px; color:var(--color-text-secondary); flex:1; overflow-y:auto;`;
            sugBody.textContent = 'Đang tải...';
            sugBodyOuter.appendChild(sugBody);
            suggestionPanel.appendChild(sugHeader);
            suggestionPanel.appendChild(sugBodyOuter);
        }

        // Render câu — thu thập tất cả dampTokens theo thứ tự xuất hiện
        const allDampTokens = [];
        const seenTokens = new Set();
        for (const item of output.sentences) {
            const p = document.createElement('p');
            p.style.cssText = `
                margin:0 0 8px 0; padding:4px 0;
                line-height:1.7; font-size:14px;
                color:var(--color-text-primary);
            `;
            if (item.dampTokens && item.dampTokens.length > 0) {
                this._renderWithUnderline(p, item.text, item.dampTokens);
                item.dampTokens.forEach(t => {
                    if (!seenTokens.has(t.toLowerCase())) {
                        seenTokens.add(t.toLowerCase());
                        allDampTokens.push(t);
                    }
                });
            } else {
                renderSentence(p, item.text);
            }
            responseWrap.appendChild(p);
        }
        container.appendChild(responseWrap);

        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = `padding:8px 12px; border-top:1px solid #d1d5db; display:flex; gap:6px; align-items:center; flex-wrap:nowrap;`;
        const btnStyle = `background:transparent; border:1px solid #d1d5db; border-radius:6px; color:#6b7280; font-size:11px; font-weight:500; padding:3px 8px; cursor:pointer; white-space:nowrap;`;

        const btnCopy = document.createElement('button');
        btnCopy.style.cssText = btnStyle; btnCopy.textContent = '⎘ Copy';
        btnCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(output.response).then(() => {
                btnCopy.textContent = '✓ Copied';
                setTimeout(() => { btnCopy.textContent = '⎘ Copy'; }, 1500);
            });
        });

        const btnExpanded = document.createElement('button');
        btnExpanded.style.cssText = btnStyle; btnExpanded.textContent = '⊕ Expanded';
        btnExpanded.disabled = mode === 'expanded' || mode === 'comprehensive';
        btnExpanded.addEventListener('click', () => outputWriteLayer._render(output._context, 0.618, 'expanded'));

        const btnComprehensive = document.createElement('button');
        btnComprehensive.style.cssText = btnStyle; btnComprehensive.textContent = '◉ Comprehensive';
        btnComprehensive.disabled = mode === 'comprehensive';
        btnComprehensive.addEventListener('click', () => outputWriteLayer._render(output._context, 1.0, 'comprehensive'));

        const btnScrollUp = document.createElement('button');
        btnScrollUp.style.cssText = btnStyle; btnScrollUp.textContent = '↑ Top';
        btnScrollUp.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

        footer.appendChild(btnCopy); footer.appendChild(btnExpanded);
        footer.appendChild(btnComprehensive); footer.appendChild(btnScrollUp);
        container.appendChild(footer);

        wrapper.appendChild(container);
        if (suggestionPanel) wrapper.appendChild(suggestionPanel);
        panel.appendChild(wrapper);
        panel.__nktgLastResponse = output.response;

        // Tự động tra từ điển tất cả từ gạch chân sau khi render
        if (mode === 'comprehensive' && allDampTokens.length > 0) {
            this._loadAllSuggestions(allDampTokens, output.lang, suggestionPanel);
        }
    }

    // Render câu với gạch chân từ DAMPING — dùng word boundary
    _renderWithUnderline(el, sentence, dampTokens) {
        const sorted = [...dampTokens]
            .map(token => { const m = findWordMatch(sentence, token); return m ? { token, idx: m.idx } : null; })
            .filter(t => t !== null)
            .sort((a, b) => a.idx - b.idx)
            .map(t => t.token);

        let remaining = sentence;
        const parts = [];
        for (const token of sorted) {
            const m = findWordMatch(remaining, token);
            if (!m) continue;
            if (m.idx > 0) parts.push({ type: 'text', content: remaining.slice(0, m.idx) });
            parts.push({ type: 'damp', content: remaining.slice(m.idx, m.idx + m.len), token });
            remaining = remaining.slice(m.idx + m.len);
        }
        if (remaining.length > 0) parts.push({ type: 'text', content: remaining });

        el.innerHTML = '';
        for (const part of parts) {
            if (part.type === 'text') {
                el.appendChild(document.createTextNode(part.content));
            } else {
                const span = document.createElement('span');
                span.textContent = part.content;
                span.dataset.token = part.token;
                span.style.cssText = `
                    text-decoration:underline; text-decoration-style:solid;
                    text-decoration-color:rgba(150,150,150,0.8); text-decoration-thickness:1.5px;
                    text-underline-offset:2px; cursor:pointer;
                `;
                span.addEventListener('click', () => {
                    const body = document.getElementById('nktg-suggestion-body');
                    if (!body) return;
                    const items = body.querySelectorAll('[data-token-id]');
                    items.forEach(item => {
                        if (item.dataset.tokenId === part.token) {
                            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            item.style.background = 'rgba(74,155,47,0.08)';
                            setTimeout(() => { item.style.background = ''; }, 1500);
                        }
                    });
                });
                el.appendChild(span);
            }
        }
    }

    // Tự động tra tất cả từ gạch chân → hiện bên phải như Citation panel
    // Tuần tự từng từ 1 — an toàn, không xung đột, không rate limit
    async _loadAllSuggestions(dampTokens, lang, suggestionPanel) {
        const body = suggestionPanel.querySelector('#nktg-suggestion-body');
        if (!body) return;
        body.innerHTML = '';

        // Tạo sẵn tất cả item với trạng thái loading
        const itemMap = {};
        for (const token of dampTokens) {
            const item = document.createElement('div');
            item.dataset.tokenId = token;
            item.style.cssText = `padding:8px 0; border-bottom:1px solid #f3f4f6; transition:background 0.3s;`;

            const tokenLabel = document.createElement('div');
            tokenLabel.style.cssText = `font-weight:600; color:#1a1a1a; font-size:12px; margin-bottom:4px;`;
            tokenLabel.textContent = `"${token}"`;
            item.appendChild(tokenLabel);

            const synWrap = document.createElement('div');
            synWrap.style.cssText = `display:flex; flex-wrap:wrap; gap:4px; color:#9ca3af; font-size:11px;`;
            synWrap.textContent = '...';
            item.appendChild(synWrap);
            body.appendChild(item);
            itemMap[token] = synWrap;
        }

        // Tuần tự từng từ 1
        for (const token of dampTokens) {
            const synWrap = itemMap[token];
            if (!synWrap) continue;
            try {
                const synonyms = await fetchSynonyms(token, lang);
                synWrap.innerHTML = '';
                if (!synonyms || synonyms.length === 0) {
                    synWrap.style.cssText = 'color:#9ca3af; font-size:11px;';
                    synWrap.textContent = 'Bạn có thể sử dụng vốn từ vựng của bạn để cân nhắc sửa chữa văn bản được tối ưu hơn.';
                    continue;
                }
                synWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px;';
                for (const syn of synonyms) {
                    const chip = document.createElement('span');
                    chip.textContent = syn;
                    chip.style.cssText = `display:inline-block; padding:1px 7px; background:#f0fdf4; border:1px solid #86efac; border-radius:10px; font-size:11px; color:#166534;`;
                    synWrap.appendChild(chip);
                }
                Logger.log(`[Step 8W] "${token}" → ${synonyms.length} synonym(s)`, 'info');
            } catch {
                synWrap.style.cssText = 'color:#9ca3af; font-size:11px;';
                synWrap.textContent = 'Lỗi tra từ điển';
            }
        }
    }

    async _render(context, ratio, mode) {
        const kernel         = context.kernel;
        const sentenceScores = kernel.sentenceScores || {};
        const tokenScores    = kernel.tokenScores    || {};
        const ampRatio       = kernel.amplifying_ratio;
        const dampRatio      = kernel.damping_ratio;
        const stableRatio    = kernel.stable_ratio;
        const state          = kernel.state;

        let baseSet = null;
        if (mode === 'comprehensive') {
            const expanded = this.extractImportantSentences(
                sentenceScores, tokenScores, state,
                ampRatio, dampRatio, stableRatio, 0.618
            );
            baseSet = new Set(expanded);
        }

        const output = this.generateResponse(context, ratio, baseSet);
        output._context = context;
        context.output = output;

        await this.renderToUI(output, mode);
        Logger.log(
            `[Step 8W Output] State: ${output.state} | Expansion: ${output.expansionRate} | Mode: ${mode}`,
            'success'
        );
    }
}

export const outputWriteLayer = new NKTgOutputWriteLayer();

export async function handleOutputLayerWrite(context) {
    try {
        Logger.log('[Step 8W Node] Output Write Layer (Não Phải) processing...', 'info');
        if (!context.kernel) throw new Error('Missing context.kernel data from Step 7.');

        await outputWriteLayer._render(context, 0.382, 'standard');

        await handleDistributedSync(context);
    } catch (err) {
        Logger.log(`[Step 8W Fatal] ${err.message}`, 'danger');
        setPipelineState('ERROR');
        unlockPipelineUI();
    }
}
