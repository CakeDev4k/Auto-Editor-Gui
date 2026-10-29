import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  type AppState,
  type AudioStreamPreview,
  type CutsTimeline,
  type ExportKey,
  type LogClass,
  type ModeKey,
  type QueueItem,
  type QueueStatus,
  DEFAULT_STATE,
  EXPORTS,
  MARGIN_RE,
  MODES,
  NAMED_EXPORTS,
  THRESHOLD_RE,
  WAVEFORM_BUCKETS,
  WAVEFORM_BUCKETS_MAX,
  WAVEFORM_BUCKETS_PER_SEC,
} from "./types";
import {
  buildEditOnlyArgs,
  cancelEditor,
  checkAutoEditor,
  cleanupTempFile,
  defaultOutputFor,
  extractAudioPreviews,
  fetchFileInfo,
  listMediaFiles,
  logDir,
  openInExplorer,
  previewCuts,
  probeFile,
  startEditor,
} from "./runner";
import { SUPPORTED_EXTS, VIDEO_EXTS } from "./media";
import { runPreflight } from "./preflight";
import { getIcon } from "./icons";
import { findAppUpdate, installAppUpdate } from "./appUpdate";
import type { Update } from "@tauri-apps/plugin-updater";
import { createSelect } from "./select";
import {
  type ToolId,
  type ToolProgress,
  type ToolStatus,
  type ToolUpdate,
  AUTO_EDITOR_REPO_URL,
  AUTO_EDITOR_SITE_URL,
  FFMPEG_BUILDS_URL,
  FFMPEG_SITE_URL,
  TAURI_URL,
  CUT_PRIME_URL,
  checkToolUpdates,
  displayVersion,
  installToolUpdate,
  managedToolsDir,
  onToolProgress,
  openExternal,
  phaseLabel,
  restoreBundledTool,
  toolsStatus,
} from "./tools";

type Status = "idle" | "running" | "ok" | "err";

interface WaveStyle {
  /** Onda do trecho que sobrevive: sempre o elemento mais aceso da trilha. */
  kept: string;
  /** Onda do trecho cortado: apagada, para ler como "isso não vai existir". */
  cut: string;
  /** Véu vermelho sobre o trecho cortado. */
  cutWash: string;
  /** Régua sólida no topo. Sem ela, as trilhas de faixa individual. */
  ruler?: boolean;
  rulerKept?: string;
  rulerCut?: string;
}

/**
 * Verde = fica, vermelho = sai — os dois únicos significados que a cor carrega
 * na timeline. O contraste faz o trabalho pesado: o trecho mantido é o que
 * brilha, o cortado é um fantasma sob a faixa vermelha.
 */
const WAVE_COLORS: WaveStyle = {
  kept: "#4ade80",
  cut: "rgba(255, 255, 255, 0.14)",
  cutWash: "rgba(220, 38, 38, 0.14)",
  ruler: true,
  rulerKept: "#22c55e",
  rulerCut: "#dc2626",
};

/** Minimapa: sem régua, porque a trilha inteira já é o resumo. */
const MINI_WAVE_COLORS: WaveStyle = {
  kept: "#4ade80",
  cut: "rgba(255, 255, 255, 0.12)",
  cutWash: "rgba(220, 38, 38, 0.26)",
};

/** Faixas individuais: mesma leitura, um tom abaixo da trilha principal. */
const LANE_WAVE_COLORS: WaveStyle = {
  kept: "#86efac",
  cut: "rgba(255, 255, 255, 0.1)",
  cutWash: "rgba(220, 38, 38, 0.1)",
};

