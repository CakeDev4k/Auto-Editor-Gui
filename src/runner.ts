import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type AppState,
  type AudioStreamPreview,
  type CutsTimeline,
  type LogClass,
  type ProbeInfo,
  type QueueItem,
  FFMPEG_TIME_RE,
  NAMED_EXPORTS,
  TQDM_RE,
} from "./types";

export interface FileInfo {
  name: string;
  size_bytes: number;
  ext: string;
}

export async function fetchFileInfo(path: string): Promise<FileInfo> {
  return await invoke<FileInfo>("file_info", { path });
}

export async function listMediaFiles(
  dir: string,
  extensions: string[],
): Promise<string[]> {
  return await invoke<string[]>("list_media_files", { dir, extensions });
}

export async function probeFile(path: string): Promise<ProbeInfo> {
  return await invoke<ProbeInfo>("probe_file", { path });
}

export async function checkAutoEditor(): Promise<string> {
  return await invoke<string>("check_auto_editor");
}

export async function openInExplorer(path: string): Promise<void> {
  await invoke("open_in_explorer", { path });
}

export async function logDir(): Promise<string> {
  return await invoke<string>("log_dir");
}

export async function pathExists(path: string): Promise<boolean> {
  return await invoke<boolean>("path_exists", { path });
}

export async function cleanupTempFile(path: string): Promise<void> {
  await invoke("cleanup_temp_file", { path });
}

export function buildArgs(
  s: AppState,
  inputPath: string,
  outputPath?: string,
  editAudioStreams?: number[] | null,
): string[] {
  const args: string[] = [inputPath];

  if (s.advanced) {
    const expr = s.expression.trim();
    if (expr) args.push("--edit", expr);
  } else if (s.mode !== "none") {
    args.push("--edit", buildEditMethod(s, editAudioStreams));
  }

  const margin = s.margin.trim();
  if (margin) args.push("--margin", margin);

  if (s.exportFormat !== "none") {
    let value: string = s.exportFormat;
    if (NAMED_EXPORTS.has(s.exportFormat)) {
      const name = s.timelineName.trim();
      if (name) value = `${s.exportFormat}:name="${name}"`;
    }
    args.push("--export", value);
  }

  const out = (outputPath ?? "").trim();
  if (out) args.push("--output", out);

  return args;
}

/**
 * Apenas os args que afetam quais trechos serão cortados (sem export/output).
 * Usado pelo `preview_cuts` e como chave de cache da prévia.
 */
export function buildEditOnlyArgs(
  s: AppState,
  editAudioStreams?: number[] | null,
): string[] {
  const args: string[] = [];
  if (s.advanced) {
    const expr = s.expression.trim();
    if (expr) args.push("--edit", expr);
  } else if (s.mode !== "none") {
    args.push("--edit", buildEditMethod(s, editAudioStreams));
  }
  const margin = s.margin.trim();
  if (margin) args.push("--margin", margin);
  return args;
}

function buildEditMethod(
  s: AppState,
  editAudioStreams?: number[] | null,
): string {
  const t = s.threshold.trim();
  if (s.mode === "audio") {
    const threshold = t ? `threshold=${t},` : "";
    if (editAudioStreams && editAudioStreams.length === 0) return "none";
    if (!editAudioStreams || editAudioStreams.length === 0) {
      return t ? `audio:threshold=${t},stream=all` : "audio:stream=all";
    }
    if (editAudioStreams.length === 1) {
      return `audio:${threshold}stream=${editAudioStreams[0]}`;
    }
    return `(${["or", ...editAudioStreams.map((stream) => `audio:${threshold}stream=${stream}`)].join(" ")})`;
  }
  return t ? `${s.mode}:threshold=${t}` : s.mode;
}

export async function previewCuts(
  input: string,
  editArgs: string[],
): Promise<CutsTimeline> {
  return await invoke<CutsTimeline>("preview_cuts", { input, editArgs });
}

/**
 * Prepara o preview de áudio de todas as faixas numa tacada só: os processos
 * rodam em paralelo e cada um decodifica o arquivo uma vez, produzindo os picos
 * e o WAV tocável juntos.
 */
export async function extractAudioPreviews(
  input: string,
  buckets: number,
  audioStreams: number,
): Promise<AudioStreamPreview[]> {
  return await invoke<AudioStreamPreview[]>("extract_audio_previews", {
    input,
    buckets,
    audioStreams,
  });
}

export function defaultOutputFor(item: QueueItem): string {
  const dot = item.path.lastIndexOf(".");
  return dot >= 0
    ? `${item.path.slice(0, dot)}_ALTERED${item.path.slice(dot)}`
    : `${item.path}_ALTERED`;
}

export function classifyLine(text: string): LogClass {
  const lower = text.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("erro") ||
    lower.includes("traceback") ||
    lower.includes("frame=0 ") ||
    lower.includes("bitrate=n/a")
  ) {
    return "error";
  }
  if (
    lower.includes("success") ||
    lower.includes("done") ||
    lower.includes("concluído") ||
    lower.includes("concluido")
  ) {
    return "success";
  }
  if (
    lower.includes("warning") ||
    lower.includes("aviso") ||
    lower.startsWith("ffmpeg version")
  ) {
    return "warning";
  }
  return "info";
}

/**
 * Tenta extrair progresso (0-100) e label de uma linha.
 * Retorna null se a linha não for de progresso.
 */
export function parseProgress(
  text: string,
  durationSecs: number | null,
): { percent: number; label: string } | null {
  const tq = text.match(TQDM_RE);
  if (tq) {
    return { percent: Math.min(100, parseInt(tq[2], 10)), label: tq[1] };
  }
  const ff = text.match(FFMPEG_TIME_RE);
  if (ff && durationSecs && durationSecs > 0) {
    const cur = parseInt(ff[1]) * 3600 + parseInt(ff[2]) * 60 + parseFloat(ff[3]);
    const pct = Math.max(0, Math.min(100, (cur / durationSecs) * 100));
    return { percent: pct, label: "encode" };
  }
  return null;
}

export interface RunHandlers {
  onLine: (text: string, cls: LogClass) => void;
  onProgress: (percent: number, label: string) => void;
  onExit: (code: number) => void;
}

export interface RunOptions {
  state: AppState;
  inputPath: string;
  outputPath?: string;
  editAudioStreams?: number[] | null;
  durationSecs: number | null;
  cwd: string | null;
}

export async function startEditor(
  opts: RunOptions,
  h: RunHandlers,
): Promise<UnlistenFn[]> {
  const args = buildArgs(
    opts.state,
    opts.inputPath,
    opts.outputPath,
    opts.editAudioStreams,
  );
  const duration = opts.durationSecs;

  const offLine = await listen<{ stream: string; text: string }>(
    "editor://line",
    (e) => {
      const raw = e.payload.text.replace(/\r/g, "\n");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;

        const prog = parseProgress(t, duration);
        if (prog) {
          h.onProgress(prog.percent, prog.label);
          continue;
        }

        h.onLine(t, classifyLine(t));
      }
    },
  );

  const offExit = await listen<{ code: number }>("editor://exit", (e) => {
    h.onExit(e.payload.code);
  });

  await invoke("run_editor", { args, cwd: opts.cwd });

  return [offLine, offExit];
}

export async function cancelEditor(): Promise<void> {
  await invoke("cancel_editor");
}
