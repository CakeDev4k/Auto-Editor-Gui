use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

mod tools;
use tools::{tool_command, ToolStatus};

#[derive(Default, Clone)]
struct EditorState {
    child: Arc<Mutex<Option<CommandChild>>>,
    log_file: Arc<Mutex<Option<File>>>,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
struct FileInfo {
    name: String,
    size_bytes: u64,
    ext: String,
}

#[derive(Serialize, Default)]
struct ProbeInfo {
    duration_secs: f64,
    width: Option<u32>,
    height: Option<u32>,
    vcodec: Option<String>,
    acodec: Option<String>,
    has_audio: bool,
    has_video: bool,
    audio_streams: u32,
    audio_tracks: Vec<AudioTrackInfo>,
}

#[derive(Serialize)]
struct AudioTrackInfo {
    stream: u32,
    name: String,
    codec: Option<String>,
    channels: Option<u32>,
}

/// Tudo que o preview precisa de uma faixa de áudio, produzido numa passada só.
#[derive(Serialize)]
struct AudioStreamPreview {
    stream: u32,
    name: String,
    /// Picos em 0-255. `u8` e não `f32` porque a onda vira pixel: 8 bits de
    /// amplitude é mais resolução do que a tela mostra, e o JSON que atravessa
    /// a IPC fica cerca de três vezes menor.
    peaks: Vec<u8>,
    /// WAV mixável desta faixa. Vazio quando o arquivo tem uma faixa só — aí o
    /// próprio `<video>` toca o áudio e não há nada para mixar.
    proxy_path: String,
}

#[tauri::command]
fn file_info(path: String) -> Result<FileInfo, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    Ok(FileInfo {
        name,
        size_bytes: meta.len(),
        ext,
    })
}

/// Verifica se o sidecar auto_editor responde. Retorna a versão/saída.
#[tauri::command]
async fn check_auto_editor(app: AppHandle) -> Result<String, String> {
    let cmd = tool_command(&app, "auto_editor")?.args(["--version"]);

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Roda ffprobe e extrai metadados do arquivo.
#[tauri::command]
async fn probe_file(app: AppHandle, path: String) -> Result<ProbeInfo, String> {
    let cmd = tool_command(&app, "ffprobe")?
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ]);

    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("ffprobe JSON inválido: {e}"))?;

    let mut info = ProbeInfo::default();

    if let Some(d) = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
    {
        info.duration_secs = d;
    }

    if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let codec_type = s.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            let codec = s
                .get("codec_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match codec_type {
                "video" => {
                    info.has_video = true;
                    info.vcodec = codec;
                    info.width = s.get("width").and_then(|v| v.as_u64()).map(|n| n as u32);
                    info.height = s.get("height").and_then(|v| v.as_u64()).map(|n| n as u32);
                }
                "audio" => {
                    let stream = info.audio_streams;
                    info.has_audio = true;
                    info.audio_streams += 1;
                    let name = s
                        .get("tags")
                        .and_then(|t| t.get("name").or_else(|| t.get("title")).or_else(|| t.get("handler_name")))
                        .and_then(|v| v.as_str())
                        .filter(|v| !v.trim().is_empty())
                        .map(|v| v.trim().to_string())
                        .unwrap_or_else(|| format!("Audio {}", stream + 1));
                    let channels = s.get("channels").and_then(|v| v.as_u64()).map(|n| n as u32);
                    info.audio_tracks.push(AudioTrackInfo {
                        stream,
                        name,
                        codec: codec.clone(),
                        channels,
                    });
                    info.acodec = codec;
                }
                _ => {}
            }
        }
    }

    Ok(info)
}

/// Lista as mídias suportadas de uma pasta, em ordem de nome.
///
/// Não desce em subpastas: quem escolhe "a pasta da gravação de hoje" espera os
/// arquivos dela, não a árvore inteira do drive de projetos.
#[tauri::command]
fn list_media_files(dir: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    let allowed: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let entries = fs::read_dir(&dir).map_err(|e| format!("não consegui ler {dir}: {e}"))?;

    let mut found: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if allowed.iter().any(|a| a == &ext) {
            found.push(path.to_string_lossy().to_string());
        }
    }

    found.sort_by_key(|p| p.to_lowercase());
    Ok(found)
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if p.is_file() {
        p.parent().map(|p| p.to_path_buf()).unwrap_or(p)
    } else {
        p
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        return Err("plataforma não suportada".into());
    }
    Ok(())
}

