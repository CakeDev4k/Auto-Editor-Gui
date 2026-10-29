//! Toolchain externa do PrimeTrim: `auto_editor` e o trio do FFmpeg.
//!
//! O instalador embarca uma cópia de cada binário (sidecar do Tauri), mas essa
//! cópia congela no dia do build. Este módulo permite baixar versões novas para
//! uma pasta gravável do usuário e passar a usá-las no lugar do sidecar — sem
//! precisar de permissão de administrador, que é o que impediria escrever em
//! `Program Files`.
//!
//! A regra de resolução é sempre a mesma: se existe binário gerenciado, ele
//! ganha; senão, cai no sidecar embarcado. Assim o app funciona igual antes
//! quando nunca se atualizou nada, e "restaurar embarcado" é só apagar arquivo.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::Command;
use tauri_plugin_shell::ShellExt;

/// Repositório que fornece o motor de cortes. Também é o crédito exibido no app.
pub const AUTO_EDITOR_REPO: &str = "WyattBlue/auto-editor";
const AUTO_EDITOR_API: &str =
    "https://api.github.com/repos/WyattBlue/auto-editor/releases/latest";

/// Builds "essentials" do gyan.dev — a mesma origem do ffmpeg.exe embarcado.
const FFMPEG_VERSION_URL: &str = "https://www.gyan.dev/ffmpeg/builds/release-version";
const FFMPEG_ZIP_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_HOME: &str = "https://www.gyan.dev/ffmpeg/builds/";

const USER_AGENT: &str = concat!("PrimeTrim/", env!("CARGO_PKG_VERSION"), " (+threshold)");

/// Binários que vêm juntos no zip do FFmpeg. `ffplay` não é usado pelo app, mas
/// é sidecar declarado — atualizar os três mantém o conjunto coerente.
const FFMPEG_BINARIES: [&str; 3] = ["ffmpeg", "ffprobe", "ffplay"];

// ---------------------------------------------------------------- resolução

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn managed_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados indisponível: {e}"))?
        .join("bin"))
}

fn ensure_managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = managed_dir_path(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("não consegui criar {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Caminho do binário baixado pelo updater, se ele existir de fato.
fn managed_path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let p = managed_dir_path(app).ok()?.join(exe_name(name));
    p.is_file().then_some(p)
}

/// Comando pronto para um binário da toolchain: versão gerenciada quando existe,
/// sidecar embarcado caso contrário.
///
/// Chamado do lado Rust, então não passa pelo escopo de `shell:allow-execute`
/// (esse escopo só vale para invocações vindas da webview).
pub fn tool_command(app: &AppHandle, name: &str) -> Result<Command, String> {
    if let Some(path) = managed_path(app, name) {
        return Ok(app.shell().command(path.to_string_lossy().to_string()));
    }
    app.shell()
        .sidecar(name)
        .map_err(|e| format!("sidecar {name} não encontrado: {e}"))
}

// ---------------------------------------------------------------- manifesto

/// Versão registrada no momento da instalação. O binário do FFmpeg só reporta a
/// string do build (`2026-08-09-git-...`), que não dá para comparar com o número
/// de release publicado — guardar o que instalamos resolve isso.
fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(managed_dir_path(app)?.join("installed.json"))
}

fn read_manifest(app: &AppHandle) -> BTreeMap<String, String> {
    manifest_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_manifest(app: &AppHandle, manifest: &BTreeMap<String, String>) -> Result<(), String> {
    let path = manifest_path(app)?;
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- versões

#[derive(Serialize, Clone)]
pub struct ToolStatus {
    /// `auto_editor` ou `ffmpeg`.
    id: String,
    label: String,
    /// String crua reportada pelo próprio binário.
    version: String,
    /// Versão de release registrada na instalação, quando conhecida.
    tracked_version: Option<String>,
    /// `managed` (baixado pelo updater) ou `bundled` (veio no instalador).
    source: String,
    path: String,
    error: Option<String>,
}

fn tool_label(id: &str) -> &'static str {
    match id {
        "auto_editor" => "auto-editor",
        _ => "FFmpeg",
    }
}

/// Primeiro `1.2` / `1.2.3` da string.
fn semver_of(text: &str) -> Option<String> {
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // Recusa dígito colado em letra/hífen à esquerda (evita casar "8" de "x264").
        if i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == '-') {
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == '.') {
                i += 1;
            }
            continue;
        }
        let start = i;
        let mut dots = 0;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == '.') {
            if bytes[i] == '.' {
                // "2026-08-09" não é semver; "9.0.1." também não continua.
                if i + 1 >= bytes.len() || !bytes[i + 1].is_ascii_digit() {
                    break;
                }
                dots += 1;
            }
            i += 1;
        }
        // Exigir pelo menos um ponto é o que separa "9.0.1-essentials_build"
        // (release) de "2026-08-09-git-..." (build datado): a data não tem ponto.
        if dots >= 1 {
            return Some(bytes[start..i].iter().collect());
        }
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == '-') {
            i += 1;
        }
    }
    None
}

