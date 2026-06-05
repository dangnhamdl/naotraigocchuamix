/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 3: PDF PREPROCESSOR
 * ============================================================================
 * Input:  Text sau khi pdf.js extract từ .pdf
 * Output: context.tokenList + context.sentenceMap
 *
 * Rác đặc thù .pdf (pdf.js output):
 *   - Line wrap giữa câu: "nổi\ntiếng" → "nổi tiếng"
 *   - Hyphen ngắt dòng: "word-\nbreak" → "wordbreak"
 *   - Số trang độc lập
 *   - Dòng quá ngắn (header/footer)
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedRagLayer } from './step4-rag-layer.js';

// ============================================================================
// MATH GUARD
// ============================================================================
const MATH_PATTERNS = [
    /\$\$[\s\S]+?\$\$/g,
    /\\\[[\s\S]+?\\\]/g,
    /\$[^\$\n]{2,}\$/g,
    /\\\([^)]{2,}\\\)/g,
    /\\[a-zA-Z]+(?:\{[^{}]*\}){1,3}/g,
    /[∫∂∑∏√∞±∓×÷≤≥≠≈≡∈∉⊂⊆∪∩∅∀∃∇∆][^\n,]*/g,
    /[παβγδεζηθκλμνξρστφχψω]\s*(?:[=≈<>≤≥])\s*[\d\+\-][^\s,;.!?]{0,20}/g,
    /[a-zA-Z0-9]{1,4}[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ᵢⁿ₌₀₁₂₃₄₅₆₇₈₉]+/g,
    /\b[A-Za-z]{1,4}\s*=\s*(?=[^=\s])(?:[A-Za-z0-9\+\-\*\/\^\(\)\[\]\.]{2,40})(?=[\s,;.])/gm,
    /\b(?:sqrt|sin|cos|tan|log|ln|exp|lim)\s*\([^)]{1,30}\)/gi,
    /[a-zA-Z0-9]\^[{]?[a-zA-Z0-9\+\-]{1,5}[}]?/g,
    /\d+(?:[.,]\d+)?\s*[×÷]\s*\d+(?:[.,]\d+)?/g,
];

const MATH_WORDS = new Set(['dx','dy','dz','dt','df','dn','ds','du','dv','dr','dp','dq']);

function cleanMathMatch(match) {
    const tokens = match.trim().split(/(\s+)/);
    let cutIdx = tokens.length;
    for (let i = tokens.length - 1; i >= 1; i -= 2) {
        const w = tokens[i].replace(/[.,;!?]$/, '');
        const prevToken = i >= 2 ? tokens[i - 2] : '';
        if (!w) continue;
        const isNatural = /^[a-zA-Z\p{L}]{2,}$/u.test(w) &&
            !/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉ᵢⁿ₌\^∫∂∑∏√∞±∓×÷≤≥≠≈≡∈∉⊂⊆∪∩∅∀∃∇∆]/.test(w) &&
            !MATH_WORDS.has(w.toLowerCase());
        if (isNatural && !/[=\+\-\*\/]$/.test(prevToken)) {
            cutIdx = i;
        } else { break; }
    }
    return tokens.slice(0, cutIdx).join('').replace(/[.,;]+$/, '').trim();
}

class MathGuard {
    constructor() { this.mathMap = []; }
    protect(text) {
        this.mathMap = [];
        let result = text;
        for (const pattern of MATH_PATTERNS) {
            pattern.lastIndex = 0;
            result = result.replace(pattern, (match) => {
                if (/^__MATH_\d+__$/.test(match.trim())) return match;
                const cleaned = cleanMathMatch(match);
                if (cleaned.length < 2) return match;
                const idx = this.mathMap.length;
                this.mathMap.push(cleaned);
                return ` __MATH_${idx}__ `;
            });
        }
        return result;
    }
    restore(text) {
        let result = text;
        this.mathMap.forEach((formula, i) => {
            result = result.replace(new RegExp(`__MATH_${i}__`, 'g'), formula);
        });
        return result;
    }
    restoreArray(arr) { return arr.map(s => this.restore(s)); }
}

// ============================================================================
// TOKENIZE & SPLIT SENTENCES
// ============================================================================
export function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu) || [];
}

const ABBREVIATIONS = [
    'TP.', 'Mr.', 'Mrs.', 'Dr.', 'vs.', 'v.v.', 'vv.',
    'Ltd.', 'Co.', 'Corp.', 'Inc.', 'No.', 'St.',
    'PGS.', 'GS.', 'ThS.', 'KS.', 'Th.S.', 'P.G.S.'
];
const NO_UPPERCASE_LANGS = new Set(['ar', 'he', 'fa', 'ko', 'zh', 'ja', 'hi']);

