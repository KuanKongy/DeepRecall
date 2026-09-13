import { sha256 } from "hash-wasm";

// Identity sent with rate-limited requests as X-Client-Id: "<uuid>.<sha256>".
// The UUID is the personal rate-limit key (each browser gets its own quota,
// so people behind one shared NAT don't starve each other); the fingerprint
// hash is a forensic signal the server only logs, never limits on.

const STORAGE_KEY = "deeprecall-device";

// Private browsing can deny localStorage; a per-page-load ID still keeps the
// session's requests on one quota, and the server's IP guard backs it up.
let memoryId: string | null = null;

function deviceId(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    if (!memoryId) memoryId = crypto.randomUUID();
    return memoryId;
  }
}

let cached: Promise<string> | null = null;

export function clientId(): Promise<string> {
  if (!cached) {
    const traits = [
      navigator.platform ?? "",
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      String(window.devicePixelRatio ?? ""),
      navigator.userAgent,
      (navigator.languages ?? [navigator.language]).join(","),
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
      String(navigator.hardwareConcurrency ?? ""),
    ].join("|");
    cached = sha256(traits).then((hash) => `${deviceId()}.${hash}`);
  }
  return cached;
}
