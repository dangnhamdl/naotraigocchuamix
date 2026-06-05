/**
 * ============================================================================
 * NKTg AI SYSTEM CORE KERNEL - STEP 6a: BRAIN ENCODER (ĐẠI NÃO)
 * ============================================================================
 * Specification: Production-ready NKTg AI Brain Encoder
 * Token → 21-dimensional semantic vector
 * Version: 2.0.0
 * License: Commercial
 *
 * Bất biến với mọi loại dữ liệu — nhận tokenList từ cổng nhập (Step 3x)
 * Không chứa logic tokenize text — đã chuyển về Step 3
 */

function fnv1a32(str) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function parkMillerNext(seed) {
  const a = 16807;
  const m = 2147483647;
  const q = 127773;
  const r = 2836;
  const hi = Math.floor(seed / q);
  const lo = seed % q;
  let test = a * lo - r * hi;
  if (test <= 0) test += m;
  return test;
}

function seededFloatsFromSeed(seed, dims) {
  const m = 2147483647;
  let s = seed >>> 0;
  if (s === 0) s = 1;
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    s = parkMillerNext(s);
    out[i] = (s / m) * 2 - 1;
  }
  return out;
}

function zscoreInPlace(arr, useSampleVariance = false) {
  const n = arr.length;
  if (n === 0) return;
  let mean = 0.0, M2 = 0.0, count = 0;
  for (let i = 0; i < n; i++) {
    count++;
    const x = arr[i];
    const delta = x - mean;
    mean += delta / count;
    M2 += delta * (x - mean);
  }
  const denom = useSampleVariance && count > 1 ? (count - 1) : count;
  const variance = denom > 0 ? M2 / denom : 0;
  const std = Math.sqrt(variance);
  if (std === 0 || !isFinite(std)) {
    for (let i = 0; i < n; i++) arr[i] = 0;
  } else {
    for (let i = 0; i < n; i++) arr[i] = (arr[i] - mean) / std;
  }
}

function makeDeterministicProjection(seed, inDim, outDim) {
  const mat = new Float32Array(outDim * inDim);
  let s = seed >>> 0;
  if (s === 0) s = 1;
  const scale = Math.sqrt(2.0 / (inDim + outDim));
  for (let i = 0; i < outDim * inDim; i++) {
    s = parkMillerNext(s);
    mat[i] = ((s / 2147483647) * 2 - 1) * scale;
  }
  return { mat, inDim, outDim };
}

function applyProjection(vecIn, proj) {
  const { mat, inDim, outDim } = proj;
  const out = new Float32Array(outDim);
  for (let row = 0; row < outDim; row++) {
    let acc = 0.0;
    const baseIdx = row * inDim;
    for (let col = 0; col < inDim; col++) {
      acc += mat[baseIdx + col] * vecIn[col];
    }
    out[row] = acc;
  }
  return out;
}

class NKTgBrainEncoder {
  constructor(options = {}) {
    this.dims = Number.isInteger(options.dims) && options.dims > 0 ? options.dims : 21;
    this.useProjection = !!options.useProjection;
    this.projOutDim = Number.isInteger(options.projOutDim) && options.projOutDim > 0 ? options.projOutDim : this.dims;
    this.seed = options.seed || 2026;
    this.cache = new Map();
    this.stats = { totalTokens: 0, cacheHits: 0, cacheMisses: 0, seedZeroCount: 0 };
    if (this.useProjection) {
      this.proj = makeDeterministicProjection(this.seed ^ 0x9e3779b9, this.dims, this.projOutDim);
    } else {
      this.proj = null;
    }
    this.onCacheMiss = typeof options.onCacheMiss === 'function' ? options.onCacheMiss : null;
    this.onSeedZero = typeof options.onSeedZero === 'function' ? options.onSeedZero : null;
  }

  encodeToken(token) {
    this.stats.totalTokens++;
    if (this.cache.has(token)) {
      this.stats.cacheHits++;
      return this.cache.get(token).slice(0);
    }
    this.stats.cacheMisses++;
    let seed = fnv1a32(token) >>> 0;
    if (seed === 0) {
      this.stats.seedZeroCount++;
      if (this.onSeedZero) try { this.onSeedZero(token); } catch (e) {}
      seed = fnv1a32(token + '_fallback') >>> 0;
      if (seed === 0) seed = (token.length * 31 + 1) >>> 0;
    }
    if (this.onCacheMiss) try { this.onCacheMiss(token, seed); } catch (e) {}
    const baseVec = seededFloatsFromSeed(seed, this.dims);
    zscoreInPlace(baseVec);
    let finalVec;
    if (this.useProjection && this.proj) {
      finalVec = applyProjection(baseVec, this.proj);
      zscoreInPlace(finalVec);
    } else {
      finalVec = baseVec;
    }
    this.cache.set(token, finalVec.slice(0));
    return finalVec.slice(0);
  }

  /**
   * Encode danh sách token từ context.tokenList
   * tokenList: string[] — nhận từ Step 3 (text) hoặc Step 3a/3b/3c (video/ảnh/PDF)
   */
  encodeTokenList(tokenList) {
    return tokenList.map((token, i) => ({
      token,
      vec: Array.from(this.encodeToken(token))
    }));
  }

  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      hitRate: this.stats.totalTokens > 0 ? (this.stats.cacheHits / this.stats.totalTokens * 100).toFixed(2) + '%' : '0%'
    };
  }

  reset() {
    this.cache.clear();
    this.stats = { totalTokens: 0, cacheHits: 0, cacheMisses: 0, seedZeroCount: 0 };
  }

  exportState() {
    const cacheObj = {};
    for (const [key, value] of this.cache.entries()) cacheObj[key] = Array.from(value);
    return {
      version: '2.0.0',
      dims: this.dims,
      useProjection: this.useProjection,
      projOutDim: this.projOutDim,
      seed: this.seed,
      cache: cacheObj,
      stats: { ...this.stats },
      proj: this.proj ? { mat: Array.from(this.proj.mat), inDim: this.proj.inDim, outDim: this.proj.outDim } : null
    };
  }

  importState(state) {
    if (!state || typeof state !== 'object') throw new Error('Invalid state object');
    this.dims = state.dims || this.dims;
    this.useProjection = !!state.useProjection;
    this.projOutDim = state.projOutDim || this.projOutDim;
    this.seed = state.seed || this.seed;
    this.cache = new Map();
    if (state.cache) for (const key of Object.keys(state.cache)) this.cache.set(key, new Float32Array(state.cache[key]));
    if (state.stats) this.stats = { ...state.stats };
    if (state.proj) this.proj = { mat: new Float32Array(state.proj.mat), inDim: state.proj.inDim, outDim: state.proj.outDim };
    else this.proj = null;
  }

  static quantizeInt8(vec) {
    const out = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, vec[i])) * 127);
    return out;
  }

  static dequantizeInt8(vec) {
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / 127.0;
    return out;
  }
}

export { NKTgBrainEncoder, fnv1a32, parkMillerNext, zscoreInPlace };
