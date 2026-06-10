/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: WIKI SEARCH (SYNONYM FINDER) v2.0
 * ============================================================================
 * Chức năng duy nhất: tìm synonym cho token, đúng POS
 * Export: fetchSynonyms(token, lang) → Promise<string[]>
 *
 * Ngôn ngữ hỗ trợ:
 *   en — English
 *   vi — Tiếng Việt
 *   de — Deutsch
 *   es — Español
 *   fr — Français
 *   ja — 日本語
 *   ru — Русский
 *   zh — 中文
 *
 * Chiến lược theo ngôn ngữ:
 *   Tất cả: HuggingFace dict (xanhnon/visynonym) — ưu tiên, cache memory, O(1)
 *   Fallback EN : FreeDictionary → DictAPI+Datamuse → en.Wiktionary
 *   Fallback VI : vi.Wiktionary
 *   Fallback DE : de.Wiktionary
 *   Fallback ES : es.Wiktionary
 *   Fallback FR : fr.Wiktionary
 *   Fallback JA : ja.Wiktionary
 *   Fallback RU : ru.Wiktionary
 *   Fallback ZH : zh.Wiktionary
 *
 * Nguyên tắc POS:
 *   - Chỉ trả về synonym khi token có đúng 1 POS trong nguồn
 *   - Multi-POS → bỏ (không chắc)
 *   - Giữ nguyên tắc này cho mọi ngôn ngữ
 */

import { Logger } from './step1-init.js';

const TIMEOUT_SHORT = 6000;
const TIMEOUT_LONG  = 15000;

// ============================================================================
// FETCH VỚI TIMEOUT
// ============================================================================
function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_SHORT) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
}

// ============================================================================
// GLOBAL BLACKLIST — từ cổ/archaic + data noise
// ============================================================================
const ARCHAIC_WORDS = new Set([
    'tether','atween','prostrate','wayfare','assail','twelvemonth','foretime',
    'behold','laze','withouten','perchance','mayhap','thrice','whilom','betwixt',
    'amongst','whilst','perforce','forsooth','henceforth','thereupon','whereupon',
    'aforesaid','aforementioned','heretofore','hitherto','thenceforth'
]);

const CONTEXT_NOISE = new Set([
    'pristine','terminal','commoners','bergh','dominator','paginate',
    'denomination','eke','flashy'
]);

const GLOBAL_BLACKLIST = new Set([...ARCHAIC_WORDS, ...CONTEXT_NOISE]);

// ============================================================================
// STOP WORDS theo ngôn ngữ
// ============================================================================
const STOP_WORDS = {
    en: new Set([
        'a','an','the','is','are','was','were','be','been','being',
        'it','its','this','that','these','those','i','we','you','he',
        'she','they','and','or','but','not','for','in','on','at','to',
        'of','as','by','with','from','up','out','if','do','did','has',
        'had','have','will','would','could','should','may','might','s'
    ]),
    vi: new Set([
        'và','hoặc','nhưng','vì','nên','để','mà','thì','là','của',
        'trong','ngoài','trên','dưới','với','từ','đến','về','cho',
        'không','có','được','bị','đã','đang','sẽ','vẫn','cũng','đều',
        'này','đó','kia','đây','ở','tại','qua','theo','sau','trước',
        'một','hai','ba','bốn','năm','nhiều','ít','mỗi','các','những',
        'tôi','bạn','anh','chị','ông','bà','họ','chúng','mình','ta',
        'gì','nào','ai','khi','như','vậy','thế','rất','quá','lắm',
    ]),
    de: new Set([
        'der','die','das','ein','eine','und','oder','aber','nicht','ich',
        'du','er','sie','es','wir','ihr','den','dem','des','von','zu','in',
        'an','auf','mit','für','ist','sind','war','wurde','haben','sein',
        'wie','als','auch','noch','schon','nur','ja','nein','so','sehr'
    ]),
    es: new Set([
        'el','la','los','las','un','una','unos','unas','y','o','pero','no',
        'yo','tú','él','ella','nosotros','vosotros','ellos','de','en','con',
        'por','para','que','es','son','fue','ser','estar','hay','más','muy',
        'también','si','ya','como','su','sus','se','al','del'
    ]),
    fr: new Set([
        'le','la','les','un','une','des','et','ou','mais','ne','pas','je',
        'tu','il','elle','nous','vous','ils','elles','de','en','à','dans',
        'sur','avec','pour','par','est','sont','était','être','avoir','très',
        'aussi','si','comme','ce','se','son','sa','ses','au','aux','du'
    ]),
    ja: new Set([
        'の','に','は','を','が','で','と','も','な','へ','から','まで',
        'より','や','ね','よ','か','ば','ので','のに','けど','し','て',
        'だ','です','ます','ない','ある','いる','する','この','その','あの',
        'これ','それ','あれ','ここ','そこ','あそこ','私','あなた','彼','彼女'
    ]),
    ru: new Set([
        'и','в','не','на','я','что','тот','быть','с','а','весь','это',
        'как','она','по','но','они','к','у','ты','из','мы','за','бы',
        'по','от','до','его','её','их','мне','вы','или','если','же',
        'уже','ещё','здесь','там','так','да','нет','очень','только'
    ]),
    zh: new Set([
        '的','了','在','是','我','有','和','就','不','人','都','一',
        '一个','上','也','很','到','说','要','去','你','会','着','没有',
        '看','好','自己','这','那','里','来','时','大','地','为','子',
        '中','以','年','得','就','他','她','它','们','这个','那个'
    ])
};

