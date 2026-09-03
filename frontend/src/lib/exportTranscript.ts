import type { TranscriptSegment } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)},${String(frac).padStart(3, "0")}`;
}

export function transcriptToSrt(transcript: TranscriptSegment[]): string {
  return transcript
    .map((seg, i) => `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text.trim()}\n`)
    .join("\n");
}

export function transcriptToTxt(transcript: TranscriptSegment[]): string {
  return transcript.map((seg) => `[${fmtTime(seg.start)}] ${seg.text.trim()}`).join("\n");
}

export function downloadFile(name: string, content: string, mime = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
