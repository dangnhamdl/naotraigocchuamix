/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: WIKI SEARCH (SYNONYM FINDER) v3.0
 * ============================================================================
 * Chức năng duy nhất: tìm synonym cho token, đúng POS
 * Export: fetchSynonyms(token, lang) → Promise<string[]>
 *
 * Nguồn duy nhất: HuggingFace xanhnon/visynonym
 * Ngôn ngữ: en, vi, de, es, fr, ja, ru, zh
 *
 * Nguyên tắc POS:
 *   - Chỉ lấy synonym khi token có đúng 1 POS trong dict
 *   - Multi-POS → bỏ
 */

import { Logger } from './step1-init.js';

const TIMEOUT_LONG = 15000;

// ============================================================================
// FETCH VỚI TIMEOUT
// ============================================================================
function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_LONG) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timeoutId));
}

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
        'от','до','его','её','их','мне','вы','или','если','же',
        'уже','ещё','здесь','там','так','да','нет','очень','только'
    ]),
    zh: new Set([
        '的','了','在','是','我','有','和','就','不','人','都','一',
        '上','也','很','到','说','要','去','你','会','着','没有',
        '看','好','自己','这','那','里','来','时','大','地','为','子',
        '中','以','年','得','他','她','它','们','这个','那个'
    ])
};

// ============================================================================
// HUGGINGFACE — CACHE FACTORY
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

const _hfCache   = {};
const _hfLoading = {};

async function loadHFDict(lang) {
    if (_hfCache[lang])   return _hfCache[lang];
    if (_hfLoading[lang]) return _hfLoading[lang];

    const url = HF_URLS[lang];
    if (!url) throw new Error(`No HF URL for lang "${lang}"`);

    _hfLoading[lang] = (async () => {
        const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error(`HuggingFace ${lang.toUpperCase()} HTTP ${res.status}`);
        _hfCache[lang]   = await res.json();
        _hfLoading[lang] = null;
        Logger.log(`[Wiki-${lang.toUpperCase()}] HF dict loaded — ${Object.keys(_hfCache[lang]).length} entries`, 'info');
        return _hfCache[lang];
    })();

    return _hfLoading[lang];
}

// ============================================================================
// SANITIZE
// ============================================================================
function sanitize(synonyms, token) {
    const lowerToken = token.toLowerCase();
    const seen = new Set();
    return synonyms.filter(syn => {
        if (!syn || syn.length < 2) return false;
        const lower = syn.toLowerCase();
        if (lower === lowerToken) return false;
        if (seen.has(lower)) return false;
        seen.add(lower);
        if (syn.includes(' ') || syn.includes('-')) return false;
        return true;
    }).slice(0, 12);
}

// ============================================================================
// TRA HUGGINGFACE — single-POS guard
// ============================================================================
async function fetchSynonymsHF(token, lang) {
    const dict  = await loadHFDict(lang);
    const key   = token.toLowerCase().trim();
    const entry = dict[key];
    if (!entry) return [];

    let raw = [];
    if (Array.isArray(entry)) {
        // File không có POS → dùng thẳng
        raw = entry;
    } else if (typeof entry === 'object') {
        const posKeys = Object.keys(entry).filter(k => Array.isArray(entry[k]) && entry[k].length > 0);
        if (posKeys.length === 0) return [];
        if (posKeys.length > 1)   return [];  // multi-POS → bỏ
        raw = entry[posKeys[0]];
    }

    return sanitize(raw, token);
}

// ============================================================================
// PUBLIC EXPORT
// ============================================================================
export async function fetchSynonyms(token, lang = 'en') {
    // Guard chung
    if (!token || token.length < 2) return [];
    if (/^\d+$/.test(token))        return [];

    // Ngôn ngữ không hỗ trợ
    if (!HF_URLS[lang]) {
        Logger.log(`[Wiki] Unsupported lang: "${lang}"`, 'warn');
        return [];
    }

    // Stop words
    const stopSet = STOP_WORDS[lang] || STOP_WORDS['en'];
    if (stopSet.has(token.toLowerCase())) return [];

    Logger.log(`[Wiki-${lang.toUpperCase()}] fetchSynonyms: "${token}"`, 'info');

    try {
        const syns = await fetchSynonymsHF(token, lang);
        Logger.log(`[Wiki-${lang.toUpperCase()}] HuggingFace: "${token}" → ${syns.length} synonym(s)`, 'info');
        return syns;
    } catch (err) {
        Logger.log(`[Wiki-${lang.toUpperCase()}] HF error: ${err.message}`, 'warn');
        return [];
    }
}
