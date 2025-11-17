import PyInstaller.__main__
import os
import sys

def build_executable():
    """Cria o executável usando PyInstaller"""
    # Caminho do script principal
    script_path = 'autocutgui.py'  # Ajuste se o nome for diferente
    # Nome do executável
    exe_name = 'AutoEditorGUI'
    # Caminho para auto_editor.exe (deve estar na pasta atual)
    auto_editor_exe = 'auto_editor.exe'
    if not os.path.exists(auto_editor_exe):
        print(f"❌ {auto_editor_exe} não encontrado na pasta atual!")
        print("📦 Coloque o auto_editor.exe ao lado deste build.py antes de rodar.")
        sys.exit(1)
    # Pasta FFmpeg (deve existir com estrutura 'ffmpeg/bin/ffmpeg.exe')
    ffmpeg_folder = 'ffmpeg'
    ffmpeg_bin = '.'
    required_files = ['ffmpeg.exe', 'ffprobe.exe']  # ffplay opcional
    for file in required_files:
        if not os.path.exists(os.path.join(ffmpeg_bin, file)):
            print(f"❌ {file} não encontrado em {ffmpeg_bin}!")
            print("📦 Crie a pasta 'ffmpeg/bin' contendo ffmpeg.exe, ffprobe.exe e DLLs.")
            sys.exit(1)
    # Ícone opcional
    icon_path = 'icon.ico' if os.path.exists('icon.ico') else None
    # Argumentos do PyInstaller
    args = [
        script_path,
        '--name=' + exe_name,
        '--onefile',          # Arquivo único
        '--windowed',         # Sem console (GUI)
        '--clean',            # Limpa cache
        '--noconfirm',        # Não pede confirmação
        '--debug=imports',    # Temporário: útil para testar paths internos
        # Bundlear ffmpeg, ffprobe e ffplay (se existir)
        f'--add-binary=ffmpeg.exe;.',
        f'--add-binary=ffprobe.exe;.',
        f'--add-binary=ffplay.exe;.',


        f'--add-binary={auto_editor_exe};.',
    ]
    # Incluir ícone e outros recursos, se existirem
    if icon_path:
        args.append(f'--icon={icon_path}')
    if os.path.exists('icon.png'):
        args.append('--add-data=icon.png;.')
    # Remover argumentos vazios
    args = [arg for arg in args if arg]
    print("🚀 Iniciando build do executável...")
    print(f"📦 Empacotando script: {script_path}")
    print(f"📝 Nome: {exe_name}.exe")
    print(f"🔗 Incluindo: {auto_editor_exe}")
    print(f"🎞️ Incluindo: ffmpeg/bin/ (ffmpeg.exe, ffprobe.exe, DLLs)")
    print("="*55)
    try:
        PyInstaller.__main__.run(args)
        print("\n" + "="*55)
        print("✅ Build concluído com sucesso!")
        print(f"📁 Executável criado em: dist/{exe_name}.exe")
        print("\n💡 Instruções:")
        print("   1. Vá para a pasta 'dist'")
        print(f"   2. Execute {exe_name}.exe")
        print("   3. Tudo incluso: Python, Auto-Editor e FFmpeg!")
        print("\n🐞 Para depurar, rode pelo CMD e veja mensagens do PyInstaller.")
        print("⚠️ Se ver 'missing module', adicione --hidden-import=NOME no build.py.")
        print("="*55)
    except Exception as e:
        print(f"\n❌ Erro durante o build: {e}")
        sys.exit(1)

if __name__ == '__main__':
    try:
        import PyInstaller
    except ImportError:
        print("❌ PyInstaller não encontrado! Instalando...")
        os.system(f"{sys.executable} -m pip install pyinstaller")
        import PyInstaller
    build_executable()