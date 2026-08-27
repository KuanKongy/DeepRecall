import { createSHA256 } from "hash-wasm";

// Streams the file through hash-wasm in 8 MB slices: constant memory at
// ~1 GB/s, and byte-identical to the server's hashlib.sha256 so cache keys
// match. (SubtleCrypto is one-shot and would need the whole file in RAM.)
export async function hashFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const chunk = file.slice(offset, offset + chunkSize);
    hasher.update(new Uint8Array(await chunk.arrayBuffer()));
    if (onProgress) onProgress(Math.min(1, (offset + chunkSize) / file.size));
  }
  return hasher.digest("hex");
}
