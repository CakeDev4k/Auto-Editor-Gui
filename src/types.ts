export type ModeKey = "audio" | "motion" | "none";
export type ExportKey =
  | "none"
  | "premiere"
  | "resolve"
  | "final-cut-pro"
  | "shotcut"
  | "kdenlive"
  | "clip-sequence";

/** Como uma escolha se apresenta no dropdown: ícone, nome e o que ela faz. */
export interface ChoiceMeta {
  label: string;
  icon: string;
  hint: string;
  /**
   * Nome de um logo em `logos.ts`. Quando existe, entra no lugar do `icon`:
   * na lista de editores, a logo do próprio app é reconhecida antes de o nome
   * ser lido.
   */
  logo?: string;
}

export const MODES: Record<ModeKey, ChoiceMeta> = {
  audio: {
    label: "Áudio",
    icon: "audioLines",
    hint: "Corta onde o som fica abaixo do threshold",
  },
  motion: {
    label: "Movimento",
    icon: "activity",
    hint: "Corta onde a imagem fica parada",
  },
  none: {
    label: "Padrão",
    icon: "sliders",
    hint: "Deixa o auto-editor decidir sozinho",
  },
};

export const EXPORTS: Record<ExportKey, ChoiceMeta> = {
  none: {
    label: "Arquivo de vídeo",
    icon: "film",
    hint: "Renderiza o vídeo já cortado",
  },
  premiere: {
    label: "Adobe Premiere Pro",
    icon: "layers",
    logo: "premiere",
    hint: "XML de timeline para importar",
  },
  resolve: {
    label: "DaVinci Resolve",
    icon: "layers",
    logo: "resolve",
    hint: "XML de timeline para importar",
  },
  "final-cut-pro": {
    label: "Final Cut Pro",
    icon: "layers",
    logo: "final-cut-pro",
    hint: "XML de timeline para importar",
  },
  shotcut: {
    label: "ShotCut",
    icon: "layers",
    logo: "shotcut",
    hint: "Projeto MLT",
  },
  kdenlive: {
    label: "Kdenlive",
    icon: "layers",
    logo: "kdenlive",
    hint: "Projeto MLT",
  },
  "clip-sequence": {
    label: "Clipes separados",
    icon: "clapper",
    hint: "Um arquivo por trecho mantido",
  },
};

export const NAMED_EXPORTS = new Set<ExportKey>([
  "premiere",
  "resolve",
  "final-cut-pro",
]);

export interface ProbeInfo {
  duration_secs: number;
  width: number | null;
  height: number | null;
  vcodec: string | null;
  acodec: string | null;
  has_audio: boolean;
  has_video: boolean;
  audio_streams: number;
  audio_tracks: AudioTrackInfo[];
}

export interface AudioTrackInfo {
  stream: number;
  name: string;
  codec: string | null;
  channels: number | null;
}

export type QueueStatus = "pending" | "running" | "done" | "error";

export interface CutChunk {
  start: number;
  end: number;
  speed: number;
  kept: boolean;
}

export interface CutsTimeline {
  duration: number;
  framerate: number;
  kept_seconds: number;
  cut_seconds: number;
  final_seconds: number;
  chunks: CutChunk[];
}

export interface QueueItem {
  path: string;
  name: string;
  sizeBytes: number;
  ext: string;
  probe: ProbeInfo | null;
  status: QueueStatus;
  outputPath: string;
  error?: string;
  preview: CutsTimeline | null;
  previewKey: string;
  /** Uma entrada por faixa de áudio; extraídas uma vez por arquivo. */
  audioPreviews: AudioStreamPreview[] | null;
  audioPreviewsLoading: boolean;
  /** Marca falha para não ficar tentando extrair o mesmo arquivo em loop. */
  audioPreviewsFailed: boolean;
  /** Onda das faixas ativas, calculada no front a partir de `audioPreviews`. */
  mixedPeaks: number[] | null;
  mixedPeaksKey: string;
  previewAudioStreams: number[] | null;
}

/**
 * Preview de uma faixa de áudio. Sai de uma única passada de ffmpeg por faixa,
 * que produz os picos e (quando há mais de uma faixa) o WAV tocável.
 */
export interface AudioStreamPreview {
  stream: number;
  name: string;
  /** Amplitudes 0-255. */
  peaks: number[];
  /** Vazio quando o arquivo tem uma faixa só — aí o vídeo toca o áudio nativo. */
  proxy_path: string;
}

export const WAVEFORM_BUCKETS = 4000;
/**
 * Densidade da onda. 30 baldes por segundo desenham bem no zoom que a timeline
 * oferece e, num arquivo de uma hora, mandam metade dos números pela IPC do que
 * os 60 anteriores — que a tela nunca chegava a mostrar.
 */
export const WAVEFORM_BUCKETS_PER_SEC = 30;
export const WAVEFORM_BUCKETS_MAX = 120000;

export interface AppState {
  queue: QueueItem[];
  selectedIndex: number;
  outputFile: string;
  advanced: boolean;
  mode: ModeKey;
  margin: string;
  threshold: string;
  expression: string;
  exportFormat: ExportKey;
  timelineName: string;
  processing: boolean;
  cancelled: boolean;
}

export const DEFAULT_STATE: AppState = {
  queue: [],
  selectedIndex: -1,
  outputFile: "",
  advanced: false,
  mode: "audio",
  margin: "0.2sec",
  threshold: "0.04",
  expression: "(or audio:stream=0 audio:threshold=10%,stream=1)",
  exportFormat: "premiere",
  timelineName: "Auto-Editor Media Group",
  processing: false,
  cancelled: false,
};

export type LogClass = "info" | "success" | "warning" | "error" | "command";

// Validação de inputs
export const MARGIN_RE = /^\d+(\.\d+)?(sec|s|ms|%)?$/i;
export const THRESHOLD_RE = /^\d+(\.\d+)?%?$/;

// Regex de progresso
// auto-editor (tqdm): "Cutting:  47%|██▏  | ..."
export const TQDM_RE = /(\w+):\s+(\d+)%\|/;
// ffmpeg embebido: "frame=  123 fps=... time=00:01:23.45 ..."
export const FFMPEG_TIME_RE = /time=(\d+):(\d+):([\d.]+)/;
