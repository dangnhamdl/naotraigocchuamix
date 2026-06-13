/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 8: OUTPUT WRITE LAYER (NÃO PHẢI) v2.0
 * ============================================================================
 * Não Phải — Addition mode
 *
 * Base: giống hệt não trái (step8-output-layer.js) đến phần generateResponse
 * Chỉ khác:
 *   - Title "NKTg Addition", border xanh lá #4A9B2F
 *   - Nút footer: Copy / Refined / Expanded / Comprehensive / Top
 *   - Refined  (38.2%): đóng băng, không gạch chân
 *   - Expanded (61.8%): không gạch chân
 *   - Comprehensive (100%): gạch chân token DAMPING phần ngoài 61.8%
 *     → click từ gạch chân → Popover fallback text theo ngôn ngữ
 *
 * v17: wordCount dùng Universal tokenizer — đúng với CJK/RTL/Devanagari
 * v18: Bỏ convertLatexToText() — dùng KaTeX 0.16.21 render công thức
 * v2.0: Bỏ toàn bộ wiki/synonym logic — thuần trích xuất + gạch chân DAMPING
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';

// ============================================================================
// KaTeX
// ============================================================================
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
            try {
                window.katex.render(part.latex, mathEl, { throwOnError: false, displayMode: part.block });
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

// ============================================================================
// FALLBACK TEXT — đa ngôn ngữ (Popover Comprehensive)
// ============================================================================
const FALLBACK_TEXT = {
    vi: 'Bạn có thể dùng vốn từ vựng của bạn để cân nhắc sửa chữa văn bản được tối ưu hơn.',
    en: 'You may use your own vocabulary to consider optimizing the text.',
    zh: '您可以使用自己的词汇来考虑优化文本。',
    ja: '自分の語彙を使ってテキストを最適化することを検討してください。',
    ko: '자신의 어휘를 사용하여 텍스트를 최적화하는 것을 고려해 보세요.',
    fr: 'Vous pouvez utiliser votre propre vocabulaire pour envisager d\'optimiser le texte.',
    de: 'Sie können Ihren eigenen Wortschatz nutzen, um den Text zu optimieren.',
    es: 'Puedes usar tu propio vocabulario para considerar optimizar el texto.',
    pt: 'Você pode usar seu próprio vocabulário para considerar otimizar o texto.',
    it: 'Puoi usare il tuo vocabolario per considerare di ottimizzare il testo.',
    ru: 'Вы можете использовать свой словарный запас для оптимизации текста.',
    ar: 'يمكنك استخدام مفرداتك الخاصة للنظر في تحسين النص.',
    fa: 'می‌توانید از واژگان خود برای بهینه‌سازی متن استفاده کنید.',
    hi: 'आप पाठ को अनुकूलित करने के लिए अपनी शब्दावली का उपयोग कर सकते हैं।',
    he: 'תוכל להשתמש במילים שלך כדי לשקול לייעל את הטקסט.',
    pl: 'Możesz użyć własnego słownictwa, aby rozważyć optymalizację tekstu.',
    nl: 'Je kunt je eigen woordenschat gebruiken om de tekst te optimaliseren.',
    tr: 'Metni optimize etmek için kendi kelime dağarcığınızı kullanabilirsiniz.',
    sv: 'Du kan använda ditt eget ordförråd för att överväga att optimera texten.',
    el: 'Μπορείτε να χρησιμοποιήσετε το δικό σας λεξιλόγιο για να βελτιστοποιήσετε το κείμενο.',
    uk: 'Ви можете використовувати свій словниковий запас для оптимізації тексту.',
};

function getFallbackText(lang) {
    return FALLBACK_TEXT[lang] || FALLBACK_TEXT['en'];
}

// ============================================================================
// POPOVER — mobile + desktop (giống dictionary lookup)
// ============================================================================
function isMobile() {
    return window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

function showPopover(spanEl, token, lang) {
    hidePopover();
    const popW = isMobile() ? 260 : 300;

    const pop = document.createElement('div');
    pop.id = 'nktg-popover';
    pop.style.cssText = `
        position:absolute; z-index:9999;
        background:#fff; border:1px solid #e5e7eb;
        border-radius:10px; padding:10px 12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.13);
        width:${popW}px;
        font-family:'Segoe UI',sans-serif;
    `;

    const label = document.createElement('div');
    label.style.cssText = 'font-weight:700; font-size:13px; color:#1a1a1a; margin-bottom:7px;';
    label.textContent = `"${token}"`;
    pop.appendChild(label);

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:11px; color:#9ca3af; line-height:1.5;';
    msg.textContent = getFallbackText(lang);
    pop.appendChild(msg);

    document.body.appendChild(pop);

    // Highlight span
    spanEl.dataset.popoverActive = '1';
    spanEl.style.background = 'rgba(74,155,47,0.15)';
    spanEl.style.borderRadius = '3px';
    spanEl.style.textDecoration = 'none';
    spanEl.style.outline = '1.5px solid #4A9B2F';

    // Position — flip up/down tự động
    const rect   = spanEl.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const popH   = pop.offsetHeight || 80;

    const top = (rect.top - popH - 12 >= 8)
        ? scrollY + rect.top - popH - 12
        : scrollY + rect.bottom + 12;
    let left = scrollX + rect.left + rect.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));

    pop.style.top  = `${top}px`;
    pop.style.left = `${left}px`;

    // Đóng khi click/tap ngoài
    const onOutside = (e) => {
        if (!pop.contains(e.target) && e.target !== spanEl) {
            hidePopover();
            document.removeEventListener('touchstart', onOutside, true);
            document.removeEventListener('mousedown',  onOutside, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('touchstart', onOutside, true);
        document.addEventListener('mousedown',  onOutside, true);
    }, 0);
}

function hidePopover() {
    const existing = document.getElementById('nktg-popover');
    if (existing) existing.remove();
    document.querySelectorAll('[data-popover-active="1"]').forEach(el => {
        el.removeAttribute('data-popover-active');
        el.style.background = '';
        el.style.borderRadius = '';
        el.style.outline = '';
        el.style.textDecoration = 'underline';
        el.style.textDecorationStyle = 'solid';
        el.style.textDecorationColor = 'rgba(150,150,150,0.8)';
        el.style.textDecorationThickness = '1.5px';
    });
}

// ============================================================================
// RENDER CÂU CÓ GẠCH CHÂN DAMPING — chỉ dùng cho Comprehensive (phần ngoài 61.8%)
// ============================================================================
function findWordMatch(text, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i').exec(text);
    return match ? { idx: match.index, len: match[0].length } : null;
}

function renderSentenceWithDamp(el, sentence, dampTokens, lang) {
    // Sắp xếp token theo vị trí xuất hiện trong câu
    const sorted = dampTokens
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
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                showPopover(span, part.token, lang);
            });
            el.appendChild(span);
        }
    }
}

