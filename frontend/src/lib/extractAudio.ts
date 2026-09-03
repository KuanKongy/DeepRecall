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

export interface ExtractedAudio {
  blob: Blob;
  filename: string;
}

// Demux the audio track without re-encoding (seconds, not minutes), so a
// 1 GB lecture uploads as a ~40 MB file. WORKERFS mounts the File directly
// instead of copying it into wasm memory. AAC sources (mp4/mov) land in m4a;
// opus/vorbis sources (webm/mkv) need the webm container instead.
export async function extractAudio(file: File): Promise<ExtractedAudio> {
  const ffmpeg = await getFFmpeg();
  await ffmpeg.createDir("/input");
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, "/input");
  const attempts: Array<{ out: string; type: string }> = [
    { out: "audio.m4a", type: "audio/mp4" },
    { out: "audio.webm", type: "audio/webm" },
  ];
  try {
    for (const attempt of attempts) {
      const code = await ffmpeg.exec([
        "-hide_banner", "-loglevel", "error",
        "-i", `/input/${file.name}`,
        "-vn", "-c:a", "copy", "-y", attempt.out,
      ]);
      if (code !== 0) continue;
      const data = await ffmpeg.readFile(attempt.out);
      await ffmpeg.deleteFile(attempt.out);
      return { blob: new Blob([data], { type: attempt.type }), filename: attempt.out };
    }
    throw new Error("ffmpeg could not demux the audio track");
  } finally {
    for (const attempt of attempts) {
      try { await ffmpeg.deleteFile(attempt.out); } catch { /* not created */ }
    }
    try {
      await ffmpeg.unmount("/input");
      await ffmpeg.deleteDir("/input");
    } catch { /* already gone */ }
  }
}
