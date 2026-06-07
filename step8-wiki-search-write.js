/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: WIKI SEARCH (SYNONYM FINDER)
 * ============================================================================
 * Chức năng duy nhất: tìm synonym cho token
 * Export: fetchSynonyms(token, lang) → Promise<string[]>
 *
 * Fallback chain (lang = 'en'):
 *   Nguồn 1: Free Dictionary API  — public, CORS OK
 *   Nguồn 2: dictionaryapi.dev + Datamuse — fallback
 *   Nguồn 3: Wiktionary MediaWiki — fallback
 *
 * Fallback chain (lang = 'vi'):
 *   Nguồn VI-1: vi.wiktionary.org — ưu tiên
 *   Nguồn VI-2: HuggingFace CDN  — fallback (thêm sau khi upload dict)
 */

import { Logger } from './step1-init.js';

const TIMEOUT_MS = 6000;

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
// GLOBAL BLACKLIST — 2 nhóm: từ cổ/archaic + data noise từ API
// ============================================================================
const ARCHAIC_WORDS = [
    'tether', 'atween', 'prostrate', 'wayfare', 'assail',
    'twelvemonth', 'foretime', 'behold', 'laze',
    'withouten', 'perchance', 'mayhap', 'thrice',
    'whilom', 'betwixt', 'amongst', 'whilst', 'perforce',
    'forsooth', 'henceforth', 'thereupon', 'whereupon'
];

const CONTEXT_NOISE = [
    'pristine', 'terminal', 'commoners', 'bergh',
    'dominator', 'paginate', 'denomination', 'eke',
    'flashy',
];

const GLOBAL_BLACKLIST = new Set([...ARCHAIC_WORDS, ...CONTEXT_NOISE]);

// ============================================================================
// PRE-FILTER — chặn token không phải base form trước khi gọi API
// ============================================================================
const PRE_FILTER_EXCEPTIONS = new Set([
    'her', 'over', 'under', 'after', 'butter', 'water',
    'father', 'mother', 'sister', 'brother', 'offer', 'order',
    'other', 'rather', 'either', 'never', 'ever', 'river',
    'cover', 'power', 'flower', 'answer', 'center', 'enter',
    'winter', 'wonder', 'tender', 'gender', 'cancer', 'proper',
    'super', 'paper', 'fever', 'best', 'rest', 'test', 'west',
    'chest', 'forest', 'harvest', 'interest', 'manifest', 'protest'
]);

function preFilterToken(token) {
    const t = token.toLowerCase();
    if (t.length < 3) return false;
    if (PRE_FILTER_EXCEPTIONS.has(t)) return true;
    if (t.endsWith('ing') && t.length > 4) return false;
    if (t.endsWith('ed')  && t.length > 3) return false;
    if (t.endsWith('er')  && t.length > 4) return false;
    if (t.endsWith('est') && t.length > 5) return false;
    const sExceptions = new Set([
        'this','his','was','has','as','us','bus','yes','its','plus',
        'thus','versus','campus','focus','bonus','virus','status',
        'census','chorus','corpus','nexus','radius','stimulus'
    ]);
    if (t.endsWith('s') && t.length > 3 && !sExceptions.has(t)) return false;
    return true;
}

