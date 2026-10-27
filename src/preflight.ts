import type { AppState, QueueItem } from "./types";
import { defaultOutputFor, pathExists, probeFile } from "./runner";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  overwritePaths: string[];
}

function samePath(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function parentPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return slash > 0 ? path.slice(0, slash) : "";
}

function plannedOutputFor(
  state: AppState,
  item: QueueItem,
  total: number,
): string {
  const custom = total === 1 ? state.outputFile.trim() : "";
  return custom || defaultOutputFor(item);
}

async function ensureProbe(item: QueueItem, warnings: string[]) {
  if (item.probe !== null) return;
  try {
    item.probe = await probeFile(item.path);
  } catch (e) {
    warnings.push(`Nao consegui ler metadados de ${item.name}: ${e}`);
  }
}

export async function runPreflight(state: AppState): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const overwritePaths: string[] = [];
  const total = state.queue.length;
  const plannedOutputs = new Map<string, string>();

  for (const item of state.queue) {
    if (!(await pathExists(item.path))) {
      errors.push(`Arquivo nao encontrado: ${item.name}`);
      continue;
    }

    await ensureProbe(item, warnings);

    if (!state.advanced && state.mode === "audio") {
      if (item.probe && !item.probe.has_audio) {
        errors.push(`${item.name} nao tem faixa de audio para o modo Audio.`);
      }
      const audioStreams = item.probe?.audio_streams ?? 0;
      if (audioStreams > 0 && item.previewAudioStreams?.length === 0) {
        errors.push(`${item.name} esta sem faixa de audio ativa.`);
      }
    }

    if (!state.advanced && state.mode === "motion" && item.probe && !item.probe.has_video) {
      errors.push(`${item.name} nao tem video para o modo Motion.`);
    }

    const output = plannedOutputFor(state, item, total);
    if (samePath(output, item.path)) {
      errors.push(`${item.name}: a saida nao pode sobrescrever o arquivo original.`);
    }

    const parent = parentPath(output);
    if (parent && !(await pathExists(parent))) {
      errors.push(`${item.name}: pasta de saida nao existe (${parent}).`);
    }

    const outputKey = output.toLowerCase();
    const previous = plannedOutputs.get(outputKey);
    if (previous) {
      errors.push(`Saida duplicada: ${previous} e ${item.name} gerariam o mesmo arquivo.`);
    } else {
      plannedOutputs.set(outputKey, item.name);
    }

    if (await pathExists(output)) {
      overwritePaths.push(output);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    overwritePaths,
  };
}
