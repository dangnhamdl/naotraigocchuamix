/**
 * ============================================================================
 * NKTg AI SYSTEM - INPUT ADAPTER
 * ============================================================================
 * File: /nktg-ai/input-adapter.js
 * Purpose: Nhận dạng loại input → extract text → validate 21000 ký tự → điều phối Step 3
 *
 * Luồng:
 *   File upload (.txt/.docx/.pdf/.png/.jpg/.webp/.bmp) ưu tiên trước textarea
 *   → extract text
 *   → validate 21000 ký tự SAU extract (không kiểm tra file size)
 *   → điều phối sang Step 3 tương ứng qua inputType
 *
 * Thư viện CDN:
 *   mammoth.js   1.11.0   — https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.11.0/mammoth.browser.min.js
 *   pdfjs-dist   3.11.174 — https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
 *   tesseract.js 5        — https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js
 */

import { Logger, setPipelineState, unlockPipelineUI, initializeNKTgQuery } from './step1-init.js';

const MAX_CHARS = 21000;

const MAMMOTH_CDN      = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.11.0/mammoth.browser.min.js';
const PDFJS_CDN        = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_CDN    = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js';

// ============================================================================
// LAZY LOAD THƯ VIỆN — chỉ load khi cần, không load khi khởi động
// ============================================================================

let mammothLoaded    = false;
let pdfjsLoaded      = false;
let tesseractLoaded  = false;
let _createWorker    = null;  // giữ trực tiếp hàm createWorker sau khi import

function loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) {
            resolve(); return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.onload  = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load: ${url}`));
        document.head.appendChild(script);
    });
}

async function ensureMammoth() {
    if (mammothLoaded) return;
    await loadScript(MAMMOTH_CDN);
    mammothLoaded = true;
    Logger.log('[Input Adapter] mammoth.js 1.11.0 loaded.', 'info');
}

async function ensurePdfjs() {
    if (pdfjsLoaded) return;
    await loadScript(PDFJS_CDN);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    pdfjsLoaded = true;
    Logger.log('[Input Adapter] pdf.js 3.11.174 loaded.', 'info');
}

async function ensureTesseract() {
    if (tesseractLoaded && _createWorker) return;
    // Tesseract.js v5 ESM — createWorker có thể nằm ở .default hoặc trực tiếp
    const mod = await import(TESSERACT_CDN);
    _createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    if (typeof _createWorker !== 'function') {
        throw new Error('Tesseract.js load failed: createWorker not found');
    }
    tesseractLoaded = true;
    Logger.log('[Input Adapter] Tesseract.js 5 loaded.', 'info');
}

// ============================================================================
// EXTRACT TEXT THEO LOẠI FILE
// ============================================================================

async function extractTxt(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Cannot read .txt file'));
        reader.readAsText(file, 'UTF-8');
    });
}

async function extractDocx(file) {
    await ensureMammoth();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                const arrayBuffer = e.target.result;
                const result = await window.mammoth.extractRawText({ arrayBuffer });
                resolve(result.value);
            } catch (err) {
                reject(new Error(`mammoth.js error: ${err.message}`));
            }
        };
        reader.onerror = () => reject(new Error('Cannot read .docx file'));
        reader.readAsArrayBuffer(file);
    });
}

async function extractPdf(file) {
    await ensurePdfjs();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                const typedArray = new Uint8Array(e.target.result);
                const pdf = await window.pdfjsLib.getDocument({ data: typedArray }).promise;
                let fullText = '';
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent({
                        normalizeWhitespace: true,
                        disableCombineTextItems: false
                    });
                    let pageText = '';
                    for (let j = 0; j < content.items.length; j++) {
                        const item = content.items[j];
                        pageText += item.str;
                        if (item.hasEOL) {
                            // Dùng space thay \n — tránh ngắt giữa câu/công thức
                            // Step 3 PDF sẽ tự xử lý ngắt câu qua splitSentences
                            pageText += ' ';
                        } else if (j < content.items.length - 1) {
                            const next = content.items[j + 1];
                            const gap = next.transform?.[4] - (item.transform?.[4] + item.width);
                            if (gap > 2) pageText += ' ';
                        }
                    }
                    fullText += pageText + '\n';
                }
                resolve(fullText);
            } catch (err) {
                reject(new Error(`pdf.js error: ${err.message}`));
            }
        };
        reader.onerror = () => reject(new Error('Cannot read .pdf file'));
        reader.readAsArrayBuffer(file);
    });
}

// Định dạng ảnh được chấp nhận — kiểm tra MIME type thay vì extension
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp']);

// tessdata_fast — bản LSTM-only nhẹ (~1-2MB/ngôn ngữ) thay cho bản full (~10-15MB/ngôn ngữ)
// Hỗ trợ đầy đủ ngôn ngữ giống bản full, chỉ nén nhẹ hơn
// Base path KHÔNG gắn ngôn ngữ cụ thể — Tesseract tự ghép {lang}.traineddata.gz
const TESSDATA_FAST_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data@1/4.0.0_fast';

// Mức tăng contrast — 0 = không đổi, dương = tăng tương phản
const CONTRAST_LEVEL = 40;

// ============================================================================
// OCR_LANG_HINT — bảng rút gọn CHỈ dùng để chọn gói ngôn ngữ Tesseract OCR
// KHÔNG phải LanguageDetectionEntries của Step 2 (logic detect chính thức).
// Mục đích duy nhất: từ text thô lần 1 (OCR bằng "eng" — chìa khóa dò script),
// nhận diện Unicode range để chọn gói ngôn ngữ Tesseract cho lần 2.
// Step 2 vẫn detect ngôn ngữ đầy đủ như cũ, không bị ảnh hưởng.
// Không match script nào trong bảng → fallback "eng+vie" (Latin).
// ============================================================================
const OCR_LANG_HINT = Object.freeze([
    ["jpn",     /[\u3040-\u30ff\u31f0-\u31ff]/],   // Hiragana/Katakana — Nhật
    ["chi_sim", /[\u4e00-\u9fff]/],                 // Han CJK — Trung
    ["kor",     /[\uac00-\ud7af]/],                 // Hangul — Hàn
    ["heb",     /[\u0590-\u05FF]/],                 // Hebrew
    ["fas",     /[\u067E\u0686\u0698\u06AF\u06A9]/],// Ba Tư
    ["ara",     /[\u0600-\u06FF]/],                 // Arabic
    ["hin",     /[\u0900-\u097F]/],                 // Devanagari
    ["rus",     /[\u0400-\u04FF]/],                 // Cyrillic
    ["ell",     /[\u0370-\u03FF]/],                 // Greek
    ["tha",     /[\u0E00-\u0E7F]/],                 // Thai
]);

// Đoán gói ngôn ngữ Tesseract từ text thô lần 1 (dò bằng "eng").
// Unicode range của ký tự vẫn đúng dù OCR sai nghĩa, đủ để nhận diện script.
// Không match gì đặc biệt (Latin) → fallback "eng+vie".
function guessOcrLang(rawText) {
    for (const [lang, regex] of OCR_LANG_HINT) {
        if (regex.test(rawText)) return lang;
    }
    return 'eng+vie';
}

async function runTesseract(imageSource, lang) {
    const worker = await _createWorker(lang, 1, {
        langPath: TESSDATA_FAST_PATH
    });
    try {
        const { data } = await worker.recognize(imageSource);
        return data;
    } finally {
        await worker.terminate();
    }
}

async function extractImage(file) {
    await ensureTesseract();

    // Luôn xử lý ảnh: resize nếu quá lớn + grayscale + tăng contrast
    // Giúp cải thiện OCR với ảnh mờ, nén, ánh sáng không đều
    const imageSource = await preprocessImageFile(file);

    // ── Lần 1: OCR với "eng" — chìa khóa nhẹ nhất, chỉ để "phá lớp" ảnh ──
    // Output có thể sai nghĩa nếu ảnh không phải Latin, nhưng Unicode range
    // của ký tự (CJK, Hangul, Cyrillic, Arabic...) vẫn đúng để dò script.
    const firstPass = await runTesseract(imageSource, 'eng');

    // Đoán ngôn ngữ thật từ script trong text thô lần 1
    const realLang = guessOcrLang(firstPass.text);

    // ── Lần 2: OCR lại với ngôn ngữ thật — đây là kết quả dùng cho pipeline ──
    Logger.log(`[Input Adapter] OCR lần 1 (eng) xong — OCR lại với "${realLang}"...`, 'info');
    const secondPass = await runTesseract(imageSource, realLang);

    return { text: secondPass.text, words: secondPass.words || [] };
}

// Resize (nếu cần) + Grayscale + tăng Contrast — chạy cho MỌI ảnh trước OCR
// Dùng Canvas API thuần (0KB thêm) — không cần OpenCV.js
async function preprocessImageFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);

            // Resize nếu vượt MAX_DIM — giữ nguyên nếu ảnh đã nhỏ hơn
            const MAX_DIM = 2480; // ~A4 tại 300 DPI
            const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width  = Math.round(img.width  * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Grayscale + tăng contrast — pixel manipulation
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const contrastFactor = (259 * (CONTRAST_LEVEL + 255)) / (255 * (259 - CONTRAST_LEVEL));

            for (let i = 0; i < data.length; i += 4) {
                // Grayscale: luminance theo công thức ITU-R BT.601
                const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

                // Tăng contrast quanh điểm giữa 128
                let value = contrastFactor * (gray - 128) + 128;
                value = Math.max(0, Math.min(255, value));

                data[i]     = value; // R
                data[i + 1] = value; // G
                data[i + 2] = value; // B
                // data[i + 3] giữ nguyên alpha
            }

            ctx.putImageData(imageData, 0, 0);

            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Canvas preprocess failed'));
            }, 'image/png');
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Cannot load image for preprocessing'));
        };
        img.src = url;
    });
}

// ============================================================================
// VALIDATE 21000 KÝ TỰ SAU EXTRACT
// ============================================================================

function validateExtractedText(text, sourceName) {
    if (!text || text.trim() === '') {
        throw new Error(`[Input Adapter] ${sourceName}: Empty content after extraction.`);
    }
    if (text.length > MAX_CHARS) {
        throw new Error(`[Input Adapter] ${sourceName}: Exceeds ${MAX_CHARS} characters (current: ${text.length}). Please shorten the content.`);
    }
    return text.trim();
}

// ============================================================================
// MAIN ENTRY — được gọi khi người dùng nhấn submit
// ============================================================================

export async function handleInputAdapter() {
    const fileInput  = document.getElementById('fileInput');
    const fileStatus = document.getElementById('fileUploadStatus');
    const textarea   = document.getElementById('queryInput');
    const file       = fileInput?.files?.[0] || null;

    try {
        // ── Ưu tiên: File upload trước, textarea sau ──
        if (file) {
            const ext = file.name.split('.').pop().toLowerCase();
            Logger.log(`[Input Adapter] File detected: ${file.name} (.${ext})`, 'info');

            let rawText   = '';
            let inputType = '';

            if (ext === 'txt') {
                Logger.log('[Input Adapter] Route → Step 3 TXT', 'info');
                rawText   = await extractTxt(file);
                inputType = 'txt';

            } else if (ext === 'docx') {
                Logger.log('[Input Adapter] Route → Step 3 DOCX (mammoth.js)', 'info');
                rawText   = await extractDocx(file);
                inputType = 'docx';

            } else if (ext === 'pdf') {
                Logger.log('[Input Adapter] Route → Step 3 PDF (pdf.js)', 'info');
                rawText   = await extractPdf(file);
                inputType = 'pdf';

            } else if (IMAGE_MIME_TYPES.has(file.type)) {
                // Dùng file.type (MIME) thay vì ext — tránh file đặt tên sai extension
                Logger.log(`[Input Adapter] Route → Step 3 Image (Tesseract.js) — ${file.type}`, 'info');
                const imageResult = await extractImage(file);
                rawText   = imageResult.text;
                // Truyền ocrWords qua window tạm thời — step3-image.js đọc từ context.ocrWords
                // Không phá signature initializeNKTgQuery(cleanText, inputType)
                window.__nktgOcrWords = imageResult.words;
                inputType = 'image';

            } else {
                throw new Error(`Unsupported file format: .${ext}. Only .txt, .docx, .pdf, .png, .jpg, .webp, .bmp are accepted.`);
            }

            const cleanText = validateExtractedText(rawText, file.name);
            Logger.log(`[Input Adapter] Extract OK: ${cleanText.length} chars — forwarding to pipeline.`, 'success');

            if (fileStatus) {
                fileStatus.textContent = `✔ ${file.name} — ${cleanText.length} chars`;
                fileStatus.className   = 'file-upload-status success';
            }

            await initializeNKTgQuery(cleanText, inputType);

        } else {
            // ── Fallback: textarea ──
            const textareaValue = textarea?.value || '';
            Logger.log('[Input Adapter] No file — Route → Step 3 Text (textarea)', 'info');

            const cleanText = validateExtractedText(textareaValue, 'textarea');
            await initializeNKTgQuery(cleanText, 'text');
        }

    } catch (err) {
        Logger.log(`[Input Adapter Error] ${err.message}`, 'danger');

        if (fileStatus && file) {
            fileStatus.textContent = `✘ ${err.message}`;
            fileStatus.className   = 'file-upload-status error';
        }

        setPipelineState('ERROR');
        unlockPipelineUI();
    }
}

// ============================================================================
// FILE INPUT CHANGE — hiển thị tên file khi chọn xong
// ============================================================================

function onDOMReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
}

onDOMReady(() => {
    const fileInput  = document.getElementById('fileInput');
    const fileStatus = document.getElementById('fileUploadStatus');
    const uploadBtn  = document.getElementById('fileUploadBtn');

    if (fileInput && fileStatus) {
        fileInput.addEventListener('change', function () {
            const file = this.files?.[0];
            if (file) {
                fileStatus.textContent = `📄 ${file.name} — ready`;
                fileStatus.className   = 'file-upload-status success';
            } else {
                fileStatus.textContent = '';
                fileStatus.className   = 'file-upload-status';
            }
        });
    }
});
