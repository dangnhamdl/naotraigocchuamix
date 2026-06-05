/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: WIKI SEARCH WRITE (SYNONYM OPTIMIZER)
 * ============================================================================
 * File: /nktg-ai/step8-wiki-search-write.js
 * Purpose: Tối ưu các câu bị bỏ bằng cách thay token DAMP → synonym
 *
 * Luồng:
 *   base.baseSentences     — 8 câu đã chọn (giữ nguyên)
 *   base.sentenceScores    — 22 câu tất cả
 *   base.tokenScores       — token với state/energy
 *
 *   rejectedSentences = 22 - 8 = 14 câu bị bỏ
 *
 *   for mỗi câu trong rejectedSentences (tuần tự):
 *     → tìm token DAMP trong câu
 *     → for mỗi token DAMP (tuần tự):
 *         → tra synonym: Wikidata SPARQL → fallback Wiktionary
 *         → thay token → score lại
 *         → tăng → giữ câu mới, không tăng → giữ kết quả trước
 *     → so sánh score cuối vs score gốc:
 *         → tăng → đưa vào optimizedPool
 *         → không tăng → loại câu
 *
 * Fallback chain:
 *   Wikidata SPARQL (CORS OK, public)
 *   → bị chặn → Wiktionary REST API (CORS OK, public)
 *   → nguồn 3 (từ điển riêng) — bổ sung sau
 *
 * Export:
 *   optimizeRejectedSentences(base) → Promise<optimizedPool[]>
 *   optimizedPool: [{ sentence: string, score: number }]
 */

import { Logger } from './step1-init.js';

const TIMEOUT_MS = 5000; // timeout mỗi fetch

// ============================================================================
// SCORE SENTENCE — tổng energy tất cả token, không filter state
// (copy từ step8-output-layer-write.js để module độc lập)
// ============================================================================
function countTokens(text) {
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu)?.length || 1;
}

function scoreSentenceAll(sentence, tokenScores) {
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

// ============================================================================
// FETCH VỚI TIMEOUT
// ============================================================================
function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
}

// ============================================================================
// NGUỒN 1 — Wikidata SPARQL
// Lấy synonym của token theo Lexeme
// ============================================================================
async function fetchSynonymsWikidata(token, lang) {
    // Map lang code sang Wikidata language code
    const langCode = lang === 'vi' ? 'vi' :
                     lang === 'en' ? 'en' :
                     lang === 'fr' ? 'fr' :
                     lang === 'de' ? 'de' :
                     lang === 'zh' ? 'zh' :
                     lang === 'ja' ? 'ja' :
                     lang === 'ko' ? 'ko' : 'en'; // fallback en

    const query = `
SELECT DISTINCT ?synonym WHERE {
  ?lexeme a ontolex:LexicalEntry ;
          wikibase:lemma "${token}"@${langCode} ;
          ontolex:sense ?sense .
  ?sense wdt:P5973 ?synSense .
  ?synLexeme ontolex:sense ?synSense ;
             wikibase:lemma ?synonym .
  FILTER(LANG(?synonym) = "${langCode}")
  FILTER(?synonym != "${token}"@${langCode})
}
LIMIT 10
`.trim();

    const url = 'https://query.wikidata.org/sparql?query=' +
        encodeURIComponent(query) +
        '&format=json';

    const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/sparql-results+json' }
    });

    if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);

    const data = await res.json();
    const synonyms = (data.results?.bindings || [])
        .map(b => b.synonym?.value)
        .filter(Boolean)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.toLowerCase() !== token.toLowerCase());

    return synonyms; // [] nếu không tìm thấy — không phải bị chặn
}

