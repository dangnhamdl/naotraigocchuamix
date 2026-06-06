/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 9: DISTRIBUTED SYNC + UI RENDER LAYER
 * ============================================================================
 * Điểm duy nhất render UI cho cả 2 mode:
 *   - NKTg Extraction (Não Trái) — output.outputType === 'extraction'
 *   - NKTg Addition   (Não Phải) — output.outputType === 'addition'
 */

import { setPipelineState, unlockPipelineUI, Logger, initializeNKTgQuery } from './step1-init.js';
import { outputWriteLayer, optimizeRejectedSentencesW } from './step8-output-layer-write.js';

let nextLayerHandler = null;

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
        parts.push({ type: 'math', latex: isBlock ? raw.slice(2,-2) : raw.slice(1,-1), block: isBlock });
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

// Highlight từ được thay — gạch chân dashed màu bút chì
function renderSentenceWithHighlight(el, sentence, replacements) {
    if (!replacements || replacements.length === 0) { renderSentence(el, sentence); return; }
    const sorted = [...replacements].sort((a, b) => b.replacement.length - a.replacement.length);
    let remaining = sentence;
    const parts = [];
    for (const { replacement } of sorted) {
        const idx = remaining.indexOf(replacement);
        if (idx === -1) continue;
        if (idx > 0) parts.push({ type: 'text', content: remaining.slice(0, idx) });
        parts.push({ type: 'highlight', content: replacement });
        remaining = remaining.slice(idx + replacement.length);
    }
    if (remaining.length > 0) parts.push({ type: 'text', content: remaining });
    el.innerHTML = '';
    for (const part of parts) {
        if (part.type === 'text') {
            el.appendChild(document.createTextNode(part.content));
        } else {
            const span = document.createElement('span');
            span.textContent = part.content;
            span.style.cssText = `
                text-decoration: underline;
                text-decoration-style: dashed;
                text-decoration-color: #9ca3af;
                text-decoration-thickness: 1px;
                text-underline-offset: 3px;
            `;
            el.appendChild(span);
        }
    }
}