// ============================================================================
// PRE-FILTER — chỉ dùng cho EN (ngôn ngữ biến dạng động từ mạnh)
// ============================================================================
const PRE_FILTER_EXCEPTIONS = new Set([
    'her','over','under','after','butter','water','father','mother','sister',
    'brother','offer','order','other','rather','either','never','ever','river',
    'cover','power','flower','answer','center','enter','winter','wonder','tender',
    'gender','cancer','proper','super','paper','fever','best','rest','test','west',
    'chest','forest','harvest','interest','manifest','protest'
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
// SANITIZE CHUNG — dùng sau khi lấy synonym từ bất kỳ nguồn nào
// ============================================================================
function sanitizeSynonyms(synonyms, token, lang) {
    const lowerToken = token.toLowerCase();
    const seen = new Set();
    const BLOCKED_SUFFIXES_EN = ['ish','er','est','ed','ing'];

    return synonyms.filter(syn => {
        if (!syn || syn.length < 2) return false;
        const lower = syn.toLowerCase();
        if (lower === lowerToken) return false;
        if (seen.has(lower)) return false;
        seen.add(lower);
        if (GLOBAL_BLACKLIST.has(lower)) return false;
        if (syn.includes(' ') || syn.includes('-')) return false;
        // Với EN: chặn biến thể suffix
        if (lang === 'en') {
            for (const suffix of BLOCKED_SUFFIXES_EN) {
                if (lower.endsWith(suffix) && !lowerToken.endsWith(suffix)) return false;
            }
        }
        return true;
    }).slice(0, 12);
}

// ============================================================================
// HUGGINGFACE — CACHE FACTORY
// Dùng chung cho mọi ngôn ngữ có file trong xanhnon/visynonym
// ============================================================================
const HF_BASE = 'https://huggingface.co/datasets/xanhnon/visynonym/resolve/main';

const HF_URLS = {
    en: `${HF_BASE}/en-synonyms.json`,
    vi: `${HF_BASE}/vi-synonyms.json`,
    de: `${HF_BASE}/de-synonyms.json`,
    es: `${HF_BASE}/es-synonyms.json`,
    fr: `${HF_BASE}/fr-synonyms.json`,
    ja: `${HF_BASE}/ja-synonyms.json`,
    ru: `${HF_BASE}/ru-synonyms.json`,
    zh: `${HF_BASE}/zh-synonyms.json`,
};

// Cache singleton theo ngôn ngữ
const _hfCache   = {};  // lang → dict object
const _hfLoading = {};  // lang → Promise

async function loadHFDict(lang) {
    if (_hfCache[lang])   return _hfCache[lang];
    if (_hfLoading[lang]) return _hfLoading[lang];

    const url = HF_URLS[lang];
    if (!url) throw new Error(`No HF URL for lang "${lang}"`);

    _hfLoading[lang] = (async () => {
        const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, TIMEOUT_LONG);
        if (!res.ok) throw new Error(`HuggingFace ${lang.toUpperCase()} HTTP ${res.status}`);
        _hfCache[lang]   = await res.json();
        _hfLoading[lang] = null;
        Logger.log(`[Wiki-${lang.toUpperCase()}] HF dict loaded — ${Object.keys(_hfCache[lang]).length} entries`, 'info');
        return _hfCache[lang];
    })();

    return _hfLoading[lang];
}

// Tra HuggingFace dict — áp dụng POS single-guard
async function fetchSynonymsHF(token, lang) {
    // EN: chạy qua pre-filter trước
    if (lang === 'en' && !preFilterToken(token)) return [];

    const dict  = await loadHFDict(lang);
    const key   = token.toLowerCase().trim();
    const entry = dict[key];
    if (!entry) return [];

    let raw = [];
    if (Array.isArray(entry)) {
        // File cũ — không có POS, dùng thẳng
        raw = entry;
    } else if (typeof entry === 'object') {
        const posKeys = Object.keys(entry).filter(k => Array.isArray(entry[k]) && entry[k].length > 0);
        if (posKeys.length === 0) return [];
        if (posKeys.length > 1)   return [];  // multi-POS → bỏ
        raw = entry[posKeys[0]];
    }

    return sanitizeSynonyms(raw, token, lang);
}

// ============================================================================
// FALLBACK EN-2 — Free Dictionary API (POS single-guard)
// ============================================================================
async function fetchSynonymsFreeDictionary(token) {
    if (!preFilterToken(token)) return [];
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`FreeDictionary HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data) || !data[0]?.word) return [];
    if (data[0].word.toLowerCase() !== token.toLowerCase()) return [];

    const SUPPORTED_POS = new Set(['noun','verb','adjective','adverb']);
    const posSynMap = new Map();
    for (const entry of data) {
        for (const meaning of (entry.meanings || [])) {
            const pos = meaning.partOfSpeech?.toLowerCase();
            if (!pos || !SUPPORTED_POS.has(pos)) continue;
            if (!posSynMap.has(pos)) posSynMap.set(pos, new Set());
            for (const s of (meaning.synonyms || [])) {
                if (s && s.toLowerCase() !== token.toLowerCase()) posSynMap.get(pos).add(s.trim());
            }
        }
    }

    if (posSynMap.size === 0 || posSynMap.size > 1) return [];
    const synonyms = [...(posSynMap.values().next().value)];
    return sanitizeSynonyms(synonyms, token, 'en');
}

// ============================================================================
// FALLBACK EN-3 — DictAPI + Datamuse
// ============================================================================
const POS_MAP = { noun:'n', verb:'v', adjective:'adj', adverb:'adv', pronoun:'n' };

async function fetchSynonymsSource2EN(token) {
    const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token.toLowerCase())}`;
    const dictRes = await fetchWithTimeout(dictUrl, { headers: { 'Accept': 'application/json' } });
    if (dictRes.status === 404) return [];
    if (!dictRes.ok) throw new Error(`DictAPI HTTP ${dictRes.status}`);
    const dictData = await dictRes.json();
    if (!Array.isArray(dictData) || !dictData.length) return [];

    let detectedPOS = null; let maxDefs = 0;
    for (const entry of dictData)
        for (const meaning of (entry.meanings || [])) {
            const defCount = (meaning.definitions || []).length;
            if (defCount > maxDefs) { maxDefs = defCount; detectedPOS = meaning.partOfSpeech; }
        }
    if (!detectedPOS) return [];

    const tag = POS_MAP[detectedPOS.toLowerCase()];
    if (!tag) return [];

    const dmUrl = `https://api.datamuse.com/words?rel_syn=${encodeURIComponent(token.toLowerCase())}&md=p&max=20`;
    const dmRes = await fetchWithTimeout(dmUrl, { headers: { 'Accept': 'application/json' } });
    if (!dmRes.ok) throw new Error(`Datamuse HTTP ${dmRes.status}`);
    const dmData = await dmRes.json();
    const synonyms = (Array.isArray(dmData) ? dmData : [])
        .filter(item => item.word && !item.word.includes(' ') &&
            item.word.toLowerCase() !== token.toLowerCase() &&
            (item.tags || []).includes(tag))
        .map(item => item.word.trim());
    return sanitizeSynonyms(synonyms, token, 'en');
}

// ============================================================================
// FALLBACK WIKTIONARY — dùng cho EN và các ngôn ngữ châu Âu (DE, ES, FR, RU)
// ============================================================================
const WIKTIONARY_LANG_CODE = {
    en: 'en', de: 'de', es: 'es', fr: 'fr', ru: 'ru'
};

// Template đồng nghĩa theo ngôn ngữ
const WIKTIONARY_SYN_TEMPLATES = {
    en: /\{\{syn\|en\|([^}]+)\}\}/gi,
    de: /\{\{(?:Syn|Synonyme)[^}]*\|([^}]+)\}\}/gi,
    es: /\{\{sinón[^}]*\|([^}]+)\}\}/gi,
    fr: /\{\{(?:syn|synonymes?)[^}]*\|([^}]+)\}\}/gi,
    ru: /\{\{(?:syn|Syn)[^}]*\|([^}]+)\}\}/gi,
};

