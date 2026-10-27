import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Atualização do próprio PrimeTrim (não confundir com tools.ts, que atualiza
 * auto-editor e FFmpeg).
 *
 * O plugin lê o `latest.json` da última release do GitHub e só instala o que
 * vier assinado com a chave privada cujo par é o `pubkey` da tauri.conf.json.
 * Um fork que publicar as próprias releases precisa trocar os dois — ver README.
 */

export type AppUpdateProgress = { downloaded: number; total: number | null };

export async function findAppUpdate(): Promise<Update | null> {
  return await check();
}

/**
 * Baixa, instala e reinicia. No Windows o instalador NSIS em modo passivo
 * fecha o app sozinho antes de trocar os arquivos, então o `relaunch` só chega
 * a rodar nas outras plataformas.
 */
export async function installAppUpdate(
  update: Update,
  onProgress: (p: AppUpdateProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        break;
      case "Finished":
        if (total !== null) downloaded = total;
        break;
    }
    onProgress({ downloaded, total });
  });
  await relaunch();
}
