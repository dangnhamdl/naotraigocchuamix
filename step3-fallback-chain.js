/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 3: TEXT PREPROCESSOR
 * ============================================================================
 * Chuẩn NLP: làm sạch noise, giữ nguyên text tự nhiên cho Step 6a tokenize
 * KHÔNG lowercase, KHÔNG bỏ stop words — để Step 6a xử lý
 *
 * Output thêm vào context:
 *   context.tokenList   — [string] danh sách token chuẩn cho Step 6a
 *   context.sentenceMap — [string] danh sách câu đã tách cho Step 6b
 *
 * Hỗ trợ 21 ngôn ngữ:
 *   Latin (vi, en, fr, de, es, pt, it, nl, pl, tr, sv)
 *   CJK   (zh, ja, ko) — tách từng ký tự, dấu câu 。！？
 *   RTL   (ar, he, fa) — khoảng trắng, dấu câu ؟، .!?
 *   Devanagari (hi)    — khoảng trắng, dấu câu ।
 *   Cyrillic   (ru)    — khoảng trắng, dấu câu .!?
 *   Hy Lạp    (el)     — khoảng trắng, dấu câu .!?
 */
import { registerFallbackChainHandler } from './step2-geo-routing.js';
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';
import { handleDistributedRagLayer } from './step4-rag-layer.js';

// ============================================================================
// MATH GUARD — Bảo vệ công thức toán học trước khi NLP xử lý
// 4 loại:
//   Loại 1 — Inline đơn giản:   F = ma, E = mc², a² + b² = c²
//   Loại 2 — Ký hiệu đặc biệt: ∫₀¹f(x)dx, ∑ᵢ, ∂f/∂x, ∇f, √2, π≈3.14
//   Loại 3 — LaTeX:             \frac{1}{2}mv², \int_0^\infty, $...$
//   Loại 4 — Số học phức tạp:   3×10⁸, mc², x₁, (-b±√(b²-4ac))/2a
// ============================================================================
const MATH_PATTERNS = [
    // Loại 3 — LaTeX block: $$ ... $$ hoặc \[ ... \]
    /\$\$[\s\S]+?\$\$/g,
    /\\\[[\s\S]+?\\\]/g,
    // Loại 3 — LaTeX inline: $ ... $ hoặc \( ... \)
    /\$[^\$\n]{2,}\$/g,
    /\\\([^)]{2,}\\\)/g,
    // Loại 3 — LaTeX command: \cmd{...}
    /\\[a-zA-Z]+(?:\{[^{}]*\}){1,3}/g,

    // Loại 2 — Ký hiệu toán Unicode + toàn bộ cụm (cắt trước từ tự nhiên bằng cleanMathMatch)
    /[∫∂∑∏√∞±∓×÷≤≥≠≈≡∈∉⊂⊆∪∩∅∀∃∇∆][^\n,]*/g,

    // Loại 2 — Hằng số toán đứng cạnh toán tử và số
    /[παβγδεζηθκλμνξρστφχψω]\s*(?:[=≈<>≤≥])\s*[\d\+\-][^\s,;.!?]{0,20}/g,

    // Loại 4 — biến + superscript/subscript Unicode
    /[a-zA-Z0-9]{1,4}[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ᵢⁿ₌₀₁₂₃₄₅₆₇₈₉]+/g,

    // Loại 1 — Phương trình: biến = biểu thức toán
    /\b[A-Za-z]{1,4}\s*=\s*(?=[^=\s])(?:[A-Za-z0-9\+\-\*\/\^\(\)\[\]\.]{2,40})(?=[\s,;.])/gm,

    // Loại 1 — Hàm toán học
    /\b(?:sqrt|sin|cos|tan|log|ln|exp|lim)\s*\([^)]{1,30}\)/gi,

    // Loại 1 — biến^mũ
    /[a-zA-Z0-9]\^[{]?[a-zA-Z0-9\+\-]{1,5}[}]?/g,

    // Loại 4 — Số × ÷ Số
    /\d+(?:[.,]\d+)?\s*[×÷]\s*\d+(?:[.,]\d+)?/g,
];