fn version_parts(v: &str) -> Vec<u64> {
    v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
}

/// `true` quando `latest` é estritamente maior que `current`.
fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_parts(latest), version_parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

async fn raw_version(app: &AppHandle, id: &str) -> Result<String, String> {
    let (bin, args): (&str, [&str; 1]) = match id {
        "auto_editor" => ("auto_editor", ["--version"]),
        "ffmpeg" => ("ffmpeg", ["-version"]),
        other => return Err(format!("ferramenta desconhecida: {other}")),
    };

    let out = tool_command(app, bin)?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next().unwrap_or("").trim().to_string();
    if id == "ffmpeg" {
        // "ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright ..."
        let rest = first.strip_prefix("ffmpeg version ").unwrap_or(&first);
        return Ok(rest.split_whitespace().next().unwrap_or(rest).to_string());
    }
    Ok(first)
}

async fn status_of(app: &AppHandle, id: &str) -> ToolStatus {
    let managed = managed_path(app, id);
    let path = managed
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("{} (embarcado)", exe_name(id)));

    let (version, error) = match raw_version(app, id).await {
        Ok(v) => (v, None),
        Err(e) => (String::new(), Some(e)),
    };

    ToolStatus {
        id: id.to_string(),
        label: tool_label(id).to_string(),
        version,
        tracked_version: read_manifest(app).get(id).cloned(),
        source: if managed.is_some() { "managed" } else { "bundled" }.to_string(),
        path,
        error,
    }
}

#[tauri::command]
pub async fn tools_status(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    Ok(vec![
        status_of(&app, "auto_editor").await,
        status_of(&app, "ffmpeg").await,
    ])
}

// ---------------------------------------------------------------- checagem

#[derive(Serialize, Clone)]
pub struct ToolUpdate {
    id: String,
    label: String,
    /// Versão que o app considera instalada (manifesto quando há, senão o binário).
    current: String,
    latest: String,
    update_available: bool,
    /// `false` quando a versão instalada não é comparável (ex.: build git do
    /// FFmpeg embarcado) — nesse caso o app oferece a atualização sem afirmar
    /// que a atual está velha.
    comparable: bool,
    notes: String,
    release_url: String,
    published_at: String,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("cliente HTTP indisponível: {e}"))
}

/// Nome do asset do auto-editor para a plataforma atual.
fn auto_editor_asset_name() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    // O auto-editor chama o ARM de `aarch64` no Windows e no Linux, mas de
    // `arm64` no Mac (`auto-editor-macos-arm64`). Errar aqui so aparece no
    // Mac com chip Apple, como "a release nao tem o arquivo".
    let arch = match (os, std::env::consts::ARCH) {
        ("macos", "aarch64") => "arm64",
        (_, "aarch64") => "aarch64",
        _ => "x86_64",
    };
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    format!("auto-editor-{os}-{arch}{suffix}")
}

async fn latest_auto_editor() -> Result<GhRelease, String> {
    let resp = http_client()?
        .get(AUTO_EDITOR_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("falha ao consultar o GitHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub respondeu {}", resp.status()));
    }
    resp.json::<GhRelease>()
        .await
        .map_err(|e| format!("resposta do GitHub inválida: {e}"))
}