fn now_ts() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", secs)
}

fn unique_temp_path(prefix: &str, ext: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}-{nanos}-{n}.{ext}"))
}

fn open_run_log(app: &AppHandle) -> Option<File> {
    let dir = app.path().app_log_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("run-{}.log", now_ts()));
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

fn write_log_line(slot: &Arc<Mutex<Option<File>>>, stream: &str, text: &str) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "[{}] {}", stream, text);
        }
    }
}

#[tauri::command]
async fn run_editor(
    app: AppHandle,
    state: State<'_, EditorState>,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    {
        let guard = state.child.lock().unwrap();
        if guard.is_some() {
            return Err("Já existe um processamento em andamento".into());
        }
    }

    let mut cmd = tool_command(&app, "auto_editor")?.args(args.clone());

    if let Some(dir) = cwd.as_ref() {
        cmd = cmd.current_dir(PathBuf::from(dir));
    }

    let existing_path = std::env::var("PATH").unwrap_or_default();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let new_path = format!("{};{}", exe_dir.display(), existing_path);
    cmd = cmd.env("PATH", new_path);

    // Abre log persistente para esta execução
    let log_file = open_run_log(&app);
    {
        let mut guard = state.log_file.lock().unwrap();
        *guard = log_file;
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "[meta] cmd auto_editor {}", args.join(" "));
            if let Some(d) = cwd.as_ref() {
                let _ = writeln!(f, "[meta] cwd {}", d);
            }
        }
    }

    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;

    let child_slot = state.child.clone();
    {
        let mut guard = child_slot.lock().unwrap();
        *guard = Some(child);
    }

    let log_slot = state.log_file.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    write_log_line(&log_slot, "stdout", text.trim_end());
                    let _ = app_handle.emit(
                        "editor://line",
                        serde_json::json!({ "stream": "stdout", "text": text }),
                    );
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    write_log_line(&log_slot, "stderr", text.trim_end());
                    let _ = app_handle.emit(
                        "editor://line",
                        serde_json::json!({ "stream": "stderr", "text": text }),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code.unwrap_or(-1);
                    write_log_line(&log_slot, "exit", &code.to_string());
                    let _ = app_handle.emit(
                        "editor://exit",
                        serde_json::json!({ "code": code }),
                    );
                    if let Ok(mut g) = child_slot.lock() {
                        *g = None;
                    }
                    if let Ok(mut g) = log_slot.lock() {
                        if let Some(mut f) = g.take() {
                            let _ = f.flush();
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    write_log_line(&log_slot, "error", &err);
                    let _ = app_handle.emit(
                        "editor://line",
                        serde_json::json!({ "stream": "stderr", "text": err }),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_editor(state: State<'_, EditorState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn log_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _ = fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn cleanup_temp_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "caminho temporario invalido".to_string())?;
    if !name.starts_with("autocut-") {
        return Err("arquivo temporario fora do escopo do PrimeTrim".into());
    }

    let temp_dir = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let parent = p
        .parent()
        .ok_or_else(|| "arquivo temporario sem pasta".to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(temp_dir) {
        return Err("arquivo temporario fora da pasta temporaria".into());
    }

    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct CutChunk {
    start: f64,
    end: f64,
    speed: f64,
    kept: bool,
}

#[derive(Serialize, Default)]
struct CutsTimeline {
    duration: f64,
    framerate: f64,
    kept_seconds: f64,
    cut_seconds: f64,
    final_seconds: f64,
    chunks: Vec<CutChunk>,
}

fn parse_timebase(v: &serde_json::Value) -> f64 {
    // tenta número direto
    if let Some(n) = v.as_f64() {
        if n > 0.0 {
            return n;
        }
    }
    // string "30/1" ou "30000/1001" ou "30"
    if let Some(s) = v.as_str() {
        if let Some((num, den)) = s.split_once('/') {
            if let (Ok(n), Ok(d)) = (num.parse::<f64>(), den.parse::<f64>()) {
                if d > 0.0 {
                    return n / d;
                }
            }
        }
        if let Ok(n) = s.parse::<f64>() {
            if n > 0.0 {
                return n;
            }
        }
    }
    30.0
}

fn extract_tb(json: &serde_json::Value) -> f64 {
    let candidates = [
        json.get("tb"),
        json.get("timebase"),
        json.get("framerate"),
        json.pointer("/timeline/timebase"),
        json.pointer("/timeline/tb"),
        json.pointer("/timeline/framerate"),
    ];
    for c in candidates.iter().flatten() {
        let v = parse_timebase(c);
        if v > 0.0 && v < 10000.0 {
            return v;
        }
    }
    30.0
}

async fn probe_video_timebase(app: &AppHandle, input: &str) -> Option<f64> {
    let output = tool_command(app, "ffprobe")
        .ok()?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate,r_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let tb = parse_timebase(&serde_json::Value::String(line.trim().to_string()));
        if tb > 0.0 && tb < 10000.0 {
            return Some(tb);
        }
    }
    None
}

fn parse_chunks_v1(arr: &[serde_json::Value], tb: f64) -> Vec<CutChunk> {
    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        if let Some(t) = c.as_array() {
            let s = t.first().and_then(|v| v.as_f64()).unwrap_or(0.0) / tb;
            let e = t.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0) / tb;
            let sp = t.get(2).and_then(|v| v.as_f64()).unwrap_or(1.0);
            let kept = sp > 0.0 && sp < 100.0;
            out.push(CutChunk {
                start: s,
                end: e,
                speed: sp,
                kept,
            });
        }
    }
    out
}

fn parse_track_v3(track: &[serde_json::Value], tb: f64) -> Vec<CutChunk> {
    // Cada elemento tem `offset` (origem no source) e `dur` (em frames do source)
    // e `speed`. Reconstruímos o timeline do INPUT a partir das clips do output.
    let mut by_offset: Vec<CutChunk> = Vec::with_capacity(track.len());
    for c in track {
        let off = c.get("offset").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let dur = c
            .get("dur")
            .or_else(|| c.get("duration"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let sp = c.get("speed").and_then(|v| v.as_f64()).unwrap_or(1.0);
        if dur <= 0.0 {
            continue;
        }
        let start = off / tb;
        let end = (off + dur) / tb;
        by_offset.push(CutChunk {
            start,
            end,
            speed: sp,
            kept: sp > 0.0 && sp < 100.0,
        });
    }
    by_offset.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    // Preenche os "gaps" do source que não aparecem no output como cortados.
    let mut filled = Vec::new();
    let mut cursor = 0.0_f64;
    for c in &by_offset {
        if c.start > cursor + 1e-6 {
            filled.push(CutChunk {
                start: cursor,
                end: c.start,
                speed: 99999.0,
                kept: false,
            });
        }
        filled.push(CutChunk {
            start: c.start,
            end: c.end,
            speed: c.speed,
            kept: c.kept,
        });
        cursor = c.end.max(cursor);
    }
    filled
}

/// Extrai picos do áudio (mono 8kHz) e os bucketiza para `buckets` valores 0-255.
fn peaks_from_s16le(bytes: &[u8], buckets: u32) -> Result<Vec<u8>, String> {
    let n_samples = bytes.len() / 2;
    let buckets = buckets.max(1) as usize;
    if n_samples == 0 {
        return Err("nenhuma amostra de áudio extraída".into());
    }

    let mut peaks = Vec::with_capacity(buckets);
    for i in 0..buckets {
        let start = (i * n_samples) / buckets;
        let end = ((i + 1) * n_samples) / buckets;
        let mut peak: u16 = 0;
        for j in start..end {
            let lo = bytes[j * 2];
            let hi = bytes[j * 2 + 1];
            let v = i16::from_le_bytes([lo, hi]);
            let abs = v.unsigned_abs();
            if abs > peak {
                peak = abs;
            }
        }
        peaks.push(((peak as u32 * 255) / 32768).min(255) as u8);
    }

    Ok(peaks)
}

/// Roda um ffmpeg por faixa que decodifica UMA vez e produz duas saídas: o WAV
/// mixável (quando o arquivo tem mais de uma faixa) e os picos em s16le pelo
/// stdout. Antes eram passadas separadas para o proxy e para a onda, cada uma
/// decodificando o arquivo inteiro de novo.
async fn extract_stream_preview(
    app: &AppHandle,
    input: &str,
    stream: u32,
    buckets: u32,
    with_proxy: bool,
) -> Result<AudioStreamPreview, String> {
    let proxy = with_proxy.then(|| unique_temp_path("autocut-audio-proxy", "wav"));

    let mut args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-i".into(),
        input.to_string(),
    ];

    if let Some(path) = proxy.as_ref() {
        args.extend([
            "-map".into(),
            format!("0:a:{stream}"),
            "-vn".into(),
            "-ac".into(),
            "2".into(),
            "-ar".into(),
            "48000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            "-y".into(),
            path.to_string_lossy().to_string(),
        ]);
    }

    args.extend([
        "-map".into(),
        format!("0:a:{stream}"),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        "8000".into(),
        "-f".into(),
        "s16le".into(),
        "-".into(),
    ]);

    let (mut rx, _child) = tool_command(app, "ffmpeg")?
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut bytes: Vec<u8> = Vec::new();
    let mut errs: Vec<u8> = Vec::new();
    let mut exit_code: i32 = -1;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(b) => bytes.extend(b),
            CommandEvent::Stderr(b) => errs.extend(b),
            CommandEvent::Terminated(p) => {
                exit_code = p.code.unwrap_or(-1);
                break;
            }
            _ => {}
        }
    }

    let cleanup = || {
        if let Some(path) = proxy.as_ref() {
            let _ = fs::remove_file(path);
        }
    };

    if exit_code != 0 {
        cleanup();
        return Err(format!(
            "ffmpeg falhou na faixa A{} ({exit_code}): {}",
            stream + 1,
            String::from_utf8_lossy(&errs)
        ));
    }

    let peaks = match peaks_from_s16le(&bytes, buckets) {
        Ok(p) => p,
        Err(e) => {
            cleanup();
            return Err(e);
        }
    };

    Ok(AudioStreamPreview {
        stream,
        name: format!("Audio {}", stream + 1),
        peaks,
        proxy_path: proxy
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

/// Prepara o preview de áudio de todas as faixas de uma vez, em paralelo.
///
/// A onda mixada não vem daqui: o front calcula o máximo entre as faixas ativas,
/// então ligar e desligar faixa não custa nenhum ffmpeg.
#[tauri::command]
async fn extract_audio_previews(
    app: AppHandle,
    input: String,
    buckets: u32,
    audio_streams: Option<u32>,
) -> Result<Vec<AudioStreamPreview>, String> {
    let count = audio_streams.unwrap_or(0);
    if count == 0 {
        return Ok(Vec::new());
    }
    // Com uma faixa só o próprio elemento de vídeo toca o áudio: não há o que
    // mixar, e escrever um WAV do arquivo inteiro seria trabalho jogado fora.
    let with_proxy = count > 1;

    // Três processos por vez: aproveita várias faixas sem transformar um
    // arquivo de dez trilhas em dez ffmpegs disputando o mesmo disco.
    let gate = Arc::new(tokio::sync::Semaphore::new(3));
    let mut handles = Vec::with_capacity(count as usize);
    for stream in 0..count {
        let app = app.clone();
        let input = input.clone();
        let gate = gate.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let _permit = gate.acquire_owned().await.map_err(|e| e.to_string())?;
            extract_stream_preview(&app, &input, stream, buckets, with_proxy).await
        }));
    }

    let mut ready: Vec<AudioStreamPreview> = Vec::with_capacity(handles.len());
    let mut failure: Option<String> = None;
    for handle in handles {
        match handle.await {
            Ok(Ok(preview)) => ready.push(preview),
            Ok(Err(e)) => {
                if failure.is_none() {
                    failure = Some(e);
                }
            }
            Err(e) => {
                if failure.is_none() {
                    failure = Some(e.to_string());
                }
            }
        }
    }

    // Uma faixa que falha invalida o conjunto: meio preview de áudio é pior que
    // nenhum, porque a onda mentiria sobre o que está tocando.
    if let Some(e) = failure {
        for preview in &ready {
            if !preview.proxy_path.is_empty() {
                let _ = fs::remove_file(&preview.proxy_path);
            }
        }
        return Err(e);
    }

    ready.sort_by_key(|p| p.stream);
    Ok(ready)
}

#[tauri::command]
async fn preview_cuts(
    app: AppHandle,
    input: String,
    edit_args: Vec<String>,
) -> Result<CutsTimeline, String> {
    // arquivo temporário para o JSON do timeline
    let tmp_path = unique_temp_path("autocut-preview", "json");

    let mut args: Vec<String> = vec![input.clone()];
    args.extend(edit_args);
    args.push("--export".into());
    args.push("v1".into());
    args.push("-o".into());
    args.push(tmp_path.to_string_lossy().to_string());

    let mut cmd = tool_command(&app, "auto_editor")?.args(args);

    let existing_path = std::env::var("PATH").unwrap_or_default();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let new_path = format!("{};{}", exe_dir.display(), existing_path);
    cmd = cmd.env("PATH", new_path);

    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "auto_editor falhou: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let raw = fs::read_to_string(&tmp_path)
        .map_err(|e| format!("não foi possível ler {}: {}", tmp_path.display(), e))?;
    let _ = fs::remove_file(&tmp_path);

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON inválido: {e}"))?;

    let mut tb = extract_tb(&json);
    if json.get("chunks").is_some()
        && json.get("tb").is_none()
        && json.get("timebase").is_none()
        && json.get("framerate").is_none()
    {
        if let Some(probed_tb) = probe_video_timebase(&app, &input).await {
            tb = probed_tb;
        }
    }

    // tenta formato v1 (chunks no root) e depois v3 (timeline.v[0] / timeline.a[0])
    let chunks: Vec<CutChunk> = if let Some(arr) = json.get("chunks").and_then(|v| v.as_array()) {
        parse_chunks_v1(arr, tb)
    } else if let Some(v_tracks) = json
        .pointer("/timeline/v")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_array())
    {
        parse_track_v3(v_tracks, tb)
    } else if let Some(a_tracks) = json
        .pointer("/timeline/a")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|t| t.as_array())
    {
        parse_track_v3(a_tracks, tb)
    } else {
        return Err(format!(
            "formato JSON não reconhecido (chaves: {:?})",
            json.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        ));
    };

    let mut kept_s: f64 = 0.0;
    let mut cut_s: f64 = 0.0;
    let mut final_s: f64 = 0.0;
    let mut total: f64 = 0.0;
    for c in &chunks {
        let dur = (c.end - c.start).max(0.0);
        total = total.max(c.end);
        if c.kept {
            kept_s += dur;
            if c.speed > 0.0 {
                final_s += dur / c.speed;
            }
        } else {
            cut_s += dur;
        }
    }

    Ok(CutsTimeline {
        duration: total,
        framerate: tb,
        kept_seconds: kept_s,
        cut_seconds: cut_s,
        final_seconds: final_s,
        chunks,
    })
}

