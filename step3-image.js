/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 3: IMAGE PREPROCESSOR (OCR)
 * ============================================================================
 * Input:  Text sau khi Tesseract.js OCR extract từ file ảnh
 * Output: context.tokenList + context.sentenceMap
 *
 * Rác đặc thù OCR (Tesseract.js output) — xử lý TRƯỚC MathGuard:
 *   - Ký tự lạ do nhận sai: "l" → "1", "O" → "0", "rn" → "m"
 *   - Dòng chỉ có 1-2 ký tự (nhiễu viền, đốm ảnh)
 *   - Khoảng trắng thừa giữa các ký tự trong cùng 1 từ: "h e l l o"
 *   - Dòng trống liên tiếp do khoảng cách dòng trong ảnh
 *   - Ký tự không thuộc Unicode hợp lệ (artifact nén ảnh JPG)
 *
 * Rác cấu trúc chung (line-level garbage filtering — bước 12, đồng bộ với
 * step3-fallback-chain.js/step3-pdf.js/step3-txt.js): timestamp, separator,
 * URL/path không protocol, breadcrumb, duplicate line, OCR tab/UI artifact
 * (token dài + nhiều token đơn lẻ xen kẽ) — chạy SAU MathGuard.protect().
 */
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedRagLayer } from './step4-rag-layer.js';

// ============================================================================
// MATH GUARD — giữ nguyên từ step3-pdf.js, OCR cũng có thể gặp công thức
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
// TOKENIZE & SPLIT SENTENCES — giữ nguyên từ step3-pdf.js
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
async function processImage(context) {
    Logger.log("[Step 3 Image] executing...", "info");

    if (!context.normalizedText) {
        context.preprocessedText = "";
        context.tokenList  = [];
        context.sentenceMap = [];
        return context;
    }

    const lang = context.textMeta?.language || 'unknown';
    let text = context.normalizedText;

    // ── Rác đặc thù OCR — TRƯỚC MathGuard ──

    // Xóa ký tự không thuộc Unicode hợp lệ (artifact JPG nén)
    text = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}\p{M}\n]/gu, ' ');

    // Xóa dòng chỉ có 1-2 ký tự (nhiễu viền ảnh, đốm)
    text = text.replace(/^.{1,2}$/gm, (line) => {
        const trimmed = line.trim();
        return trimmed.length <= 2 ? '' : line;
    });

    // Ghép từ bị tách ký tự do OCR: "h e l l o" → "hello"
    // Chỉ áp dụng khi mỗi ký tự cách nhau đúng 1 space, chuỗi >= 3 ký tự đơn
    text = text.replace(/\b((?:[a-zA-Z] ){2,}[a-zA-Z])\b/g, (match) => {
        return match.replace(/ /g, '');
    });

    // Xóa dòng trống liên tiếp (> 2) — OCR thường sinh nhiều dòng trống
    text = text.replace(/\n{3,}/g, '\n\n');

    // ── MATH GUARD: bảo vệ công thức TRƯỚC khi xử lý ──
    const mathGuard = new MathGuard();
    text = mathGuard.protect(text);
    if (mathGuard.mathMap.length > 0) {
        Logger.log(`[Step 3 Image MathGuard] Bảo vệ ${mathGuard.mathMap.length} công thức.`, "info");
    }

    // ── Các bước chung — y hệt step3-pdf.js ──
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

    // 12. Line-level garbage filtering — boolean thuần, không score
    // Mỗi điều kiện độc lập: dòng khớp BẤT KỲ điều kiện nào → loại ngay
    // Hard filter: timestamp, separator/bullet, URL/path không protocol (chuỗi
    //   liền >=15 ký tự có dấu / — không cần domain.tld, vì OCR thường làm
    //   mất dấu chấm domain), breadcrumb, duplicate line
    // Structural filter: dùng tokenize() — token dài (>=12) kèm nhiều token
    //   độ dài 1 (>=3) xen kẽ → đặc trưng OCR tab/UI bị dính + rơi rớt ký tự đơn
    //   (an toàn cho CJK vì mọi token CJK đều dài 1 → không có "token dài";
    //    an toàn cho câu số liệu vì từ tự nhiên hiếm khi >=12 ký tự liên tục;
    //    an toàn cho tiếng Đức từ ghép dài vì không kèm nhiều token đơn lẻ)
    // Chạy TRƯỚC mathGuard.restore() — text vẫn chứa __MATH_N__, nên khi tính
    // tokens cho structural filter phải strip placeholder ra trước.
    {
        const seenLines = new Set();
        const lines = text.split('\n');
        const cleanedLines = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // ── Hard filter ──
            if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) continue;          // timestamp
            if (/^[-=_*•~]{3,}$/.test(line)) continue;                       // separator/bullet
            if (/\S{15,}\/\S+/.test(line) && !/^https?:\/\//i.test(line)) continue; // URL/path không protocol
            if (/\S+\s*[>|]\s*\S+/.test(line)) continue;                     // breadcrumb

            const lineKey = line.toLowerCase().replace(/\s+/g, ' ');
            if (seenLines.has(lineKey)) continue;                            // duplicate line
            seenLines.add(lineKey);

            // ── Structural filter — dùng tokenize(), bỏ qua __MATH_N__ ──
            const lineForTokens = line.replace(/__MATH_\d+__/g, '');
            const lineTokens = tokenize(lineForTokens);
            const hasLongToken = lineTokens.some(t => t.length >= 12);
            const isolatedTokenCount = lineTokens.filter(t => t.length === 1).length;
            if (hasLongToken && isolatedTokenCount >= 3) continue;

            // ── Ghép line wrap ──
            if (
                cleanedLines.length > 0 &&
                !/[.!?…,;:"")\]']$/.test(cleanedLines[cleanedLines.length - 1]) &&
                /^\p{Ll}/u.test(line)
            ) {
                cleanedLines[cleanedLines.length - 1] += ' ' + line;
            } else {
                cleanedLines.push(line);
            }
        }
        text = cleanedLines.join('\n');
        text = text.replace(/\n{3,}/g, '\n\n');
    }

    // ── MATH GUARD restore ──
    text = mathGuard.restore(text);

    context.preprocessedText = text;
    context.tokenList   = tokenize(text);
    context.sentenceMap = splitSentences(text, lang);
    context.sentenceMap = mathGuard.restoreArray(context.sentenceMap);

    Logger.log(
        `[Step 3 Image] done | ${context.tokenList.length} tokens | ${context.sentenceMap.length} câu | lang: ${lang}`,
        "success"
    );

    if (typeof handleDistributedRagLayer === 'function') {
        await handleDistributedRagLayer(context);
    } else {
        Logger.log("[Step 3 Image] Step 4 missing, skipping", "warn");
    }
    return context;
}

export async function step3Image(context) {
    try {
        return await processImage(context);
    } catch (err) {
        Logger.log(`[Step 3 Image Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
        throw err;
    }
}