const WIKTIONARY_SYN_SECTIONS = {
    en: /={2,4}Synonyms={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i,
    de: /={2,4}Synonyme={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i,
    es: /={2,4}Sinónimos={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i,
    fr: /={2,4}Synonymes={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i,
    ru: /={2,4}(?:Синонимы|Synonyms)={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i,
};

// Ký tự hợp lệ theo ngôn ngữ
const WIKTIONARY_CHAR_PATTERN = {
    en: /^[a-zA-Z]+$/,
    de: /^[a-zA-ZäöüÄÖÜß]+$/,
    es: /^[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]+$/,
    fr: /^[a-zA-ZàâäéèêëïîôùûüÿçœæÀÂÄÉÈÊËÏÎÔÙÛÜŸÇŒÆ]+$/,
    ru: /^[а-яёА-ЯЁ]+$/,
};

async function fetchSynonymsWiktionary(token, lang) {
    const langCode = WIKTIONARY_LANG_CODE[lang] || 'en';
    const url = `https://${langCode}.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`${langCode}.Wiktionary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return [];

    const wikitext  = data.parse?.wikitext?.['*'] || '';
    const synonyms  = new Set();
    const charPat   = WIKTIONARY_CHAR_PATTERN[lang] || /^[a-zA-Z]+$/;

    function isValid(word) {
        if (!word || word.length < 2 || word.length > 30) return false;
        if (word.toLowerCase() === token.toLowerCase()) return false;
        if (word.includes(':') || word.includes('=')) return false;
        return charPat.test(word);
    }

    // Template {{syn|lang|...}}
    const tmpl = WIKTIONARY_SYN_TEMPLATES[lang];
    if (tmpl) {
        for (const m of wikitext.matchAll(tmpl))
            for (const p of m[1].split('|')) {
                const w = p.trim().replace(/^\s*[\*#:;|]+\s*/, '');
                if (isValid(w)) synonyms.add(w);
            }
    }

    // Section Synonyms
    const secPat = WIKTIONARY_SYN_SECTIONS[lang];
    if (secPat) {
        const sec = (wikitext.match(secPat) || [])[1] || '';
        if (sec) {
            for (const m of sec.matchAll(/\{\{l\|[a-z]{2}\|([^|}]+)\}\}/gi)) {
                const w = m[1].trim(); if (isValid(w)) synonyms.add(w);
            }
            for (const m of sec.matchAll(/\[\[([^\]|#]+)/g)) {
                const w = m[1].trim(); if (isValid(w)) synonyms.add(w);
            }
        }
    }

    return sanitizeSynonyms([...synonyms], token, lang);
}

// ============================================================================
// FALLBACK WIKTIONARY — JA (日本語) — cấu trúc khác
// ============================================================================
async function fetchSynonymsJaWiktionary(token) {
    const url = `https://ja.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`ja.Wiktionary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return [];

    const wikitext = data.parse?.wikitext?.['*'] || '';
    const synonyms = new Set();

    // Section 類義語 (ruigigo = synonyms)
    const sec = (wikitext.match(/={2,4}\s*類義語\s*={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i) || [])[1] || '';
    if (sec) {
        for (const m of sec.matchAll(/\[\[([^\]|#]+)/g)) {
            const w = m[1].trim();
            if (w && w.length >= 1 && w !== token && /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(w))
                synonyms.add(w);
        }
    }

    // Template {{syn|ja|...}}
    for (const m of wikitext.matchAll(/\{\{syn\|ja\|([^}]+)\}\}/gi))
        for (const p of m[1].split('|')) {
            const w = p.trim();
            if (w && w !== token) synonyms.add(w);
        }

    return [...synonyms].slice(0, 12);
}

// ============================================================================
// FALLBACK WIKTIONARY — ZH (中文) — cấu trúc khác
// ============================================================================
async function fetchSynonymsZhWiktionary(token) {
    const url = `https://zh.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token)}&prop=wikitext&format=json&origin=*`;
    const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`zh.Wiktionary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) return [];

    const wikitext = data.parse?.wikitext?.['*'] || '';
    const synonyms = new Set();

    // Section 近义词 / 同义词
    const sec = (wikitext.match(/={2,4}\s*(?:近义词|同义词)\s*={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i) || [])[1] || '';
    if (sec) {
        for (const m of sec.matchAll(/\[\[([^\]|#]+)/g)) {
            const w = m[1].trim();
            if (w && w !== token && /\p{Script=Han}/u.test(w)) synonyms.add(w);
        }
    }

    // Template {{syn|zh|...}}
    for (const m of wikitext.matchAll(/\{\{syn\|zh\|([^}]+)\}\}/gi))
        for (const p of m[1].split('|')) {
            const w = p.trim();
            if (w && w !== token) synonyms.add(w);
        }

    return [...synonyms].slice(0, 12);
}

// ============================================================================
// FALLBACK WIKTIONARY — VI
// ============================================================================
async function fetchSynonymsViWiktionary(token) {
    const url = `https://vi.wiktionary.org/w/api.php?` +
        `action=parse&page=${encodeURIComponent(token.replace(/ /g, '_'))}&prop=wikitext&format=json&origin=*`;
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
        return /\p{L}/u.test(word);
    }
    function cleanVi(raw) {
        return raw.trim()
            .replace(/^\s*[\*#:;\|]+\s*/, '')
            .replace(/\{\{[^}]*\}\}/g, '')
            .replace(/[[\]{}]/g, '')
            .replace(/\s+/g, ' ').trim();
    }

    const section = (wikitext.match(
        /={2,4}\s*Từ đồng nghĩa\s*={2,4}([\s\S]*?)(?:={2,4}[^=]|$)/i
    ) || [])[1] || '';

    if (section) {
        for (const m of section.matchAll(/\{\{(?:đồng nghĩa|syn)[^}]*\|([^}]+)\}\}/gi))
            for (const p of m[1].split('|')) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }
        for (const m of section.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g))
            { const w = cleanVi(m[1]); if (isValidVi(w)) synonyms.add(w); }
        for (const line of section.split('\n')) {
            if (!line.trim().startsWith('*')) continue;
            const plain = line.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
                              .replace(/\{\{[^}]+\}\}/g, '').replace(/^\s*\*+\s*/, '');
            for (const p of plain.split(/[,;\/]/)) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }
        }
    }

    if (synonyms.size === 0)
        for (const m of wikitext.matchAll(/\{\{(?:đồng nghĩa|syn)[^}]*\|([^}]+)\}\}/gi))
            for (const p of m[1].split('|')) { const w = cleanVi(p); if (isValidVi(w)) synonyms.add(w); }

    return [...synonyms].slice(0, 12);
}

// ============================================================================
// PUBLIC EXPORT — fetchSynonyms(token, lang) → Promise<string[]>
// ============================================================================
export async function fetchSynonyms(token, lang = 'en') {
    // Guard chung
    if (!token || token.length < 2) return [];
    if (/^\d+$/.test(token))        return [];

    const stopSet = STOP_WORDS[lang] || STOP_WORDS['en'];
    if (stopSet.has(token.toLowerCase())) return [];

    Logger.log(`[Wiki-${lang.toUpperCase()}] fetchSynonyms: "${token}"`, 'info');

    // ─────────────────────────────────────────────────────────────────────────
    // TIẾNG VIỆT (vi)
    // ─────────────────────────────────────────────────────────────────────────
    if (lang === 'vi') {
        try {
            const syns = await fetchSynonymsHF(token, 'vi');
            Logger.log(`[Wiki-VI] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;  // trả về luôn dù 0
        } catch (err) {
            Logger.log(`[Wiki-VI] HF blocked (${err.message}) → fallback vi.Wiktionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsViWiktionary(token);
            Logger.log(`[Wiki-VI] vi.Wiktionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-VI] vi.Wiktionary blocked (${err.message})`, 'warn');
        }
        return [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIẾNG ANH (en)
    // ─────────────────────────────────────────────────────────────────────────
    if (lang === 'en') {
        if (token.length < 3) return [];
        try {
            const syns = await fetchSynonymsHF(token, 'en');
            Logger.log(`[Wiki-EN] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-EN] HF blocked (${err.message}) → fallback FreeDictionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsFreeDictionary(token);
            Logger.log(`[Wiki-EN] FreeDictionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-EN] FreeDictionary blocked (${err.message}) → fallback Source2`, 'warn');
        }
        try {
            const syns = await fetchSynonymsSource2EN(token);
            Logger.log(`[Wiki-EN] DictAPI+Datamuse: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-EN] Source2 blocked (${err.message}) → fallback Wiktionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsWiktionary(token, 'en');
            Logger.log(`[Wiki-EN] en.Wiktionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-EN] Wiktionary blocked (${err.message})`, 'warn');
        }
        return [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIẾNG NHẬT (ja)
    // ─────────────────────────────────────────────────────────────────────────
    if (lang === 'ja') {
        try {
            const syns = await fetchSynonymsHF(token, 'ja');
            Logger.log(`[Wiki-JA] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-JA] HF blocked (${err.message}) → fallback ja.Wiktionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsJaWiktionary(token);
            Logger.log(`[Wiki-JA] ja.Wiktionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-JA] ja.Wiktionary blocked (${err.message})`, 'warn');
        }
        return [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIẾNG TRUNG (zh)
    // ─────────────────────────────────────────────────────────────────────────
    if (lang === 'zh') {
        try {
            const syns = await fetchSynonymsHF(token, 'zh');
            Logger.log(`[Wiki-ZH] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-ZH] HF blocked (${err.message}) → fallback zh.Wiktionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsZhWiktionary(token);
            Logger.log(`[Wiki-ZH] zh.Wiktionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-ZH] zh.Wiktionary blocked (${err.message})`, 'warn');
        }
        return [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TIẾNG ĐỨC (de) / TÂY BAN NHA (es) / PHÁP (fr) / NGA (ru)
    // Cùng pattern: HF → Wiktionary ngôn ngữ tương ứng
    // ─────────────────────────────────────────────────────────────────────────
    if (['de','es','fr','ru'].includes(lang)) {
        try {
            const syns = await fetchSynonymsHF(token, lang);
            Logger.log(`[Wiki-${lang.toUpperCase()}] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-${lang.toUpperCase()}] HF blocked (${err.message}) → fallback ${lang}.Wiktionary`, 'warn');
        }
        try {
            const syns = await fetchSynonymsWiktionary(token, lang);
            Logger.log(`[Wiki-${lang.toUpperCase()}] ${lang}.Wiktionary: "${token}" → ${syns.length} synonym(s)`, 'info');
            return syns;
        } catch (err) {
            Logger.log(`[Wiki-${lang.toUpperCase()}] ${lang}.Wiktionary blocked (${err.message})`, 'warn');
        }
        return [];
    }

    // Ngôn ngữ không hỗ trợ
    Logger.log(`[Wiki] Unsupported lang: "${lang}"`, 'warn');
    return [];
}
