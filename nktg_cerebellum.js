/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 6b: CEREBELLUM ENGINE
 * ============================================================================
 * File: /nktg-ai/nktg_cerebellum.js
 * Specification: Production Enterprise Compliance (ES Module)
 *
 * Thuật toán NKTg gốc:
 *   X = H × W_x                    (thế năng ngữ nghĩa)
 *   V = (H - H_prev) × W_v         (vận tốc thay đổi)
 *   M = sigmoid(H × W_m)           (khối lượng động)
 *   P = M ⊙ V                      (động lượng element-wise)
 *   NKTg1 = X^T × B × P            (tích song tuyến tính)
 *   NKTg2 = ΔM^T × B × P          (tích song tuyến tính)
 *   state = sign(NKTg1 × NKTg2)    (không xác suất, không MLP)
 *
 * Bất biến với mọi loại dữ liệu:
 *   - Nhận tokensWithVecs từ Step 6a (đã encode)
 *   - Nhận sentenceMap từ context (do Step 3x cung cấp)
 *   - Không chứa logic text, tokenize, hay splitSentences
 */

import { NKTgBrainEncoder } from './nktg_brain_encoder.js';
import { handleKernelLayer } from './step7-nktg-kernel.js';
import { setPipelineState, unlockPipelineUI, Logger } from './step1-init.js';

const brainEncoder = new NKTgBrainEncoder({ dims: 21 });

// ============================================================================
// DETERMINISTIC MATRIX GENERATION (thay thế ma trận học được)
// Dùng Park-Miller seed để tạo W_x, W_v, W_m, B cố định, không training
// ============================================================================

function makeDetMatrix(seed, rows, cols) {
    const mat = new Float32Array(rows * cols);
    let s = (seed >>> 0) || 1;
    const scale = Math.sqrt(2.0 / (rows + cols)); // Xavier init
    for (let i = 0; i < rows * cols; i++) {
        const hi = Math.floor(s / 127773);
        const lo = s % 127773;
        let next = 16807 * lo - 2836 * hi;
        if (next <= 0) next += 2147483647;
        s = next;
        mat[i] = ((s / 2147483647) * 2 - 1) * scale;
    }
    return mat;
}

// Ma trận chiếu deterministic — d=21, d_k=21
const DIMS = 21;
const W_x = makeDetMatrix(0xA1B2C3D4, DIMS, DIMS);
const W_v = makeDetMatrix(0xB2C3D4E5, DIMS, DIMS);
const W_m = makeDetMatrix(0xC3D4E5F6, DIMS, DIMS);
const B   = makeDetMatrix(0xD4E5F6A7, DIMS, DIMS);

// ============================================================================
// TÍNH TRẠNG THÁI THEO TỈ LỆ TOKEN — dùng chung cho đơn vị và toàn dữ liệu
// Đa số tương đối thắng — không dùng ngưỡng cứng
// STABLE chỉ khi AMP = DAMP (bằng nhau thật sự)
// ============================================================================

function calcState(counts, n) {
    if (n === 0) return 'STABLE';
    if (counts.AMP > counts.DAMP && counts.AMP > counts.STABLE) return 'AMPLIFYING';
    if (counts.DAMP > counts.AMP && counts.DAMP > counts.STABLE) return 'DAMPING';
    return 'STABLE';
}

// ============================================================================
// VECTOR OPERATIONS
// ============================================================================

function matMulVec(vec, mat, d, dk) {
    const out = new Float32Array(dk);
    for (let j = 0; j < dk; j++) {
        let acc = 0;
        for (let i = 0; i < d; i++) acc += vec[i] * mat[i * dk + j];
        out[j] = acc;
    }
    return out;
}

function sigmoidVec(vec) {
    return vec.map(x => 1 / (1 + Math.exp(-x)));
}

function elemMul(a, b) {
    return a.map((v, i) => v * b[i]);
}

function elemSub(a, b) {
    return a.map((v, i) => v - b[i]);
}

function bilinear(x, B, p, d) {
    const tmp = new Float32Array(d);
    for (let i = 0; i < d; i++) {
        let acc = 0;
        for (let j = 0; j < d; j++) acc += B[i * d + j] * p[j];
        tmp[i] = acc;
    }
    let scalar = 0;
    for (let i = 0; i < d; i++) scalar += x[i] * tmp[i];
    return scalar;
}

function norm(vec) {
    return Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
}

// ============================================================================
// NKTg CEREBELLUM
// ============================================================================

class NKTgCerebellum {
    constructor() {
        this.deltaT = 1; // Δt = 1 (bước thời gian cố định giữa các token)
    }