// ============================================================================
// CLASS — giống hệt não trái, chỉ thêm mixLayer
// ============================================================================
class NKTgOutputWriteLayer {

    // Giống hệt não trái
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

    // Giống hệt não trái
    similarity(a, b) {
        const setA = new Set(a.toLowerCase().split(/\s+/));
        const setB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = [...setA].filter(w => setB.has(w)).length;
        const union = new Set([...setA, ...setB]).size;
        return union > 0 ? intersection / union : 0;
    }

    // Giống hệt não trái
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

    // Giống hệt não trái
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

    // Giống hệt não trái — 38.2%
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
            `[Step 8W Filter] AMP: ${tierAmp.length}(keep=${ampKeep}) | DAMP: ${tierDamp.length}(keep=${dampKeep}) | STABLE: ${tierStable.length}(keep=${stableKeep}) | Tổng: ${ordered.length} | ratio: 0.382`,
            'info'
        );
        return ordered;
    }

    // Giống hệt não trái — generateResponse trả về base (38.2%)
    generateBase(context) {
        const kernel = context.kernel;
        const state  = kernel.state;
        const rawInput = context.meta?.rawInput || '';
        const sentenceScores = kernel.sentenceScores || {};
        const tokenScores    = kernel.tokenScores    || {};
        const ampRatio    = kernel.amplifying_ratio;
        const dampRatio   = kernel.damping_ratio;
        const stableRatio = kernel.stable_ratio;

        const baseSentences = this.extractImportantSentences(
            sentenceScores, tokenScores, state,
            ampRatio, dampRatio, stableRatio
        );

        const ampCount    = kernel.dominantTokens.length;
        const totalTokens = ampCount +
            (kernel.filteredTokens?.length || 0) +
            (kernel.stableTokens?.length   || 0);

        let prefix = '';
        if (state === 'AMPLIFYING') {
            prefix = `Amplifying ${ampCount}/${totalTokens} tokens`;
        } else if (state === 'DAMPING') {
            prefix = `Damping ${kernel.filteredTokens?.length}/${totalTokens} tokens`;
        } else {
            prefix = `Stable ${kernel.stableTokens?.length}/${totalTokens} tokens`;
        }

        return {
            baseSentences,
            sentenceScores,
            tokenScores,
            ampRatio,
            dampRatio,
            stableRatio,
            state,
            prefix,
            rawInput,
            lang: context.textMeta?.language || 'en',
            dominantTokens: kernel.dominantTokens,
            filteredTokens: kernel.filteredTokens,
            stableTokens:   kernel.stableTokens,
        };
    }

    // ============================================================================
    // MIX LAYER — não phải thêm vào so với não trái
    // Refined (38.2%): dùng baseSentences
    // Expanded (61.8%): tính lại theo cùng logic, ratio 0.618
    // Comprehensive (100%): toàn bộ câu theo thứ tự gốc
    // ============================================================================
    mixLayer(base, mixMode = 'standard') {
        const allSentences = Object.keys(base.sentenceScores);
        let selectedSentences;

        if (mixMode === 'standard') {
            selectedSentences = base.baseSentences;

        } else if (mixMode === 'expanded') {
            const totalKeep  = Math.ceil(allSentences.length * 0.618);
            const ampKeep    = Math.round(totalKeep * base.ampRatio);
            const dampKeep   = Math.round(totalKeep * base.dampRatio);
            const stableKeep = Math.max(0, totalKeep - ampKeep - dampKeep);
            const tierAmp    = this.filterLayer(base.sentenceScores, base.tokenScores, 'AMPLIFYING', ampKeep);
            const tierDamp   = this.filterLayer(base.sentenceScores, base.tokenScores, 'DAMPING',    dampKeep);
            const tierStable = this.filterLayer(base.sentenceScores, base.tokenScores, 'STABLE',     stableKeep);
            const selected   = new Set([...tierAmp, ...tierDamp, ...tierStable]);
            selectedSentences = allSentences.filter(s => selected.has(s));
            Logger.log(
                `[Step 8W Filter] AMP: ${tierAmp.length}(keep=${ampKeep}) | DAMP: ${tierDamp.length}(keep=${dampKeep}) | STABLE: ${tierStable.length}(keep=${stableKeep}) | Tổng: ${selectedSentences.length} | ratio: 0.618`,
                'info'
            );

        } else if (mixMode === 'comprehensive') {
            selectedSentences = allSentences;
            Logger.log(`[Step 8W Filter] Comprehensive — toàn bộ ${allSentences.length} câu theo thứ tự gốc`, 'info');
        } else {
            selectedSentences = base.baseSentences;
        }

        // expandedSet: 61.8% đóng băng — dùng để xác định câu nào cần gạch chân
        const expandedTotalKeep  = Math.ceil(allSentences.length * 0.618);
        const expandedAmpKeep    = Math.round(expandedTotalKeep * base.ampRatio);
        const expandedDampKeep   = Math.round(expandedTotalKeep * base.dampRatio);
        const expandedStableKeep = Math.max(0, expandedTotalKeep - expandedAmpKeep - expandedDampKeep);
        const expAmp    = this.filterLayer(base.sentenceScores, base.tokenScores, 'AMPLIFYING', expandedAmpKeep);
        const expDamp   = this.filterLayer(base.sentenceScores, base.tokenScores, 'DAMPING',    expandedDampKeep);
        const expStable = this.filterLayer(base.sentenceScores, base.tokenScores, 'STABLE',     expandedStableKeep);
        const expandedSet = new Set([...expAmp, ...expDamp, ...expStable]);

        const optimizedText = selectedSentences.join(' ');
        const displaySentences = [];
        for (const sentence of selectedSentences) {
            const lines = sentence.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            for (const line of lines) {
                displaySentences.push({ text: line, originalSentence: sentence });
            }
        }

        return {
            sentences:      displaySentences,
            response:       optimizedText,
            prefix:         base.prefix,
            state:          base.state,
            mixMode,
            expandedSet,                  // 61.8% đóng băng
            lang:           base.lang,
            tokenScores:    base.tokenScores,
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

        // Header
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
        title.style.cssText = 'color: #4A9B2F; font-size: 15px; font-weight: 500;';
        title.textContent = 'NKTg Addition';

        const badge = document.createElement('span');
        const badgeColor = output.state === 'AMPLIFYING' ? '#1f6feb' :
                           output.state === 'DAMPING'    ? '#da3633' : '#238636';
        badge.style.cssText = `
            background: ${badgeColor};
            color: #fff; font-size: 11px; font-weight: 600;
            padding: 2px 8px; border-radius: 12px;
        `;
        badge.textContent = output.state;

        const modeBadge = document.createElement('span');
        modeBadge.style.cssText = `
            background: #f0fdf4; color: #4A9B2F;
            font-size: 11px; font-weight: 600;
            padding: 2px 8px; border-radius: 12px;
            border: 1px solid #86efac; margin-left: auto;
        `;
        modeBadge.textContent = output.mixMode === 'standard'     ? 'Refined' :
                                output.mixMode === 'expanded'     ? 'Expanded' : 'Comprehensive';

        header.appendChild(title);
        header.appendChild(badge);
        header.appendChild(modeBadge);
        container.appendChild(header);

        // Meta
        const meta = document.createElement('div');
        meta.style.cssText = `
            padding: 10px 18px; border-bottom: 1px solid #d1d5db;
            display: flex; gap: 20px; flex-wrap: wrap;
            font-size: 12px; color: #6b7280;
        `;
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

        // Content
        const responseWrap = document.createElement('div');
        responseWrap.style.cssText = 'padding: 16px 18px;';

        try { await ensureKaTeX(); } catch {
            Logger.log('[Step 8W] KaTeX load failed — fallback to plain text.', 'warn');
        }

        for (const item of output.sentences) {
            const text             = item.text;
            const originalSentence = item.originalSentence;
            // Gạch chân chỉ khi: Comprehensive + câu nằm ngoài 61.8%
            const isNew = output.mixMode === 'comprehensive' &&
                          output.expandedSet &&
                          !output.expandedSet.has(originalSentence);

            const p = document.createElement('p');
            p.style.cssText = `
                margin: 0 0 10px 0; padding: 10px 14px;
                background: #ffffff;
                border-left: 3px solid #4A9B2F;
                border-radius: 0 6px 6px 0;
                line-height: 1.7; font-size: 14px;
            `;

            if (isNew && output.tokenScores) {
                const validDamp = Object.entries(output.tokenScores)
                    .filter(([token, data]) => data.state === 'DAMPING' && findWordMatch(text, token) !== null)
                    .map(([token]) => token);
                if (validDamp.length > 0) {
                    renderSentenceWithDamp(p, text, validDamp, output.lang);
                } else {
                    renderSentence(p, text);
                }
            } else {
                renderSentence(p, text);
            }
            responseWrap.appendChild(p);
        }

        // Footer
        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 8px 12px; border-top: 1px solid #d1d5db;
            display: flex; gap: 6px; align-items: center; flex-wrap: nowrap;
        `;

        const btnStyle = `
            background: transparent; border: 1px solid #d1d5db;
            border-radius: 6px; color: #6b7280;
            font-size: 11px; font-weight: 500;
            padding: 3px 8px; cursor: pointer;
            transition: border-color 0.2s, color 0.2s;
            white-space: nowrap;
        `;

        // Copy
        const btnCopy = document.createElement('button');
        btnCopy.style.cssText = btnStyle;
        btnCopy.textContent = '⎘ Copy';
        btnCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(output.response).then(() => {
                btnCopy.textContent = '✓ Copied';
                setTimeout(() => { btnCopy.textContent = '⎘ Copy'; }, 1500);
            });
        });

        const activeStyle = `
            background: #f0fdf4; border: 1px solid #4A9B2F;
            border-radius: 6px; color: #4A9B2F;
            font-size: 11px; font-weight: 600;
            padding: 3px 8px; cursor: default;
            white-space: nowrap;
        `;

        // Refined
        const btnRefined = document.createElement('button');
        btnRefined.style.cssText = output.mixMode === 'standard' ? activeStyle : btnStyle;
        btnRefined.textContent = '⊙ Refined';
        btnRefined.disabled = output.mixMode === 'standard';
        btnRefined.addEventListener('click', async () => {
            btnRefined.disabled = true;
            btnRefined.textContent = '...';
            try {
                const mixed = outputWriteLayer.mixLayer(output._base, 'standard');
                mixed._base = output._base;
                await outputWriteLayer.renderToUI(mixed);
            } catch (err) {
                Logger.log(`[Step 8W] Refined error: ${err.message}`, 'danger');
                btnRefined.disabled = false;
                btnRefined.textContent = '⊙ Refined';
            }
        });

        // Expanded
        const btnExpanded = document.createElement('button');
        btnExpanded.style.cssText = output.mixMode === 'expanded' ? activeStyle : btnStyle;
        btnExpanded.textContent = '⊕ Expanded';
        btnExpanded.disabled = output.mixMode === 'expanded';
        btnExpanded.addEventListener('click', async () => {
            btnExpanded.disabled = true;
            btnExpanded.textContent = '...';
            try {
                const mixed = outputWriteLayer.mixLayer(output._base, 'expanded');
                mixed._base = output._base;
                await outputWriteLayer.renderToUI(mixed);
            } catch (err) {
                Logger.log(`[Step 8W] Expanded error: ${err.message}`, 'danger');
                btnExpanded.disabled = false;
                btnExpanded.textContent = '⊕ Expanded';
            }
        });

        // Comprehensive
        const btnComprehensive = document.createElement('button');
        btnComprehensive.style.cssText = output.mixMode === 'comprehensive' ? activeStyle : btnStyle;
        btnComprehensive.textContent = '◉ Comprehensive';
        btnComprehensive.disabled = output.mixMode === 'comprehensive';
        btnComprehensive.addEventListener('click', async () => {
            btnComprehensive.disabled = true;
            btnComprehensive.textContent = '...';
            try {
                const mixed = outputWriteLayer.mixLayer(output._base, 'comprehensive');
                mixed._base = output._base;
                await outputWriteLayer.renderToUI(mixed);
            } catch (err) {
                Logger.log(`[Step 8W] Comprehensive error: ${err.message}`, 'danger');
                btnComprehensive.disabled = false;
                btnComprehensive.textContent = '◉ Comprehensive';
            }
        });

        // Top
        const btnTop = document.createElement('button');
        btnTop.style.cssText = btnStyle;
        btnTop.textContent = '↑ Top';
        btnTop.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        footer.appendChild(btnCopy);
        footer.appendChild(btnRefined);
        footer.appendChild(btnExpanded);
        footer.appendChild(btnComprehensive);
        footer.appendChild(btnTop);
        container.appendChild(responseWrap);
        container.appendChild(footer);
        panel.appendChild(container);
        panel.__nktgLastResponse = output.response;
    }
}

export const outputWriteLayer = new NKTgOutputWriteLayer();

export async function handleOutputLayerWrite(context) {
    try {
        Logger.log('[Step 8W Node] Output Write Layer (Não Phải) processing...', 'info');
        if (!context.kernel) throw new Error('Missing context.kernel data from Step 7.');

        const base = outputWriteLayer.generateBase(context);
        const mixed = outputWriteLayer.mixLayer(base, 'standard');
        mixed._base = base;
        context.output = mixed;  // Step 9 cần

        Logger.log(
            `[Step 8W Output] State: ${mixed.state} | Expansion: ${mixed.expansionRate} | Mode: standard`,
            'success'
        );

        await outputWriteLayer.renderToUI(mixed);
        await handleDistributedSync(context);
    } catch (err) {
        Logger.log(`[Step 8W Fatal] ${err.message}`, 'danger');
        setPipelineState('ERROR');
        unlockPipelineUI();
    }
}