// ============================================================================
// NGUỒN 1 — Free Dictionary API
// ============================================================================
async function fetchSynonymsFreeDictionary(token) {
    if (!preFilterToken(token)) return [];

    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });

    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`FreeDictionary HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0 || !data[0].word) return [];

    // API-as-Truth
    if (data[0].word.toLowerCase() !== token.toLowerCase()) return [];

    // POS Match — chỉ lấy synonym nếu token có 1 POS duy nhất
    const SUPPORTED_POS = new Set(['noun', 'verb', 'adjective', 'adverb']);
    const posSynCount = new Map();
    const posSynMap   = new Map();
    for (const entry of data) {
        for (const meaning of (entry.meanings || [])) {
            const pos = meaning.partOfSpeech?.toLowerCase();
            if (!pos || !SUPPORTED_POS.has(pos)) continue;
            const syns = (meaning.synonyms || []).filter(s => s && s.toLowerCase() !== token.toLowerCase());
            if (!posSynMap.has(pos)) posSynMap.set(pos, new Set());
            for (const s of syns) posSynMap.get(pos).add(s.trim());
            posSynCount.set(pos, (posSynCount.get(pos) || 0) + syns.length);
        }
    }

    if (posSynCount.size === 0) return [];
    if (posSynCount.size > 1)   return []; // multi-POS → không chắc → bỏ

    const targetPOS = [...posSynCount.keys()][0];
    const synonyms  = posSynMap.get(targetPOS) || new Set();

    // Final sanitization
    const lowerToken     = token.toLowerCase();
    const BLOCKED_SUFFIXES = ['ish', 'er', 'est', 'ed', 'ing'];
    return [...synonyms].filter(syn => {
        const lower = syn.toLowerCase();
        if (GLOBAL_BLACKLIST.has(lower)) return false;
        if (syn.includes(' ') || syn.includes('-')) return false;
        for (const suffix of BLOCKED_SUFFIXES) {
            if (lower.endsWith(suffix) && !lowerToken.endsWith(suffix)) return false;
        }
        return true;
    }).slice(0, 10);
}

// ============================================================================
// NGUỒN 2 — dictionaryapi.dev + Datamuse
// ============================================================================
const POS_MAP = {
    'noun': 'n', 'verb': 'v', 'adjective': 'adj', 'adverb': 'adv', 'pronoun': 'n',
};

async function fetchSynonymsSource2(token) {
    const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;
    const dictRes = await fetchWithTimeout(dictUrl, { headers: { 'Accept': 'application/json' } });
    if (dictRes.status === 404) return [];
    if (!dictRes.ok) throw new Error(`DictAPI HTTP ${dictRes.status}`);
    const dictData = await dictRes.json();
    if (!Array.isArray(dictData) || dictData.length === 0) return [];

    let detectedPOS = null;
    let maxDefs = 0;
    for (const entry of dictData) {
        for (const meaning of (entry.meanings || [])) {
            const defCount = (meaning.definitions || []).length;
            if (defCount > maxDefs) { maxDefs = defCount; detectedPOS = meaning.partOfSpeech; }
        }
    }
    if (!detectedPOS) return [];

    const datamuseTag = POS_MAP[detectedPOS.toLowerCase()];
    if (!datamuseTag) return [];

    const datamuseUrl = `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(token.toLowerCase())}&md=p&max=20`;
    const datamuseRes = await fetchWithTimeout(datamuseUrl, { headers: { 'Accept': 'application/json' } });
    if (!datamuseRes.ok) throw new Error(`Datamuse HTTP ${datamuseRes.status}`);

    const datamuseData = await datamuseRes.json();
    return (Array.isArray(datamuseData) ? datamuseData : [])
        .filter(item => item.word && !item.word.includes(' ') &&
            item.word.toLowerCase() !== token.toLowerCase() &&
            (item.tags || []).includes(datamuseTag))
        .map(item => item.word.trim())
        .slice(0, 10);
}

// ============================================================================
// NGUỒN 3 — Wiktionary
// ============================================================================
async function fetchSynonymsWiktionary(token) {
    const url = `https://en.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Wiktionary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return [];

    const wikitext = data.parse?.wikitext?.['*'] || '';

    // Kiểm tra từ hợp lệ — loại namespace prefix, cụm từ, ký tự lạ
    function isValidSyn(word) {
        if (!word) return false;
        if (word.includes(':')) return false;          // Thesaurus:xxx, Category:xxx
        if (word.includes(' ')) return false;          // cụm từ
        if (word.includes('-')) return false;          // từ ghép
        if (word.includes('=')) return false;          // template param
        if (word.toLowerCase() === token.toLowerCase()) return false;
        if (word.length < 2 || word.length > 20) return false;
        if (!/^[a-zA-Z]+$/.test(word)) return false;  // chỉ chữ cái Latin
        return true;
    }

    const synonyms = new Set();

    // Chỉ lấy từ trong {{syn|en|...}} — nguồn đáng tin cậy nhất
    const synTemplates = wikitext.matchAll(/\{\{syn\|en\|([^}]+)\}\}/gi);
    for (const match of synTemplates) {
        for (const part of match[1].split('|')) {
            const word = part.trim().replace(/^[\s*#:]+/, '');
            if (isValidSyn(word)) synonyms.add(word);
        }
    }

    // Chỉ lấy {{l|en|...}} và [[...]] trong section Synonyms — tránh lấy lan sang section khác
    const synSection = wikitext.match(/={2,4}Synonyms={2,4}([\s\S]*?)(?:={2,4}[^=])/i);
    if (synSection) {
        const linkTemplates = synSection[1].matchAll(/\{\{l\|en\|([^|}]+)\}\}/gi);
        for (const match of linkTemplates) {
            const word = match[1].trim();
            if (isValidSyn(word)) synonyms.add(word);
        }
        const wikiLinks = synSection[1].matchAll(/\[\[([^\]|#]+)/g);
        for (const match of wikiLinks) {
            const word = match[1].trim();
            if (isValidSyn(word)) synonyms.add(word);
        }
    }

    return [...synonyms].slice(0, 10);
}

// ============================================================================
// NGUỒN VI-1 — vi.wiktionary.org (tiếng Việt)
// ============================================================================
const VI_STOP_WORDS = new Set([
    'và','hoặc','nhưng','vì','nên','để','mà','thì','là','của',
    'trong','ngoài','trên','dưới','với','từ','đến','về','cho',
    'không','có','được','bị','đã','đang','sẽ','vẫn','cũng','đều',
    'này','đó','kia','đây','ở','tại','qua','theo','sau','trước',
    'một','hai','ba','bốn','năm','nhiều','ít','mỗi','các','những',
    'tôi','bạn','anh','chị','ông','bà','họ','chúng','mình','ta',
    'gì','nào','ai','khi','như','vậy','thế','rất','quá','lắm',
]);

async function fetchSynonymsViWiktionary(token) {
    const url = `https://vi.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`vi.Wiktionary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return [];

    const wikitext = data?.parse?.wikitext?.['*'] || '';
    const synonyms = new Set();

    function isValidVi(word) {
        if (!word || word.length < 2 || word.length > 40) return false;
        if (word.toLowerCase() === token.toLowerCase()) return false;
        if (word.includes(':') || word.includes('=')) return false;
        if (/^\d+$/.test(word)) return false;
        if (!/\p{L}/u.test(word)) return false;
        return true;
    }

    function cleanVi(raw) {
        return raw.trim()
            .replace(/^\s*[\*#:;\|]+\s*/, '')
            .replace(/\{\{[^}]*\}\}/g, '')
            .replace(/[[\]{}]/g, '')
            .replace(/\s+/g, ' ').trim();
    }

    // Tìm section ===Từ đồng nghĩa===
    const section = (wikitext.match(
        /={2,4}\s*Từ đồng nghĩa\s*={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i
    ) || [])[1] || '';

    if (section) {
        // {{đồng nghĩa|từ1|từ2}} hoặc {{syn|từ1|từ2}}
        for (const m of section.matchAll(/\{\{(?:đồng nghĩa|syn)[^}]*\|([^}]+)\}\}/gi))
            for (const p of m[1].split('|')) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }
        // [[từ]] hoặc [[từ|text]]
        for (const m of section.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g))
            { const w = cleanVi(m[1]); if (isValidVi(w)) synonyms.add(w); }
        // bullet: * từ1, từ2
        for (const line of section.split('\n')) {
            if (!line.trim().startsWith('*')) continue;
            const plain = line.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
                              .replace(/\{\{[^}]+\}\}/g, '').replace(/^\s*\*+\s*/, '');
            for (const p of plain.split(/[,;\/]/)) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }
        }
    }

    // Fallback: {{đồng nghĩa|...}} ở bất kỳ đâu
    if (synonyms.size === 0)
        for (const m of wikitext.matchAll(/\{\{(?:đồng nghĩa|syn)[^}]*\|([^}]+)\}\}/gi))
            for (const p of m[1].split('|')) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }

    return [...synonyms].slice(0, 12);
}

