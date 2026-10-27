import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Ferramentas externas que o app sabe atualizar. */
export type ToolId = "auto_editor" | "ffmpeg";

export interface ToolStatus {
  id: ToolId;
  label: string;
  /** String crua reportada pelo binário (`31.5.0`, `9.0.1-essentials_build`...). */
  version: string;
  /** Versão de release registrada quando o updater instalou. */
  tracked_version: string | null;
  /** `managed` = baixado pelo updater; `bundled` = veio no instalador. */
  source: "managed" | "bundled";
  path: string;
  error: string | null;
}

export interface ToolUpdate {
  id: ToolId;
  label: string;
  current: string;
  latest: string;
  update_available: boolean;
  /**
   * `false` quando a versão instalada não é um número comparável — o build git
   * do FFmpeg embarcado, por exemplo. Aí o app oferece a atualização sem
   * afirmar que a atual está velha.
   */
  comparable: boolean;
  notes: string;
  release_url: string;
  published_at: string;
}

export interface ToolProgress {
  id: ToolId;
  phase: "download" | "extract" | "verify" | "install" | "done";
  percent: number;
  detail: string;
}

export const AUTO_EDITOR_REPO_URL = "https://github.com/WyattBlue/auto-editor";
export const AUTO_EDITOR_SITE_URL = "https://auto-editor.com";
export const FFMPEG_SITE_URL = "https://ffmpeg.org";
export const FFMPEG_BUILDS_URL = "https://www.gyan.dev/ffmpeg/builds/";
export const TAURI_URL = "https://tauri.app";
/** Seção do Cut Prime na home do site — as extensões não têm página própria. */
export const CUT_PRIME_URL = "https://www.threshold-editor.com/pt#cutprime";

export async function toolsStatus(): Promise<ToolStatus[]> {
  return await invoke<ToolStatus[]>("tools_status");
}

export async function checkToolUpdates(): Promise<ToolUpdate[]> {
  return await invoke<ToolUpdate[]>("check_tool_updates");
}

export async function installToolUpdate(id: ToolId): Promise<ToolStatus[]> {
  return await invoke<ToolStatus[]>("install_tool_update", { id });
}

export async function restoreBundledTool(id: ToolId): Promise<ToolStatus[]> {
  return await invoke<ToolStatus[]>("restore_bundled_tool", { id });
}

export async function managedToolsDir(): Promise<string> {
  return await invoke<string>("managed_tools_dir");
}

export async function openExternal(url: string): Promise<void> {
  await invoke("open_external", { url });
}

export async function onToolProgress(
  handler: (p: ToolProgress) => void,
): Promise<UnlistenFn> {
  return await listen<ToolProgress>("tools://progress", (e) => handler(e.payload));
}

const PHASE_LABEL: Record<ToolProgress["phase"], string> = {
  download: "Baixando",
  extract: "Extraindo",
  verify: "Verificando",
  install: "Instalando",
  done: "Concluído",
};

export function phaseLabel(phase: ToolProgress["phase"]): string {
  return PHASE_LABEL[phase] ?? phase;
}

/**
 * Versão a exibir para uma ferramenta. Prefere o número de release registrado
 * na instalação: o binário do FFmpeg só reporta a string do build, que não diz
 * nada para quem quer saber se está atualizado.
 */
export function displayVersion(status: ToolStatus): string {
  if (status.error) return "—";
  return status.tracked_version ?? status.version ?? "—";
}