// ============================================================================
// NGUỒN 2 — Wiktionary REST API
// https://en.wiktionary.org/api/rest_v1/page/definition/{token}
// ============================================================================
async function fetchSynonymsWiktionary(token, lang) {
    // Wiktionary dùng lang code 2 ký tự
    const langCode = lang === 'vi' ? 'vi' :
                     lang === 'zh' ? 'zh' :
                     lang === 'ja' ? 'ja' :
                     lang === 'ko' ? 'ko' :
                     lang === 'fr' ? 'fr' :
                     lang === 'de' ? 'de' : 'en';

    const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(token)}`;

    const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) throw new Error(`Wiktionary HTTP ${res.status}`);

    const data = await res.json();

    // data là object { "en": [...], "vi": [...], ... }
    // Mỗi entry có { partOfSpeech, definitions: [{ definition, parsedExamples, synonyms }] }
    const entries = data[langCode] || data['en'] || [];
    const synonyms = [];

    for (const entry of entries) {
        for (const def of (entry.definitions || [])) {
            for (const syn of (def.synonyms || [])) {
                // syn có thể là string hoặc object { word }
                const word = typeof syn === 'string' ? syn : syn.word;
                if (word && word.toLowerCase() !== token.toLowerCase()) {
                    synonyms.push(word.trim());
                }
            }
        }
    }

    // Deduplicate
    return [...new Set(synonyms)].slice(0, 10);
}

// ============================================================================
// FALLBACK CHAIN — Wikidata → Wiktionary → (nguồn riêng sau)
// Phân biệt: bị chặn (throw) vs không tìm được (return [])
// ============================================================================
async function fetchSynonyms(token, lang) {
    // Nguồn 1: Wikidata SPARQL
    try {
        const synonyms = await fetchSynonymsWikidata(token, lang);
        Logger.log(`[Wiki] Wikidata OK: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        // Bị chặn (abort/network/CORS) → thử nguồn 2
        Logger.log(`[Wiki] Wikidata blocked (${err.message}) → fallback Wiktionary`, 'warn');
    }

    // Nguồn 2: Wiktionary REST
    try {
        const synonyms = await fetchSynonymsWiktionary(token, lang);
        Logger.log(`[Wiki] Wiktionary OK: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        // Bị chặn → nguồn 3 (chưa có)
        Logger.log(`[Wiki] Wiktionary blocked (${err.message}) → no more sources`, 'warn');
    }

    // Nguồn 3: từ điển riêng — bổ sung sau
    // try { ... } catch { ... }

    return []; // tất cả nguồn đều bị chặn hoặc không tìm được
}

// ============================================================================
// TỐI ƯU 1 CÂU — xử lý tuần tự từng token DAMP
// ============================================================================
async function optimizeSentence(sentence, tokenScores, lang) {
    // Tìm token DAMP xuất hiện trong câu
    const dampTokens = Object.entries(tokenScores)
        .filter(([token, data]) =>
            data.state === 'DAMPING' &&
            sentence.toLowerCase().includes(token.toLowerCase())
        )
        .map(([token]) => token);

    if (dampTokens.length === 0) {
        // Không có token DAMP → không tối ưu được
        return null;
    }

    const originalScore = scoreSentenceAll(sentence, tokenScores);
    let currentSentence = sentence;
    let currentScore    = originalScore;

    // Xử lý tuần tự từng token DAMP
    for (const dampToken of dampTokens) {
        const synonyms = await fetchSynonyms(dampToken, lang);

        if (synonyms.length === 0) {
            // Không tìm được synonym → giữ nguyên currentSentence, tiếp tục token kế
            Logger.log(`[Wiki Optimize] "${dampToken}" → no synonyms, skip`, 'info');
            continue;
        }

        // Thử từng synonym, lấy cái cho score cao nhất
        let bestSentence = currentSentence;
        let bestScore    = currentScore;

        for (const synonym of synonyms) {
            // Replace token trong câu — case-insensitive, giữ cấu trúc câu
            const regex = new RegExp(
                dampToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'gi'
            );
            const trySentence = currentSentence.replace(regex, synonym);
            const tryScore    = scoreSentenceAll(trySentence, tokenScores);

            if (tryScore > bestScore) {
                bestScore    = tryScore;
                bestSentence = trySentence;
            }
        }

        if (bestScore > currentScore) {
            Logger.log(
                `[Wiki Optimize] "${dampToken}" → "${currentSentence.slice(0, 30)}..." score ${currentScore.toFixed(4)} → ${bestScore.toFixed(4)}`,
                'success'
            );
            currentSentence = bestSentence;
            currentScore    = bestScore;
        } else {
            Logger.log(`[Wiki Optimize] "${dampToken}" → no improvement, keep current`, 'info');
        }
    }

    // So sánh kết quả cuối vs câu gốc ban đầu
    if (currentScore > originalScore) {
        return { sentence: currentSentence, score: currentScore };
    }

    // Không tối ưu được → loại câu
    Logger.log(`[Wiki Optimize] Sentence dropped (no net improvement)`, 'info');
    return null;
}

// ============================================================================
// MAIN EXPORT — tối ưu toàn bộ câu bị bỏ, tuần tự từng câu
// ============================================================================
export async function optimizeRejectedSentences(base) {
    const { baseSentences, sentenceScores, tokenScores } = base;
    const lang = base.lang || 'en';

    // Lấy 14 câu bị bỏ — giữ thứ tự gốc từ sentenceScores
    const rejectedSentences = Object.keys(sentenceScores)
        .filter(s => !baseSentences.includes(s));

    Logger.log(
        `[Wiki Search] Bắt đầu tối ưu ${rejectedSentences.length} câu bị bỏ...`,
        'info'
    );

    const optimizedPool = [];

    // Tuần tự — xong câu này mới sang câu kế
    for (let i = 0; i < rejectedSentences.length; i++) {
        const sentence = rejectedSentences[i];
        Logger.log(
            `[Wiki Search] Câu ${i + 1}/${rejectedSentences.length}: "${sentence.slice(0, 40)}..."`,
            'info'
        );

        const result = await optimizeSentence(sentence, tokenScores, lang);

        if (result) {
            optimizedPool.push(result);
            Logger.log(
                `[Wiki Search] ✓ Câu ${i + 1} tối ưu OK → pool (${optimizedPool.length})`,
                'success'
            );
        } else {
            Logger.log(`[Wiki Search] ✗ Câu ${i + 1} bị loại`, 'info');
        }
    }

    Logger.log(
        `[Wiki Search] Hoàn tất: ${optimizedPool.length}/${rejectedSentences.length} câu vào optimizedPool`,
        'success'
    );

    return optimizedPool;
    // optimizedPool: [{ sentence: string, score: number }]
    // → mixLayer() dùng pool này cho Expanded/Comprehensive
}
