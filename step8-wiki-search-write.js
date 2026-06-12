/**
 * ============================================================================
 * NKTg AI SYSTEM - STEP 8: SYNONYM FINDER v4.0
 * ============================================================================
 * Export: fetchSynonyms(token, lang) → Promise<string[]>
 *
 * Nguồn: 9 git mirror, random load balancing có trọng số
 * Khi nguồn bị chặn → loại ra, tính lại trọng số cho nguồn còn lại
 * Cache memory sau lần đầu load thành công
 * Tìm tuần tự từng từ 1 — không batch
 *
 * Ngôn ngữ: en, vi, de, es, fr, ja, ru, zh
 * POS guard: chỉ lấy synonym khi token có đúng 1 POS
 */

import { Logger } from './step1-init.js';

const TIMEOUT_MS = 15000;

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
// 9 NGUỒN — trọng số phân tải
// ============================================================================
const SOURCES = [
    { name: 'HuggingFace', base: 'https://huggingface.co/datasets/xanhnon/visynonym/resolve/main/', weight: 25 },
    { name: 'GitHub',      base: 'https://raw.githubusercontent.com/NKTgAI-Variable-Inertia/visynonym/main/', weight: 25 },
    { name: 'GitLab',      base: 'https://gitlab.com/NKTg-Variable-Inertia/visynonym/-/raw/main/', weight: 15 },
    { name: 'Bitbucket',   base: 'https://bitbucket.org/nktg-variable-inertia/visynonym/raw/main/', weight: 15 },
    { name: 'Codeberg',    base: 'https://codeberg.org/NKTg-Variable-Inertia/visynonym/raw/branch/main/', weight: 10 },
    { name: 'Gitea',       base: 'https://gitea.com/NKTg-Variable-Inertia/visynonym/raw/branch/main/', weight: 5 },
    { name: 'Framagit',    base: 'https://framagit.org/NKTg-Variable-Inertia/visynonym/-/raw/main/', weight: 2 },
    { name: 'Disroot',     base: 'https://git.disroot.org/NKTg-Variable-Inertia/visynonym/raw/branch/main/', weight: 2 },
    { name: 'Srht',        base: 'https://git.sr.ht/~nktg-variable-inertia/visynonym/blob/main/', weight: 1 },
];

// Tập nguồn bị chặn trong session hiện tại
const _blockedSources = new Set();

// Chọn nguồn ngẫu nhiên theo trọng số, bỏ qua nguồn bị chặn
function pickSource() {
    const available = SOURCES.filter(s => !_blockedSources.has(s.name));
    if (available.length === 0) return null;
    const totalWeight = available.reduce((s, src) => s + src.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const src of available) {
        rand -= src.weight;
        if (rand <= 0) return src;
    }
    return available[available.length - 1];
}

// ============================================================================
// CACHE — dùng chung cho mọi nguồn (nội dung giống nhau)
// ============================================================================
const _dictCache   = {};  // lang → dict object
const _dictLoading = {};  // lang → Promise

// Load dict từ nguồn được chọn, fallback nếu bị chặn
async function loadDict(lang) {
    if (_dictCache[lang])   return _dictCache[lang];
    if (_dictLoading[lang]) return _dictLoading[lang];

    _dictLoading[lang] = (async () => {
        // Thử lần lượt cho đến khi load được
        while (true) {
            const src = pickSource();
            if (!src) {
                _dictLoading[lang] = null;
                throw new Error(`All sources blocked for lang "${lang}"`);
            }

            const url = `${src.base}${lang}-synonyms.json`;
            try {
                const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                _dictCache[lang]   = await res.json();
                _dictLoading[lang] = null;
                Logger.log(`[HF] Dict loaded via ${src.name} — lang: ${lang} | ${Object.keys(_dictCache[lang]).length} entries`, 'info');
                return _dictCache[lang];
            } catch (err) {
                Logger.log(`[HF] ${src.name} blocked/error (${err.message}) → trying next source`, 'warn');
                _blockedSources.add(src.name);
                // Tiếp tục vòng lặp thử nguồn khác
            }
        }
    })();

    return _dictLoading[lang];
}

// ============================================================================
// STOP WORDS
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

// Danh sách ngôn ngữ hỗ trợ
const SUPPORTED_LANGS = new Set(['en','vi','de','es','fr','ja','ru','zh']);

// ============================================================================
// SANITIZE
// ============================================================================
function sanitize(synonyms, token, lang = 'en') {
    const lowerToken = token.toLowerCase();
    const seen = new Set();
    return synonyms.filter(syn => {
        if (!syn || syn.length < 2) return false;
        const lower = syn.toLowerCase();
        if (lower === lowerToken) return false;
        if (seen.has(lower)) return false;
        seen.add(lower);
        // Tiếng Việt: cho phép khoảng trắng (từ ghép đa âm tiết)
        // Tiếng Anh và các ngôn ngữ khác: không cho phép khoảng trắng hoặc gạch nối
        if (lang !== 'vi' && (syn.includes(' ') || syn.includes('-'))) return false;
        return true;
    }).slice(0, 12);
}

// ============================================================================
// TRA TỪ ĐIỂN — single-POS guard
// ============================================================================
async function lookupToken(token, lang) {
    const dict  = await loadDict(lang);
    const key   = token.toLowerCase().trim();
    const entry = dict[key];
    if (!entry) return [];

    let raw = [];
    if (Array.isArray(entry)) {
        raw = entry;
    } else if (typeof entry === 'object') {
        const posKeys = Object.keys(entry).filter(k => Array.isArray(entry[k]) && entry[k].length > 0);
        if (posKeys.length === 0) return [];
        if (posKeys.length > 1)   return [];  // multi-POS → bỏ
        raw = entry[posKeys[0]];
    }

    return sanitize(raw, token, lang);
}

