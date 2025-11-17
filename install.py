import os
import urllib.request
import shutil
from pathlib import Path

def download_file(url, destino):
    if not Path(destino).exists():
        print(f"Baixando {os.path.basename(destino)}...")
        urllib.request.urlretrieve(url, destino)
        if destino.endswith(".zip"):
            import zipfile
            with zipfile.ZipFile(destino, 'r') as zip_ref:
                zip_ref.extractall(".")
            os.remove(destino)

# FFmpeg mais recente (versão estática para Windows 64-bit)
ffmpeg_url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
download_file(ffmpeg_url, "ffmpeg.zip")

# Auto-editor (versão mais recente do GitHub)
autoeditor_url = "https://github.com/WyattBlue/auto-editor/releases/latest/download/auto-editor_windows_amd64.exe"
download_file(autoeditor_url, "auto-editor.exe")
shutil.move("auto-editor_windows_amd64.exe", "auto-editor.exe")  # renomeia se necessário