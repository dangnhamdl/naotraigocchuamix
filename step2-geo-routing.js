/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 2: TEXT ANALYZER (FIXED)
 * ============================================================================
 * File: /nktg-ai/step2-geo-routing.js
 * Purpose: Local text analyzer node for 21 languages
 * Fix: Replaced blocking waitForStep3() loop with deferred callback pattern
 *      v2: Language detection dùng ký tự độc nhất — không trùng lặp giữa ngôn ngữ
 *      v3: Sửa thứ tự ưu tiên — fa trước ar, vi giữ đúng vị trí gốc (trước pt/es/fr/it)
 *          pt/es trước fr, fr trước it, tr/sv trước de
 *          Bỏ stop-word 'um' khỏi de (trùng tiếng Bồ), nl dùng stop-words thay ëï
 *      v4: Phân luồng Step 3 theo inputType — text/txt/docx/pdf
 *      v5: Thêm route inputType = 'image' → step3-image.js
 */

import {
    registerGeoRoutingHandler,
    setPipelineState,
    unlockPipelineUI,
    Logger
} from './step1-init.js';

let globalFallbackChainHandler = null;
let pendingContext = null;

// ============================================================================
// LANGUAGE DETECTION — mỗi ngôn ngữ dùng ký tự ĐỘC NHẤT
// Thứ tự: script riêng biệt trước, Latin có dấu đặc trưng sau, en fallback cuối
// ============================================================================
const LanguageDetectionEntries = Object.freeze([
    // Nhóm script độc lập — không trùng với bất kỳ ngôn ngữ nào
    ["ja",  /[\u3040-\u30ff\u31f0-\u31ff]/],        // Hiragana/Katakana — chỉ Nhật (trước zh!)
    ["zh",  /[\u4e00-\u9fff]/],                      // Han CJK — Trung
    ["ko",  /[\uac00-\ud7af]/],                      // Hangul — chỉ Hàn
    ["he",  /[\u0590-\u05FF]/],                      // Hebrew script
    ["fa",  /[\u067E\u0686\u0698\u06AF\u06A9]/],     // پ چ ژ گ ک — Ba Tư, TRƯỚC ar
    ["ar",  /[\u0600-\u06FF]/],                      // Arabic script
    ["hi",  /[\u0900-\u097F]/],                      // Devanagari — chỉ Hindi
    ["ru",  /[\u0400-\u04FF]/],                      // Cyrillic
    ["el",  /[\u0370-\u03FF]/],                      // Greek

    // Nhóm Latin — dùng ký tự đặc trưng độc nhất
    ["pl",  /[ąćęłńśźżĄĆĘŁŃŚŹŻ]/],                 // ł ą — chỉ Ba Lan
    ["tr",  /[ğışĞİŞ]/],                             // ğ ı ş — chỉ Thổ, TRƯỚC de (ü trùng de)
    ["sv",  /[åÅ]/],                                 // å — chỉ Bắc Âu, TRƯỚC de (ä ö trùng de)
    ["de",  /[ßäöüÄÖÜ]|\b(ist|das|die|der|ein|eine|und|mit|auf|für|nicht|auch|sich|von|im|zu|Sie)\b/i],
    ["vi",  /[ắặẳẵằếệểễềịỉĩọỏõợởỡụủũựửữỵỷỹđ]/i],  // tone marks — chỉ tiếng Việt, TRƯỚC pt/es/fr/it
    ["pt",  /[ãõÃÕ]/],                               // ã õ — Bồ Đào Nha, TRƯỚC fr
    ["es",  /[ñ¿¡Ñ]/],                               // ñ ¿ ¡ — chỉ Tây Ban Nha, TRƯỚC fr
    ["fr",  /[œæçÇŒÆ]|\b(le|la|les|du|des|avec|dans|pour|pas|une|sur|est|qui)\b/i], // TRƯỚC it
    ["it",  /[èÈ]/],                                 // è — đặc trưng Ý
    ["nl",  /\b(een|het|dat|van|voor|zijn|wordt|zoals|middelen|stabiel|draait)\b/i],
    ["en",  /[a-zA-Z]/]                              // fallback Latin
]);

// Từ điển viết tắt — không cắt câu tại các dấu chấm này
const ABBREVIATIONS = [
    'TP.', 'Mr.', 'Mrs.', 'Dr.', 'vs.', 'v.v.', 'vv.',
    'Ltd.', 'Co.', 'Corp.', 'Inc.', 'No.', 'St.',
    'PGS.', 'GS.', 'ThS.', 'KS.', 'Th.S.', 'P.G.S.'
];