// ============================================================================
// BIGRAM HELPER — tiếng Việt, Trung, Nhật (đa âm tiết)
// Trả về [{bigram, displayToken}] theo thứ tự: trái trước, phải sau
//
// Tiếng Việt (vi): âm tiết phân cách bằng khoảng trắng → dùng \S+
// Tiếng Trung (zh): không khoảng trắng → bigram = ký tự liền nhau
// Tiếng Nhật (ja): chỉ Kanji cần bigram, Hiragana/Katakana là particle → bỏ qua
// ============================================================================
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/; // Han CJK (zh + ja Kanji)
const HIRAGANA_KATAKANA_REGEX = /^[\u3040-\u30ff]+$/; // Hiragana/Katakana thuần — particle ja

function extractBigrams(token, sentence, lang) {
    if (!sentence) return [];

    // Tiếng Nhật: nếu token là Hiragana/Katakana thuần → không bigram
    if (lang === 'ja' && HIRAGANA_KATAKANA_REGEX.test(token)) return [];

    // Tiếng Trung + Nhật Kanji: không có khoảng trắng
    // Tìm vị trí ký tự token trong chuỗi, bigram = ký tự liền trước/sau
    if (lang === 'zh' || (lang === 'ja' && CJK_REGEX.test(token))) {
        // token có thể là 1 ký tự CJK
        const idx = sentence.indexOf(token);
        if (idx === -1) return [];
        const candidates = [];
        // Bigram trái: ký tự trước + token
        if (idx > 0) {
            const left = sentence[idx - 1];
            if (CJK_REGEX.test(left)) {
                const bigram = `${left}${token}`;
                candidates.push({ bigram, displayToken: bigram });
            }
        }
        // Bigram phải: token + ký tự sau
        if (idx + token.length < sentence.length) {
            const right = sentence[idx + token.length];
            if (CJK_REGEX.test(right)) {
                const bigram = `${token}${right}`;
                candidates.push({ bigram, displayToken: bigram });
            }
        }
        return candidates;
    }

    // Tiếng Việt: âm tiết phân cách bằng khoảng trắng
    const wordRegex = /\S+/g;
    const words = [];
    let m;
    while ((m = wordRegex.exec(sentence)) !== null) {
        words.push({ word: m[0], index: m.index });
    }
    const tokenLower = token.toLowerCase();
    const pos = words.findIndex(w => w.word.toLowerCase() === tokenLower);
    if (pos === -1) return [];

    const candidates = [];
    if (pos > 0) {
        const left = words[pos - 1].word;
        candidates.push({ bigram: `${left} ${token}`, displayToken: `${left} ${token}` });
    }
    if (pos < words.length - 1) {
        const right = words[pos + 1].word;
        candidates.push({ bigram: `${token} ${right}`, displayToken: `${token} ${right}` });
    }
    return candidates;
}

// ============================================================================
// PUBLIC EXPORT — tìm tuần tự từng từ 1
// sentence: truyền vào để hỗ trợ bigram tiếng Việt
// Trả về { synonyms: string[], displayToken: string }
//   displayToken = bigram nếu tìm được, token đơn nếu không
// ============================================================================
export async function fetchSynonyms(token, lang = 'en', sentence = '') {
    // Guard chung
    if (!token || token.length < 2) return { synonyms: [], displayToken: token };
    if (/^\d+$/.test(token))        return { synonyms: [], displayToken: token };

    // Ngôn ngữ không hỗ trợ
    if (!SUPPORTED_LANGS.has(lang)) {
        Logger.log(`[HF] Unsupported lang: "${lang}"`, 'warn');
        return { synonyms: [], displayToken: token };
    }

    // Stop words
    const stopSet = STOP_WORDS[lang] || STOP_WORDS['en'];
    if (stopSet.has(token.toLowerCase())) return { synonyms: [], displayToken: token };

    Logger.log(`[HF] fetchSynonyms: "${token}" (${lang})`, 'info');

    try {
        // ----------------------------------------------------------------
        // Tiếng Việt, Trung, Nhật: thử bigram trước — chỉ gạch khi chắc chắn đúng
        // ----------------------------------------------------------------
        if (['vi', 'zh', 'ja'].includes(lang) && sentence) {
            const bigrams = extractBigrams(token, sentence, lang);
            for (const { bigram, displayToken } of bigrams) {
                // Stop word guard cho bigram vi: bỏ qua nếu cả 2 âm tiết đều là stop word
                if (lang === 'vi') {
                    const parts = bigram.toLowerCase().split(' ');
                    if (parts.every(p => stopSet.has(p))) continue;
                }

                const syns = await lookupToken(bigram, lang);
                if (syns.length > 0) {
                    Logger.log(`[HF] ${lang} bigram "${bigram}" → ${syns.length} synonym(s)`, 'info');
                    return { synonyms: syns, displayToken };
                }
            }
            // Không tìm được bigram → không gạch chân
            Logger.log(`[HF] ${lang} "${token}" — no bigram found, skip underline`, 'info');
            return { synonyms: [], displayToken: '' };
        }

        // ----------------------------------------------------------------
        // Các ngôn ngữ khác (en, de, es, fr, ...): tra token đơn như cũ
        // ----------------------------------------------------------------
        const syns = await lookupToken(token, lang);
        Logger.log(`[HF] "${token}" → ${syns.length} synonym(s)`, 'info');
        return { synonyms: syns, displayToken: token };

    } catch (err) {
        Logger.log(`[HF] "${token}" error: ${err.message}`, 'warn');
        return { synonyms: [], displayToken: token };
    }
}
