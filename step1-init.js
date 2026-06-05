/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 1: SECURE QUERY INITIALIZATION MODULE
 * ============================================================================
 * v2: Gắn context.meta.mode từ window.nktgGetMode()
 *     'extraction' → Não Trái  |  'addition' → Não Phải
 */

export const NKTgConfig = {
    MAX_INPUT_LENGTH: 21000
};

let currentPipelineState = "IDLE";
let geoRoutingHandler = null;

export function setPipelineState(newState) {
    const validStates = ["IDLE", "INITIALIZED", "PROCESSING", "ERROR", "GEO_ROUTING_ACTIVATED", "GLOBAL_FALLBACK_ACTIVATED", "COMPLETED"];
    if (!validStates.includes(newState)) {
        console.error(`[Fatal] Invalid pipeline state mutation requested: ${newState}`);
        return;
    }
    currentPipelineState = newState;
    const badge = document.getElementById('stateBadge');
    if (badge) {
        badge.innerText = `PIPELINE: ${newState}`;
        if (newState === 'ERROR') badge.style.backgroundColor = 'var(--danger-color)';
        else if (newState === 'GEO_ROUTING_ACTIVATED' || newState === 'GLOBAL_FALLBACK_ACTIVATED') badge.style.backgroundColor = 'var(--accent-color)';
        else if (newState === 'COMPLETED') badge.style.backgroundColor = 'var(--success-color)';
        else badge.style.backgroundColor = '#21262d';
    }
}

export function unlockPipelineUI() {
    const sendArrow = document.getElementById('sendArrow');
    if (sendArrow) {
        sendArrow.disabled = false;
        Logger.log("UI Control Re-enabled globally by the handling endpoint.", "success");
    }

    const ta = document.getElementById('queryInput');
    const cc = document.getElementById('charCounter');
    const fi = document.getElementById('fileInput');
    const fs = document.getElementById('fileUploadStatus');
    if (ta && cc) {
        ta.value = '';
        cc.innerText = `0/${NKTgConfig.MAX_INPUT_LENGTH}`;
        cc.classList.remove('limit-reached');
    }
    if (fi) fi.value = '';
    if (fs) { fs.textContent = ''; fs.className = 'file-upload-status'; }
}

export const Logger = {
    get el() { return document.getElementById('consoleOutput'); },
    escapeHTML: function(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    },
    log: function(message, type = 'info') {
        const timeStr = new Date().toISOString().split('T')[1].substring(0, 8);
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-${type}">${this.escapeHTML(message)}</span>`;
        if (this.el) {
            this.el.appendChild(logEntry);
            this.el.scrollTop = this.el.scrollHeight;
        }
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
};

function onDOMReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
}

onDOMReady(() => {
    Logger.log("NKTg Core System Production Architecture initialized. Status: Ready.", "success");

    const queryTextArea = document.getElementById('queryInput');
    const charCounterContainer = document.getElementById('charCounter');
    const sendArrow = document.getElementById('sendArrow');

    if (queryTextArea && charCounterContainer) {
        queryTextArea.addEventListener('input', function() {
            if (this.value.length > NKTgConfig.MAX_INPUT_LENGTH) this.value = this.value.slice(0, NKTgConfig.MAX_INPUT_LENGTH);
            const currentLength = this.value.length;
            charCounterContainer.innerText = `${currentLength}/${NKTgConfig.MAX_INPUT_LENGTH}`;
            if (currentLength >= NKTgConfig.MAX_INPUT_LENGTH) charCounterContainer.classList.add('limit-reached');
            else charCounterContainer.classList.remove('limit-reached');
        });
    }

    if (sendArrow) {
        sendArrow.addEventListener('click', async function() {
            const mode = typeof window.nktgGetMode === 'function' ? window.nktgGetMode() : null;
            const warning = document.getElementById('modeWarning');
            if (!mode) {
                if (warning) warning.style.display = 'block';
                return;
            }
            if (warning) warning.style.display = 'none';

            setPipelineState("IDLE");
            this.disabled = true;
            try {
                const { handleInputAdapter } = await import('./input-adapter.js');
                await handleInputAdapter();
            } catch (e) {
                this.disabled = false;
            }
        });
    }
});

export function validateAndSanitizeInput(input) {
    if (input.length > NKTgConfig.MAX_INPUT_LENGTH) throw new Error(`Execution Denied: Payload footprint exceeds threshold.`);
    let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    if (!sanitized || sanitized.trim() === "") throw new Error("Execution Denied: Payload content is non-compliant.");
    return sanitized;
}

export function verifyHardwareCapabilities() {
    const capabilities = {
        webGPU: !!navigator.gpu,
        wasm: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function"
    };
    if (!capabilities.wasm) throw new Error("Fatal Hardware Exception: WASM engine missing.");
    if (!capabilities.webGPU) Logger.log("Hardware Alert: Alternative sub-routine fallback to Multi-Threaded WASM CPU activated.", "warn");
    else Logger.log("Hardware Verification Passed: WebGPU context active.", "success");
    return capabilities;
}

// inputType: 'text' | 'txt' | 'docx' | 'pdf'
// mode:      'extraction' | 'addition' — lấy từ window.nktgGetMode()
export async function initializeNKTgQuery(input, inputType = 'text') {
    setPipelineState("PROCESSING");
    Logger.log(`--------------------------------------------------`, "info");
    Logger.log(`Initiating secure payload parsing and query initialization routine...`, "info");

    try {
        const cleanInput = validateAndSanitizeInput(input);
        setPipelineState("INITIALIZED");
        Logger.log("Payload inspection completed successfully. Content structure secured.", "success");

        const hardware = verifyHardwareCapabilities();

        // ── Lấy mode từ UI galaxy selector ──
        const mode = (typeof window.nktgGetMode === 'function' ? window.nktgGetMode() : null) || 'extraction';

        const nktgContext = {
            meta: {
                timestamp: Date.now(),
                rawInput: cleanInput,
                inputType,
                mode,               // 'extraction' | 'addition'
                vramSavingsMode: true
            },
            runtimeCapabilities: hardware,
            get pipelineState() { return currentPipelineState; }
        };

        Logger.log(`NKTg Context Machine constructed. InputType: ${inputType} | Mode: ${mode}`, "success");

        if (typeof geoRoutingHandler === 'function') {
            setPipelineState("GEO_ROUTING_ACTIVATED");
            Logger.log(`State Verification: context.pipelineState reads -> "${nktgContext.pipelineState}"`, "success");
            Logger.log(`[Handshake Success] Context verified. Transmitting traffic to Step 2 (Geo Routing)...`, "info");

            await geoRoutingHandler(nktgContext);
        } else {
            Logger.log("[Pipeline Blocked] Warning: Step 2 Geo Routing Handler not registered.", "warn");
            setPipelineState("IDLE");
            unlockPipelineUI();
        }
    } catch (error) {
        setPipelineState("ERROR");
        Logger.log(`[Pipeline Aborted] Structural Failure at Step 1: ${error.message}`, "danger");
        unlockPipelineUI();
        throw error;
    }
}

export function registerGeoRoutingHandler(fn) {
    if (typeof fn !== 'function') return;
    geoRoutingHandler = fn;
    console.log("[Kernel] Step 2 Geo Routing Handler successfully hooked into Step 1 pipeline.");
}