// ============================================================================
// NGUỒN EN-HF — HuggingFace dict tiếng Anh (ưu tiên trước API)
// Cache 1 lần vào memory — 91,062 từ, 6.7MB
// ============================================================================
const HF_EN_URL = 'https://huggingface.co/datasets/xanhnon/visynonym/resolve/main/en-synonyms.json';

let _enDictCache   = null;
let _enDictLoading = null;

async function loadEnDictFromHF() {
    if (_enDictCache) return _enDictCache;
    if (_enDictLoading) return _enDictLoading;
    _enDictLoading = (async () => {
        const res = await fetchWithTimeout(HF_EN_URL, { headers: { 'Accept': 'application/json' } }, 15000);
        if (!res.ok) throw new Error(`HuggingFace EN HTTP ${res.status}`);
        _enDictCache   = await res.json();
        _enDictLoading = null;
        Logger.log(`[Wiki-EN] HF dict loaded — ${Object.keys(_enDictCache).length} entries`, 'info');
        return _enDictCache;
    })();
    return _enDictLoading;
}

async function fetchSynonymsEnHuggingFace(token) {
    const dict = await loadEnDictFromHF();
    const key  = token.toLowerCase().trim();
    return dict[key] || [];
}

// ============================================================================
// FALLBACK CHAIN — public export
// ============================================================================
const stopWords = new Set([
    'a','an','the','is','are','was','were','be','been','being',
    'it','its','this','that','these','those','i','we','you','he',
    'she','they','and','or','but','not','for','in','on','at','to',
    'of','as','by','with','from','up','out','if','do','did','has',
    'had','have','will','would','could','should','may','might','s'
]);