// Biến vi phân thường bị nhận nhầm là từ tự nhiên
const MATH_WORDS = new Set(['dx','dy','dz','dt','df','dn','ds','du','dv','dr','dp','dq']);

// Cắt từ tự nhiên bị bắt nhầm ở cuối match
// Không cắt nếu từ đứng sau toán tử = + - * / (vế phải phương trình)
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

        // Không cắt nếu prevToken kết thúc bằng toán tử = + - * /
        if (isNatural && !/[=\+\-\*\/]$/.test(prevToken)) {
            cutIdx = i;
        } else {
            break;
        }
    }

    return tokens.slice(0, cutIdx).join('').replace(/[.,;]+$/, '').trim();
}

class MathGuard {
    constructor() {
        this.mathMap = [];
    }

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

    restoreArray(arr) {
        return arr.map(s => this.restore(s));
    }
}

// ============================================================================

export const StopWordMap = {
    en: ["the","is","at","which","on","and","a","an","of","to","in","for","it","this","that","are","was","be","with","as","by","from","or","but","not","have","had","has","will","would","could","should","may","might","do","did","does"],
    vi: ["là","và","của","trong","một","những","các","có","được","để","cho","với","từ","về","theo","hay","hoặc","nếu","khi","thì","mà","nhưng","vì","nên","rằng","đã","sẽ","đang","này","đó","vậy","như","cũng","còn","rất","hơn","nhất","tôi","bạn","họ","chúng","ta"],
    fr: ["le","la","les","et","un","une","des","du","de","en","au","aux","par","sur","dans","avec","pour","pas","ne","se","ce","qui","que","où","ou","mais","donc"],
    de: ["der","die","das","und","ein","eine","in","zu","den","dem","von","mit","auf","für","ist","sich","nicht","auch","an","als","bei","nach"],
    es: ["el","la","los","las","y","un","una","de","en","que","se","por","con","su","para","es","al","del","le","lo"],
    zh: ["的","了","在","是","和","有","我","他","这","中","大","为","上","个","国","到","说","们"],
    ja: ["の","に","は","を","が","と","で","た","し","て","も","な","か","ん","から","まで","より"],
    ko: ["의","에","은","는","이","가","을","를","와","과","도","로","으로","에서","에게"],
    ar: ["و","في","من","على","إلى","هو","هي","أن","لا","ما","كان","قد"],
    ru: ["и","в","на","с","по","за","к","от","до","не","что","это","как","все","или","но"],
};

// ============================================================================
// TOKENIZE — Universal Tokenizer hỗ trợ 21 ngôn ngữ
// ============================================================================
export function tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu) || [];
}

// ============================================================================
// SPLIT SENTENCES — Universal Sentence Splitter hỗ trợ 21 ngôn ngữ
// ============================================================================
const ABBREVIATIONS = [
    'TP.', 'Mr.', 'Mrs.', 'Dr.', 'vs.', 'v.v.', 'vv.',
    'Ltd.', 'Co.', 'Corp.', 'Inc.', 'No.', 'St.',
    'PGS.', 'GS.', 'ThS.', 'KS.', 'Th.S.', 'P.G.S.'
];

const NO_UPPERCASE_LANGS = new Set(['ar', 'he', 'fa', 'ko', 'zh', 'ja', 'hi']);