function countSentences(text) {
    let tmp = text;
    tmp = tmp.replace(/\.{3}/g, '__ELLIPSIS__');
    ABBREVIATIONS.forEach((abbr, i) => {
        tmp = tmp.replaceAll(abbr, abbr.replace('.', `__ABBR${i}__`));
    });
    tmp = tmp.replace(/(\d)\.(\d)/g, '$1__DEC__$2');
    tmp = tmp.replace(/(?<=\s|^)([0-9]{1,3}|[a-zA-Z])[\.\)]\s+/gm, '__LIST__');
    const sentences = tmp
        .split(/(?<=[.!?…。！？]["']?)\s*(?=[\p{Lu}\p{Lt}]|\n|$)/u)
        .filter(s => s.trim().length > 0);
    return Math.max(1, sentences.length);
}

function countParagraphs(text) {
    const paragraphs = text
        .split(/\n\n+|\n(?=[ \t]{2,})/)
        .filter(p => p.trim().length > 0);
    return Math.max(1, paragraphs.length);
}

// ============================================================================
// ĐIỀU PHỐI STEP 3 THEO inputType
// ============================================================================
async function routeToStep3(context) {
    const inputType = context.meta?.inputType || 'text';

    if (inputType === 'txt') {
        Logger.log("[Step 2] Route → Step 3 TXT", "info");
        const { step3Txt } = await import('./step3-txt.js');
        await step3Txt(context);

    } else if (inputType === 'docx') {
        Logger.log("[Step 2] Route → Step 3 DOCX", "info");
        const { step3Docx } = await import('./step3-docx.js');
        await step3Docx(context);

    } else if (inputType === 'pdf') {
        Logger.log("[Step 2] Route → Step 3 PDF", "info");
        const { step3Pdf } = await import('./step3-pdf.js');
        await step3Pdf(context);

    } else if (inputType === 'image') {
        Logger.log("[Step 2] Route → Step 3 Image", "info");
        const { step3Image } = await import('./step3-image.js');
        await step3Image(context);

    } else {
        Logger.log("[Step 2] Route → Step 3 Text (textarea)", "info");
        if (typeof globalFallbackChainHandler === 'function') {
            await globalFallbackChainHandler(context);
        } else {
            Logger.log("[Step 2] Step 3 Text not ready yet. Deferring context...", "warn");
            pendingContext = context;
        }
    }
}

/**
 * Hook injected from Step 3 Text (textarea).
 */
export function registerFallbackChainHandler(fn) {
    if (typeof fn === 'function') {
        globalFallbackChainHandler = fn;
        console.log("[Kernel] Step 3 Text Preprocessor Hooked.");

        if (pendingContext !== null) {
            const ctx = pendingContext;
            pendingContext = null;
            Logger.log("[Step 2] Deferred context detected. Handing off to Step 3 Text...", "info");
            setPipelineState("PROCESSING");
            fn(ctx).catch(err => {
                Logger.log(`[Step 2 Deferred Handoff Fatal] ${err.message}`, "danger");
                setPipelineState("ERROR");
                unlockPipelineUI();
            });
        }
    }
}

/**
 * Main handler
 */
async function handleGeoRouting(context) {
    Logger.log("[Step 2 Node] Text Analyzer activated.", "info");

    const t0 = performance.now();

    try {
        const rawText = String(context?.meta?.rawInput || "");
        const normalizedText = rawText
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+/g, " ")
            .trim();

        context.normalizedText = normalizedText;

        if (!normalizedText) {
            context.textMeta = {
                language: "unknown",
                wordCount: 0,
                sentenceCount: 0,
                charCount: 0,
                paragraphCount: 0,
                avgSentenceLength: 0,
                emptyInput: true,
                estimatedReadingTime: 0,
                lengthCategory: "SHORT",
                processingTimeMs: performance.now() - t0
            };

            Logger.log("[Step 2] Empty input detected.", "warn");
            setPipelineState("PROCESSING");
            await routeToStep3(context);
            return;
        }

        // Language detection
        let language = "en";
        for (const [lang, regex] of LanguageDetectionEntries) {
            if (regex.test(normalizedText)) {
                language = lang;
                break;
            }
        }

        const words = normalizedText.match(/[\p{L}\p{N}][\p{L}\p{N}''\-]*/gu) || [];
        const wordCount = words.length;
        const sentenceCount = countSentences(normalizedText);
        const paragraphCount = countParagraphs(normalizedText);
        const charCount = normalizedText.length;
        const lengthCategory = wordCount > 2000 ? "LONG" : "SHORT";
        const avgSentenceLength = sentenceCount > 0 ? Math.round(wordCount / sentenceCount) : 0;
        const estimatedReadingTime = Math.max(1, Math.ceil(wordCount / 200));

        context.textMeta = {
            language,
            wordCount,
            sentenceCount,
            charCount,
            paragraphCount,
            avgSentenceLength,
            emptyInput: false,
            estimatedReadingTime,
            lengthCategory,
            processingTimeMs: performance.now() - t0
        };

        Logger.log(
            `[Step 2 Analyzer] ${language} | Words: ${wordCount} | Sentences: ${sentenceCount} | InputType: ${context.meta?.inputType || 'text'}`,
            "info"
        );

        setPipelineState("PROCESSING");
        await routeToStep3(context);

    } catch (err) {
        Logger.log(`[Step 2 Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}

registerGeoRoutingHandler(handleGeoRouting);
