import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// Single-thread core: needs no COOP/COEP headers, so it works on GitHub Pages.
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let ffmpegPromise: Promise<FFmpeg> | null = null;

function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null; // allow a retry after a failed CDN load
      throw err;
    });
  }
  return ffmpegPromise;
}

// Demux the audio track without re-encoding (seconds, not minutes), so a
// 1 GB lecture uploads as a ~40 MB m4a. WORKERFS mounts the File directly
// instead of copying it into wasm memory.
export async function extractAudio(file: File): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  await ffmpeg.createDir("/input");
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, "/input");
  try {
    const code = await ffmpeg.exec([
      "-hide_banner", "-loglevel", "error",
      "-i", `/input/${file.name}`,
      "-vn", "-c:a", "copy", "-y", "audio.m4a",
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg demux failed with exit code ${code}`);
    }
    const data = await ffmpeg.readFile("audio.m4a");
    return new Blob([data], { type: "audio/mp4" });
  } finally {
    try { await ffmpeg.deleteFile("audio.m4a"); } catch { /* never created */ }
    try {
      await ffmpeg.unmount("/input");
      await ffmpeg.deleteDir("/input");
    } catch { /* already gone */ }
  }
}