export async function fetchSynonyms(token, lang) {
    if (!token || token.length < 2) return [];
    if (/^\d+$/.test(token)) return [];

    // ── TIẾNG VIỆT ──────────────────────────────────────────────────────────
    if (lang === 'vi') {
        if (VI_STOP_WORDS.has(token.toLowerCase())) return [];
        try {
            const synonyms = await fetchSynonymsViWiktionary(token);
            Logger.log(`[Wiki-VI] vi.Wiktionary: "${token}" → ${synonyms.length} synonym(s)`, 'info');
            return synonyms;
        } catch (err) {
            Logger.log(`[Wiki-VI] vi.Wiktionary blocked (${err.message}) → no VI source`, 'warn');
        }
        return [];
    }

    // ── TIẾNG ANH ────────────────────────────────────────────────────────────
    if (token.length < 3) return [];
    if (stopWords.has(token.toLowerCase())) return [];

    // EN-1: HuggingFace dict — ưu tiên (91,062 từ, O(1))
    try {
        const synonyms = await fetchSynonymsEnHuggingFace(token);
        Logger.log(`[Wiki-EN] HuggingFace: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        if (synonyms.length > 0) return synonyms;
    } catch (err) {
        Logger.log(`[Wiki-EN] HuggingFace blocked (${err.message}) → fallback FreeDictionary`, 'warn');
    }

    // EN-2: Free Dictionary API — fallback
    try {
        const synonyms = await fetchSynonymsFreeDictionary(token);
        Logger.log(`[Wiki] FreeDictionary: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        Logger.log(`[Wiki] FreeDictionary blocked (${err.message}) → fallback Source2`, 'warn');
    }

    try {
        const synonyms = await fetchSynonymsSource2(token);
        Logger.log(`[Wiki] Source2 (DictAPI+Datamuse): "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        Logger.log(`[Wiki] Source2 blocked (${err.message}) → fallback Wiktionary`, 'warn');
    }

    try {
        const synonyms = await fetchSynonymsWiktionary(token);
        Logger.log(`[Wiki] Wiktionary: "${token}" → ${synonyms.length} synonym(s)`, 'info');
        return synonyms;
    } catch (err) {
        Logger.log(`[Wiki] Wiktionary blocked (${err.message}) → no more sources`, 'warn');
    }

    return [];
}