async fn latest_ffmpeg() -> Result<String, String> {
    let resp = http_client()?
        .get(FFMPEG_VERSION_URL)
        .send()
        .await
        .map_err(|e| format!("falha ao consultar gyan.dev: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("gyan.dev respondeu {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let version = text.trim().to_string();
    if version.is_empty() {
        return Err("gyan.dev não informou a versão".into());
    }
    Ok(version)
}

/// Versão que serve de base para comparar: o manifesto tem prioridade porque
/// registra o número de release; o binário só reporta a string do build.
fn effective_current(status: &ToolStatus) -> (String, Option<String>) {
    let tracked = status.tracked_version.clone();
    let display = tracked.clone().unwrap_or_else(|| status.version.clone());
    let comparable = tracked.or_else(|| semver_of(&status.version));
    (display, comparable)
}

#[tauri::command]
pub async fn check_tool_updates(app: AppHandle) -> Result<Vec<ToolUpdate>, String> {
    let mut out = Vec::new();

    let ae_status = status_of(&app, "auto_editor").await;
    let (ae_display, ae_comparable) = effective_current(&ae_status);
    match latest_auto_editor().await {
        Ok(release) => {
            let latest = release.tag_name.trim_start_matches('v').to_string();
            let update_available = match &ae_comparable {
                Some(cur) => is_newer(&latest, cur),
                None => true,
            };
            out.push(ToolUpdate {
                id: "auto_editor".into(),
                label: tool_label("auto_editor").into(),
                current: ae_display,
                latest,
                update_available,
                comparable: ae_comparable.is_some(),
                notes: release.body.trim().to_string(),
                release_url: if release.html_url.is_empty() {
                    format!("https://github.com/{AUTO_EDITOR_REPO}/releases")
                } else {
                    release.html_url
                },
                published_at: release.published_at,
            });
        }
        Err(e) => return Err(e),
    }

    let ff_status = status_of(&app, "ffmpeg").await;
    let (ff_display, ff_comparable) = effective_current(&ff_status);
    if !ffmpeg_updatable() {
        out.push(ToolUpdate {
            id: "ffmpeg".into(),
            label: tool_label("ffmpeg").into(),
            latest: ff_display.clone(),
            current: ff_display,
            update_available: false,
            comparable: ff_comparable.is_some(),
            notes: FFMPEG_BUNDLED_ONLY.into(),
            release_url: FFMPEG_HOME.into(),
            published_at: String::new(),
        });
        return Ok(out);
    }
    let latest = latest_ffmpeg().await?;
    let update_available = match &ff_comparable {
        Some(cur) => is_newer(&latest, cur),
        None => true,
    };
    out.push(ToolUpdate {
        id: "ffmpeg".into(),
        label: tool_label("ffmpeg").into(),
        current: ff_display,
        latest,
        update_available,
        comparable: ff_comparable.is_some(),
        notes: String::new(),
        release_url: FFMPEG_HOME.into(),
        published_at: String::new(),
    });

    Ok(out)
}

// ---------------------------------------------------------------- download

fn emit_progress(app: &AppHandle, id: &str, phase: &str, percent: f64, detail: &str) {
    let _ = app.emit(
        "tools://progress",
        serde_json::json!({
            "id": id,
            "phase": phase,
            "percent": percent.clamp(0.0, 100.0),
            "detail": detail,
        }),
    );
}

async fn download_to(app: &AppHandle, id: &str, url: &str, dest: &Path) -> Result<(), String> {
    let mut resp = http_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download falhou: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download respondeu {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut file = File::create(dest).map_err(|e| format!("não consegui gravar: {e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = 0u64;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("download interrompido: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("não consegui gravar: {e}"))?;
        received += chunk.len() as u64;

        // Um evento a cada ~1 MB: suficiente para a barra andar, sem inundar a IPC.
        if received - last_emit >= 1_000_000 || received == total {
            last_emit = received;
            let percent = if total > 0 {
                (received as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            emit_progress(
                app,
                id,
                "download",
                percent,
                &format!("{} MB", received / 1_000_000),
            );
        }
    }

    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Troca `staged` por `target`, contornando o bloqueio do Windows em binário em
/// uso: o antigo sai do caminho antes, e só depois é apagado.
fn swap_in(staged: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        let backup = target.with_extension("old");
        let _ = fs::remove_file(&backup);
        fs::rename(target, &backup)
            .map_err(|e| format!("{} está em uso ({e})", target.display()))?;
        let result = fs::rename(staged, target);
        match result {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                Ok(())
            }
            Err(e) => {
                let _ = fs::rename(&backup, target);
                Err(format!("não consegui instalar {}: {e}", target.display()))
            }
        }
    } else {
        fs::rename(staged, target).map_err(|e| format!("não consegui instalar: {e}"))
    }
}

/// Confere que o arquivo baixado é mesmo executável antes de virar o oficial.
async fn verify_binary(app: &AppHandle, path: &Path, id: &str) -> Result<String, String> {
    let arg = if id == "ffmpeg" { "-version" } else { "--version" };
    let out = app
        .shell()
        .command(path.to_string_lossy().to_string())
        .args([arg])
        .output()
        .await
        .map_err(|e| format!("o binário baixado não executou: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "o binário baixado retornou erro: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string())
}

/// No Mac e no Linux, arquivo baixado nasce sem permissao de execucao, e o
/// `--version` da verificacao falharia com "permission denied".
#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("nao consegui tornar {} executavel: {e}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn unique_temp(prefix: &str, ext: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("autocut-{prefix}-{nanos}.{ext}"))
}

async fn install_auto_editor(app: &AppHandle) -> Result<String, String> {
    let release = latest_auto_editor().await?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    let wanted = auto_editor_asset_name();
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == wanted)
        .ok_or_else(|| format!("a release {version} não tem o arquivo {wanted}"))?;

    let dir = ensure_managed_dir(app)?;
    let staged = dir.join(format!("{}.download", exe_name("auto_editor")));
    let _ = fs::remove_file(&staged);

    emit_progress(app, "auto_editor", "download", 0.0, "iniciando");
    download_to(app, "auto_editor", &asset.browser_download_url, &staged).await?;

    make_executable(&staged)?;
    emit_progress(app, "auto_editor", "verify", 100.0, "verificando");
    if let Err(e) = verify_binary(app, &staged, "auto_editor").await {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }

    emit_progress(app, "auto_editor", "install", 100.0, "instalando");
    swap_in(&staged, &dir.join(exe_name("auto_editor")))?;

    let mut manifest = read_manifest(app);
    manifest.insert("auto_editor".into(), version.clone());
    write_manifest(app, &manifest)?;
    Ok(version)
}

/// Extrai `bin/ffmpeg.exe` e companhia do zip do gyan.dev, ignorando a pasta
/// raiz versionada (`ffmpeg-9.0.1-essentials_build/`).
fn extract_ffmpeg_zip(app: &AppHandle, zip_path: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    let file = File::open(zip_path).map_err(|e| format!("zip ilegível: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip inválido: {e}"))?;

    let mut staged = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entrada {i} ilegível: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let base = match name.rsplit('/').next() {
            Some(b) => b.to_string(),
            None => continue,
        };
        let stem = base.trim_end_matches(".exe");
        if !FFMPEG_BINARIES.contains(&stem) || !name.contains("/bin/") {
            continue;
        }

        let out_path = dir.join(format!("{}.download", exe_name(stem)));
        let mut out = File::create(&out_path).map_err(|e| format!("não consegui gravar: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extração falhou: {e}"))?;
        out.flush().map_err(|e| e.to_string())?;
        emit_progress(app, "ffmpeg", "extract", 100.0, &base);
        staged.push(out_path);
    }

    if staged.is_empty() {
        return Err("o zip do FFmpeg não continha os binários esperados".into());
    }
    Ok(staged)
}

/// O gyan.dev so tem builds de Windows. No Mac o FFmpeg vem dentro do app
/// (versao fixa no `release.yml`) e atualiza junto com ele: a fonte de Mac
/// usada na build nao tem um link estavel de "ultima versao" para o app seguir.
fn ffmpeg_updatable() -> bool {
    cfg!(target_os = "windows")
}

const FFMPEG_BUNDLED_ONLY: &str =
    "Neste sistema o FFmpeg vem junto com o PrimeTrim e atualiza quando o app atualiza.";

async fn install_ffmpeg(app: &AppHandle) -> Result<String, String> {
    if !ffmpeg_updatable() {
        return Err(FFMPEG_BUNDLED_ONLY.into());
    }
    let version = latest_ffmpeg().await?;
    let dir = ensure_managed_dir(app)?;
    let zip_path = unique_temp("ffmpeg", "zip");

    emit_progress(app, "ffmpeg", "download", 0.0, "iniciando");
    let downloaded = download_to(app, "ffmpeg", FFMPEG_ZIP_URL, &zip_path).await;
    if let Err(e) = downloaded {
        let _ = fs::remove_file(&zip_path);
        return Err(e);
    }

    emit_progress(app, "ffmpeg", "extract", 0.0, "extraindo");
    let staged = extract_ffmpeg_zip(app, &zip_path, &dir);
    let _ = fs::remove_file(&zip_path);
    let staged = staged?;

    let cleanup = |files: &[PathBuf]| {
        for f in files {
            let _ = fs::remove_file(f);
        }
    };

    let staged_ffmpeg = staged
        .iter()
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("ffmpeg."))
        })
        .cloned();
    let Some(staged_ffmpeg) = staged_ffmpeg else {
        cleanup(&staged);
        return Err("o zip não trouxe o ffmpeg".into());
    };

    emit_progress(app, "ffmpeg", "verify", 100.0, "verificando");
    if let Err(e) = verify_binary(app, &staged_ffmpeg, "ffmpeg").await {
        cleanup(&staged);
        return Err(e);
    }

    emit_progress(app, "ffmpeg", "install", 100.0, "instalando");
    for path in &staged {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .trim_end_matches(".download")
            .to_string();
        if let Err(e) = swap_in(path, &dir.join(&name)) {
            cleanup(&staged);
            return Err(e);
        }
    }

    let mut manifest = read_manifest(app);
    manifest.insert("ffmpeg".into(), version.clone());
    write_manifest(app, &manifest)?;
    Ok(version)
}

