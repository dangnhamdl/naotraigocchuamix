/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: WIKI SEARCH WRITE (SYNONYM OPTIMIZER)
 * ============================================================================
 * File: /nktg-ai/step8-wiki-search-write.js
 * Purpose: Tối ưu các câu bị bỏ bằng cách thay token DAMP → synonym
 *
 * Fallback chain (hiện tại tiếng Anh):
 *   Nguồn 1: Free Dictionary API  — public, CORS OK, JSON có synonyms sẵn
 *   Nguồn 2: Wiktionary MediaWiki — fallback khi nguồn 1 bị chặn
 *   Nguồn 3: từ điển riêng       — bổ sung sau
 *
 * Phân biệt:
 *   bị chặn   → throw  → thử nguồn kế
 *   không có  → return [] → câu bị loại (không fallback)
 *
 * Export:
 *   optimizeRejectedSentences(base) → Promise<optimizedPool[]>
 *   optimizedPool: [{ sentence: string, score: number }]
 */

import { Logger } from './step1-init.js';

const TIMEOUT_MS = 6000;

// ============================================================================
// SCORE SENTENCE — tổng energy tất cả token, không filter state
// ============================================================================
function countTokens(text) {
    return text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|\p{L}+|\p{N}+/gu)?.length || 1;
}

function scoreSentenceAll(sentence, tokenScores) {
    const lower = sentence.toLowerCase();
    let totalEnergy = 0;
    let matchCount  = 0;
    for (const [token, data] of Object.entries(tokenScores)) {
        if (lower.includes(token.toLowerCase())) {
            totalEnergy += Math.max(0, data.energy + 3);
            matchCount++;
        }
    }
    const wordCount = countTokens(sentence);
    const density   = matchCount > 0 ? matchCount / wordCount : 0;
    return totalEnergy * density;
}

// ============================================================================
// FETCH VỚI TIMEOUT
// ============================================================================
function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
}

// ============================================================================
// NGUỒN 1 — Free Dictionary API (synonyms cấp meaning)
// https://api.dictionaryapi.dev/api/v2/entries/en/{word}
// Chỉ lấy synonyms cấp meaning — synonym thật sự, không lấy cấp definition
// ============================================================================
async function fetchSynonymsFreeDictionary(token) {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;

    const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
    });

    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`FreeDictionary HTTP ${res.status}`);

    const data = await res.json();
    const synonyms = new Set();

    for (const entry of (Array.isArray(data) ? data : [])) {
        for (const meaning of (entry.meanings || [])) {
            for (const syn of (meaning.synonyms || [])) {
                if (syn && syn.toLowerCase() !== token.toLowerCase()) {
                    synonyms.add(syn.trim());
                }
            }
        }
    }

    return [...synonyms].slice(0, 10);
}

// ============================================================================
// NGUỒN 2 — dictionaryapi.dev (POS) + Datamuse (synonyms filter theo POS)
//
// Bước 1: dictionaryapi.dev → xác định POS của token
//   GET https://api.dictionaryapi.dev/api/v2/entries/en/{word}
//   Lấy partOfSpeech từ meaning đầu tiên có nhiều definitions nhất
//
// Bước 2: Datamuse → lấy synonyms đúng POS
//   GET https://api.datamuse.com/words?rel_syn={word}&md=p
//   Filter: chỉ giữ synonym có tags chứa đúng POS của token
//
// Map POS: noun→n | verb→v | adjective→adj | adverb→adv
// ============================================================================

// Map partOfSpeech từ dictionaryapi.dev sang Datamuse tag
const POS_MAP = {
    'noun':      'n',
    'verb':      'v',
    'adjective': 'adj',
    'adverb':    'adv',
    'pronoun':   'n',   // pronoun xử lý như noun
};