export function splitSentences(text, lang = '') {
    let tmp = text;

    tmp = tmp.replace(/\.{3}/g, '__ELLIPSIS__');
    ABBREVIATIONS.forEach((abbr, i) => {
        tmp = tmp.replaceAll(abbr, abbr.replace('.', `__ABBR${i}__`));
    });
    tmp = tmp.replace(/(\d)\.(\d)/g, '$1__DEC__$2');
    tmp = tmp.replace(/(?<=\s|^)([0-9]{1,3}|[a-zA-Z])[\.\)]\s+/gm, '__LIST__');

    tmp = tmp.replace(/__ELLIPSIS__/g, '...');
    ABBREVIATIONS.forEach((abbr, i) => {
        tmp = tmp.replace(new RegExp(`__ABBR${i}__`, 'g'), '.');
    });
    tmp = tmp.replace(/__DEC__/g, '.');
    tmp = tmp.replace(/__LIST__/g, '');

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
async function processText(context) {
    Logger.log("[Step 3] executing...", "info");

    if (!context.normalizedText) {
        context.preprocessedText = "";
        context.tokenList = [];
        context.sentenceMap = [];
        return context;
    }

    const lang = context.textMeta?.language || 'unknown';
    let text = context.normalizedText;

    // ── MATH GUARD: bảo vệ công thức TRƯỚC khi xử lý ──
    const mathGuard = new MathGuard();
    text = mathGuard.protect(text);
    if (mathGuard.mathMap.length > 0) {
        Logger.log(`[Step 3 MathGuard] Bảo vệ ${mathGuard.mathMap.length} công thức.`, "info");
    }

    // 0. Lọc control characters (trừ \n, \r, \t)
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

    // 1. Lọc HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // 2. NFC normalize
    text = text.normalize('NFC');

    // 3. Bỏ markdown link [text](url) → giữ text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, ' $1 ');

    // 4. Bỏ URL độc lập
    text = text.replace(/https?:\/\/[^\s]+/g, ' ');

    // 5. Bảo vệ email
    const emailMap = [];
    text = text.replace(/[\w.-]+@[\w.-]+\.[a-z]{2,}/gi, (match) => {
        emailMap.push(match);
        return `__EMAIL${emailMap.length - 1}__`;
    });

    // 5b. Bảo vệ dấu – nối số
    text = text.replace(/(\d)\s*[–\-]\s*(\d)/g, '$1__DASH__$2');

    // 6. Bỏ số thứ tự đầu dòng
    text = text.replace(/^\s*\d+\.\s*/gm, ' ');

    // 7. Chuẩn hóa dấu câu lặp
    text = text.replace(/!{2,}/g, '!');
    text = text.replace(/\?{2,}/g, '?');
    text = text.replace(/\.{4,}/g, '…');

    // 8. Whitelist ký tự
    text = text.replace(/[^\p{L}\p{N}\p{P}\s\/%\{\}\\^_=+<>|]/gu, ' ');

    // 9. Chuẩn hóa khoảng trắng
    text = text.replace(/[ \t]+/g, ' ').trim();

    // 10. Restore email
    emailMap.forEach((email, i) => {
        text = text.replace(`__EMAIL${i}__`, email);
    });

    // 11. Restore dấu – nối số
    text = text.replace(/__DASH__/g, '–');

    // ── MATH GUARD: khôi phục công thức SAU khi xử lý ──
    text = mathGuard.restore(text);

    context.preprocessedText = text;
    context.tokenList   = tokenize(text);
    context.sentenceMap = splitSentences(text, lang);
    context.sentenceMap = mathGuard.restoreArray(context.sentenceMap);

    Logger.log(
        `[Step 3] done | ${context.textMeta?.wordCount || 0} từ gốc → ${context.tokenList.length} tokens sạch | ${context.sentenceMap.length} câu | lang: ${lang}`,
        "success"
    );

    if (typeof handleDistributedRagLayer === 'function') {
        await handleDistributedRagLayer(context);
    } else {
        Logger.log("[Step 3] Step 4 missing, skipping", "warn");
    }

    return context;
}

export async function step3FallbackChain(context) {
    try {
        return await processText(context);
    } catch (err) {
        Logger.log(`[Step 3 Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
        throw err;
    }
}

setTimeout(() => {
    registerFallbackChainHandler(step3FallbackChain);
    Logger.log("[Kernel] Step 3 REGISTERED SUCCESSFULLY", "info");
}, 0);