    /**
     * Xử lý toàn bộ chuỗi token theo thuật toán NKTg gốc
     * @param {Array} tokensWithVecs - [{token, vec}] — nhận từ Step 6a
     * @param {Array} sentenceMap   - [string]        — nhận từ context (Step 3x)
     */
    processSentence(tokensWithVecs, sentenceMap) {
        const n = tokensWithVecs.length;
        const results = [];

        let H_prev = new Float32Array(DIMS).fill(0);
        let M_prev = new Float32Array(DIMS).fill(0.5); // sigmoid(0) = 0.5

        let sumNKTg1 = 0;
        let globalCounts = { AMP: 0, DAMP: 0, STABLE: 0 };

        // ---------------------------------------------------------------
        // Tính state từng token — gốc của mọi phân tích
        // ---------------------------------------------------------------
        for (let idx = 0; idx < n; idx++) {
            const { token, vec } = tokensWithVecs[idx];
            const H = new Float32Array(vec);

            const X = matMulVec(H, W_x, DIMS, DIMS);

            const dH = elemSub(Array.from(H), Array.from(H_prev));
            const dH_dt = dH.map(v => v / this.deltaT);
            const V = matMulVec(dH_dt, W_v, DIMS, DIMS);

            const HWm = matMulVec(H, W_m, DIMS, DIMS);
            const M = new Float32Array(sigmoidVec(Array.from(HWm)));

            const P = elemMul(Array.from(M), Array.from(V));
            const NKTg1 = bilinear(Array.from(X), B, P, DIMS);

            const deltaM = elemSub(Array.from(M), Array.from(M_prev))
                .map(v => v / this.deltaT);
            const NKTg2 = bilinear(deltaM, B, P, DIMS);

            const product = NKTg1 * NKTg2;
            let state;
            if (product > 0) state = 'AMPLIFYING';
            else if (product < 0) state = 'DAMPING';
            else state = 'STABLE';

            const P_scalar = norm(Array.from(M)) * norm(Array.from(V));

            sumNKTg1 += NKTg1;
            if (state === 'AMPLIFYING') globalCounts.AMP++;
            else if (state === 'DAMPING') globalCounts.DAMP++;
            else globalCounts.STABLE++;

            results.push({
                token,
                P: +P_scalar.toFixed(4),
                NKTg1: +NKTg1.toFixed(4),
                NKTg2: +NKTg2.toFixed(4),
                state
            });

            H_prev = H;
            M_prev = M;
        }

        // ---------------------------------------------------------------
        // Tính trạng thái từng đơn vị — gom token theo sentenceMap
        // sentenceMap do Step 3x cung cấp — text: câu, video: scene, ảnh: region
        // ---------------------------------------------------------------
        const sentenceScores = {};
        let tokenIndex = 0;

        for (const sentence of sentenceMap) {
            const unitTokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}''\-]*/gu) || [];
            const count = unitTokens.length;
            const slice = results.slice(tokenIndex, tokenIndex + count);
            tokenIndex += count;

            if (slice.length === 0) continue;

            const counts = { AMP: 0, DAMP: 0, STABLE: 0 };
            for (const t of slice) {
                if (t.state === 'AMPLIFYING') counts.AMP++;
                else if (t.state === 'DAMPING') counts.DAMP++;
                else counts.STABLE++;
            }

            sentenceScores[sentence] = {
                state: calcState(counts, slice.length),
                amplifying_ratio: counts.AMP / slice.length,
                damping_ratio:    counts.DAMP / slice.length,
                stable_ratio:     counts.STABLE / slice.length
            };
        }

        // ---------------------------------------------------------------
        // Tính trạng thái toàn dữ liệu — từ tất cả token
        // ---------------------------------------------------------------
        const metrics = {
            sumP: +sumNKTg1.toFixed(4),
            amplifying_ratio: globalCounts.AMP / n,
            damping_ratio:    globalCounts.DAMP / n,
            stable_ratio:     globalCounts.STABLE / n,
            state: calcState(globalCounts, n)
        };

        return { tokens: results, sentenceScores, metrics };
    }
}

export const cerebellum = new NKTgCerebellum();

export async function handleSmallAILayer(context) {
    try {
        Logger.log("[Step 6b Node] Cerebellum Engine processing...", "info");

        // Nhận tokenList từ context (Step 3 đã chuẩn bị)
        const encodedTokens = brainEncoder.encodeTokenList(context.tokenList);
        const tokensWithVecs = encodedTokens.map(item => ({
            token: item.token,
            vec: item.vec
        }));

        const encoderStats = brainEncoder.getStats();
        Logger.log(
            `[Step 6a Encoder] Tokens: ${encoderStats.totalTokens} | Cache hit: ${encoderStats.hitRate}`,
            "info"
        );

        // Nhận sentenceMap từ context (Step 3 đã chuẩn bị)
        const aiResult = cerebellum.processSentence(tokensWithVecs, context.sentenceMap);
        context.ai = { ...aiResult, processedAt: Date.now() };

        Logger.log(
            `[Step 6b Metrics] State: ${aiResult.metrics.state} | Amplifying: ${(aiResult.metrics.amplifying_ratio * 100).toFixed(0)}% | Damping: ${(aiResult.metrics.damping_ratio * 100).toFixed(0)}% | Stable: ${(aiResult.metrics.stable_ratio * 100).toFixed(0)}% | Sentences: ${Object.keys(aiResult.sentenceScores).length}`,
            "success"
        );

        await handleKernelLayer(context);

    } catch (err) {
        Logger.log(`[Step 6b Fatal] ${err.message}`, "danger");
        setPipelineState("ERROR");
        unlockPipelineUI();
    }
}