async function fetchSynonymsSource1(token) {
    // ── Bước 1: xác định POS từ dictionaryapi.dev ──
    const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;

    const dictRes = await fetchWithTimeout(dictUrl, {
        headers: { 'Accept': 'application/json' }
    });

    // 404 = từ không có trong từ điển → return [] (không phải bị chặn)
    if (dictRes.status === 404) return [];

    // Lỗi mạng/server → throw để fallback nguồn 2
    if (!dictRes.ok) throw new Error(`DictAPI HTTP ${dictRes.status}`);

    const dictData = await dictRes.json();
    if (!Array.isArray(dictData) || dictData.length === 0) return [];

    // Lấy POS từ meaning có nhiều definitions nhất — meaning chính của từ
    let detectedPOS = null;
    let maxDefs = 0;
    for (const entry of dictData) {
        for (const meaning of (entry.meanings || [])) {
            const defCount = (meaning.definitions || []).length;
            if (defCount > maxDefs) {
                maxDefs = defCount;
                detectedPOS = meaning.partOfSpeech;
            }
        }
    }

    if (!detectedPOS) return []; // không xác định được POS → không thay

    const datamuseTag = POS_MAP[detectedPOS.toLowerCase()];
    if (!datamuseTag) return []; // POS không hỗ trợ (conjunction, preposition...) → bỏ qua

    // ── Bước 2: lấy synonyms từ Datamuse, filter theo POS ──
    const datamuseUrl = `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(token.toLowerCase())}&md=p&max=20`;

    const datamuseRes = await fetchWithTimeout(datamuseUrl, {
        headers: { 'Accept': 'application/json' }
    });

    if (!datamuseRes.ok) throw new Error(`Datamuse HTTP ${datamuseRes.status}`);

    const datamuseData = await datamuseRes.json();

    // Filter: chỉ giữ synonym cùng POS với token gốc
    // Bỏ cụm từ nhiều hơn 1 từ (có space)
    const synonyms = (Array.isArray(datamuseData) ? datamuseData : [])
        .filter(item => {
            if (!item.word) return false;
            if (item.word.includes(' ')) return false; // bỏ cụm từ
            if (item.word.toLowerCase() === token.toLowerCase()) return false;
            const tags = item.tags || [];
            return tags.includes(datamuseTag);
        })
        .map(item => item.word.trim())
        .slice(0, 10);

    return synonyms;
}

