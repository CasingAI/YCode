/**
 * 附件上传事务的全量 checksum。
 *
 * 修复依据：Web 端常以 http 预览 / 局域网远程访问打开（非安全上下文），此时
 * `globalThis.crypto.subtle` 为 undefined（WebCrypto 仅限安全上下文），原实现
 * 在 begin 之前直接抛 fault.attachment.checksumUnavailable，导致图片/文本/二进制
 * 全部附件尚未开传就失败。仓库已知约束，先例见 useTaskSessionFilePath 注释。
 * CLI 侧 attachment-upload-registry 按 `sha256:<小写 hex>` 全量比对，回退实现
 * 必须产出逐字节一致的格式；安全上下文仍优先原生 WebCrypto。
 */
export async function computeAttachmentChecksum(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    // WebCrypto 的 BufferSource 要求 ArrayBuffer；复制避免调用期间底层 view 被复用。
    const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    const hex = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `sha256:${hex}`;
  }
  return `sha256:${sha256Hex(bytes)}`;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** FIPS 180-4 纯 JS SHA-256；仅在非安全上下文（无 WebCrypto）时使用。 */
function sha256Hex(bytes: Uint8Array): string {
  const state = Uint32Array.from(SHA256_INITIAL_STATE);
  const words = new Uint32Array(64);
  const totalBytes = bytes.byteLength;
  const bitLengthHi = Math.floor(totalBytes / 0x20000000) >>> 0;
  const bitLengthLo = (totalBytes << 3) >>> 0;
  // 含 0x80 填充与 8 字节大端位长头的最终字节数（FIPS 180-4 §5.1）。
  const paddedTotal = ((totalBytes + 9 + 63) >> 6) << 6;
  // noUncheckedIndexedAccess 下读值收敛为 number；循环索引均在界内，缺省值不会命中。
  const messageByte = (pos: number): number =>
    pos < totalBytes ? (bytes[pos] ?? 0) : pos === totalBytes ? 0x80 : 0;
  const word = (index: number): number => words[index] ?? 0;

  for (let blockStart = 0; blockStart < paddedTotal; blockStart += 64) {
    for (let i = 0; i < 16; i += 1) {
      const index = blockStart + i * 4;
      words[i] =
        ((messageByte(index) << 24) |
          (messageByte(index + 1) << 16) |
          (messageByte(index + 2) << 8) |
          messageByte(index + 3)) >>>
        0;
    }
    // 末块最后 8 字节为位长；该区间 messageByte 恒为 0，直接覆盖。
    if (blockStart + 64 === paddedTotal) {
      words[14] = bitLengthHi;
      words[15] = bitLengthLo;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = word(i - 15);
      const y = word(i - 2);
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[i] = (word(i - 16) + s0 + word(i - 7) + s1) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (SHA256_K[i] ?? 0) + word(i)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += (state[i] ?? 0).toString(16).padStart(8, "0");
  return hex;
}