function formatDuration(secs: number): string {
  if (!secs || !isFinite(secs)) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatMediaTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fileIcon(ext: string): string {
  return VIDEO_EXTS.has(ext) ? getIcon("film", 14, "icon-video") : getIcon("music", 14, "icon-audio");
}

export async function mountUI(root: HTMLElement) {
  const state: AppState = { ...DEFAULT_STATE, queue: [] };
  let unlisteners: Array<() => void> = [];
  let unlistenTools: (() => void) | null = null;
  let userScrolled = false;

  root.innerHTML = `
    <!-- A janela não tem a moldura do Windows: esta barra arrasta a janela
         (duplo clique maximiza) e leva os três botões no canto. O atributo de
         arrastar vale só para o próprio elemento, por isso se repete nos filhos
         que não são botões. Sem marca do app aqui, por decisão do dono: o
         espaço da esquerda é do anúncio do Cut Prime. -->
    <header class="app-bar" data-tauri-drag-region>
      <button class="bar-promo" data-url="${CUT_PRIME_URL}" type="button" title="Conhecer o Cut Prime">
        <span class="bar-promo-tag">PRO</span>
        <strong>CUT PRIME</strong>
        ${getIcon("external", 11)}
      </button>
      <div class="app-bar-actions" data-tauri-drag-region>
        <span class="status-badge idle hidden" id="status">
          <span class="status-dot"></span>
          <span id="status-text"></span>
        </span>
        <button class="icon-btn" id="tools-btn" type="button" title="Dependências e atualizações">
          ${getIcon("package", 16)}
        </button>
        <button class="icon-btn" id="about-btn" type="button" title="Sobre e créditos">
          ${getIcon("info", 16)}
        </button>
        <div class="win-controls">
          <button class="win-ctl" id="win-min" type="button" title="Minimizar" aria-label="Minimizar">
            <svg viewBox="0 0 10 10" width="10" height="10"><path d="M1 5h8" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
          <button class="win-ctl" id="win-max" type="button" title="Maximizar" aria-label="Maximizar">
            <svg viewBox="0 0 10 10" width="10" height="10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
          <button class="win-ctl close" id="win-close" type="button" title="Fechar" aria-label="Fechar">
            <svg viewBox="0 0 10 10" width="10" height="10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
      </div>
    </header>

    <main class="app-main">
    <div id="banner" class="banner hidden"></div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">${getIcon("folder", 16)} Arquivos</div>
        <span class="card-subtitle" id="queue-summary"></span>
      </div>

      <div class="dropzone" id="dropzone">
        <div class="dz-icon">${getIcon("upload", 26)}</div>
        <div class="dz-body">
          <div class="dz-text">Arraste vídeos e áudios aqui</div>
          <div class="hint">ou clique para escolher · pode soltar uma pasta inteira</div>
        </div>
      </div>

      <ul class="file-list hidden" id="file-list"></ul>

      <div class="file-toolbar hidden" id="file-toolbar">
        <span class="cuts-summary" id="cuts-summary"></span>
        <span class="file-toolbar-spacer"></span>
        <button class="ghost" id="clear-btn">${getIcon("trash", 13)} Limpar tudo</button>
      </div>

      <div id="preview-wrap" class="hidden">
        <div class="preview-stage" id="preview-stage">
          <video id="preview" preload="metadata"></video>
          <div id="audio-layer-host" class="hidden"></div>
          <div id="audio-prep-chip" class="audio-prep-chip hidden">
            Preparando faixas de áudio…
          </div>

          <div id="preview-audio-dashboard" class="preview-audio-dashboard hidden">
            <div class="audio-info">
              <div class="audio-name" id="audio-dashboard-name">Nome do arquivo</div>
              <div class="audio-size-dur" id="audio-dashboard-meta">0 MB · 0:00</div>
            </div>
          </div>

          <div class="preview-controls" id="preview-controls">
            <button class="preview-btn-play" id="preview-btn-play" title="Tocar / pausar (espaço)" type="button">
              ${getIcon("play", 12)}
            </button>
            <input id="preview-scrub" class="preview-scrub" type="range" min="0" max="1000" value="0" step="1" />
            <span class="preview-time" id="preview-time">0:00 / 0:00</span>
            <button class="preview-btn-skip hidden" id="play-preview-btn" type="button"
                    aria-pressed="false" title="Prévia do corte: pula os trechos cortados">
              ${getIcon("skipCut", 12)}
            </button>
          </div>
          <div class="preview-loading hidden" id="preview-loading">
            <span id="preview-loading-text">Carregando preview...</span>
          </div>
        </div>

        <div id="cuts-section" class="hidden">
          <div class="cuts-minimap hidden" id="cuts-minimap" title="Arraste a área destacada para deslocar">
            <canvas class="cuts-waveform mini" id="cuts-mini-wave"></canvas>
            <div class="cuts-viewport" id="cuts-viewport"></div>
          </div>
          <div class="cuts-track-wrap" id="cuts-track-wrap" title="Roda: zoom · Arraste: deslocar · Duplo clique: resetar">
            <canvas class="cuts-waveform" id="cuts-wave"></canvas>
            <div class="cuts-playhead" id="cuts-playhead"></div>
            <div class="cuts-hover hidden" id="cuts-hover"></div>
          </div>
          <div class="audio-lanes hidden" id="audio-lanes"></div>
          <div class="cuts-axis">
            <span id="cuts-time-cur">0:00</span>
            <span id="cuts-legend">
              <span class="lg-dot kept"></span> mantido
              <span class="lg-dot cut"></span> cortado
              <span class="zoom-info hidden" id="zoom-info"></span>
            </span>
            <span id="cuts-time-end">—</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">${getIcon("settings", 16)} Edição</div>
        <div class="advanced-toggle-wrapper">
          <span class="toggle-label">Modo avançado</span>
          <label class="switch">
            <input type="checkbox" id="advanced" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>

      <div id="simple-mode">
        <label id="mode-label">Modo</label>
        <div id="mode-select"></div>

        <div class="row" style="margin-top:10px">
          <div>
            <label for="margin">Margem</label>
            <input id="margin" type="text" />
            <div class="error-msg" id="margin-err"></div>
          </div>
          <div>
            <label for="threshold">Threshold</label>
            <input id="threshold" type="text" />
            <div class="error-msg" id="threshold-err"></div>
          </div>
        </div>
      </div>

      <div id="advanced-mode" class="hidden">
        <label for="expression">Expressão</label>
        <textarea id="expression" rows="3"></textarea>
        <div class="expression-actions">
          <span class="expression-note">
            No modo avançado os cortes não se atualizam sozinhos.
          </span>
          <button id="analyze-btn" class="primary" type="button">
            ${getIcon("zap", 13)} Aplicar expressão
          </button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${getIcon("export", 16)} Exportar</div>
      <label id="export-label">Formato</label>
      <div id="export-select"></div>

      <div id="timeline-wrap">
        <label for="timeline">Nome da Timeline</label>
        <input id="timeline" type="text" />
      </div>

      <div id="output-wrap">
        <label for="output">Salvar como (opcional)</label>
        <div class="row">
          <input id="output" type="text" placeholder="Auto: <nome>_ALTERED.<ext>" />
          <button id="output-btn" type="button" style="flex:0 0 auto">${getIcon("folder", 13)} Escolher…</button>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="primary" id="run-btn">${getIcon("play", 15)} Iniciar Edição</button>
      <button class="danger" id="cancel-btn" disabled>${getIcon("stop", 15)} Cancelar</button>
    </div>

    <div class="card log-card" id="log-card">
      <div class="card-header">
        <button class="card-title log-toggle" id="log-toggle" type="button"
                aria-expanded="true" aria-controls="log-body">
          <span class="log-chevron">${getIcon("chevron", 14)}</span>
          ${getIcon("terminal", 16)} Log
        </button>
        <button id="open-logs-btn" class="ghost">${getIcon("fileText", 13)} Abrir pasta de logs</button>
      </div>

      <div class="progress-wrap hidden" id="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        <div class="progress-meta">
          <span id="progress-label">—</span>
          <span id="progress-pct">0%</span>
        </div>
      </div>

      <div class="log-body" id="log-body">
        <div class="log" id="log"></div>
      </div>
    </div>
    </main>

    <div class="modal-backdrop hidden" id="done-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="done-modal-title">
        <div class="modal-head">
          <div class="modal-title" id="done-modal-title">
            <span class="done-check">${getIcon("check", 14)}</span>
            <span id="done-title-text">Corte concluído</span>
          </div>
          <button class="icon-btn" id="done-close" type="button" title="Fechar">
            ${getIcon("x", 15)}
          </button>
        </div>
        <div class="modal-body">
          <p class="done-summary" id="done-summary"></p>

          <div class="done-files" id="done-files"></div>

        </div>
        <div class="modal-foot">
          <label class="checkbox">
            <input type="checkbox" id="done-mute" />
            Não mostrar de novo
          </label>
          <div class="done-actions">
            <button class="ghost" id="done-dismiss" type="button">Fechar</button>
            <button class="primary" id="done-open" type="button">
              ${getIcon("folder", 13)} Mostrar na pasta
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-backdrop hidden" id="tools-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tools-modal-title">
        <div class="modal-head">
          <div class="modal-title" id="tools-modal-title">
            ${getIcon("package", 16)} Dependências
          </div>
          <button class="icon-btn" id="tools-close" type="button" title="Fechar">
            ${getIcon("x", 15)}
          </button>
        </div>
        <div class="modal-body">
          <div id="tools-list"></div>
          <div class="banner info hidden" id="tools-msg"></div>
          <p class="modal-note">
            As versões novas são baixadas para uma pasta do seu usuário e passam a ser
            usadas no lugar das que vieram no instalador — sem precisar de administrador.
            "Restaurar" apaga a cópia baixada e volta para a embarcada.
          </p>
        </div>
        <div class="modal-foot">
          <button class="ghost" id="tools-dir-btn" type="button">
            ${getIcon("folder", 13)} Abrir pasta
          </button>
          <button class="primary" id="tools-check-btn" type="button">
            ${getIcon("refresh", 14)} Verificar atualizações
          </button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop hidden" id="cutprime-modal">
      <div class="modal cutprime-pop" role="dialog" aria-modal="true" aria-labelledby="cutprime-title">
        <button class="icon-btn cutprime-x" id="cutprime-close" type="button" title="Fechar">
          ${getIcon("x", 15)}
        </button>
        <span class="cutprime-tag">CUT PRIME</span>
        <div class="cutprime-title" id="cutprime-title">Faça isso direto no Premiere</div>
        <p class="cutprime-text">Corte de silêncio e troca de câmera por voz, sem exportar XML.</p>
        <div class="cutprime-actions">
          <button class="ghost" id="cutprime-later" type="button">Agora não</button>
          <button class="primary" id="cutprime-open" data-url="${CUT_PRIME_URL}" type="button">
            ${getIcon("zap", 14)} Conhecer
          </button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop hidden" id="update-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
        <div class="modal-head">
          <div class="modal-title" id="update-modal-title">
            ${getIcon("download", 16)} Nova versão do PrimeTrim
          </div>
          <button class="icon-btn" id="update-close" type="button" title="Fechar">
            ${getIcon("x", 15)}
          </button>
        </div>
        <div class="modal-body">
          <p class="update-versions" id="update-versions"></p>
          <div class="update-notes" id="update-notes"></div>
          <div class="update-progress hidden" id="update-progress">
            <div class="progress-bar"><div class="progress-fill" id="update-progress-fill"></div></div>
            <span id="update-progress-label">Baixando…</span>
          </div>
          <div class="banner error hidden" id="update-error"></div>
        </div>
        <div class="modal-foot">
          <span class="update-busy-note hidden" id="update-busy-note">Termine o corte em andamento para atualizar.</span>
          <div class="update-actions">
            <button class="ghost" id="update-later" type="button">Depois</button>
            <button class="primary" id="update-install" type="button">
              ${getIcon("download", 14)} Atualizar e reiniciar
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-backdrop hidden" id="about-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="about-modal-title">
        <div class="modal-head">
          <div class="modal-title" id="about-modal-title">${getIcon("info", 16)} Sobre</div>
          <button class="icon-btn" id="about-close" type="button" title="Fechar">
            ${getIcon("x", 15)}
          </button>
        </div>
        <div class="modal-body">
          <div class="about-hero">
            <span class="brand-mark">${getIcon("primetrim", 24)}</span>
            <div>
              <div class="about-hero-title">PRIME<em>TRIM</em></div>
              <div class="about-hero-sub">Threshold · versão ${__APP_VERSION__}</div>
            </div>
          </div>

          <div class="app-update-row">
            <span class="app-update-status" id="app-update-status">Atualizações automáticas ativadas.</span>
            <button class="ghost" id="app-update-check" type="button">
              ${getIcon("refresh", 13)} Procurar atualização
            </button>
          </div>

          <div class="credit">
            <div class="credit-title">
              <span>${getIcon("zap", 14)} auto-editor</span>
              <span class="tool-tag" id="about-ae-version">—</span>
            </div>
            <div class="credit-body">
              Todo o corte automático deste app é feito pelo <strong>auto-editor</strong>,
              criado por <strong>WyattBlue</strong>. O PrimeTrim é apenas uma interface:
              a análise de áudio, a detecção de movimento e a exportação de timeline
              são dele.
            </div>
            <button class="credit-link" data-url="${AUTO_EDITOR_REPO_URL}" type="button">
              ${getIcon("github", 12)} github.com/WyattBlue/auto-editor
            </button>
            <button class="credit-link" data-url="${AUTO_EDITOR_SITE_URL}" type="button">
              ${getIcon("external", 12)} auto-editor.com
            </button>
            <div class="credit-body" style="color: var(--text-faint); font-size: 11.5px;">
              O repositório está em domínio público (Unlicense). Os binários publicados
              nas releases embutem outros projetos e seguem as licenças deles.
            </div>
          </div>

          <div class="credit">
            <div class="credit-title">
              <span>${getIcon("film", 14)} FFmpeg</span>
              <span class="tool-tag" id="about-ff-version">—</span>
            </div>
            <div class="credit-body">
              Leitura de metadados, extração de waveform e mixagem das faixas de áudio
              do preview. Builds "essentials" para Windows por gyan.dev; no Mac, builds de Martin Riedl.
            </div>
            <button class="credit-link" data-url="${FFMPEG_SITE_URL}" type="button">
              ${getIcon("external", 12)} ffmpeg.org
            </button>
            <button class="credit-link" data-url="${FFMPEG_BUILDS_URL}" type="button">
              ${getIcon("external", 12)} gyan.dev/ffmpeg/builds
            </button>
          </div>

          <div class="credit">
            <div class="credit-title"><span>${getIcon("package", 14)} Tauri</span></div>
            <div class="credit-body">Janela, ponte com o sistema e empacotamento do app.</div>
            <button class="credit-link" data-url="${TAURI_URL}" type="button">
              ${getIcon("external", 12)} tauri.app
            </button>
          </div>

          <p class="modal-note">
            PrimeTrim é um projeto Threshold. Feito para a rotina de quem corta muito
            material bruto e não quer fazer o primeiro passe na mão.
          </p>
        </div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    root.querySelector<T>(`#${id}`)!;

  const banner = $("banner") as HTMLDivElement;
  const dropzone = $("dropzone");
  const fileList = $("file-list") as HTMLUListElement;
  const fileToolbar = $("file-toolbar");
  const queueSummary = $("queue-summary") as HTMLSpanElement;
  const clearBtn = $("clear-btn") as HTMLButtonElement;
  const previewWrap = $("preview-wrap");
  const previewStage = $("preview-stage") as HTMLDivElement;
  const preview = $("preview") as HTMLVideoElement;
  const audioLayerHost = $("audio-layer-host") as HTMLDivElement;
  const audioPrepChip = $("audio-prep-chip") as HTMLDivElement;
  const previewControls = $("preview-controls") as HTMLDivElement;
  const previewScrub = $("preview-scrub") as HTMLInputElement;
  const previewTime = $("preview-time") as HTMLSpanElement;
  const previewLoading = $("preview-loading") as HTMLDivElement;
  const previewLoadingText = $("preview-loading-text") as HTMLSpanElement;
  const previewBtnPlay = $("preview-btn-play") as HTMLButtonElement;
  const previewAudioDashboard = $("preview-audio-dashboard") as HTMLDivElement;
  const audioDashboardName = $("audio-dashboard-name") as HTMLDivElement;
  const audioDashboardMeta = $("audio-dashboard-meta") as HTMLDivElement;
  const analyzeBtn = $("analyze-btn") as HTMLButtonElement;
  const playPreviewBtn = $("play-preview-btn") as HTMLButtonElement;
  const cutsSummary = $("cuts-summary") as HTMLSpanElement;
  const cutsSection = $("cuts-section");
  const cutsTrackWrap = $("cuts-track-wrap") as HTMLDivElement;
  const cutsPlayhead = $("cuts-playhead") as HTMLDivElement;
  const cutsHover = $("cuts-hover") as HTMLDivElement;
  const audioLanes = $("audio-lanes") as HTMLDivElement;
  const cutsTimeCur = $("cuts-time-cur") as HTMLSpanElement;
  const cutsTimeEnd = $("cuts-time-end") as HTMLSpanElement;
  const cutsMinimap = $("cuts-minimap") as HTMLDivElement;
  const cutsViewport = $("cuts-viewport") as HTMLDivElement;
  const zoomInfo = $("zoom-info") as HTMLSpanElement;
  const cutsCanvas = $("cuts-wave") as HTMLCanvasElement;
  const cutsMiniCanvas = $("cuts-mini-wave") as HTMLCanvasElement;
  const advancedCb = $("advanced") as HTMLInputElement;
  const simpleBox = $("simple-mode");
  const advancedBox = $("advanced-mode");
  const marginIn = $("margin") as HTMLInputElement;
  const marginErr = $("margin-err");
  const thresholdIn = $("threshold") as HTMLInputElement;
  const thresholdErr = $("threshold-err");
  const exprIn = $("expression") as HTMLTextAreaElement;
  const timelineWrap = $("timeline-wrap");
  const timelineIn = $("timeline") as HTMLInputElement;
  const outputWrap = $("output-wrap");
  const outputIn = $("output") as HTMLInputElement;
  const outputBtn = $("output-btn") as HTMLButtonElement;
  const runBtn = $("run-btn") as HTMLButtonElement;
  const cancelBtn = $("cancel-btn") as HTMLButtonElement;
  const openLogsBtn = $("open-logs-btn") as HTMLButtonElement;
  const logEl = $("log");
  const statusEl = $("status");
  const statusText = $("status-text") as HTMLSpanElement;
  const progressWrap = $("progress-wrap");
  const progressFill = $("progress-fill") as HTMLDivElement;
  const progressLabel = $("progress-label") as HTMLSpanElement;
  const progressPct = $("progress-pct") as HTMLSpanElement;
  const logCard = $("log-card");
  const logToggle = $("log-toggle") as HTMLButtonElement;
  const doneModal = $("done-modal");
  const cutPrimeModal = $("cutprime-modal");
  const doneTitleText = $("done-title-text") as HTMLSpanElement;
  const doneSummary = $("done-summary") as HTMLParagraphElement;
  const doneFiles = $("done-files") as HTMLDivElement;
  const doneMute = $("done-mute") as HTMLInputElement;
  const toolsBtn = $("tools-btn") as HTMLButtonElement;
  const aboutBtn = $("about-btn") as HTMLButtonElement;
  const toolsModal = $("tools-modal");
  const aboutModal = $("about-modal");
  const updateModal = $("update-modal");
  const toolsList = $("tools-list") as HTMLDivElement;
  const toolsMsg = $("tools-msg") as HTMLDivElement;
  const toolsCheckBtn = $("tools-check-btn") as HTMLButtonElement;
  const toolsDirBtn = $("tools-dir-btn") as HTMLButtonElement;
  const aboutAeVersion = $("about-ae-version") as HTMLSpanElement;
  const aboutFfVersion = $("about-ff-version") as HTMLSpanElement;

  // Dropdowns próprios: com ícone e uma linha dizendo o que cada opção faz.
  const modeSelect = createSelect({
    options: (Object.keys(MODES) as ModeKey[]).map((key) => ({
      value: key,
      ...MODES[key],
    })),
    value: state.mode,
    label: "Modo de corte",
    onChange: (value) => onModeChanged(value as ModeKey),
  });
  $("mode-select").appendChild(modeSelect.el);

  const exportSelect = createSelect({
    options: (Object.keys(EXPORTS) as ExportKey[]).map((key) => ({
      value: key,
      ...EXPORTS[key],
    })),
    value: state.exportFormat,
    label: "Formato de exportação",
    onChange: (value) => {
      state.exportFormat = value as ExportKey;
      syncTimelineVisibility();
    },
  });
  $("export-select").appendChild(exportSelect.el);

  marginIn.value = state.margin;
  thresholdIn.value = state.threshold;
  exprIn.value = state.expression;
  timelineIn.value = state.timelineName;
  syncTimelineVisibility();

  function syncTimelineVisibility() {
    timelineWrap.classList.toggle(
      "hidden",
      !NAMED_EXPORTS.has(state.exportFormat),
    );
  }

  function setStatus(s: Status, text: string) {
    statusEl.className = `status-badge ${s}`;
    statusEl.classList.toggle("hidden", s === "idle");
    statusText.textContent = text;
  }

  function setProgressVisible(v: boolean) {
    progressWrap.classList.toggle("hidden", !v);
  }

  function setProgress(pct: number, label: string) {
    progressFill.style.width = `${pct.toFixed(1)}%`;
    progressPct.textContent = `${Math.floor(pct)}%`;
    progressLabel.textContent = label;
  }

  function showBanner(kind: "error" | "warning" | "info", html: string) {
    banner.className = `banner ${kind}`;
    banner.innerHTML = html;
    banner.classList.remove("hidden");
  }

  function hideBanner() {
    banner.classList.add("hidden");
    banner.innerHTML = "";
  }

  function log(text: string, cls: LogClass = "info") {
    const div = document.createElement("div");
    div.className = `log-line ${cls}`;
    div.textContent = text;
    logEl.appendChild(div);
    if (!userScrolled) logEl.scrollTop = logEl.scrollHeight;
  }

  logEl.addEventListener("scroll", () => {
    const atBottom =
      logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 8;
    userScrolled = !atBottom;
  });

  function cleanupTempPath(path: string) {
    if (!path) return;
    void cleanupTempFile(path).catch(() => {});
  }

  /** Solta os WAVs temporários de um item e esquece os picos já extraídos. */
  function discardAudioPreviews(item: QueueItem) {
    const previews = item.audioPreviews;
    item.audioPreviews = null;
    item.audioPreviewsLoading = false;
    item.audioPreviewsFailed = false;
    item.mixedPeaks = null;
    item.mixedPeaksKey = "";
    if (audioLayersPath === item.path) teardownAudioLayers();
    for (const track of previews ?? []) cleanupTempPath(track.proxy_path);
  }

  function discardAllAudioPreviews() {
    for (const item of state.queue) discardAudioPreviews(item);
  }

  function validateMargin(): boolean {
    const v = marginIn.value.trim();
    const ok = v === "" || MARGIN_RE.test(v);
    marginErr.textContent = ok ? "" : "Use 0.2sec, 200ms ou 5%.";
    marginIn.classList.toggle("invalid", !ok);
    return ok;
  }

  function validateThreshold(): boolean {
    const v = thresholdIn.value.trim();
    const ok = v === "" || THRESHOLD_RE.test(v);
    thresholdErr.textContent = ok ? "" : "Use 0.04 ou 4%.";
    thresholdIn.classList.toggle("invalid", !ok);
    return ok;
  }

  type DragKind = "margin" | "threshold";
  type ParsedDragValue = {
    value: number;
    unit: string;
    step: number;
    decimals: number;
  };

  function parseDragValue(raw: string, kind: DragKind): ParsedDragValue | null {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)([a-z%]*)$/i);
    if (!m) return null;

    const value = Number(m[1]);
    if (!isFinite(value)) return null;

    const unit = m[2] ?? "";
    if (kind === "threshold") {
      return unit === "%"
        ? { value, unit, step: 0.1, decimals: 1 }
        : { value, unit, step: 0.001, decimals: 3 };
    }

    if (unit.toLowerCase() === "ms") {
      return { value, unit, step: 10, decimals: 0 };
    }
    if (unit === "%") {
      return { value, unit, step: 0.1, decimals: 1 };
    }
    return { value, unit, step: 0.01, decimals: 2 };
  }

  function formatDragValue(value: number, unit: string, decimals: number): string {
    const fixed = Math.max(0, value).toFixed(decimals);
    const compact = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    return `${compact}${unit}`;
  }

  function installValueDrag(input: HTMLInputElement, kind: DragKind) {
    input.classList.add("drag-value");
    input.title = "Digite ou arraste horizontalmente para ajustar";

    let drag:
      | {
          pointerId: number;
          startX: number;
          parsed: ParsedDragValue;
          didDrag: boolean;
          lastSteps: number;
        }
      | null = null;
    let suppressClick = false;

    input.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const parsed = parseDragValue(input.value, kind);
      if (!parsed) return;
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        parsed,
        didDrag: false,
        lastSteps: 0,
      };
      input.setPointerCapture(e.pointerId);
    });

    input.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (!drag.didDrag && Math.abs(dx) < 4) return;

      e.preventDefault();
      drag.didDrag = true;
      input.readOnly = true;
      input.classList.add("dragging");
      document.body.classList.add("dragging-value");

      const steps = Math.trunc(dx / 8);
      if (steps === drag.lastSteps) return;
      drag.lastSteps = steps;

      input.value = formatDragValue(
        drag.parsed.value + steps * drag.parsed.step,
        drag.parsed.unit,
        drag.parsed.decimals,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const finishDrag = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.didDrag) {
        suppressClick = true;
        e.preventDefault();
      }
      try {
        input.releasePointerCapture(e.pointerId);
      } catch {}
      drag = null;
      input.readOnly = false;
      input.classList.remove("dragging");
      document.body.classList.remove("dragging-value");
    };

    input.addEventListener("pointerup", finishDrag);
    input.addEventListener("pointercancel", finishDrag);
    input.addEventListener(
      "click",
      (e) => {
        if (!suppressClick) return;
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
  }

  installValueDrag(marginIn, "margin");
  installValueDrag(thresholdIn, "threshold");

  // ---- modais ----

  function openModal(el: HTMLElement) {
    el.classList.remove("hidden");
  }

  function closeModal(el: HTMLElement) {
    el.classList.add("hidden");
    // O anúncio espera o aviso de conclusão sair: um modal por vez.
    if (el === doneModal && cutPrimePending) {
      cutPrimePending = false;
      openModal(cutPrimeModal);
    }
  }

  function anyModalOpen(): boolean {
    return (
      !toolsModal.classList.contains("hidden") ||
      !aboutModal.classList.contains("hidden") ||
      !updateModal.classList.contains("hidden") ||
      !doneModal.classList.contains("hidden") ||
      !cutPrimeModal.classList.contains("hidden")
    );
  }

  function closeAllModals() {
    closeModal(toolsModal);
    closeModal(aboutModal);
    if (!appUpdateInstalling) closeModal(updateModal);
    closeModal(doneModal);
    closeModal(cutPrimeModal);
  }

  for (const backdrop of [toolsModal, aboutModal, doneModal, cutPrimeModal, updateModal]) {
    // Clique fora do painel fecha; clique dentro não deve vazar para o fundo.
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && !(backdrop === updateModal && appUpdateInstalling)) {
        closeModal(backdrop);
      }
    });
  }

  // ---- log recolhível ----

  const LOG_COLLAPSED_KEY = "autocut.logCollapsed";

  function setLogCollapsed(collapsed: boolean) {
    logCard.classList.toggle("is-collapsed", collapsed);
    logToggle.setAttribute("aria-expanded", String(!collapsed));
    try {
      localStorage.setItem(LOG_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // modo privado / storage bloqueado: a preferência só não sobrevive
    }
  }

  logToggle.addEventListener("click", () =>
    setLogCollapsed(!logCard.classList.contains("is-collapsed")),
  );

  try {
    setLogCollapsed(localStorage.getItem(LOG_COLLAPSED_KEY) === "1");
  } catch {
    setLogCollapsed(false);
  }

  // ---- aviso de conclusão ----

  const DONE_MUTED_KEY = "autocut.hideDoneDialog";

  let lastOutputs: string[] = [];

  /** Separa pasta de arquivo, aceitando as duas barras. */
  function splitPath(path: string): { name: string; dir: string } {
    const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return cut >= 0
      ? { name: path.slice(cut + 1), dir: path.slice(0, cut) }
      : { name: path, dir: "" };
  }

  function doneMuted(): boolean {
    try {
      return localStorage.getItem(DONE_MUTED_KEY) === "1";
    } catch {
      return false;
    }
  }

  /**
   * Mostra onde os arquivos foram parar.
   *
   * O caminho de saída só aparecia no log, misturado com a saída do
   * auto-editor — e "_ALTERED" ao lado do original é fácil de não achar quando
   * se está processando uma fila inteira.
   */
  function showDoneDialog(outputs: string[], failed: number) {
    lastOutputs = outputs;
    if (outputs.length === 0 || doneMuted()) return;

    doneTitleText.textContent =
      failed > 0 ? "Corte concluído com falhas" : "Corte concluído";
    doneSummary.textContent =
      outputs.length === 1
        ? "1 arquivo pronto."
        : `${outputs.length} arquivos prontos.` +
          (failed > 0 ? ` ${failed} falharam — veja o log.` : "");

    doneFiles.innerHTML = "";
    for (const path of outputs) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "done-file";
      row.title = `Mostrar ${path} na pasta`;

      const name = document.createElement("span");
      name.className = "done-file-name";
      name.textContent = splitPath(path).name;

      const dir = document.createElement("span");
      dir.className = "done-file-dir";
      dir.textContent = splitPath(path).dir;

      row.appendChild(name);
      row.appendChild(dir);
      row.addEventListener("click", () => {
        void openInExplorer(path).catch((e) => log(`${e}`, "error"));
      });
      doneFiles.appendChild(row);
    }

    doneMute.checked = false;
    openModal(doneModal);
  }

  doneMute.addEventListener("change", () => {
    try {
      localStorage.setItem(DONE_MUTED_KEY, doneMute.checked ? "1" : "0");
    } catch {
      // sem storage a caixinha vale só para esta sessão
    }
  });

  ($("done-close") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(doneModal),
  );
  ($("done-dismiss") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(doneModal),
  );
  ($("done-open") as HTMLButtonElement).addEventListener("click", () => {
    const target = lastOutputs[0];
    if (target) void openInExplorer(target).catch((e) => log(`${e}`, "error"));
  });

  // ---- atualização do app ----

  const updateVersions = $("update-versions");
  const updateNotes = $("update-notes");
  const updateProgress = $("update-progress");
  const updateProgressFill = $("update-progress-fill");
  const updateProgressLabel = $("update-progress-label");
  const updateError = $("update-error");
  const updateBusyNote = $("update-busy-note");
  const updateInstallBtn = $("update-install") as HTMLButtonElement;
  const updateLaterBtn = $("update-later") as HTMLButtonElement;
  const appUpdateStatus = $("app-update-status");
  const appUpdateCheckBtn = $("app-update-check") as HTMLButtonElement;

  let pendingAppUpdate: Update | null = null;
  let appUpdateInstalling = false;

  function formatMB(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function showAppUpdate(update: Update) {
    pendingAppUpdate = update;
    updateVersions.innerHTML = `Versão <strong>${update.version}</strong> disponível — você tem a ${update.currentVersion}.`;
    // Notas vêm do corpo da release no GitHub: texto, nunca HTML.
    updateNotes.textContent = update.body?.trim() || "Sem notas para esta versão.";
    updateError.classList.add("hidden");
    updateProgress.classList.add("hidden");
    syncAppUpdateButtons();
    openModal(updateModal);
  }

  /** Instalar fecha o app: não pode acontecer com um corte rodando. */
  function syncAppUpdateButtons() {
    updateInstallBtn.disabled = appUpdateInstalling || state.processing;
    updateLaterBtn.disabled = appUpdateInstalling;
    updateBusyNote.classList.toggle("hidden", !state.processing || appUpdateInstalling);
  }

  async function checkAppUpdate(silent: boolean) {
    appUpdateCheckBtn.disabled = true;
    appUpdateStatus.textContent = "Procurando…";
    try {
      const update = await findAppUpdate();
      if (update) {
        appUpdateStatus.textContent = `Versão ${update.version} disponível.`;
        log(`Nova versão do PrimeTrim: ${update.version}`, "info");
        if (silent && anyModalOpen()) return; // não empilha em cima de outro modal
        if (!silent) closeModal(aboutModal);
        showAppUpdate(update);
      } else {
        appUpdateStatus.textContent = "Você está na versão mais recente.";
      }
    } catch (e) {
      // Sem rede, ou release sem latest.json: na checagem do início isso só
      // vai para o log — o app funciona igual sem atualizar.
      appUpdateStatus.textContent = "Não foi possível verificar agora.";
      log(`Verificação de atualização do app falhou: ${e}`, silent ? "warning" : "error");
    } finally {
      appUpdateCheckBtn.disabled = false;
    }
  }

  updateInstallBtn.addEventListener("click", async () => {
    if (!pendingAppUpdate || state.processing) return;
    appUpdateInstalling = true;
    syncAppUpdateButtons();
    updateError.classList.add("hidden");
    updateProgress.classList.remove("hidden");
    updateProgressFill.style.width = "0%";
    updateProgressLabel.textContent = "Baixando…";
    try {
      await installAppUpdate(pendingAppUpdate, ({ downloaded, total }) => {
        if (total) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          updateProgressFill.style.width = `${pct}%`;
          updateProgressLabel.textContent =
            pct >= 100
              ? "Instalando — o app vai reiniciar…"
              : `Baixando… ${formatMB(downloaded)} de ${formatMB(total)}`;
        } else {
          updateProgressLabel.textContent = `Baixando… ${formatMB(downloaded)}`;
        }
      });
    } catch (e) {
      appUpdateInstalling = false;
      updateProgress.classList.add("hidden");
      updateError.textContent = `Não deu para atualizar: ${e}`;
      updateError.classList.remove("hidden");
      log(`Atualização do app falhou: ${e}`, "error");
      syncAppUpdateButtons();
    }
  });

  updateLaterBtn.addEventListener("click", () => closeModal(updateModal));
  ($("update-close") as HTMLButtonElement).addEventListener("click", () => {
    if (!appUpdateInstalling) closeModal(updateModal);
  });
  appUpdateCheckBtn.addEventListener("click", () => void checkAppUpdate(false));

  // ---- anúncio do Cut Prime ----

  // De vez em quando, não sempre: a cada CUT_PRIME_EVERY cortes concluídos.
  // A conta fica no localStorage para não recomeçar toda vez que o app abre.
  const CUT_PRIME_RUNS_KEY = "primetrim.runsSinceCutPrime";
  const CUT_PRIME_EVERY = 3;
  let cutPrimePending = false;

  function maybeShowCutPrime() {
    let runs = 0;
    try {
      runs = Number(localStorage.getItem(CUT_PRIME_RUNS_KEY) ?? "0") || 0;
    } catch {
      // sem storage conta só nesta sessão — e aí quase nunca aparece, o que é ok
    }
    runs += 1;
    const due = runs >= CUT_PRIME_EVERY;
    try {
      localStorage.setItem(CUT_PRIME_RUNS_KEY, due ? "0" : String(runs));
    } catch {
      // idem
    }
    if (!due) return;
    if (!doneModal.classList.contains("hidden")) cutPrimePending = true;
    else openModal(cutPrimeModal);
  }

  ($("cutprime-close") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(cutPrimeModal),
  );
  ($("cutprime-later") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(cutPrimeModal),
  );
  // O botão "Conhecer" abre o site pelo handler genérico de [data-url]; aqui
  // só fecha o popup junto.
  ($("cutprime-open") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(cutPrimeModal),
  );

  ($("tools-close") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(toolsModal),
  );
  ($("about-close") as HTMLButtonElement).addEventListener("click", () =>
    closeModal(aboutModal),
  );

  toolsBtn.addEventListener("click", () => {
    openModal(toolsModal);
    void refreshToolStatuses();
  });

  aboutBtn.addEventListener("click", () => openModal(aboutModal));

  // Links de crédito e do Cut Prime: o Rust só abre https de uma lista fechada de hosts.
  root.querySelectorAll<HTMLButtonElement>("[data-url]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url ?? "";
      if (url) void openExternal(url).catch((e) => log(`${e}`, "error"));
    });
  });

  // ---- dependências (auto-editor / FFmpeg) ----

  let toolStatusList: ToolStatus[] = [];
  const toolUpdateMap = new Map<ToolId, ToolUpdate>();
  let toolBusy: ToolId | null = null;
  let toolPhase: ToolProgress | null = null;
  let checkingUpdates = false;

  const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  };

  function esc(text: string): string {
    return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
  }

  function setToolsMsg(kind: "info" | "warning" | "error" | null, text = "") {
    if (!kind) {
      toolsMsg.classList.add("hidden");
      toolsMsg.textContent = "";
      return;
    }
    toolsMsg.className = `banner ${kind}`;
    toolsMsg.textContent = text;
  }

  function toolRowHtml(status: ToolStatus): string {
    const update = toolUpdateMap.get(status.id);
    const busy = toolBusy === status.id;
    const hasUpdate = !!update?.update_available;
    const managed = status.source === "managed";

    const versionBits = [`instalado <strong>${esc(displayVersion(status))}</strong>`];
    if (update) {
      versionBits.push(
        hasUpdate
          ? `disponível <span class="to">${esc(update.latest)}</span>`
          : `disponível ${esc(update.latest)}`,
      );
    }

    const notComparable = update && !update.comparable;
    const progressBlock = busy
      ? `<div class="tool-progress">
           <div class="progress-bar">
             <div class="progress-fill" id="tool-fill-${status.id}" style="width:${(
               toolPhase?.percent ?? 0
             ).toFixed(1)}%"></div>
           </div>
           <div class="progress-meta">
             <span id="tool-phase-${status.id}">${esc(
               toolPhase ? phaseLabel(toolPhase.phase) : "Preparando",
             )}</span>
             <span id="tool-detail-${status.id}">${esc(toolPhase?.detail ?? "")}</span>
           </div>
         </div>`
      : "";

    const actions: string[] = [];
    if (managed && !busy) {
      actions.push(
        `<button class="ghost" data-restore="${status.id}" type="button" title="Voltar para a versão que veio no instalador">${getIcon(
          "undo",
          12,
        )} Restaurar</button>`,
      );
    }
    if (update) {
      const label = busy
        ? "Baixando…"
        : hasUpdate
          ? `Atualizar para ${esc(update.latest)}`
          : "Reinstalar";
      actions.push(
        `<button class="${hasUpdate ? "primary" : "ghost"}" data-install="${
          status.id
        }" type="button" ${busy || toolBusy ? "disabled" : ""}>${getIcon(
          "download",
          13,
        )} ${label}</button>`,
      );
    }

    return `
      <div class="tool-row ${hasUpdate ? "has-update" : ""}">
        <div class="tool-info">
          <div class="tool-name">
            ${esc(status.label)}
            <span class="tool-tag ${managed ? "managed" : ""}">${
              managed ? "atualizado" : "embarcado"
            }</span>
          </div>
          <div class="tool-version">${versionBits.join(" · ")}</div>
          ${
            status.error
              ? `<div class="tool-error">${esc(status.error)}</div>`
              : ""
          }
          ${
            notComparable
              ? `<div class="tool-version" style="color: var(--text-faint)">A versão embarcada é um build de desenvolvimento, então não dá para compará-la com o número de release.</div>`
              : ""
          }
          ${progressBlock}
        </div>
        <div class="tool-actions">${actions.join("")}</div>
      </div>`;
  }

  function renderTools() {
    if (toolStatusList.length === 0) {
      toolsList.innerHTML = `<div class="tool-row"><div class="tool-info"><div class="tool-version">Lendo versões…</div></div></div>`;
      return;
    }

    toolsList.innerHTML = toolStatusList.map(toolRowHtml).join("");

    toolsList
      .querySelectorAll<HTMLButtonElement>("[data-install]")
      .forEach((btn) =>
        btn.addEventListener("click", () =>
          doInstallTool(btn.dataset.install as ToolId),
        ),
      );
    toolsList
      .querySelectorAll<HTMLButtonElement>("[data-restore]")
      .forEach((btn) =>
        btn.addEventListener("click", () =>
          doRestoreTool(btn.dataset.restore as ToolId),
        ),
      );

    const pending = [...toolUpdateMap.values()].some((u) => u.update_available);
    toolsBtn.classList.toggle("has-update", pending);
    toolsBtn.title = pending
      ? "Atualizações disponíveis"
      : "Dependências e atualizações";

    for (const status of toolStatusList) {
      const target =
        status.id === "auto_editor" ? aboutAeVersion : aboutFfVersion;
      target.textContent = displayVersion(status);
    }
  }

  /** Atualiza só os números da barra, sem redesenhar a lista a cada chunk. */
  function paintToolProgress(p: ToolProgress) {
    const fill = root.querySelector<HTMLDivElement>(`#tool-fill-${p.id}`);
    if (!fill) {
      renderTools();
      return;
    }
    fill.style.width = `${p.percent.toFixed(1)}%`;
    const phase = root.querySelector<HTMLSpanElement>(`#tool-phase-${p.id}`);
    const detail = root.querySelector<HTMLSpanElement>(`#tool-detail-${p.id}`);
    if (phase) phase.textContent = phaseLabel(p.phase);
    if (detail) detail.textContent = p.detail;
  }

  async function refreshToolStatuses() {
    try {
      toolStatusList = await toolsStatus();
    } catch (e) {
      setToolsMsg("error", `Não consegui ler as versões instaladas: ${e}`);
    }
    renderTools();
  }

  async function doCheckUpdates(silent = false) {
    if (checkingUpdates) return;
    checkingUpdates = true;
    toolsCheckBtn.disabled = true;
    if (!silent) {
      toolsCheckBtn.innerHTML = `${getIcon("refresh", 14, "animate-spin")} Verificando…`;
      setToolsMsg(null);
    }

    try {
      const updates = await checkToolUpdates();
      toolUpdateMap.clear();
      for (const u of updates) toolUpdateMap.set(u.id, u);

      const pending = updates.filter((u) => u.update_available);
      if (!silent) {
        setToolsMsg(
          "info",
          pending.length === 0
            ? "Tudo em dia — nenhuma atualização disponível."
            : `${pending.length} atualização(ões): ${pending
                .map((u) => `${u.label} ${u.latest}`)
                .join(", ")}.`,
        );
      }
      for (const u of pending) {
        log(`Atualização disponível: ${u.label} ${u.latest}`, "warning");
      }
    } catch (e) {
      // Falha de rede na checagem silenciosa não vira erro na cara do usuário:
      // o app funciona igual sem atualizar nada.
      if (!silent) setToolsMsg("error", `Falha ao verificar atualizações: ${e}`);
    } finally {
      checkingUpdates = false;
      toolsCheckBtn.disabled = false;
      toolsCheckBtn.innerHTML = `${getIcon("refresh", 14)} Verificar atualizações`;
      renderTools();
    }
  }

  async function doInstallTool(id: ToolId) {
    if (toolBusy) return;
    if (state.processing) {
      setToolsMsg(
        "warning",
        "Termine ou cancele a edição em andamento antes de atualizar.",
      );
      return;
    }

    const update = toolUpdateMap.get(id);
    toolBusy = id;
    toolPhase = null;
    setToolsMsg(null);
    renderTools();
    log(`Baixando ${update?.label ?? id} ${update?.latest ?? ""}...`, "info");

    try {
      toolStatusList = await installToolUpdate(id);
      // Mantém a entrada como "em dia" em vez de apagá-la: a linha continua
      // mostrando a versão publicada e oferecendo reinstalar, sem obrigar a
      // verificar de novo só para ver que já está atualizado.
      if (update) {
        toolUpdateMap.set(id, {
          ...update,
          current: update.latest,
          comparable: true,
          update_available: false,
        });
      }
      const installed = toolStatusList.find((s) => s.id === id);
      const version = installed ? displayVersion(installed) : (update?.latest ?? "");
      setToolsMsg("info", `${update?.label ?? id} ${version} instalado.`);
      log(`${update?.label ?? id} atualizado para ${version}`, "success");
      if (id === "auto_editor") await revalidateAutoEditor();
    } catch (e) {
      setToolsMsg("error", `Falha ao atualizar: ${e}`);
      log(`Falha ao atualizar ${id}: ${e}`, "error");
    } finally {
      toolBusy = null;
      toolPhase = null;
      renderTools();
    }
  }

  async function doRestoreTool(id: ToolId) {
    if (toolBusy || state.processing) return;
    try {
      toolStatusList = await restoreBundledTool(id);
      toolUpdateMap.delete(id);
      setToolsMsg("info", "Versão embarcada restaurada.");
      log(`${id}: versão embarcada restaurada`, "warning");
      if (id === "auto_editor") await revalidateAutoEditor();
    } catch (e) {
      setToolsMsg("error", `Falha ao restaurar: ${e}`);
    } finally {
      renderTools();
    }
  }

  toolsCheckBtn.addEventListener("click", () => void doCheckUpdates());
  toolsDirBtn.addEventListener("click", async () => {
    try {
      await openInExplorer(await managedToolsDir());
    } catch (e) {
      setToolsMsg("error", `${e}`);
    }
  });

  // A barra de progresso do download é um extra: se o listener falhar, o resto
  // da tela não pode ficar sem montar por causa dela.
  try {
    unlistenTools = await onToolProgress((p) => {
      if (toolBusy !== p.id) return;
      toolPhase = p;
      paintToolProgress(p);
    });
  } catch {
    unlistenTools = null;
  }

  // ---- queue ----

  function statusBadge(s: QueueStatus): string {
    switch (s) {
      case "running":
        return `<span class="qs running"></span>`;
      case "done":
        return `<span class="qs done">${getIcon("check", 8, "badge-icon")}</span>`;
      case "error":
        return `<span class="qs err">${getIcon("alert", 8, "badge-icon")}</span>`;
      default:
        return "";
    }
  }

  function renderQueue() {
    const n = state.queue.length;
    const hasFiles = n > 0;

    dropzone.classList.toggle("compact", hasFiles);
    fileList.classList.toggle("hidden", !hasFiles);
    fileToolbar.classList.toggle("hidden", !hasFiles);

    // Resumo agregado: numa fila de vinte arquivos, o total é o que responde
    // "isso vai demorar?" — contar linha por linha, não.
    if (hasFiles) {
      const bytes = state.queue.reduce((sum, it) => sum + it.sizeBytes, 0);
      const secs = state.queue.reduce(
        (sum, it) => sum + (it.probe?.duration_secs ?? 0),
        0,
      );
      const parts = [`${n} ${n === 1 ? "arquivo" : "arquivos"}`, formatSize(bytes)];
      if (secs > 0) parts.push(formatDuration(secs));
      queueSummary.textContent = parts.join(" · ");
    } else {
      queueSummary.textContent = "";
    }

    fileList.classList.toggle("is-long", n > 5);
    fileList.innerHTML = "";
    state.queue.forEach((item, idx) => {
      const selected = idx === state.selectedIndex;
      const li = document.createElement("li");
      li.className = `file-row${selected ? " selected" : ""} status-${item.status}`;
      const dur = item.probe ? formatDuration(item.probe.duration_secs) : "";
      const res =
        item.probe?.width && item.probe?.height
          ? ` · ${item.probe.width}×${item.probe.height}`
          : "";
      li.innerHTML = `
        ${statusBadge(item.status)}
        <span class="f-icon">${fileIcon(item.ext)}</span>
        <div class="f-info">
          <div class="f-name"></div>
          <div class="f-meta"></div>
        </div>
        ${selected ? `<span class="f-tag">${getIcon("play", 9)} preview</span>` : ""}
        <button class="f-remove" data-idx="${idx}" title="Remover da fila">${getIcon("x", 12)}</button>
      `;
      // textContent: nome de arquivo é texto de fora, não markup.
      const nameEl = li.querySelector(".f-name") as HTMLDivElement;
      nameEl.textContent = item.name;
      nameEl.title = item.path;
      (li.querySelector(".f-meta") as HTMLDivElement).textContent =
        `${formatSize(item.sizeBytes)}${dur ? " · " + dur : ""}${res}`;

      li.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".f-remove")) return;
        state.selectedIndex = idx;
        renderQueue();
        updatePreview();
      });
      fileList.appendChild(li);
    });

    fileList
      .querySelectorAll<HTMLButtonElement>(".f-remove")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const i = parseInt(btn.dataset.idx ?? "-1", 10);
          if (i >= 0) removeAt(i);
        });
      });

    syncOutputVisibility();
  }

  function syncOutputVisibility() {
    // Output customizado só faz sentido para 1 arquivo
    outputWrap.classList.toggle("hidden", state.queue.length !== 1);
  }

  function updatePreview() {
    const item =
      state.selectedIndex >= 0 ? state.queue[state.selectedIndex] : null;

    // sai do modo "prévia do corte" ao trocar de arquivo
    if (playPreviewMode) setPlayPreviewMode(false);

    const playable =
      !!item &&
      (item.probe?.has_video ||
        item.probe?.has_audio ||
        SUPPORTED_EXTS.includes(item.ext));
    if (item && playable) {
      // Só áudio: o elemento de vídeo continua sendo o relógio e a fonte, só
      // não tem o que mostrar. Antes um segundo elemento assumia a reprodução
      // nesse caso, e cada seek precisava reconciliar dois relógios.
      const audioOnly = !item.probe?.has_video;
      preview.classList.toggle("audio-only", audioOnly);
      previewStage.classList.toggle("audio-only", audioOnly);

      if (audioOnly) {
        previewAudioDashboard.classList.remove("hidden");
        audioDashboardName.textContent = item.name;
        const sizeStr = formatSize(item.sizeBytes);
        const durStr = item.probe ? formatDuration(item.probe.duration_secs) : "";
        audioDashboardMeta.textContent = `${sizeStr}${durStr ? " · " + durStr : ""}`;
      } else {
        previewAudioDashboard.classList.add("hidden");
      }

      if (lastPreviewPath !== item.path) {
        videoMetadataLoading = true;
        teardownAudioLayers();
        syncPreviewLoading();
        preview.src = convertFileSrc(item.path);
        lastPreviewPath = item.path;
      }
      ensureAudioPreviews(item);
        previewWrap.classList.remove("hidden");
    } else {
      if (lastPreviewPath !== "") {
        preview.removeAttribute("src");
        preview.load();
        lastPreviewPath = "";
      }
      previewAudioDashboard.classList.add("hidden");
      previewStage.classList.remove("audio-only");
      teardownAudioLayers();
      preview.muted = false;
      videoMetadataLoading = false;
      syncPreviewLoading();
        previewWrap.classList.add("hidden");
    }

    syncCustomPreviewControls();
    syncPreviewControls();
    scheduleAutoPreview();
  }

  function extensionOf(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  }

  async function addFiles(paths: string[]) {
    const existing = new Set(state.queue.map((q) => q.path));

    // Diz o que ficou de fora e por quê. Arrastar uma pasta de gravação inteira
    // costuma trazer .txt de anotação e o clipe que já estava na fila; sumir com
    // eles em silêncio faz a pessoa contar arquivo na mão para achar o que faltou.
    const duplicates = paths.filter((p) => existing.has(p));
    const unsupported = paths.filter(
      (p) => !existing.has(p) && !SUPPORTED_EXTS.includes(extensionOf(p)),
    );
    const toAdd = paths.filter(
      (p) => !existing.has(p) && SUPPORTED_EXTS.includes(extensionOf(p)),
    );

    if (duplicates.length > 0) {
      log(
        `${duplicates.length} ${duplicates.length === 1 ? "arquivo já estava" : "arquivos já estavam"} na fila`,
        "warning",
      );
    }
    if (unsupported.length > 0) {
      log(
        `${unsupported.length} ignorado(s) por formato não suportado: ${unsupported
          .map((p) => extensionOf(p) || "sem extensão")
          .filter((ext, i, all) => all.indexOf(ext) === i)
          .join(", ")}`,
        "warning",
      );
    }
    if (toAdd.length === 0) return;

    for (const p of toAdd) {
      try {
        const info = await fetchFileInfo(p);
        const item: QueueItem = {
          path: p,
          name: info.name,
          sizeBytes: info.size_bytes,
          ext: info.ext,
          probe: null,
          status: "pending",
          outputPath: "",
          preview: null,
          previewKey: "",
          audioPreviews: null,
          audioPreviewsLoading: false,
          audioPreviewsFailed: false,
          mixedPeaks: null,
          mixedPeaksKey: "",
          previewAudioStreams: null,
        };
        state.queue.push(item);
      } catch (e) {
        log(`Falha ao adicionar: ${p} (${e})`, "error");
      }
    }

    if (state.selectedIndex < 0 && state.queue.length > 0) {
      state.selectedIndex = 0;
    }
    renderQueue();
    updatePreview();

    // probe em background, atualiza UI conforme chega
    for (const item of state.queue) {
      if (item.probe !== null) continue;
      probeFile(item.path)
        .then((p) => {
          item.probe = p;
          setDefaultPreviewAudioStreams(item);
          renderQueue();
          if (
            state.selectedIndex >= 0 &&
            state.queue[state.selectedIndex] === item
          ) {
            updatePreview();
          }
        })
        .catch(() => {
          /* ignora — alguns formatos podem não ser sondáveis */
        });
    }
  }

  function removeAt(i: number) {
    const [removed] = state.queue.splice(i, 1);
    if (removed) discardAudioPreviews(removed);
    if (state.selectedIndex >= state.queue.length) {
      state.selectedIndex = state.queue.length - 1;
    }
    renderQueue();
    updatePreview();
  }

  function clearQueue() {
    discardAllAudioPreviews();
    state.queue = [];
    state.selectedIndex = -1;
    renderQueue();
    updatePreview();
  }

  async function pickFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [
        { name: "Mídia suportada", extensions: SUPPORTED_EXTS },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    });
    if (Array.isArray(selected)) await addFiles(selected);
    else if (typeof selected === "string") await addFiles([selected]);
  }

  /**
   * Troca cada pasta solta na janela pelas mídias que ela contém.
   *
   * Substitui o botão "Pasta" que existia aqui: arrastar a pasta da gravação já
   * era o gesto natural, e um botão a mais na barra não ensinava nada que o
   * arrastar não ensine sozinho.
   */
  async function expandDroppedPaths(paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      if (SUPPORTED_EXTS.includes(extensionOf(path))) {
        out.push(path);
        continue;
      }
      try {
        const found = await listMediaFiles(path, SUPPORTED_EXTS);
        if (found.length > 0) {
          log(`${found.length} arquivo(s) encontrados na pasta solta.`, "info");
          out.push(...found);
        } else {
          log("Nenhuma mídia suportada nessa pasta.", "warning");
        }
      } catch {
        // Não era pasta: deixa passar para o addFiles reclamar do formato.
        out.push(path);
      }
    }
    return out;
  }

  async function pickOutput() {
    if (state.queue.length !== 1) return;
    const item = state.queue[0];
    const dot = item.name.lastIndexOf(".");
    const ext = dot >= 0 ? item.name.slice(dot + 1) : "mp4";
    const base = dot >= 0 ? item.name.slice(0, dot) : item.name;
    const selected = await save({
      defaultPath: `${base}_ALTERED.${ext}`,
      filters: [{ name: "Saída", extensions: [ext] }],
    });
    if (typeof selected === "string") {
      state.outputFile = selected;
      outputIn.value = selected;
    }
  }

  // ---- listeners de UI ----
  dropzone.addEventListener("click", pickFiles);
  clearBtn.addEventListener("click", clearQueue);
  outputBtn.addEventListener("click", pickOutput);
  outputIn.addEventListener("input", () => (state.outputFile = outputIn.value));

  // Isolado do resto: se a ponte da janela falhar, o app perde o arrastar —
  // mas não pode perder junto o Esc, o espaço e as setas, que são registrados
  // logo abaixo e ficariam para trás numa exceção aqui.
  // Sem a moldura do Windows: os três botões do canto são da interface.
  try {
    const win = getCurrentWebviewWindow();
    document.getElementById("win-min")?.addEventListener("click", () => void win.minimize());
    document.getElementById("win-max")?.addEventListener("click", () => void win.toggleMaximize());
    document.getElementById("win-close")?.addEventListener("click", () => void win.close());
  } catch {
    // Fora do Tauri (vite puro no navegador) não há janela para controlar.
  }

  try {
    const win = getCurrentWebviewWindow();
    win.onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      dropzone.classList.add("dragover");
    } else if (event.payload.type === "leave") {
      dropzone.classList.remove("dragover");
    } else if (event.payload.type === "drop") {
      dropzone.classList.remove("dragover");
      const paths = event.payload.paths ?? [];
      if (paths.length > 0) {
        void expandDroppedPaths(paths).then((expanded) => addFiles(expanded));
      }
      }
    });
  } catch (e) {
    log(`Arrastar arquivos indisponível: ${e}`, "warning");
  }

  advancedCb.addEventListener("change", () => {
    state.advanced = advancedCb.checked;
    simpleBox.classList.toggle("hidden", state.advanced);
    advancedBox.classList.toggle("hidden", !state.advanced);
    onCutParamsChanged();
  });

  function onModeChanged(mode: ModeKey) {
    state.mode = mode;
    if (mode === "audio") {
      state.threshold = "0.04";
      thresholdIn.value = "0.04";
    } else if (mode === "motion") {
      state.threshold = "0.02";
      thresholdIn.value = "0.02";
    }
    validateThreshold();
    onCutParamsChanged();
  }

  marginIn.addEventListener("input", () => {
    state.margin = marginIn.value;
    validateMargin();
    onCutParamsChanged();
  });
  thresholdIn.addEventListener("input", () => {
    state.threshold = thresholdIn.value;
    validateThreshold();
    onCutParamsChanged();
  });
  exprIn.addEventListener("input", () => {
    state.expression = exprIn.value;
    onCutParamsChanged();
  });
  timelineIn.addEventListener(
    "input",
    () => (state.timelineName = timelineIn.value),
  );

  runBtn.addEventListener("click", () => doRun());
  cancelBtn.addEventListener("click", () => doCancel());
  openLogsBtn.addEventListener("click", async () => {
    try {
      const dir = await logDir();
      await openInExplorer(dir);
    } catch (e) {
      log(`${e}`, "error");
    }
  });

  window.addEventListener("keydown", (e) => {
    // Esc fecha o painel aberto antes de qualquer outra coisa: quem apertou
    // Esc com um modal na frente quer fechá-lo, não cancelar a renderização.
    if (e.key === "Escape" && anyModalOpen()) {
      e.preventDefault();
      closeAllModals();
      return;
    }
    if (anyModalOpen() && e.key === " ") return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void pickFiles();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void doRun();
    } else if (e.key === "Escape" && state.processing) {
      e.preventDefault();
      void doCancel();
    } else if (
      lastPreviewPath !== "" &&
      (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight")
    ) {
      const activeEl = document.activeElement;
      const isInput = activeEl && (
        activeEl.tagName === "INPUT" ||
        activeEl.tagName === "TEXTAREA" ||
        activeEl.tagName === "SELECT"
      );
      if (isInput) return;
      e.preventDefault();

      if (e.key === " ") {
        if (preview.paused || preview.ended) {
          void playPreviewMedia();
        } else {
          pausePreviewMedia();
        }
        return;
      }

      // Setas para varrer o material: 5s de passo, 1s com Shift para quando
      // se está caçando o começo exato de uma fala.
      const step = (e.shiftKey ? 1 : 5) * (e.key === "ArrowLeft" ? -1 : 1);
      const duration = Number.isFinite(preview.duration) ? preview.duration : 0;
      const target = Math.max(
        0,
        Math.min(duration > 0 ? duration : Infinity, preview.currentTime + step),
      );
      setPreviewTime(target);
      updatePlayhead();
      syncCustomPreviewControls();
    }
  });

  window.addEventListener("beforeunload", discardAllAudioPreviews);

  // ---- preview de cortes ----

  let analyzing = false;
  let previewAutoTimer: number | null = null;
  let previewAutoQueued = false;
  let playPreviewMode = false;
  let rafHandle = 0;
  let lastPreviewPath = "";
  let videoMetadataLoading = false;
  let scrubbingPreview = false;
  let renderedPreview: CutsTimeline | null = null;
  let preserveNextPreviewView = false;

  // zoom/pan da timeline (em segundos)
  let viewStart = 0;
  let viewEnd = 0;
  type Seg = { start: number; end: number; kept: boolean };
  let mergedSegs: Seg[] = [];
  const MIN_VIEW_RANGE = 0.2; // 200ms mínimo de zoom

  function viewRange() {
    return Math.max(MIN_VIEW_RANGE, viewEnd - viewStart);
  }
  function clampView(start: number, range: number, total: number) {
    const r = Math.max(MIN_VIEW_RANGE, Math.min(range, total));
    let s = Math.max(0, Math.min(start, total - r));
    if (!isFinite(s)) s = 0;
    return { start: s, end: s + r };
  }

  function selectedItem(): QueueItem | null {
    return state.selectedIndex >= 0 ? state.queue[state.selectedIndex] : null;
  }

  function allAudioStreams(item: QueueItem): number[] {
    const count = item.probe?.audio_streams ?? 0;
    return Array.from({ length: count }, (_, i) => i);
  }

  function forceAllPreviewAudioStreams(item: QueueItem) {
    const all = allAudioStreams(item);
    if (all.length === 0) return;
    item.previewAudioStreams = all;
  }

  /**
   * Começa com todas as faixas ligadas e respeita a escolha depois disso.
   *
   * Arquivos só de áudio eram exceção aqui — voltavam para "todas" a cada
   * chamada, porque o preview antigo tocava o arquivo inteiro e não sabia
   * isolar faixa. Com uma camada por faixa isso deixou de ser verdade.
   */
  function setDefaultPreviewAudioStreams(item: QueueItem) {
    if (item.previewAudioStreams !== null) return;
    forceAllPreviewAudioStreams(item);
  }

  function activeAudioStreams(item: QueueItem): number[] {
    const all = allAudioStreams(item);
    if (item.previewAudioStreams === null) return all;
    const allowed = new Set(all);
    return item.previewAudioStreams.filter((stream) => allowed.has(stream));
  }

  function editAudioStreamsForItem(item: QueueItem): number[] | null {
    if (state.advanced || state.mode !== "audio") return null;
    const all = allAudioStreams(item);
    if (all.length <= 1) return null;
    const active = activeAudioStreams(item);
    if (active.length === all.length) return null;
    return active;
  }

  function previewWaveformKey(item: QueueItem): string {
    const active = activeAudioStreams(item);
    return active.length > 0 ? active.join(",") : "muted";
  }

  function waveformBucketCount(item: QueueItem): number {
    const duration = item.probe?.duration_secs ?? item.preview?.duration ?? 0;
    if (!duration || !isFinite(duration)) return WAVEFORM_BUCKETS;
    return Math.max(
      WAVEFORM_BUCKETS,
      Math.min(WAVEFORM_BUCKETS_MAX, Math.ceil(duration * WAVEFORM_BUCKETS_PER_SEC)),
    );
  }

  // ---- camadas de áudio ----
  //
  // Um `<audio>` por faixa, todas tocando junto com o vídeo, que é o relógio.
  // Ligar e desligar faixa vira mudar `muted` — instantâneo. A versão anterior
  // remixava o arquivo inteiro no ffmpeg a cada clique numa caixinha.

  const audioLayers = new Map<number, HTMLAudioElement>();
  let audioLayersPath = "";

  function teardownAudioLayers() {
    for (const el of audioLayers.values()) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
    audioLayers.clear();
    audioLayersPath = "";
  }

  function buildAudioLayers(item: QueueItem) {
    const previews = item.audioPreviews ?? [];
    const playable = previews.filter((p) => p.proxy_path !== "");
    if (audioLayersPath === item.path && audioLayers.size === playable.length) {
      applyAudioLayerMutes(item);
      return;
    }

    teardownAudioLayers();
    if (playable.length === 0) {
      // Uma faixa só (ou nenhuma): o próprio elemento de vídeo toca o áudio.
      preview.muted = activeAudioStreams(item).length === 0;
      return;
    }

    for (const track of playable) {
      const el = document.createElement("audio");
      el.preload = "auto";
      el.src = convertFileSrc(track.proxy_path);
      el.dataset.stream = String(track.stream);
      audioLayerHost.appendChild(el);
      audioLayers.set(track.stream, el);
    }
    audioLayersPath = item.path;
    preview.muted = true;

    applyAudioLayerMutes(item);
    syncAudioLayers(true);
    if (!preview.paused && !preview.ended) void playAudioLayers();
  }

  function applyAudioLayerMutes(item: QueueItem) {
    const active = new Set(activeAudioStreams(item));
    for (const [stream, el] of audioLayers) {
      el.muted = !active.has(stream);
      el.volume = preview.volume;
    }
    // Sem camadas, mutar o vídeo é a única forma de silenciar tudo.
    if (audioLayers.size === 0) {
      preview.muted = active.size === 0;
    }
  }

  /** Dentro disto o áudio é considerado alinhado e volta à velocidade normal. */
  const SYNC_TOLERANCE = 0.02;
  /** Acima disto não dá para corrigir andando: só um seek resolve. */
  const SYNC_HARD_LIMIT = 0.25;

  /**
   * Mantém as camadas coladas no relógio do vídeo.
   *
   * As camadas não derivam entre si — elas apenas largam alguns dezenas de
   * milissegundos depois do vídeo. Corrigir isso com seek abriria um buraco
   * audível a cada ajuste, então desvios pequenos são fechados acelerando ou
   * segurando a faixa em 2%: com `preservesPitch` ligado (padrão), isso é
   * inaudível. O seek fica para quando a diferença é grande demais para andar.
   */
  function syncAudioLayers(force = false) {
    if (audioLayers.size === 0) return;
    const t = preview.currentTime;
    if (!isFinite(t)) return;

    const rate = preview.playbackRate;
    const playing = !preview.paused && !preview.ended;

    for (const el of audioLayers.values()) {
      const drift = el.currentTime - t;
      const distance = Math.abs(drift);

      if (force || distance > SYNC_HARD_LIMIT || !playing) {
        if (force || distance > SYNC_HARD_LIMIT) {
          try {
            el.currentTime = t;
          } catch {
            // fora do buffer durante o carregamento: a próxima passada corrige
          }
        }
        el.playbackRate = rate;
        continue;
      }

      el.playbackRate =
        distance <= SYNC_TOLERANCE ? rate : rate * (drift > 0 ? 0.98 : 1.02);
    }
  }

  /** Dispara todas as camadas juntas: em série, a última entraria atrasada. */
  async function playAudioLayers() {
    await Promise.all(
      [...audioLayers.values()].map((el) => {
        el.playbackRate = preview.playbackRate;
        return el.play().catch(() => {});
      }),
    );
  }

  function pauseAudioLayers() {
    for (const el of audioLayers.values()) el.pause();
  }

  function setAudioLayersTime(time: number) {
    for (const el of audioLayers.values()) {
      try {
        el.currentTime = time;
      } catch {}
    }
  }

  /** Deixa só uma faixa tocando — ou devolve todas, se ela já estava sozinha. */
  function soloPreviewAudioStream(item: QueueItem, stream: number) {
    const all = allAudioStreams(item);
    const active = activeAudioStreams(item);
    const alreadySolo = active.length === 1 && active[0] === stream;
    item.previewAudioStreams = alreadySolo ? all : [stream];
    item.mixedPeaks = null;
    item.mixedPeaksKey = "";
    if (selectedItem() !== item) return;

    applyAudioLayerMutes(item);
    renderAudioLanes();
    drawWaveform();
    drawMiniWaveform();
    drawAudioWaveforms();
    onCutParamsChanged();
  }

  /**
   * Liga/desliga uma faixa no preview. Tudo aqui é local: muta a camada, refaz
   * a onda a partir dos picos que já estão na memória e redesenha. O único
   * trabalho pesado que sobra é a reanálise de cortes, que já é adiada.
   */
  function togglePreviewAudioStream(
    item: QueueItem,
    stream: number,
    enabled: boolean,
  ) {
    const active = new Set(activeAudioStreams(item));
    if (enabled) active.add(stream);
    else active.delete(stream);
    item.previewAudioStreams = allAudioStreams(item).filter((s) => active.has(s));
    item.mixedPeaks = null;
    item.mixedPeaksKey = "";
    if (selectedItem() !== item) return;

    applyAudioLayerMutes(item);
    renderAudioLanes();
    drawWaveform();
    drawMiniWaveform();
    drawAudioWaveforms();
    onCutParamsChanged();
  }

  /**
   * O overlay bloqueia só enquanto o vídeo ainda não tem metadados. A extração
   * de áudio roda por baixo: dá para assistir e navegar antes de as faixas
   * ficarem prontas, em vez de encarar "mixando…" sem poder fazer nada.
   */
  function syncPreviewLoading() {
    const item = selectedItem();
    previewLoadingText.textContent = "Carregando preview...";
    previewLoading.classList.toggle("hidden", !videoMetadataLoading);
    previewStage.classList.toggle("loading", videoMetadataLoading);
    audioPrepChip.classList.toggle("hidden", !item?.audioPreviewsLoading);
  }

  function syncCustomPreviewControls() {
    const media = preview;
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    const current = Number.isFinite(media.currentTime) ? media.currentTime : 0;
    const hasMedia = lastPreviewPath !== "";
    const canSeek = hasMedia && duration > 0;
    const pct = canSeek ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

    previewScrub.disabled = !canSeek;
    if (!scrubbingPreview) {
      previewScrub.value = canSeek ? String(Math.round((current / duration) * 1000)) : "0";
    }
    previewScrub.style.setProperty("--fill", `${pct}%`);
    previewTime.textContent = `${formatMediaTime(current)} / ${formatMediaTime(duration)}`;

    const isPaused = media.paused || media.ended;
    previewBtnPlay.innerHTML = isPaused ? getIcon("play", 13) : getIcon("pause", 13);
    previewBtnPlay.disabled = !hasMedia;

    previewControls.classList.toggle("disabled", !hasMedia);
  }

  function seekPreviewFromScrub() {
    const duration = Number.isFinite(preview.duration) ? preview.duration : 0;
    if (duration <= 0) return;
    const ratio = Number(previewScrub.value) / 1000;
    setPreviewTime(Math.max(0, Math.min(duration, ratio * duration)));
    updatePlayhead();
    syncCustomPreviewControls();
  }

  async function playPreviewMedia() {
    // As camadas entram pelo listener de "play" do vídeo, não aqui: assim vale
    // também para o play disparado pelo próprio controle nativo.
    await preview.play().catch(() => {});
  }

  function pausePreviewMedia() {
    preview.pause();
    pauseAudioLayers();
  }

  function setPreviewTime(time: number) {
    try {
      preview.currentTime = time;
    } catch {}
    setAudioLayersTime(time);
  }

  /**
   * Extrai os previews de áudio do arquivo — uma vez por arquivo, não por
   * combinação de faixas. As faixas ativas mudam o que toca e o que a onda
   * mostra, mas não os dados brutos, então não há por que extrair de novo.
   */
  function ensureAudioPreviews(item: QueueItem) {
    setDefaultPreviewAudioStreams(item);

    const streams = item.probe?.audio_streams ?? 0;
    if (streams === 0) {
      preview.muted = false;
      syncPreviewLoading();
      return;
    }

    if (item.audioPreviews) {
      if (selectedItem() === item) buildAudioLayers(item);
      syncPreviewLoading();
      return;
    }
    if (item.audioPreviewsLoading || item.audioPreviewsFailed) {
      syncPreviewLoading();
      return;
    }

    item.audioPreviewsLoading = true;
    syncPreviewLoading();

    extractAudioPreviews(item.path, waveformBucketCount(item), streams)
      .then((previews) => {
        item.audioPreviews = previews;
        item.mixedPeaks = null;
        item.mixedPeaksKey = "";
        if (selectedItem() !== item) return;
        buildAudioLayers(item);
        renderAudioLanes();
        drawWaveform();
        drawMiniWaveform();
        drawAudioWaveforms();
      })
      .catch((e) => {
        item.audioPreviewsFailed = true;
        log(`Preview de áudio indisponível: ${e}`, "warning");
      })
      .finally(() => {
        item.audioPreviewsLoading = false;
        if (selectedItem() === item) syncPreviewLoading();
      });
  }

  /**
   * Onda das faixas ativas: o máximo ponto a ponto entre elas. É o que a
   * mixagem faria audivelmente, e sai de uma volta num array já carregado em
   * vez de uma passada de ffmpeg pelo arquivo inteiro.
   */
  function mixedPeaks(item: QueueItem): number[] | null {
    const previews = item.audioPreviews;
    if (!previews || previews.length === 0) return null;

    const key = previewWaveformKey(item);
    if (item.mixedPeaks && item.mixedPeaksKey === key) return item.mixedPeaks;

    const active = new Set(activeAudioStreams(item));
    const lanes = previews.filter((p) => active.has(p.stream));
    if (lanes.length === 0) {
      item.mixedPeaks = null;
      item.mixedPeaksKey = key;
      return null;
    }

    let peaks: number[];
    if (lanes.length === 1) {
      peaks = lanes[0].peaks;
    } else {
      const length = Math.max(...lanes.map((l) => l.peaks.length));
      peaks = new Array<number>(length).fill(0);
      for (const lane of lanes) {
        const scale = lane.peaks.length / length;
        for (let i = 0; i < length; i++) {
          const v = lane.peaks[Math.min(lane.peaks.length - 1, Math.floor(i * scale))];
          if (v > peaks[i]) peaks[i] = v;
        }
      }
    }

    item.mixedPeaks = peaks;
    item.mixedPeaksKey = key;
    return peaks;
  }

  function previewCacheKey(s: AppState, item = selectedItem()): string {
    return JSON.stringify(buildEditOnlyArgs(s, item ? editAudioStreamsForItem(item) : null));
  }

  /**
   * No modo simples os cortes se refazem sozinhos quando qualquer parâmetro
   * muda — inclusive em Movimento, que antes exigia apertar um botão sem
   * nenhuma razão visível para quem estava só mexendo no threshold.
   *
   * O modo avançado fica de fora de propósito: ali a expressão é editada
   * caractere por caractere, e reanalisar a cada tecla dispararia o auto-editor
   * em cima de texto ainda pela metade.
   */
  function shouldAutoPreviewItem(item: QueueItem | null): item is QueueItem {
    if (!item || state.advanced) return false;
    if (state.mode === "motion") return item.probe?.has_video === true;
    return item.probe?.has_audio === true;
  }

  /** Movimento decodifica vídeo: vale esperar mais antes de gastar essa passada. */
  function autoPreviewDelay(): number {
    return state.mode === "motion" ? 1200 : 650;
  }

  /**
   * A onda não entra mais nessa conta: ela é derivada de picos já extraídos e
   * fica pronta sozinha. Só a análise de cortes justifica chamar o auto-editor.
   */
  function hasPendingPreviewWork(item: QueueItem): boolean {
    if (!item.preview) return shouldAutoPreviewItem(item);
    return item.previewKey !== previewCacheKey(state, item);
  }

  function clearAutoPreviewTimer() {
    if (previewAutoTimer === null) return;
    window.clearTimeout(previewAutoTimer);
    previewAutoTimer = null;
  }

  function scheduleAutoPreview() {
    const item = selectedItem();
    if (!item || state.processing || !hasPendingPreviewWork(item)) return;

    clearAutoPreviewTimer();
    previewAutoQueued = true;

    if (analyzing) {
      syncPreviewControls();
      return;
    }

    const target = item;
    previewAutoTimer = window.setTimeout(() => {
      previewAutoTimer = null;
      if (
        selectedItem() !== target ||
        state.processing ||
        !hasPendingPreviewWork(target)
      ) {
        previewAutoQueued = false;
        syncPreviewControls();
        return;
      }
      void doAnalyze("auto");
    }, autoPreviewDelay());
    syncPreviewControls();
  }

  function onCutParamsChanged() {
    syncPreviewControls();
    scheduleAutoPreview();
  }

  function syncPreviewControls() {
    const item = selectedItem();
    const enabled = !!item && !state.processing && !analyzing;
    analyzeBtn.disabled = !enabled;
    analyzeBtn.innerHTML = analyzing
      ? `${getIcon("zap", 13, "animate-pulse")} Analisando…`
      : `${getIcon("zap", 13)} Aplicar expressão`;

    if (!item) {
      renderedPreview = null;
      cutsSection.classList.add("hidden");
      cutsSummary.textContent = "";
      playPreviewBtn.classList.add("hidden");
      return;
    }

    if (item.preview) {
      // "Atualizando…" vive no resumo, não num botão: no modo simples não há
      // botão nenhum para apertar, o corte se refaz sozinho.
      const stale = item.previewKey !== previewCacheKey(state);
      const working =
        analyzing || previewAutoTimer !== null || previewAutoQueued;
      cutsSummary.classList.toggle("stale", stale);
      cutsSummary.classList.toggle("working", stale && working);
      if (item.preview !== renderedPreview || preserveNextPreviewView) {
        renderCuts(item.preview, { preserveView: preserveNextPreviewView });
      }
      cutsSection.classList.remove("hidden");
      playPreviewBtn.classList.remove("hidden");
    } else {
      renderedPreview = null;
      cutsSection.classList.add("hidden");
      cutsSummary.textContent = analyzing ? "Analisando cortes…" : "";
      playPreviewBtn.classList.add("hidden");
    }
  }

  function renderCuts(t: CutsTimeline, opts: { preserveView?: boolean } = {}) {
    if (t.duration <= 0) return;

    const previousStart = viewStart;
    const previousRange = viewEnd - viewStart;

    // Mescla chunks adjacentes do mesmo tipo para reduzir DOM nodes
    mergedSegs = [];
    for (const c of t.chunks) {
      const last = mergedSegs[mergedSegs.length - 1];
      if (last && last.kept === c.kept && Math.abs(last.end - c.start) < 1e-3) {
        last.end = c.end;
      } else {
        mergedSegs.push({ start: c.start, end: c.end, kept: c.kept });
      }
    }

    // reseta view para mostrar a duração inteira
    if (opts.preserveView && previousRange > 0) {
      const next = clampView(previousStart, previousRange, t.duration);
      viewStart = next.start;
      viewEnd = next.end;
    } else {
      viewStart = 0;
      viewEnd = t.duration;
    }
    renderedPreview = t;
    preserveNextPreviewView = false;

    updateViewport(t.duration);
    renderAudioLanes();
    drawWaveform();
    drawMiniWaveform();
    drawAudioWaveforms();

    const pct = t.duration > 0 ? (1 - t.final_seconds / t.duration) * 100 : 0;
    cutsSummary.innerHTML = `<strong>${formatDuration(t.duration)}</strong> → <strong>${formatDuration(
      t.final_seconds,
    )}</strong> <span class="dim">(−${pct.toFixed(0)}% · ${mergedSegs.filter((m) => !m.kept).length} cortes)</span>`;
    cutsTimeEnd.textContent = formatDuration(t.duration);
    updatePlayhead();
    updateZoomUI(t.duration);
  }

  function updateViewport(total: number) {
    if (total <= 0) return;
    cutsViewport.style.left = `${(viewStart / total) * 100}%`;
    cutsViewport.style.width = `${((viewEnd - viewStart) / total) * 100}%`;
  }

  function updateZoomUI(total: number) {
    const zoomed = viewEnd - viewStart < total - 0.001;
    cutsMinimap.classList.toggle("hidden", !zoomed);
    if (zoomed) {
      const z = total / (viewEnd - viewStart);
      zoomInfo.textContent = ` · ${z.toFixed(1)}× zoom (${formatDuration(viewStart)}–${formatDuration(viewEnd)})`;
      zoomInfo.classList.remove("hidden");
    } else {
      zoomInfo.classList.add("hidden");
    }
    updateViewport(total);
  }

  function redrawZoom() {
    const item = selectedItem();
    if (!item || !item.preview) return;
    drawWaveform();
    renderAudioLanes();
    drawAudioWaveforms();
    updateZoomUI(item.preview.duration);
    updatePlayhead();
  }

  /**
   * Marca, coluna por coluna, se aquele instante sobrevive ao corte.
   *
   * Os chunks são ordenados e as colunas também, então um ponteiro que só anda
   * para frente resolve a varredura inteira numa passada — a versão anterior
   * relia a lista do começo para cada pixel, e um arquivo de 27 min com 435
   * cortes fazia isso 700 vezes por redesenho.
   */
  function keptMaskFor(
    chunks: CutsTimeline["chunks"],
    width: number,
    rangeStart: number,
    range: number,
  ): Uint8Array {
    const mask = new Uint8Array(width);
    if (chunks.length === 0) return mask.fill(1);

    let cursor = 0;
    for (let x = 0; x < width; x++) {
      const t = rangeStart + ((x + 0.5) / width) * range;
      while (cursor < chunks.length - 1 && t >= chunks[cursor].end) cursor++;
      const chunk = chunks[cursor];
      // Instante que não cai dentro de nenhum chunk é buraco no timeline: não
      // aparece na saída, logo foi cortado. A varredura anterior devolvia aqui
      // o `kept` do último chunk do arquivo, o que não quer dizer nada.
      mask[x] = t >= chunk.start && t < chunk.end && chunk.kept ? 1 : 0;
    }
    return mask;
  }

  /**
   * Desenha uma trilha de cortes.
   *
   * A leitura é por brilho, não por matiz: o que fica é uma onda acesa sobre
   * fundo limpo, e o que sai vira onda apagada sob uma faixa vermelha. Antes as
   * duas metades tinham a mesma intensidade — verde sobre verde e vermelho
   * sobre vermelho —, e com centenas de cortes o resultado era um pente onde
   * nenhum dos dois lados se destacava.
   *
   * A régua sólida no topo é o resumo: nela um corte de meio segundo continua
   * visível mesmo quando a onda embaixo já não tem pixels para mostrá-lo.
   */
  function paintWave(
    canvas: HTMLCanvasElement,
    peaks: number[],
    chunks: CutsTimeline["chunks"],
    total: number,
    rangeStart: number,
    rangeEnd: number,
    css: WaveStyle,
  ) {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0 || total <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const range = rangeEnd - rangeStart;
    const mask = keptMaskFor(chunks, cssW, rangeStart, range);
    const rulerH = css.ruler ? Math.min(4, Math.max(2, Math.round(cssH * 0.07))) : 0;

    // 1) Faixa vermelha nos trechos que saem.
    ctx.fillStyle = css.cutWash;
    let runStart = -1;
    for (let x = 0; x <= cssW; x++) {
      const isCut = x < cssW && mask[x] === 0;
      if (isCut && runStart < 0) runStart = x;
      if (!isCut && runStart >= 0) {
        ctx.fillRect(runStart, rulerH, x - runStart, cssH - rulerH);
        runStart = -1;
      }
    }

    // 2) Régua de resumo: verde onde fica, vermelho onde sai.
    if (rulerH > 0) {
      for (let x = 0; x < cssW; x++) {
        ctx.fillStyle = mask[x] === 1 ? css.rulerKept! : css.rulerCut!;
        ctx.fillRect(x, 0, 1, rulerH);
      }
    }

    // 3) A onda.
    const peaksLen = peaks.length;
    if (peaksLen === 0) return;

    const startIdx = (rangeStart / total) * peaksLen;
    const peaksPerPx = Math.max(1e-6, ((rangeEnd - rangeStart) / total) * peaksLen / cssW);
    const bodyTop = rulerH;
    const bodyH = cssH - rulerH;
    const cy = bodyTop + bodyH / 2;

    let lastColor: string | null = null;
    ctx.beginPath();

    for (let x = 0; x < cssW; x++) {
      const color = mask[x] === 1 ? css.kept : css.cut;

      let peak = 0;
      const i0 = Math.floor(startIdx + x * peaksPerPx);
      const i1 = Math.max(i0 + 1, Math.ceil(startIdx + (x + 1) * peaksPerPx));
      const lim = Math.min(i1, peaksLen);
      for (let i = Math.max(0, i0); i < lim; i++) {
        const p = peaks[i];
        if (p > peak) peak = p;
      }

      // amplifica visualmente picos baixos (raiz quadrada — mais perceptível)
      const amp = Math.sqrt(peak / 255);
      const barH = Math.max(1, amp * bodyH * 0.88);

      if (color !== lastColor) {
        if (lastColor) ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = color;
        lastColor = color;
      }
      ctx.rect(x, cy - barH / 2, 1, barH);
    }
    if (lastColor) ctx.fill();
  }

  function clearCanvas(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawWaveform() {
    const item = selectedItem();
    const peaks = item ? mixedPeaks(item) : null;
    if (!item || !item.preview || !peaks) {
      clearCanvas(cutsCanvas);
      return;
    }
    paintWave(
      cutsCanvas,
      peaks,
      item.preview.chunks,
      item.preview.duration,
      viewStart,
      viewEnd,
      WAVE_COLORS,
    );
  }

  function drawMiniWaveform() {
    const item = selectedItem();
    const peaks = item ? mixedPeaks(item) : null;
    if (!item || !item.preview || !peaks) {
      clearCanvas(cutsMiniCanvas);
      return;
    }
    paintWave(
      cutsMiniCanvas,
      peaks,
      item.preview.chunks,
      item.preview.duration,
      0,
      item.preview.duration,
      MINI_WAVE_COLORS,
    );
  }

  function audioWaveformLabel(w: AudioStreamPreview): string {
    const item = selectedItem();
    const name =
      item?.probe?.audio_tracks.find((track) => track.stream === w.stream)?.name ??
      w.name;
    return name ? `A${w.stream + 1} · ${name}` : `A${w.stream + 1}`;
  }

  function renderAudioLanes() {
    const item = selectedItem();
    const tracks = item?.audioPreviews ?? [];
    if (!item?.preview || tracks.length <= 1) {
      audioLanes.classList.add("hidden");
      audioLanes.innerHTML = "";
      return;
    }

    audioLanes.classList.remove("hidden");
    audioLanes.innerHTML = "";
    const active = new Set(activeAudioStreams(item));
    for (const track of tracks) {
      const lane = document.createElement("div");
      lane.className = "audio-lane";
      lane.classList.toggle("muted", !active.has(track.stream));

      const label = document.createElement("label");
      label.className = "audio-lane-label";
      label.title = `${audioWaveformLabel(track)} — clique para ligar/desligar, duplo clique para ouvir só esta`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = active.has(track.stream);
      input.addEventListener("change", () => {
        togglePreviewAudioStream(item, track.stream, input.checked);
      });
      // Solo, o gesto que veio junto com os chips do topo quando eles saíram:
      // é o que se quer ao tentar descobrir qual faixa é qual.
      label.addEventListener("dblclick", (e) => {
        e.preventDefault();
        soloPreviewAudioStream(item, track.stream);
      });
      const text = document.createElement("span");
      text.textContent = audioWaveformLabel(track);
      label.appendChild(input);
      label.appendChild(text);

      const wrap = document.createElement("div");
      wrap.className = "audio-lane-wave-wrap";

      const canvas = document.createElement("canvas");
      canvas.className = "cuts-waveform audio-lane-wave";
      canvas.dataset.stream = String(track.stream);

      wrap.appendChild(canvas);
      lane.appendChild(label);
      lane.appendChild(wrap);
      audioLanes.appendChild(lane);
    }
  }

  function drawAudioWaveforms() {
    const item = selectedItem();
    if (!item || !item.preview || !item.audioPreviews) return;

    for (const canvas of audioLanes.querySelectorAll<HTMLCanvasElement>(
      "canvas.audio-lane-wave",
    )) {
      const stream = Number(canvas.dataset.stream ?? "-1");
      const track = item.audioPreviews.find((w) => w.stream === stream);
      if (!track) continue;
      paintWave(
        canvas,
        track.peaks,
        item.preview.chunks,
        item.preview.duration,
        viewStart,
        viewEnd,
        LANE_WAVE_COLORS,
      );
    }
  }

  function updatePlayhead() {
    const item = selectedItem();
    if (!item || !item.preview) return;
    const media = preview;
    const t = media.currentTime || 0;
    const range = viewRange();
    const pct = ((t - viewStart) / range) * 100;
    cutsPlayhead.style.left = `${Math.max(-2, Math.min(102, pct))}%`;
    cutsPlayhead.style.opacity = pct < -1 || pct > 101 ? "0.2" : "1";
    cutsTimeCur.textContent = formatDuration(t);
  }

  // ----- zoom/pan -----

  let mousedownPending = false;
  let dragStartX = 0;
  let dragStartView: [number, number] = [0, 0];
  let didDrag = false;
  let dragMode: "main" | "viewport" | null = null;
  const DRAG_THRESHOLD = 4;

  cutsTrackWrap.addEventListener("wheel", (e) => {
    const item = selectedItem();
    if (!item || !item.preview) return;
    e.preventDefault();
    const total = item.preview.duration;

    const rect = cutsTrackWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const range = viewRange();

    if (e.shiftKey) {
      // shift+wheel = pan horizontal
      const delta = (e.deltaY / 200) * range;
      const v = clampView(viewStart + delta, range, total);
      viewStart = v.start;
      viewEnd = v.end;
    } else {
      // wheel = zoom centrado no cursor
      const focus = viewStart + ratio * range;
      const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
      const newRange = range * factor;
      const v = clampView(focus - ratio * newRange, newRange, total);
      viewStart = v.start;
      viewEnd = v.end;
    }
    redrawZoom();
  });

  cutsTrackWrap.addEventListener("dblclick", () => {
    const item = selectedItem();
    if (!item || !item.preview) return;
    viewStart = 0;
    viewEnd = item.preview.duration;
    redrawZoom();
  });

  cutsTrackWrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    mousedownPending = true;
    didDrag = false;
    dragMode = "main";
    dragStartX = e.clientX;
    dragStartView = [viewStart, viewEnd];
  });

  cutsViewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    mousedownPending = true;
    didDrag = false;
    dragMode = "viewport";
    dragStartX = e.clientX;
    dragStartView = [viewStart, viewEnd];
  });

  document.addEventListener("mousemove", (e) => {
    if (!mousedownPending) return;
    const item = selectedItem();
    if (!item || !item.preview) return;
    const total = item.preview.duration;
    const dx = e.clientX - dragStartX;
    if (!didDrag && Math.abs(dx) > DRAG_THRESHOLD) didDrag = true;
    if (!didDrag) return;

    if (dragMode === "main") {
      const rect = cutsTrackWrap.getBoundingClientRect();
      const range = dragStartView[1] - dragStartView[0];
      const dt = -(dx / rect.width) * range;
      const v = clampView(dragStartView[0] + dt, range, total);
      viewStart = v.start;
      viewEnd = v.end;
    } else if (dragMode === "viewport") {
      const rect = cutsMinimap.getBoundingClientRect();
      const range = dragStartView[1] - dragStartView[0];
      const dt = (dx / rect.width) * total;
      const v = clampView(dragStartView[0] + dt, range, total);
      viewStart = v.start;
      viewEnd = v.end;
    }
    redrawZoom();
  });

  document.addEventListener("mouseup", () => {
    mousedownPending = false;
    dragMode = null;
    // didDrag fica até o próximo click do segmento checá-lo
    setTimeout(() => {
      didDrag = false;
    }, 0);
  });

  cutsMinimap.addEventListener("click", (e) => {
    if (didDrag) return;
    if (e.target === cutsViewport) return;
    const item = selectedItem();
    if (!item || !item.preview) return;
    const total = item.preview.duration;
    const rect = cutsMinimap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const range = viewRange();
    const v = clampView(ratio * total - range / 2, range, total);
    viewStart = v.start;
    viewEnd = v.end;
    redrawZoom();
  });

  function startRaf() {
    cancelAnimationFrame(rafHandle);
    const tick = () => {
      updatePlayhead();
      maybeSkipCutZone();
      // Aqui, e não só no `timeupdate`: o evento de mídia chega umas 4x por
      // segundo, tarde demais para segurar o áudio junto da imagem.
      syncAudioLayers();
      if (!preview.paused && !preview.ended) {
        rafHandle = requestAnimationFrame(tick);
      }
    };
    rafHandle = requestAnimationFrame(tick);
  }

  function maybeSkipCutZone() {
    if (!playPreviewMode) return;
    const item = selectedItem();
    if (!item || !item.preview) return;
    const t = preview.currentTime;
    for (const c of item.preview.chunks) {
      if (!c.kept && t >= c.start && t < c.end - 0.05) {
        try {
          setPreviewTime(Math.min(c.end + 0.001, item.preview.duration - 0.01));
        } catch {}
        return;
      }
    }
  }

  preview.addEventListener("click", () => {
    if (lastPreviewPath === "") return;
    if (preview.paused || preview.ended) {
      void playPreviewMedia();
    } else {
      pausePreviewMedia();
    }
  });

  previewScrub.addEventListener("pointerdown", () => {
    scrubbingPreview = true;
  });
  previewBtnPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (lastPreviewPath === "") return;
    if (preview.paused || preview.ended) {
      void playPreviewMedia();
    } else {
      pausePreviewMedia();
    }
  });
  previewScrub.addEventListener("input", seekPreviewFromScrub);
  previewScrub.addEventListener("change", () => {
    seekPreviewFromScrub();
    scrubbingPreview = false;
  });
  previewScrub.addEventListener("pointerup", () => {
    scrubbingPreview = false;
    syncCustomPreviewControls();
  });

  // O vídeo é o único relógio: as camadas de áudio só o seguem.
  preview.addEventListener("play", () => {
    previewStage.classList.add("playing");
    startRaf();
    syncCustomPreviewControls();
    syncAudioLayers(true);
    void playAudioLayers();
  });
  preview.addEventListener("pause", () => {
    previewStage.classList.remove("playing");
    pauseAudioLayers();
    updatePlayhead();
    syncCustomPreviewControls();
  });
  preview.addEventListener("ended", () => {
    previewStage.classList.remove("playing");
    pauseAudioLayers();
    syncCustomPreviewControls();
  });
  preview.addEventListener("seeking", () => syncAudioLayers(true));
  preview.addEventListener("seeked", () => {
    syncAudioLayers(true);
    updatePlayhead();
    syncCustomPreviewControls();
  });
  preview.addEventListener("timeupdate", () => {
    updatePlayhead();
    syncCustomPreviewControls();
    syncAudioLayers();
  });
  preview.addEventListener("ratechange", () => {
    for (const el of audioLayers.values()) el.playbackRate = preview.playbackRate;
    syncCustomPreviewControls();
  });
  preview.addEventListener("volumechange", () => {
    const item = selectedItem();
    // Com camadas montadas, o áudio nativo do vídeo tem que ficar mudo: senão
    // a faixa padrão tocaria por cima das que a pessoa escolheu.
    if (audioLayers.size > 0) {
      if (!preview.muted) preview.muted = true;
      if (item) applyAudioLayerMutes(item);
    }
    syncCustomPreviewControls();
  });
  preview.addEventListener("loadstart", () => {
    videoMetadataLoading = true;
    syncPreviewLoading();
    syncCustomPreviewControls();
  });
  for (const evt of ["loadedmetadata", "canplay", "error"] as const) {
    preview.addEventListener(evt, () => {
      videoMetadataLoading = false;
      syncPreviewLoading();
      syncCustomPreviewControls();
    });
  }

  const resizeObs = new ResizeObserver(() => {
    drawWaveform();
    drawMiniWaveform();
    drawAudioWaveforms();
  });
  resizeObs.observe(cutsTrackWrap);
  resizeObs.observe(cutsMinimap);
  resizeObs.observe(audioLanes);

  /**
   * Etiqueta que segue o cursor dizendo o tempo e se aquele ponto sobrevive.
   *
   * Substitui os tooltips que existiam num `<div>` por segmento: com 435 cortes
   * aquilo eram centenas de nós de DOM, e mesmo assim não havia como apontar um
   * corte fino o bastante para não render nem um pixel.
   */
  cutsTrackWrap.addEventListener("mousemove", (e) => {
    const item = selectedItem();
    if (!item?.preview || mousedownPending) {
      cutsHover.classList.add("hidden");
      return;
    }
    const rect = cutsTrackWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = viewStart + ratio * viewRange();

    const seg = mergedSegs.find((s) => t >= s.start && t < s.end);
    const kept = seg ? seg.kept : true;
    cutsHover.textContent = `${formatMediaTime(t)} · ${kept ? "mantido" : "cortado"}`;
    cutsHover.classList.toggle("is-cut", !kept);
    cutsHover.classList.remove("hidden");

    // Não deixa a etiqueta sair pela borda quando o cursor chega na ponta.
    const half = cutsHover.offsetWidth / 2;
    const left = Math.max(half + 2, Math.min(rect.width - half - 2, ratio * rect.width));
    cutsHover.style.left = `${left}px`;
  });

  cutsTrackWrap.addEventListener("mouseleave", () =>
    cutsHover.classList.add("hidden"),
  );

  cutsTrackWrap.addEventListener("click", (e) => {
    if (didDrag) return;
    const item = selectedItem();
    if (!item || !item.preview) return;
    const rect = cutsTrackWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    try {
      setPreviewTime(viewStart + ratio * viewRange());
    } catch {}
  });

  analyzeBtn.addEventListener("click", () => void doAnalyze("manual"));
  // Toggle, e não um segundo botão de play: "pular os cortes" é um jeito de
  // assistir, não uma reprodução paralela. Por isso mora na barra de controle,
  // ao lado do tempo, e não numa fileira própria de botões.
  playPreviewBtn.addEventListener("click", () => setPlayPreviewMode(!playPreviewMode));

  function setPlayPreviewMode(on: boolean) {
    playPreviewMode = on;
    playPreviewBtn.classList.toggle("active", on);
    playPreviewBtn.setAttribute("aria-pressed", String(on));
    playPreviewBtn.title = on
      ? "Prévia do corte ligada: os trechos cortados são pulados"
      : "Prévia do corte: pula os trechos cortados";
    previewStage.classList.toggle("skipping-cuts", on);
    if (!on) return;
    maybeSkipCutZone();
    if (preview.paused) void playPreviewMedia();
  }

  async function doAnalyze(trigger: "manual" | "auto" = "manual") {
    const item = selectedItem();
    if (!item || state.processing) return;
    if (analyzing) {
      if (trigger === "auto") previewAutoQueued = true;
      return;
    }

    clearAutoPreviewTimer();

    if (!validateMargin() || !validateThreshold()) {
      if (trigger === "manual") {
        log("Corrija os campos inválidos antes de analisar.", "error");
      }
      syncPreviewControls();
      return;
    }

    const editArgs = buildEditOnlyArgs(state, editAudioStreamsForItem(item));
    const editKey = JSON.stringify(editArgs);
    if (trigger === "auto" && item.previewKey === editKey) {
      previewAutoQueued = false;
      syncPreviewControls();
      return;
    }

    analyzing = true;
    previewAutoQueued = false;
    analyzeBtn.disabled = true;
    cutsSection.classList.add("loading");

    log(
      `${trigger === "auto" ? "Atualizando" : "Analisando"} cortes de ${item.name}...`,
      "info",
    );

    try {
      // A onda já está pronta (ou a caminho) por conta de `ensureAudioPreviews`,
      // então aqui só falta perguntar ao auto-editor onde ficam os cortes.
      const t = await previewCuts(item.path, editArgs);
      preserveNextPreviewView = trigger === "auto" && item.preview !== null;
      item.preview = t;
      item.previewKey = editKey;
      log(
        `Cortes calculados: ${formatDuration(t.duration)} → ${formatDuration(t.final_seconds)} · ${t.chunks.filter((c) => !c.kept).length} cortes`,
        "success",
      );

      syncPreviewControls();
    } catch (e) {
      log(`Falha ao analisar: ${e}`, "error");
    } finally {
      const needsQueuedUpdate =
        previewAutoQueued &&
        !!selectedItem()?.preview &&
        selectedItem()?.previewKey !== previewCacheKey(state);
      analyzing = false;
      previewAutoQueued = false;
      cutsSection.classList.remove("loading");
      syncPreviewControls();
      if (needsQueuedUpdate) scheduleAutoPreview();
    }
  }

  function setItemStatus(item: QueueItem, s: QueueStatus, err?: string) {
    item.status = s;
    if (err) item.error = err;
    renderQueue();
  }

  async function doRun() {
    if (state.processing) return;
    if (state.queue.length === 0) {
      log("Adicione ao menos um arquivo.", "error");
      return;
    }
    if (!validateMargin() || !validateThreshold()) {
      log("Corrija os campos inválidos.", "error");
      return;
    }
    if (state.advanced && !state.expression.trim()) {
      log("Modo avançado: forneça uma expressão.", "error");
      return;
    }

    log("Executando pre-checagens...", "info");
    const preflight = await runPreflight(state);
    for (const item of state.queue) {
      if (item.probe) setDefaultPreviewAudioStreams(item);
    }
    renderQueue();
    updatePreview();

    for (const warning of preflight.warnings) log(`Aviso: ${warning}`, "warning");
    if (!preflight.ok) {
      for (const error of preflight.errors) log(`Erro: ${error}`, "error");
      setStatus("err", "Pre-checagem falhou");
      return;
    }
    if (preflight.overwritePaths.length > 0) {
      const ok = await confirm(
        `${preflight.overwritePaths.length} arquivo(s) de saida ja existem. Sobrescrever?`,
        {
          title: "Confirmar sobrescrita",
          kind: "warning",
          okLabel: "Sobrescrever",
          cancelLabel: "Cancelar",
        },
      );
      if (!ok) {
        log("Processamento cancelado antes de sobrescrever saidas.", "warning");
        return;
      }
    }

    state.processing = true;
    state.cancelled = false;
    syncAppUpdateButtons();
    runBtn.disabled = true;
    cancelBtn.disabled = false;
    runBtn.innerHTML = `${getIcon("zap", 15, "animate-pulse")} Processando...`;
    setStatus("running", "Processando");
    setProgressVisible(true);
    setProgress(0, "iniciando");
    userScrolled = false;
    syncPreviewControls();

    // reset status de itens
    for (const it of state.queue) {
      if (it.status !== "done") {
        it.status = "pending";
        it.error = undefined;
      }
    }
    renderQueue();

    const total = state.queue.length;
    const producedOutputs: string[] = [];
    let okCount = 0;
    let errCount = 0;

    for (let i = 0; i < state.queue.length; i++) {
      if (state.cancelled) break;

      const item = state.queue[i];
      if (item.status === "done") continue;

      state.selectedIndex = i;
      setItemStatus(item, "running");
      updatePreview();

      const customOut =
        total === 1 ? state.outputFile.trim() : "";
      item.outputPath = customOut || defaultOutputFor(item);

      const cwd = item.path.replace(/[\\/][^\\/]+$/, "") || null;

      log("─".repeat(48), "info");
      log(`[${i + 1}/${total}] ${item.name}`, "command");

      const exitCode = await new Promise<number>((resolve) => {
        startEditor(
          {
            state,
            inputPath: item.path,
            outputPath: customOut || undefined,
            editAudioStreams: editAudioStreamsForItem(item),
            durationSecs: item.probe?.duration_secs ?? null,
            cwd,
          },
          {
            onLine: (text, cls) => log(text, cls),
            onProgress: (pct, label) =>
              setProgress(pct, `[${i + 1}/${total}] ${label}`),
            onExit: (code) => {
              for (const u of unlisteners) {
                try {
                  u();
                } catch {}
              }
              unlisteners = [];
              resolve(code);
            },
          },
        )
          .then((un) => (unlisteners = un))
          .catch((e) => {
            log(`Falha ao iniciar: ${e}`, "error");
            resolve(-1);
          });
      });

      if (exitCode === 0) {
        setItemStatus(item, "done");
        producedOutputs.push(item.outputPath);
        okCount++;
        log(`Concluído: ${item.name}`, "success");
      } else {
        setItemStatus(item, "error", `código ${exitCode}`);
        errCount++;
        log(`Falha em ${item.name} (código ${exitCode})`, "error");
        if (state.cancelled) break;
      }
    }

    if (state.cancelled) {
      log("Fila interrompida.", "warning");
      setStatus("err", "Cancelado");
    } else if (errCount === 0) {
      setStatus("ok", `Concluído (${okCount}/${total})`);
      setProgress(100, "concluído");
    } else {
      setStatus("err", `${errCount} falha(s) de ${total}`);
    }

    finishRun();

    // Depois de finishRun: o aviso é a última coisa a aparecer, com os botões
    // da tela já reabilitados por baixo dele.
    if (!state.cancelled) {
      showDoneDialog(producedOutputs, errCount);
      if (producedOutputs.length > 0) maybeShowCutPrime();
    }
  }

  async function doCancel() {
    state.cancelled = true;
    try {
      await cancelEditor();
    } catch (e) {
      log(`Erro ao cancelar: ${e}`, "error");
    }
  }

  function finishRun() {
    state.processing = false;
    syncAppUpdateButtons();
    runBtn.disabled = false;
    cancelBtn.disabled = true;
    runBtn.innerHTML = `${getIcon("play", 15)} Iniciar Edição`;
    for (const u of unlisteners) {
      try {
        u();
      } catch {}
    }
    unlisteners = [];
    syncPreviewControls();
  }

  /**
   * Confere se o auto_editor em uso responde. Roda no início e de novo depois
   * de trocar de versão — um binário baixado que não executa precisa aparecer
   * antes de a pessoa enfileirar dez arquivos.
   */
  async function revalidateAutoEditor(): Promise<boolean> {
    try {
      const ver = await checkAutoEditor();
      log(`auto_editor ${ver}`, "info");
      hideBanner();
      runBtn.disabled = state.processing;
      return true;
    } catch (e) {
      showBanner(
        "error",
        `<strong>auto_editor não respondeu.</strong> Restaure a versão embarcada em Dependências ou reinstale o aplicativo. <code>${e}</code>`,
      );
      log(`auto_editor indisponível: ${e}`, "error");
      runBtn.disabled = true;
      return false;
    }
  }

  window.addEventListener("beforeunload", () => {
    unlistenTools?.();
    unlistenTools = null;
  });

  log("PrimeTrim iniciado", "info");
  await revalidateAutoEditor();

  await refreshToolStatuses();
  // Checagem silenciosa no início: falha de rede não deve virar erro na tela,
  // e o app funciona igual sem nunca atualizar nada.
  void doCheckUpdates(true);
  // O app em si também: uns segundos depois, para não disputar a abertura.
  window.setTimeout(() => void checkAppUpdate(true), 4000);

  renderQueue();
}
