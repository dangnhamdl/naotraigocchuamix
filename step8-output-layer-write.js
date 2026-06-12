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
 *   - Mọi thiết bị: click/tap từ gạch chân → Popover hiện tại chỗ (giống Grammarly / dictionary lookup)
 *   - Desktop: Popover rộng 300px, flip up/down tự động
 *   - Mobile: Popover rộng 260px, flip up/down tự động
 *   - Preload synonym ngầm sau render, Popover hiện ngay lập tức từ cache
 *   - KHÔNG thay vào văn bản, KHÔNG có panel bên phải
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedSync } from './step9-distributed-sync.js';
import { fetchSynonyms } from './step8-wiki-search-write.js';

const KATEX_JS  = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js';
const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css';
let katexLoaded = false;

// ============================================================================
// MOBILE DETECTION & SYNONYM CACHE
// ============================================================================
function isMobile() {
    return window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

function _popoverWidth() {
    return isMobile() ? 260 : 300;
}

// Cache synonym per render session — { [tokenLower]: string[] }
// Reset mỗi lần render Comprehensive mới
let _synonymCache = {};

// ============================================================================
// FALLBACK TEXT — đa ngôn ngữ (21 ngôn ngữ theo step2-geo-routing.js)
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
    // CJK: không có \b word boundary — tìm trực tiếp bằng indexOf
    const isCJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(token);
    const regex = isCJK
        ? new RegExp(escaped)
        : new RegExp('\\b' + escaped + '\\b', 'i');
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

    // ============================================================================
    // MOBILE POPOVER — giống dictionary lookup Apple Books / Kindle / Google Translate
    // ============================================================================

    _showPopover(spanEl, token, lang) {
        this._hidePopover();

        const cached = _synonymCache[token.toLowerCase()];
        if (cached === undefined) return; // chưa load xong, bỏ qua
        const synonyms = cached.synonyms || [];

        // Highlight từ đang chọn
        spanEl.dataset.popoverActive = '1';
        spanEl.style.background = 'rgba(74,155,47,0.15)';
        spanEl.style.borderRadius = '3px';
        spanEl.style.textDecoration = 'none';
        spanEl.style.outline = '1.5px solid #4A9B2F';

        // Tạo popover
        const pop = document.createElement('div');
        pop.id = 'nktg-popover';
        pop.style.cssText = `
            position:absolute; z-index:9999;
            background:#fff; border:1px solid #e5e7eb;
            border-radius:10px; padding:10px 12px;
            box-shadow:0 8px 24px rgba(0,0,0,0.13);
            min-width:160px; max-width:260px;
            font-family:'Segoe UI',sans-serif;
        `;

        // Tên từ
        const label = document.createElement('div');
        label.style.cssText = 'font-weight:700; font-size:13px; color:#1a1a1a; margin-bottom:7px;';
        label.textContent = `"${token}"`;
        pop.appendChild(label);

        // Nội dung synonym
        if (!synonyms || synonyms.length === 0) {
            const msg = document.createElement('div');
            msg.style.cssText = 'font-size:11px; color:#9ca3af; line-height:1.5;';
            msg.textContent = getFallbackText(lang);
            pop.appendChild(msg);
        } else {
            const chips = document.createElement('div');
            chips.style.cssText = 'display:flex; flex-wrap:wrap; gap:5px;';
            for (const syn of synonyms) {
                const chip = document.createElement('span');
                chip.textContent = syn;
                chip.style.cssText = `
                    display:inline-block; padding:2px 9px;
                    background:#f0fdf4; border:1px solid #86efac;
                    border-radius:10px; font-size:12px; color:#166534;
                `;
                chips.appendChild(chip);
            }
            pop.appendChild(chips);
        }

        // Mũi tên nhỏ
        const arrow = document.createElement('div');
        arrow.style.cssText = `
            position:absolute; width:10px; height:10px;
            background:#fff; border:1px solid #e5e7eb;
            transform:rotate(45deg);
        `;
        pop.appendChild(arrow);

        document.body.appendChild(pop);

        // Tính vị trí — phía trên từ, flip xuống dưới nếu không đủ chỗ
        const rect = spanEl.getBoundingClientRect();
        const scrollY = window.scrollY || document.documentElement.scrollTop;
        const scrollX = window.scrollX || document.documentElement.scrollLeft;
        const popW = _popoverWidth();
        const popH = pop.offsetHeight || 80;

        let top, left, arrowTop, arrowBottom, flipDown;

        // Thử hiện phía trên
        if (rect.top - popH - 12 >= 8) {
            flipDown = false;
            top = scrollY + rect.top - popH - 12;
            arrow.style.bottom = '-6px';
            arrow.style.top = '';
            arrow.style.borderTop = 'none';
            arrow.style.borderLeft = 'none';
        } else {
            flipDown = true;
            top = scrollY + rect.bottom + 12;
            arrow.style.top = '-6px';
            arrow.style.bottom = '';
            arrow.style.borderBottom = 'none';
            arrow.style.borderRight = 'none';
        }

        // Căn ngang theo giữa từ, clamp vào viewport
        left = scrollX + rect.left + rect.width / 2 - popW / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));

        // Vị trí mũi tên ngang
        const arrowLeft = (scrollX + rect.left + rect.width / 2) - left - 5;
        arrow.style.left = `${Math.max(10, Math.min(arrowLeft, popW - 20))}px`;

        pop.style.top  = `${top}px`;
        pop.style.left = `${left}px`;
        pop.style.width = `${popW}px`;

        // Đóng khi tap ngoài
        const onOutside = (e) => {
            if (!pop.contains(e.target) && e.target !== spanEl) {
                this._hidePopover();
                document.removeEventListener('touchstart', onOutside, true);
                document.removeEventListener('mousedown',  onOutside, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('touchstart', onOutside, true);
            document.addEventListener('mousedown',  onOutside, true);
        }, 0);
    }

    _hidePopover() {
        const existing = document.getElementById('nktg-popover');
        if (existing) existing.remove();
        // Xoá highlight tất cả từ
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

    async renderToUI(output, mode = 'standard') {
        const panel = document.getElementById('outputPanel');
        if (!panel) return;
        panel.innerHTML = '';
        // Lưu lang vào panel để _createDampSpan dùng sau khi patch
        panel.__nktgLang = output.lang || 'en';

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

        // Panel gợi ý bên phải — ĐÃ BỎ trên mọi thiết bị
        // Mọi thiết bị dùng Popover tại chỗ (xem _showPopover)
        let suggestionPanel = null;

        // Render câu — thu thập tất cả dampTokens theo thứ tự xuất hiện
        // tokenSentenceMap: { [token]: sentence } — dùng cho bigram lookup tiếng Việt
        const allDampTokens = [];
        const seenTokens = new Set();
        const tokenSentenceMap = {};
        for (const item of output.sentences) {
            const p = document.createElement('p');
            p.style.cssText = `
                margin:0 0 8px 0; padding:6px 14px;
                border-left:3px solid #4A9B2F;
                line-height:1.7; font-size:14px;
                color:var(--color-text-primary);
            `;
            if (item.dampTokens && item.dampTokens.length > 0) {
                this._renderWithUnderline(p, item.text, item.dampTokens, output.lang);
                item.dampTokens.forEach(t => {
                    if (!seenTokens.has(t.toLowerCase())) {
                        seenTokens.add(t.toLowerCase());
                        allDampTokens.push(t);
                        tokenSentenceMap[t] = item.text; // lưu câu chứa token
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
        // Mọi thiết bị: preload vào cache → Popover dùng khi click/tap
        if (mode === 'comprehensive' && allDampTokens.length > 0) {
            _synonymCache = {}; // reset cache cho render mới
            this._preloadSynonymsToCache(allDampTokens, output.lang, tokenSentenceMap);
        }
    }

    // Render câu với gạch chân từ DAMPING — dùng word boundary
    _renderWithUnderline(el, sentence, dampTokens, lang) {
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
                span.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._showPopover(span, part.token, lang);
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
                // Ghi vào cache (dùng chung cho Popover mobile nếu cần)
                _synonymCache[token.toLowerCase()] = synonyms || [];
                synWrap.innerHTML = '';
                if (!synonyms || synonyms.length === 0) {
                    synWrap.style.cssText = 'color:#9ca3af; font-size:11px;';
                    synWrap.textContent = getFallbackText(lang);
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
                _synonymCache[token.toLowerCase()] = [];
                synWrap.style.cssText = 'color:#9ca3af; font-size:11px;';
                synWrap.textContent = 'Lỗi tra từ điển';
            }
        }
    }

    // Mobile + Desktop: preload synonym vào cache ngầm — Popover dùng khi click/tap
    // Tuần tự từng từ 1, tokenSentenceMap = { [token]: sentence } để hỗ trợ bigram vi
    // Với tiếng Việt: sau khi tìm được bigram → patch DOM gạch chân bigram thay vì token đơn
    async _preloadSynonymsToCache(dampTokens, lang, tokenSentenceMap = {}) {
        for (const token of dampTokens) {
            try {
                const sentence = tokenSentenceMap[token] || '';
                const result = await fetchSynonyms(token, lang, sentence);
                _synonymCache[token.toLowerCase()] = result;
                Logger.log(`[Step 8W Cache] "${token}" → displayToken:"${result.displayToken}" | ${result.synonyms.length} synonym(s)`, 'info');

                // Tiếng Việt, Trung, Nhật: patch DOM sau khi biết displayToken
                if (['vi', 'zh', 'ja'].includes(lang)) {
                    this._patchMultiSyllableUnderline(token, result.displayToken, lang);
                }
            } catch {
                _synonymCache[token.toLowerCase()] = { synonyms: [], displayToken: token };
                if (['vi', 'zh', 'ja'].includes(lang)) this._patchMultiSyllableUnderline(token, '', lang);
            }
        }
    }

    // Patch DOM đa âm tiết (vi, zh, ja) sau khi cache load xong:
    // displayToken rỗng → xoá gạch chân
    // displayToken là bigram → mở rộng span bao cả cụm
    _patchMultiSyllableUnderline(token, displayToken, lang) {
        const spans = document.querySelectorAll(`[data-token="${token}"]`);
        spans.forEach(span => {
            const parent = span.parentNode;
            if (!parent) return;

            if (!displayToken) {
                // Không tìm được bigram → xoá gạch chân, giữ text thuần
                const text = document.createTextNode(span.textContent);
                parent.replaceChild(text, span);
                return;
            }

            if (displayToken === token) return; // token đơn có synonym, không cần patch

            // zh/ja: bigram không khoảng trắng — neighborChar là 1 ký tự liền kề
            if (lang === 'zh' || lang === 'ja') {
                const isLeftBigram = displayToken.endsWith(token);
                const neighborChar = isLeftBigram
                    ? displayToken[0]
                    : displayToken[displayToken.length - 1];

                const siblings = Array.from(parent.childNodes);
                const spanIdx = siblings.indexOf(span);
                if (spanIdx === -1) return;

                if (isLeftBigram) {
                    const prevNode = siblings[spanIdx - 1];
                    if (!prevNode) return;
                    if (prevNode.nodeType === Node.TEXT_NODE) {
                        // neighborChar ở cuối text node
                        const prevText = prevNode.textContent;
                        if (!prevText.endsWith(neighborChar)) return;
                        prevNode.textContent = prevText.slice(0, -1);
                    } else if (prevNode.nodeType === Node.ELEMENT_NODE && prevNode.textContent === neighborChar) {
                        // neighborChar là span riêng (cũng là DAMPING token) → xoá span đó
                        parent.removeChild(prevNode);
                    } else return;
                    const bigramSpan = this._createDampSpan(displayToken, token);
                    parent.insertBefore(bigramSpan, span);
                    parent.removeChild(span);
                } else {
                    const nextNode = siblings[spanIdx + 1];
                    if (!nextNode) return;
                    if (nextNode.nodeType === Node.TEXT_NODE) {
                        // neighborChar ở đầu text node
                        const nextText = nextNode.textContent;
                        if (!nextText.startsWith(neighborChar)) return;
                        nextNode.textContent = nextText.slice(1);
                    } else if (nextNode.nodeType === Node.ELEMENT_NODE && nextNode.textContent === neighborChar) {
                        // neighborChar là span riêng → xoá span đó
                        parent.removeChild(nextNode);
                    } else return;
                    const bigramSpan = this._createDampSpan(displayToken, token);
                    parent.insertBefore(bigramSpan, siblings[spanIdx + 1] || null);
                    parent.removeChild(span);
                }
                return;
            }

            // vi: bigram có khoảng trắng — xác định trái/phải theo parts
            const parts = displayToken.split(' ');
            if (parts.length !== 2) return;
            const isLeftBigram = parts[1].toLowerCase() === token.toLowerCase();
            const neighborWord = isLeftBigram ? parts[0] : parts[1];

            const siblings = Array.from(parent.childNodes);
            const spanIdx = siblings.indexOf(span);
            if (spanIdx === -1) return;

            if (isLeftBigram) {
                const prevNode = siblings[spanIdx - 1];
                if (!prevNode || prevNode.nodeType !== Node.TEXT_NODE) return;
                const prevText = prevNode.textContent;
                const idx = prevText.toLowerCase().lastIndexOf(neighborWord.toLowerCase());
                if (idx === -1) return;
                prevNode.textContent = prevText.slice(0, idx);
                const bigramSpan = this._createDampSpan(displayToken, token);
                parent.insertBefore(bigramSpan, span);
                parent.removeChild(span);
            } else {
                const nextNode = siblings[spanIdx + 1];
                if (!nextNode || nextNode.nodeType !== Node.TEXT_NODE) return;
                const nextText = nextNode.textContent;
                const idx = nextText.toLowerCase().indexOf(neighborWord.toLowerCase());
                if (idx === -1) return;
                nextNode.textContent = nextText.slice(idx + neighborWord.length);
                const bigramSpan = this._createDampSpan(displayToken, token);
                parent.insertBefore(bigramSpan, nextNode);
                parent.removeChild(span);
            }
        });
    }

    // Tạo span gạch chân chuẩn — dùng cho bigram patch tiếng Việt
    _createDampSpan(displayText, token) {
        const span = document.createElement('span');
        span.textContent = displayText;
        span.dataset.token = token;
        span.style.cssText = `
            text-decoration:underline; text-decoration-style:solid;
            text-decoration-color:rgba(150,150,150,0.8); text-decoration-thickness:1.5px;
            text-underline-offset:2px; cursor:pointer;
        `;
        span.addEventListener('click', (e) => {
            e.stopPropagation();
            const panel = document.getElementById('outputPanel');
            const lang = panel?.__nktgLang || 'vi';
            this._showPopover(span, token, lang);
        });
        return span;
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