export function splitSentences(text, lang = '') {
    let tmp = text;
    tmp = tmp.replace(/\.{3}/g, '__ELLIPSIS__');
    ABBREVIATIONS.forEach((abbr, i) => { tmp = tmp.replaceAll(abbr, abbr.replace('.', `__ABBR${i}__`)); });
    tmp = tmp.replace(/(\d)\.(\d)/g, '$1__DEC__$2');
    tmp = tmp.replace(/(?<=\s|^)([0-9]{1,3}|[a-zA-Z])[\.\)]\s+/gm, '__LIST__');
    tmp = tmp.replace(/__ELLIPSIS__/g, '...');
    ABBREVIATIONS.forEach((abbr, i) => { tmp = tmp.replace(new RegExp(`__ABBR${i}__`, 'g'), '.'); });
    tmp = tmp.replace(/__DEC__/g, '.').replace(/__LIST__/g, '');
    tmp = tmp.replace(/([。！？।؟])\s*/g, '$1\n');
    let parts;
    if (NO_UPPERCASE_LANGS.has(lang)) {
        parts = tmp.split(/(?<=[.!?…\u037E]["']?)\s+|\n/u);
    } else {
        parts = tmp.split(/(?<=[.!?…\u037E]["']?)\s+(?=[\p{Lu}\p{Lt}])|\n/u);
    }
    return parts.map(s => s.trim()).filter(s => s.length > 0);
}

// ============================================================================
// MAIN PROCESS
// ============================================================================
async function processPdf(context) {
    Logger.log("[Step 3 PDF] executing...", "info");

    if (!context.normalizedText) {
        context.preprocessedText = "";
        context.tokenList = [];
        context.sentenceMap = [];
        return context;
    }

    const lang = context.textMeta?.language || 'unknown';
    let text = context.normalizedText;

    // ── Rác đặc thù .pdf — TRƯỚC MathGuard ──

    // Ghép hyphen ngắt dòng: "word-\nbreak" → "wordbreak"
    text = text.replace(/-\n(\S)/g, '$1');

    // Ghép line wrap giữa câu: chữ cái + \n + chữ cái → nối bằng khoảng trắng
    text = text.replace(/([a-zA-Z\p{L}])\n([a-zA-Z\p{L}])/gu, '$1 $2');

    // Bỏ dòng chỉ có số (số trang)
    text = text.replace(/^\s*\d+\s*$/gm, '');

    // Bỏ dòng quá ngắn (header/footer — 1-2 từ đứng một mình)
    text = text.replace(/^.{1,30}$/gm, (line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        const wordCount = trimmed.split(/\s+/).filter(w => w.length > 0).length;
        return wordCount <= 2 ? '' : line;
    });

    // ── MATH GUARD: bảo vệ công thức TRƯỚC khi xử lý ──
    const mathGuard = new MathGuard();
    text = mathGuard.protect(text);
    if (mathGuard.mathMap.length > 0) {
        Logger.log(`[Step 3 PDF MathGuard] Bảo vệ ${mathGuard.mathMap.length} công thức.`, "info");
    }

    // ── Các bước chung ──
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.normalize('NFC');
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, ' $1 ');
    text = text.replace(/https?:\/\/[^\s]+/g, ' ');
    const emailMap = [];
    text = text.replace(/[\w.-]+@[\w.-]+\.[a-z]{2,}/gi, (match) => {
        emailMap.push(match);
        return `__EMAIL${emailMap.length - 1}__`;
    });
    text = text.replace(/(\d)\s*[–\-]\s*(\d)/g, '$1__DASH__$2');
    text = text.replace(/^\s*\d+\.\s*/gm, ' ');
    text = text.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/\.{4,}/g, '…');
    text = text.replace(/[^\p{L}\p{N}\p{P}\s\/%\{\}\\^_=+<>|]/gu, ' ');
    text = text.replace(/[ \t]+/g, ' ').trim();
    emailMap.forEach((email, i) => { text = text.replace(`__EMAIL${i}__`, email); });
    text = text.replace(/__DASH__/g, '–');

    // ── MATH GUARD restore ──
    text = mathGuard.restore(text);

    context.preprocessedText = text;
    context.tokenList   = tokenize(text);
    context.sentenceMap = splitSentences(text, lang);
    context.sentenceMap = mathGuard.restoreArray(context.sentenceMap);

    Logger.log(
        `[Step 3 PDF] done | ${context.tokenList.length} tokens | ${context.sentenceMap.length} câu | lang: ${lang}`,
        "success"
    );

    if (typeof handleDistributedRagLayer === 'function') {
        await handleDistributedRagLayer(context);
    } else {
        Logger.log("[Step 3 PDF] Step 4 missing, skipping", "warn");
    }
    return context;
}

export async function step3Pdf(context) {
    try {
        return await processPdf(context);
    } catch (err) {
        Logger.log(`[Step 3 PDF Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
        throw err;
    }
}