// ============================================================================
// NGUỒN 2 — Wiktionary MediaWiki API
// Parse wikitext lấy section Synonyms
// https://en.wiktionary.org/w/api.php?action=parse&page={token}&prop=wikitext&format=json&origin=*
// ============================================================================
async function fetchSynonymsWiktionary(token) {
    const url = `https://en.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;

    const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) throw new Error(`Wiktionary HTTP ${res.status}`);

    const data = await res.json();

    if (data.error) return []; // trang không tồn tại → không phải bị chặn

    const wikitext = data.parse?.wikitext?.['*'] || '';

    // Tìm section ====Synonyms==== hoặc ===Synonyms===
    // Wikitext synonym format: * {{l|en|word}} hoặc [[word]] hoặc {{syn|en|word1|word2}}
    const synonyms = new Set();

    // Extract từ {{syn|en|word1|word2|...}}
    const synTemplates = wikitext.matchAll(/\{\{syn\|en\|([^}]+)\}\}/gi);
    for (const match of synTemplates) {
        const parts = match[1].split('|');
        for (const part of parts) {
            const word = part.trim().replace(/^[\s*#:]+/, '');
            if (word && !word.includes('=') && word.toLowerCase() !== token.toLowerCase()) {
                synonyms.add(word);
            }
        }
    }

    // Extract từ {{l|en|word}}
    const linkTemplates = wikitext.matchAll(/\{\{l\|en\|([^|}]+)\}\}/gi);
    for (const match of linkTemplates) {
        const word = match[1].trim();
        if (word && word.toLowerCase() !== token.toLowerCase()) {
            synonyms.add(word);
        }
    }

    // Chỉ lấy synonyms trong section Synonyms
    const synSection = wikitext.match(/={2,4}Synonyms={2,4}([\s\S]*?)(?:={2,4}|$)/i);
    if (synSection) {
        const wikiLinks = synSection[1].matchAll(/\[\[([^\]|#]+)/g);
        for (const match of wikiLinks) {
            const word = match[1].trim();
            if (word && word.toLowerCase() !== token.toLowerCase()) {
                synonyms.add(word);
            }
        }
    }

    return [...synonyms].slice(0, 10);
}

// ============================================================================
// FALLBACK CHAIN
// Nguồn 1 (FreeDictionary) → bị chặn → Nguồn 2 (Wiktionary) → bị chặn → []
// Nếu nguồn trả về [] (không tìm thấy) → return [] ngay, không fallback
// ============================================================================
async function fetchSynonyms(token, lang) {
    // Bỏ qua token quá ngắn, số, stop words phổ biến
    const stopWords = new Set([
        'a','an','the','is','are','was','were','be','been','being',
        'it','its','this','that','these','those','i','we','you','he',
        'she','they','and','or','but','not','for','in','on','at','to',
        'of','as','by','with','from','up','out','if','do','did','has',
        'had','have','will','would','could','should','may','might','s'
    ]);

    if (token.length < 3) return [];
    if (/^\d+$/.test(token)) return [];
    if (stopWords.has(token.toLowerCase())) return [];

    // Nguồn 1: Free Dictionary API — synonyms cấp meaning
    try {
        const synonyms = await fetchSynonymsFreeDictionary(token);
        Logger.log(`[Wiki] FreeDictionary: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms; // kể cả [] — không tìm được → không fallback
    } catch (err) {
        // Bị chặn → thử nguồn 2
        Logger.log(`[Wiki] FreeDictionary blocked (${err.message}) → fallback Source2`, 'warn');
    }

    // Nguồn 2: dictionaryapi.dev (POS) + Datamuse
    try {
        const synonyms = await fetchSynonymsSource1(token);
        Logger.log(`[Wiki] Source2 (DictAPI+Datamuse): "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        Logger.log(`[Wiki] Source2 blocked (${err.message}) → fallback Wiktionary`, 'warn');
    }

    // Nguồn 3: Wiktionary MediaWiki
    try {
        const synonyms = await fetchSynonymsWiktionary(token);
        Logger.log(`[Wiki] Wiktionary: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        Logger.log(`[Wiki] Wiktionary blocked (${err.message}) → no more sources`, 'warn');
    }

    // Nguồn 3: từ điển riêng — bổ sung sau
    // try { const synonyms = await fetchSynonymsCustom(token, lang); return synonyms; } catch { ... }

    return [];
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

    if (dampTokens.length === 0) return null;

    const originalScore = scoreSentenceAll(sentence, tokenScores);
    let currentSentence = sentence;
    let currentScore    = originalScore;
    const replacements  = []; // [{ original, replacement }]

    // Tuần tự từng token DAMP
    for (const dampToken of dampTokens) {
        const synonyms = await fetchSynonyms(dampToken, lang);

        if (synonyms.length === 0) {
            Logger.log(`[Wiki Optimize] "${dampToken}" → no synonyms, skip`, 'info');
            continue;
        }

        // Thử từng synonym, lấy cái cho score cao nhất
        let bestSentence  = currentSentence;
        let bestScore     = currentScore;
        let bestSynonym   = null;

        for (const synonym of synonyms) {
            const regex = new RegExp(
                dampToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'gi'
            );
            const trySentence = currentSentence.replace(regex, synonym);
            const tryScore    = scoreSentenceAll(trySentence, tokenScores);

            if (tryScore > bestScore) {
                bestScore    = tryScore;
                bestSentence = trySentence;
                bestSynonym  = synonym;
            }
        }

        if (bestScore > currentScore && bestSynonym) {
            Logger.log(
                `[Wiki Optimize] "${dampToken}" → score ${currentScore.toFixed(4)} → ${bestScore.toFixed(4)}`,
                'success'
            );
            replacements.push({ original: dampToken, replacement: bestSynonym });
            currentSentence = bestSentence;
            currentScore    = bestScore;
        } else {
            Logger.log(`[Wiki Optimize] "${dampToken}" → no improvement`, 'info');
        }
    }

    // So sánh kết quả cuối vs câu gốc ban đầu
    if (currentScore > originalScore) {
        return {
            sentence: currentSentence,         // câu đã thay từ — dùng để render
            originalSentence: sentence,         // câu gốc — key trong sentenceScores
            score: currentScore,
            replacements
        };
    }

    Logger.log(`[Wiki Optimize] Sentence dropped (no net improvement)`, 'info');
    return null;
}

// ============================================================================
// MAIN EXPORT
// ============================================================================
export async function optimizeRejectedSentences(base) {
    const { baseSentences, sentenceScores, tokenScores } = base;
    const lang = base.lang || 'en';

    const rejectedSentences = Object.keys(sentenceScores)
        .filter(s => !baseSentences.includes(s));

    Logger.log(`[Wiki Search] Bắt đầu tối ưu ${rejectedSentences.length} câu bị bỏ...`, 'info');

    const optimizedPool = [];

    for (let i = 0; i < rejectedSentences.length; i++) {
        const sentence = rejectedSentences[i];
        Logger.log(
            `[Wiki Search] Câu ${i + 1}/${rejectedSentences.length}: "${sentence.slice(0, 50)}..."`,
            'info'
        );

        const result = await optimizeSentence(sentence, tokenScores, lang);

        if (result) {
            optimizedPool.push(result);
            Logger.log(`[Wiki Search] ✓ Câu ${i + 1} tối ưu OK → pool (${optimizedPool.length})`, 'success');
        } else {
            Logger.log(`[Wiki Search] ✗ Câu ${i + 1} bị loại`, 'info');
        }
    }

    Logger.log(
        `[Wiki Search] Hoàn tất: ${optimizedPool.length}/${rejectedSentences.length} câu vào optimizedPool`,
        'success'
    );

    return optimizedPool;
}