/// Instala a versão mais nova. Exposta ao front por um wrapper em `lib.rs` que
/// recusa a troca enquanto há uma edição rodando — no Windows não dá para
/// substituir um .exe em uso.
pub async fn install_update(app: AppHandle, id: String) -> Result<Vec<ToolStatus>, String> {
    match id.as_str() {
        "auto_editor" => install_auto_editor(&app).await?,
        "ffmpeg" => install_ffmpeg(&app).await?,
        other => return Err(format!("ferramenta desconhecida: {other}")),
    };
    emit_progress(&app, &id, "done", 100.0, "concluído");
    tools_status(app).await
}

/// Apaga a cópia gerenciada e devolve o app ao binário que veio no instalador.
pub async fn restore_bundled(app: AppHandle, id: String) -> Result<Vec<ToolStatus>, String> {
    let names: Vec<&str> = match id.as_str() {
        "auto_editor" => vec!["auto_editor"],
        "ffmpeg" => FFMPEG_BINARIES.to_vec(),
        other => return Err(format!("ferramenta desconhecida: {other}")),
    };

    let dir = managed_dir_path(&app)?;
    for name in names {
        let path = dir.join(exe_name(name));
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("não consegui remover {}: {e}", path.display()))?;
        }
    }

    let mut manifest = read_manifest(&app);
    manifest.remove(&id);
    let _ = write_manifest(&app, &manifest);

    tools_status(app).await
}