/// Instala a versão nova de uma ferramenta. Recusa enquanto uma edição roda:
/// no Windows não se substitui um .exe em uso, e matar o processo no meio do
/// caminho perderia o trabalho já feito.
#[tauri::command]
async fn install_tool_update(
    app: AppHandle,
    state: State<'_, EditorState>,
    id: String,
) -> Result<Vec<ToolStatus>, String> {
    if state.child.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("Termine ou cancele a edição em andamento antes de atualizar.".into());
    }
    tools::install_update(app, id).await
}

#[tauri::command]
async fn restore_bundled_tool(
    app: AppHandle,
    state: State<'_, EditorState>,
    id: String,
) -> Result<Vec<ToolStatus>, String> {
    if state.child.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("Termine ou cancele a edição em andamento antes de restaurar.".into());
    }
    tools::restore_bundled(app, id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Atualização do próprio app: lê o latest.json da última release no
        // GitHub e só aceita instalador assinado com a chave do pubkey.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(EditorState::default())
        .invoke_handler(tauri::generate_handler![
            file_info,
            list_media_files,
            run_editor,
            cancel_editor,
            check_auto_editor,
            probe_file,
            open_in_explorer,
            log_dir,
            path_exists,
            cleanup_temp_file,
            preview_cuts,
            extract_audio_previews,
            tools::tools_status,
            tools::check_tool_updates,
            tools::managed_tools_dir,
            tools::open_external,
            install_tool_update,
            restore_bundled_tool
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar app Tauri");
}
