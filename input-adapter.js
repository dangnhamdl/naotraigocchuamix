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

// Ngưỡng resize — ảnh > 10MB resize qua Canvas trước khi OCR, tránh crash browser
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

async function extractImage(file) {
    await ensureTesseract();

    // Resize nếu ảnh quá lớn
    let imageSource = file;
    if (file.size > IMAGE_MAX_BYTES) {
        Logger.log('[Input Adapter] Image > 10MB — resizing via Canvas...', 'warn');
        imageSource = await resizeImageFile(file);
    }

    // Tạo worker, OCR, terminate — terminate nằm trong finally, luôn chạy dù lỗi
    const worker = await _createWorker('eng+vie');
    try {
        const { data } = await worker.recognize(imageSource);
        // Trả về cả text và words — words chứa confidence score từng từ
        return { text: data.text, words: data.words || [] };
    } finally {
        await worker.terminate();
    }
}

async function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const MAX_DIM = 2480; // ~A4 tại 300 DPI
            const scale   = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
            const canvas  = document.createElement('canvas');
            canvas.width  = Math.round(img.width  * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Canvas resize failed'));
            }, 'image/png');
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Cannot load image for resize'));
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