/// Abre a pasta dos binários gerenciados no explorador de arquivos.
#[tauri::command]
pub fn managed_tools_dir(app: AppHandle) -> Result<String, String> {
    Ok(ensure_managed_dir(&app)?.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- links

/// Hosts que o app pode abrir no navegador. Lista fechada porque a URL chega da
/// webview, e "abrir qualquer coisa que mandarem" é uma porta que não precisa
/// existir num app que só linka créditos e releases.
const ALLOWED_HOSTS: [&str; 7] = [
    "github.com",
    "auto-editor.com",
    "www.auto-editor.com",
    "ffmpeg.org",
    "www.gyan.dev",
    "tauri.app",
    "www.threshold-editor.com",
];

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "somente links https são permitidos".to_string())?;
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(format!("host não permitido: {host}"));
    }

    #[cfg(target_os = "windows")]
    {
        // rundll32 em vez de `cmd /C start`: sem interpretador de shell no meio.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_from_tool_output() {
        assert_eq!(semver_of("31.5.0").as_deref(), Some("31.5.0"));
        assert_eq!(semver_of("9.0.1-essentials_build").as_deref(), Some("9.0.1"));
        assert_eq!(semver_of("30.1.6").as_deref(), Some("30.1.6"));
        // Builds datados do FFmpeg não têm número de release comparável.
        assert_eq!(semver_of("2025-11-10-git-133a0bcb13-essentials_build"), None);
        assert_eq!(semver_of("2026-08-09-git-6bbc22dc09"), None);
        assert_eq!(semver_of("N-121212-gabcdef"), None);
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("31.5.0", "29.3.1"));
        assert!(is_newer("31.10.0", "31.9.9"));
        assert!(!is_newer("31.5.0", "31.5.0"));
        assert!(!is_newer("30.1.6", "31.0.0"));
    }
}