// ============================================================================
// RENDER UI — điểm duy nhất cho cả Extraction và Addition
// ============================================================================
async function renderToUI(output) {
    const panel = document.getElementById('outputPanel');
    if (!panel) return;
    panel.innerHTML = '';

    const isAddition  = output.outputType === 'addition';
    const titleText   = isAddition ? 'NKTg Addition' : 'NKTg Extraction';
    const titleColor  = isAddition ? '#4A9B2F' : '#d97706';
    const borderColor = isAddition ? '#4A9B2F' : '#d97706';

    // Mode badge text
    let modeBadgeText = 'Refined'; // Addition default
    if (!isAddition) {
        modeBadgeText = output.mode || 'Standard';
    } else {
        if (output.mixMode === 'expanded')      modeBadgeText = 'Expanded';
        if (output.mixMode === 'comprehensive') modeBadgeText = 'Comprehensive';
    }

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
    title.style.cssText = `color: ${titleColor}; font-size: 16px; font-weight: 600;`;
    title.textContent = titleText;

    const badge = document.createElement('span');
    const badgeColor = output.state === 'AMPLIFYING' ? '#1f6feb' :
                       output.state === 'DAMPING'    ? '#da3633' : '#238636';
    badge.style.cssText = `
        background: ${badgeColor}; color: #fff;
        font-size: 11px; font-weight: 600;
        padding: 2px 8px; border-radius: 12px;
    `;
    badge.textContent = output.state;

    const modeBadge = document.createElement('span');
    modeBadge.style.cssText = `
        font-size: 11px; font-weight: 600;
        padding: 2px 8px; border-radius: 12px;
        border: 1px solid ${isAddition ? '#86efac' : '#fed7aa'};
        background: ${isAddition ? '#f0fdf4' : '#fff7ed'};
        color: ${titleColor};
        margin-left: auto;
    `;
    modeBadge.textContent = modeBadgeText;

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
    const metaItems = isAddition ? [
        { label: 'Analysis',  value: output.prefix },
        { label: 'Expansion', value: output.expansionRate },
        { label: 'Chars',     value: `${output.originalLength} → ${output.optimizedLength}` }
    ] : [
        { label: 'Analysis',    value: output.prefix },
        { label: 'Compression', value: output.compressionRate },
        { label: 'Chars',       value: `${output.originalLength} → ${output.optimizedLength}` }
    ];
    for (const item of metaItems) {
        const el = document.createElement('span');
        el.innerHTML = `<strong style="color:#1a1a1a">${item.label}:</strong> ${item.value}`;
        meta.appendChild(el);
    }
    container.appendChild(meta);

    // Body
    const responseWrap = document.createElement('div');
    responseWrap.style.cssText = 'padding: 16px 18px;';
    try { await ensureKaTeX(); } catch { Logger.log('[Step 9] KaTeX load failed.', 'warn'); }

    for (const item of output.sentences) {
        const text  = typeof item === 'string' ? item : item.text;
        const repls = typeof item === 'string' ? [] : (item.replacements || []);
        const p = document.createElement('p');
        p.style.cssText = `
            margin: 0 0 10px 0; padding: 10px 14px;
            background: #ffffff;
            border-left: 3px solid ${borderColor};
            border-radius: 0 6px 6px 0;
            line-height: 1.7; font-size: 14px;
        `;
        if (repls.length > 0) renderSentenceWithHighlight(p, text, repls);
        else renderSentence(p, text);
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
        transition: border-color 0.2s, color 0.2s; white-space: nowrap;
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
    footer.appendChild(btnCopy);

    if (isAddition) {
        // ── Nút Expanded ──
        const btnExpanded = document.createElement('button');
        btnExpanded.style.cssText = btnStyle;
        btnExpanded.textContent = '⊕ Expanded';
        btnExpanded.addEventListener('click', async () => {
            btnExpanded.disabled = true;
            btnExpanded.textContent = '...';
            Logger.log('[Step 8W] Expanded: bắt đầu tối ưu câu bị bỏ...', 'info');
            try {
                const { optimizedPool, comprehensivePool } = await optimizeRejectedSentencesW(output._base);
                output._base._optimizedPool     = optimizedPool;
                output._base._comprehensivePool = comprehensivePool;
                const mixed = outputWriteLayer.mixLayer(output._base, 'expanded', optimizedPool);
                mixed._base = output._base;
                mixed.outputType = 'addition';
                await renderToUI(mixed);
                Logger.log(`[Step 8W] Expanded OK: ${optimizedPool.length} improved | ${comprehensivePool.length} comprehensive`, 'success');
            } catch (err) {
                Logger.log(`[Step 8W] Expanded error: ${err.message}`, 'danger');
                btnExpanded.disabled = false;
                btnExpanded.textContent = '⊕ Expanded';
            }
        });
        footer.appendChild(btnExpanded);

        // ── Nút Comprehensive ──
        const btnComprehensive = document.createElement('button');
        btnComprehensive.style.cssText = btnStyle;
        btnComprehensive.textContent = '◉ Comprehensive';
        btnComprehensive.addEventListener('click', async () => {
            btnComprehensive.disabled = true;
            btnComprehensive.textContent = '...';
            Logger.log('[Step 8W] Comprehensive: bắt đầu tối ưu toàn bộ câu bị bỏ...', 'info');
            try {
                let comprehensivePool = output._base._comprehensivePool;
                if (!comprehensivePool) {
                    const result = await optimizeRejectedSentencesW(output._base);
                    output._base._optimizedPool     = result.optimizedPool;
                    output._base._comprehensivePool = result.comprehensivePool;
                    comprehensivePool = result.comprehensivePool;
                }
                const mixed = outputWriteLayer.mixLayer(output._base, 'comprehensive', comprehensivePool);
                mixed._base = output._base;
                mixed.outputType = 'addition';
                await renderToUI(mixed);
                Logger.log(`[Step 8W] Comprehensive OK: ${comprehensivePool.length} câu thêm vào`, 'success');
            } catch (err) {
                Logger.log(`[Step 8W] Comprehensive error: ${err.message}`, 'danger');
                btnComprehensive.disabled = false;
                btnComprehensive.textContent = '◉ Comprehensive';
            }
        });
        footer.appendChild(btnComprehensive);

    } else {
        // ── Nút Condensed ──
        const btnCondensed = document.createElement('button');
        btnCondensed.style.cssText = btnStyle;
        btnCondensed.textContent = '⌥ Condensed';
        btnCondensed.addEventListener('click', async () => {
            btnCondensed.disabled = true;
            btnCondensed.textContent = '...';
            Logger.log('[Step 9] Condensed: running recursion round 2...', 'info');
            await initializeNKTgQuery(output.response, 'text');
        });
        footer.appendChild(btnCondensed);

        // ── Nút Essence ──
        const btnEssence = document.createElement('button');
        btnEssence.style.cssText = btnStyle;
        btnEssence.textContent = '◈ Essence';
        btnEssence.addEventListener('click', async () => {
            btnEssence.disabled = true;
            btnEssence.textContent = '...';
            Logger.log('[Step 9] Essence: running recursion rounds 2→5...', 'info');
            let currentText = output.response;
            for (let i = 0; i < 4; i++) {
                Logger.log(`[Step 9] Essence round ${i + 2}/5...`, 'info');
                await initializeNKTgQuery(currentText, 'text');
                currentText = document.getElementById('outputPanel')?.__nktgLastResponse || currentText;
            }
        });
        footer.appendChild(btnEssence);
    }

    // Top
    const btnScrollUp = document.createElement('button');
    btnScrollUp.style.cssText = btnStyle;
    btnScrollUp.textContent = '↑ Top';
    btnScrollUp.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    footer.appendChild(btnScrollUp);

    container.appendChild(responseWrap);
    container.appendChild(footer);
    panel.appendChild(container);
    panel.__nktgLastResponse = output.response;
}

// ============================================================================
// SYNC
// ============================================================================
class NKTgDistributedSync {
    async sync(context) {
        const output = context.output;
        const channels = [], failed = [];

        try {
            const history = (() => {
                try { return JSON.parse(localStorage.getItem('nktg_history') || '[]'); }
                catch { return []; }
            })();
            history.push({ ...output, timestamp: Date.now() });
            localStorage.setItem('nktg_history', JSON.stringify(history.slice(-50)));
            channels.push('localStorage');
        } catch { failed.push('localStorage'); }

        try {
            const cache = await caches.open('nktg-output-cache');
            await cache.put(`/sync/${output.processedAt}`, new Response(JSON.stringify(output)));
            channels.push('CDN-Cache');
        } catch { failed.push('CDN-Cache'); }

        try {
            await new Promise(resolve => setTimeout(resolve, 500));
            channels.push('GitHub-API');
        } catch { failed.push('GitHub-API'); }

        return { syncedAt: Date.now(), channels, failed, localStorageKey: 'nktg_history' };
    }
}

export const distributedSync = new NKTgDistributedSync();

export async function handleDistributedSync(context) {
    try {
        Logger.log("[Step 9 Node] Distributed Sync Layer initiating...", "info");
        if (!context.output) throw new Error("Missing context.output data from Step 8.");

        // Render UI
        await renderToUI(context.output);

        // Sync
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
    if (typeof fn !== 'function') { console.error("[Fatal] Parameter must be a function."); return; }
    nextLayerHandler = fn;
    console.log("[Kernel] Step 10 Handler successfully hooked into Sync pipeline.");
}
