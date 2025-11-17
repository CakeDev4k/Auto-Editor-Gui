import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
import subprocess
import os
import sys
import threading
import locale

# Configurar codificação UTF-8 para evitar erros de charmap
if sys.platform == 'win32':
    try:
        # Força UTF-8 no Windows
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except:
        pass

# Config FFmpeg pro .exe (essencial! - igual ao código fornecido)
if getattr(sys, 'frozen', False):
    try:
        base_dir = sys._MEIPASS
    except AttributeError:
        base_dir = os.path.dirname(sys.executable)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

ffmpeg_dir = base_dir

# Garantir que ffmpeg.exe existe
ffmpeg_exe = os.path.join(ffmpeg_dir, 'ffmpeg.exe')
if not os.path.exists(ffmpeg_exe):
    print(f"⚠️ ffmpeg.exe não encontrado em: {ffmpeg_exe}")


class AutoEditorGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Auto-Editor GUI: threshold editor")
        self.root.geometry("650x650")
        self.root.minsize(650, 650)
        self.root.configure(bg="#0d1117")
         
        # Define o ícone da interface (PNG ou ICO)
        try:
            icon_path = os.path.join(os.path.dirname(__file__), "icon.png")  # coloque seu arquivo .png ou .ico
            if os.path.exists(icon_path):
                icon_image = tk.PhotoImage(file=icon_path)
                self.root.iconphoto(True, icon_image)
            else:
                print("⚠️ Ícone não encontrado, usando padrão.")
        except Exception as e:
            print(f"Erro ao carregar ícone: {e}")
         
        # Cores do tema escuro moderno (GitHub Dark)
        self.colors = {
            'bg': '#0d1117',
            'frame_bg': '#161b22',
            'primary': '#21262d',
            'secondary': '#58a6ff',
            'success': '#3fb950',
            'warning': '#d29922',
            'accent': '#f85149',
            'light': '#30363d',
            'dark': '#010409',
            'text': '#c9d1d9',
            'text_secondary': '#8b949e',
            'entry_bg': '#0d1117',
            'entry_fg': '#c9d1d9',
            'border': '#30363d',
            'hover': '#1f6feb'
        }
         
        # Variáveis
        self.input_file = tk.StringVar()
        self.edit_mode = tk.StringVar(value="🔊 Audio (silêncio)")
        self.margin = tk.StringVar(value="0.2sec")
        self.threshold = tk.StringVar(value="0.02")
        self.advanced_var = tk.BooleanVar(value=False)
        self.edit_expression = tk.StringVar(value="(or audio:stream=0 audio:threshold=10%,stream=1)")
        self.export_format = tk.StringVar(value="Adobe Premiere Pro")
        self.timeline_name = tk.StringVar(value="Auto-Editor Media Group")
        self.is_processing = False
         
        # Path para o auto_editor.exe (será resolvido em runtime)
        self.auto_editor_exe = os.path.join(base_dir, 'auto_editor.exe')
        if self.auto_editor_exe is None:
            self.auto_editor_exe = ""  # Fallback para evitar NoneType
        
        # FFmpeg dir global (igual ao código fornecido)
        self.ffmpeg_dir = ffmpeg_dir
        if not os.path.exists(self.ffmpeg_dir):
            print(f"⚠️ FFmpeg dir não encontrado em: {self.ffmpeg_dir}")
            print("Certifique-se de que a pasta 'ffmpeg/bin' está bundled no .exe.")
        
        if not os.path.exists(self.auto_editor_exe):
            print(f"⚠️ auto_editor.exe não encontrado em: {self.auto_editor_exe}")
            print("Certifique-se de que está ao lado do script ou bundled no .exe.")
         
        self.setup_ui()
        self.apply_hover_effects()
   
    # Config FFmpeg pro .exe (essencial)
    if getattr(sys, 'frozen', False):
        try:
            base_dir = sys._MEIPASS
        except AttributeError:
            base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))

    # FFmpeg agora está ao lado do código (sem subpastas)
    ffmpeg_dir = base_dir

    # Garantir que ffmpeg.exe existe
    ffmpeg_exe = os.path.join(ffmpeg_dir, 'ffmpeg.exe')
    if not os.path.exists(ffmpeg_exe):
        print(f"⚠️ ffmpeg.exe não encontrado em: {ffmpeg_exe}")


    

    def create_rounded_button(self, parent, text, command, bg_color, **kwargs):
        """Cria um botão estilizado"""
        btn = tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg_color,
            fg="white",
            font=("Segoe UI", 9, "bold"),
            relief=tk.FLAT,
            padx=15,
            pady=8,
            cursor="hand2",
            activebackground=self.colors['hover'],
            activeforeground="white",
            borderwidth=0,
            **kwargs
        )
        return btn
   
    def setup_ui(self):
        # Configurar scrollbar personalizada
        style = ttk.Style()
        style.theme_use('clam')
         
        # Container principal com padding reduzido
        main_container = tk.Frame(self.root, bg=self.colors['bg'], padx=15, pady=10)
        main_container.pack(fill=tk.BOTH, expand=True)
         
        # Frame para arquivo de entrada com card design
        file_card = self.create_card(main_container, "📁 Arquivo de Entrada")
        file_card.pack(fill=tk.X, pady=(0, 10))
         
        file_entry_frame = tk.Frame(file_card, bg=self.colors['frame_bg'])
        file_entry_frame.pack(fill=tk.X, pady=5, padx=10)
         
        entry_container = tk.Frame(file_entry_frame, bg=self.colors['entry_bg'],
                                  highlightbackground=self.colors['border'],
                                  highlightthickness=1)
        entry_container.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 10))
         
        self.file_entry = tk.Entry(
            entry_container,
            textvariable=self.input_file,
            font=("Segoe UI", 9),
            relief=tk.FLAT,
            bg=self.colors['entry_bg'],
            fg=self.colors['entry_fg'],
            insertbackground=self.colors['text'],
            borderwidth=0
        )
        self.file_entry.pack(fill=tk.BOTH, expand=True, padx=10, pady=6)
         
        select_btn = self.create_rounded_button(
            file_entry_frame,
            "📂 Selecionar",
            self.select_file,
            self.colors['secondary']
        )
        select_btn.pack(side=tk.RIGHT)
         
        # Informação do arquivo (novo)
        self.file_info_label = tk.Label(
            file_card,
            text="Nenhum arquivo selecionado",
            font=("Segoe UI", 8),
            bg=self.colors['frame_bg'],
            fg=self.colors['text_secondary'],
            anchor=tk.W
        )
        self.file_info_label.pack(fill=tk.X, padx=10, pady=(0, 5))
         
        # Card de opções de edição
        options_card = self.create_card(main_container, "⚙️ Configurações de Edição")
        options_card.pack(fill=tk.X, pady=(0, 10))
         
        options_inner = tk.Frame(options_card, bg=self.colors['frame_bg'], padx=10, pady=5)
        options_inner.pack(fill=tk.X)
         
        # Checkbox para modo avançado (movido para o topo)
        advanced_frame = tk.Frame(options_inner, bg=self.colors['frame_bg'])
        advanced_frame.pack(fill=tk.X, pady=(0, 10))
         
        self.advanced_cb = tk.Checkbutton(
            advanced_frame,
            text="🔧 Modo Avançado",
            variable=self.advanced_var,
            command=self.toggle_advanced,
            bg=self.colors['frame_bg'],
            fg=self.colors['text'],
            selectcolor=self.colors['primary'],
            font=("Segoe UI", 9, "bold"),
            activebackground=self.colors['frame_bg'],
            activeforeground=self.colors['text'],
            cursor="hand2"
        )
        self.advanced_cb.pack(anchor=tk.W)
         
        # Separador visual
        separator = tk.Frame(options_inner, bg=self.colors['border'], height=1)
        separator.pack(fill=tk.X, pady=5)
         
        # Frame para modo simples
        self.simple_frame = tk.Frame(options_inner, bg=self.colors['frame_bg'])
        self.simple_frame.pack(fill=tk.X)
         
        # Grid layout para margem e threshold lado a lado
        margin_threshold_grid = tk.Frame(self.simple_frame, bg=self.colors['frame_bg'])
        margin_threshold_grid.pack(fill=tk.X, pady=2)
         
        # Margem
        margin_frame = tk.Frame(margin_threshold_grid, bg=self.colors['frame_bg'])
        margin_frame.grid(row=0, column=0, sticky="ew", padx=(0, 5))
         
        tk.Label(
            margin_frame,
            text="Margem (Padding)",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        margin_container = tk.Frame(margin_frame, bg=self.colors['entry_bg'],
                                   highlightbackground=self.colors['border'],
                                   highlightthickness=1)
        margin_container.pack(fill=tk.X)
         
        margin_entry = tk.Entry(
            margin_container,
            textvariable=self.margin,
            font=("Segoe UI", 9),
            relief=tk.FLAT,
            bg=self.colors['entry_bg'],
            fg=self.colors['entry_fg'],
            insertbackground=self.colors['text'],
            borderwidth=0
        )
        margin_entry.pack(fill=tk.X, padx=10, pady=6)
         
        # Threshold
        threshold_frame = tk.Frame(margin_threshold_grid, bg=self.colors['frame_bg'])
        threshold_frame.grid(row=0, column=1, sticky="ew", padx=(5, 0))
         
        tk.Label(
            threshold_frame,
            text="Threshold",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        threshold_container = tk.Frame(threshold_frame, bg=self.colors['entry_bg'],
                                      highlightbackground=self.colors['border'],
                                      highlightthickness=1)
        threshold_container.pack(fill=tk.X)
         
        self.threshold_entry = tk.Entry(
            threshold_container,
            textvariable=self.threshold,
            font=("Segoe UI", 9),
            relief=tk.FLAT,
            bg=self.colors['entry_bg'],
            fg=self.colors['entry_fg'],
            insertbackground=self.colors['text'],
            borderwidth=0
        )
        self.threshold_entry.pack(fill=tk.X, padx=10, pady=6)
         
        # Configurar grid weight para margem/threshold
        margin_threshold_grid.columnconfigure(0, weight=1)
        margin_threshold_grid.columnconfigure(1, weight=1)
         
        # Modo abaixo
        mode_frame = tk.Frame(self.simple_frame, bg=self.colors['frame_bg'])
        mode_frame.pack(fill=tk.X, pady=2)
         
        tk.Label(
            mode_frame,
            text="Modo",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        self.mode_options = {
            "🔊 Audio (silêncio)": "audio",
            "🎥 Motion (movimento)": "motion",
            "Padrão": "none"
        }
         
        # Estilizar Combobox
        style.configure('Custom.TCombobox',
                       fieldbackground=self.colors['entry_bg'],
                       background=self.colors['primary'],
                       foreground=self.colors['entry_fg'],
                       borderwidth=1,
                       relief=tk.SOLID,
                       arrowcolor=self.colors['text'],
                       bordercolor=self.colors['border'])
        style.map('Custom.TCombobox',
                 fieldbackground=[('readonly', self.colors['entry_bg'])],
                 selectbackground=[('readonly', self.colors['secondary'])],
                 selectforeground=[('readonly', 'white')])
         
        self.mode_combo = ttk.Combobox(
            mode_frame,
            textvariable=self.edit_mode,
            values=list(self.mode_options.keys()),
            state="readonly",
            font=("Segoe UI", 9),
            style='Custom.TCombobox'
        )
        self.mode_combo.pack(fill=tk.X)
        self.mode_combo.bind('<<ComboboxSelected>>', self.on_mode_change)
         
        # Frame avançado (inicialmente oculto)
        self.advanced_frame = tk.Frame(options_inner, bg=self.colors['frame_bg'])
         
        tk.Label(
            self.advanced_frame,
            text="Expressão Customizada",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        expr_container = tk.Frame(self.advanced_frame, bg=self.colors['entry_bg'],
                                 highlightbackground=self.colors['border'],
                                 highlightthickness=1)
        expr_container.pack(fill=tk.X, pady=(0, 2))
         
        expr_entry = tk.Entry(
            expr_container,
            textvariable=self.edit_expression,
            font=("Segoe UI", 9),
            relief=tk.FLAT,
            bg=self.colors['entry_bg'],
            fg=self.colors['entry_fg'],
            insertbackground=self.colors['text'],
            borderwidth=0
        )
        expr_entry.pack(fill=tk.X, padx=10, pady=6)
         
        # Card de exportação (compacto)
        export_card = self.create_card(main_container, "📤 Exportar")
        export_card.pack(fill=tk.X, pady=(0, 10))
         
        export_inner = tk.Frame(export_card, bg=self.colors['frame_bg'], padx=10, pady=5)
        export_inner.pack(fill=tk.X)
         
        tk.Label(
            export_inner,
            text="Formato",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        self.export_options = {
            "Arquivo": "none",
            "Adobe Premiere Pro": "premiere",
            "DaVinci Resolve": "resolve",
            "Final Cut Pro": "final-cut-pro",
            "ShotCut": "shotcut",
            "Kdenlive": "kdenlive",
            "Clip Sequence": "clip-sequence"
        }
         
        export_combo = ttk.Combobox(
            export_inner,
            textvariable=self.export_format,
            values=list(self.export_options.keys()),
            state="readonly",
            font=("Segoe UI", 9),
            style='Custom.TCombobox'
        )
        export_combo.pack(fill=tk.X, pady=(0, 5))
         
        # Timeline name (compacto)
        tk.Label(
            export_inner,
            text="Nome da Timeline",
            font=("Segoe UI", 9, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text']
        ).pack(anchor=tk.W, pady=(0, 2))
         
        timeline_container = tk.Frame(export_inner, bg=self.colors['entry_bg'],
                                     highlightbackground=self.colors['border'],
                                     highlightthickness=1)
        timeline_container.pack(fill=tk.X, pady=(0, 2))
         
        timeline_entry = tk.Entry(
            timeline_container,
            textvariable=self.timeline_name,
            font=("Segoe UI", 9),
            relief=tk.FLAT,
            bg=self.colors['entry_bg'],
            fg=self.colors['entry_fg'],
            insertbackground=self.colors['text'],
            borderwidth=0
        )
        timeline_entry.pack(fill=tk.X, padx=10, pady=6)
         
        # Botão de editar (grande e destacado)
        btn_frame = tk.Frame(main_container, bg=self.colors['bg'])
        btn_frame.pack(pady=10)
         
        self.edit_btn = self.create_rounded_button(
            btn_frame,
            "▶️ Iniciar Edição",
            self.run_editor,
            self.colors['success']
        )
        self.edit_btn.config(font=("Segoe UI", 10, "bold"), padx=30, pady=10)
        self.edit_btn.pack()
         
        # Card de output (compacto)
        output_card = self.create_card(main_container, "📊 Log")
        output_card.pack(fill=tk.BOTH, expand=True)
         
        output_inner = tk.Frame(output_card, bg=self.colors['frame_bg'], padx=10, pady=5)
        output_inner.pack(fill=tk.BOTH, expand=True)
         
        # Output text com scroll
        output_container = tk.Frame(output_inner, bg=self.colors['dark'],
                                   highlightbackground=self.colors['border'],
                                   highlightthickness=1)
        output_container.pack(fill=tk.BOTH, expand=True)
         
        self.output_text = scrolledtext.ScrolledText(
            output_container,
            font=("Consolas", 8),
            height=8,
            bg=self.colors['dark'],
            fg=self.colors['text'],
            insertbackground=self.colors['text'],
            relief=tk.FLAT,
            borderwidth=0,
            padx=8,
            pady=8,
            wrap=tk.WORD
        )
        self.output_text.pack(fill=tk.BOTH, expand=True)
         
        # Tags de cor para output
        self.output_text.tag_config("success", foreground=self.colors['success'], font=("Consolas", 8, "bold"))
        self.output_text.tag_config("error", foreground=self.colors['accent'], font=("Consolas", 8, "bold"))
        self.output_text.tag_config("info", foreground=self.colors['secondary'])
        self.output_text.tag_config("command", foreground=self.colors['warning'])
        self.output_text.tag_config("warning", foreground=self.colors['warning'])
         
        # Mensagem inicial
        self.log_output("🚀 GUI inicializado", "info")
        self.log_output(f"📁 Auto-Editor .exe: {os.path.basename(self.auto_editor_exe) if self.auto_editor_exe else 'N/A'}", "info")
        self.log_output(f"🎬 FFmpeg dir: {self.ffmpeg_dir}", "info")
        self.log_output("Selecione um arquivo\n", "info")
   
    def create_card(self, parent, title):
        """Cria um card estilizado"""
        card = tk.LabelFrame(
            parent,
            text=f" {title} ",
            font=("Segoe UI", 10, "bold"),
            bg=self.colors['frame_bg'],
            fg=self.colors['text'],
            relief=tk.FLAT,
            borderwidth=2,
            highlightbackground=self.colors['border'],
            highlightthickness=1
        )
        return card
   
    def apply_hover_effects(self):
        """Aplica efeitos de hover nos botões"""
        def on_enter(e, btn, color):
            btn['background'] = color
       
        def on_leave(e, btn, color):
            btn['background'] = color
       
        # Aplicar aos botões quando forem criados (exemplo para edit_btn)
        if hasattr(self, 'edit_btn'):
            self.edit_btn.bind("<Enter>", lambda e: on_enter(e, self.edit_btn, self.colors['hover']))
            self.edit_btn.bind("<Leave>", lambda e: on_leave(e, self.edit_btn, self.colors['success']))
   
    def toggle_advanced(self):
        """Alterna entre modo simples e avançado"""
        if self.advanced_var.get():
            self.simple_frame.pack_forget()
            self.advanced_frame.pack(fill=tk.X, pady=(5, 0))
            self.log_output("🔧 Avançado ativado", "info")
        else:
            self.advanced_frame.pack_forget()
            self.simple_frame.pack(fill=tk.X)
            self.log_output("🔧 Simples ativado", "info")
   
    def on_mode_change(self, event):
        """Atualiza o threshold padrão baseado no modo"""
        if self.advanced_var.get():
            return
        mode_display = self.edit_mode.get()
        if "Audio" in mode_display:
            self.threshold.set("0.04")
        elif "Motion" in mode_display:
            self.threshold.set("0.02")
   
    def select_file(self):
        file_path = filedialog.askopenfilename(
            title="Selecione o arquivo de vídeo ou áudio",
            filetypes=[
                ("Todos os suportados", "*.mp4 *.mov *.avi *.wav *.mp3 *.mkv *.flv *.wmv *.m4a"),
                ("Vídeos", "*.mp4 *.mov *.avi *.mkv *.flv *.wmv"),
                ("Áudios", "*.wav *.mp3 *.m4a"),
                ("Todos os arquivos", "*.*")
            ]
        )
        if file_path:
            self.input_file.set(file_path)
            # Atualizar info do arquivo
            filename = os.path.basename(file_path)
            size_mb = os.path.getsize(file_path) / (1024 * 1024)
            self.file_info_label.config(
                text=f"📄 {filename} ({size_mb:.2f} MB)",
                fg=self.colors['text']
            )
            self.log_output(f"✅ {filename}", "success")
   
    def update_status(self, text, color):
        """Atualiza o status na UI"""
        self.root.update()
   
    def log_output(self, message, tag=""):
        """Adiciona mensagem ao log"""
        timestamp = ""  # Pode adicionar timestamp se quiser
        self.output_text.insert(tk.END, f"{message}\n", tag)
        self.output_text.see(tk.END)
        self.root.update()
   
    def run_editor(self):
        if self.is_processing:
            messagebox.showwarning("Aviso", "Já existe um processamento em andamento!")
            return
         
        input_file = self.input_file.get().strip()
        if not input_file or not os.path.exists(input_file):
            messagebox.showerror("Erro", "Por favor, selecione um arquivo válido!")
            return
         
        # Verifica se o .exe existe agora
        if not self.auto_editor_exe or not os.path.exists(self.auto_editor_exe):
            messagebox.showerror("Erro", f"auto_editor.exe não encontrado em: {self.auto_editor_exe}\n\nCertifique-se de que está bundled ou ao lado do script.")
            return
         
        # Monta argumentos (sem o nome do comando, pois será passado ao .exe)
        args = [input_file]
         
        if self.advanced_var.get():
            expr = self.edit_expression.get().strip()
            if expr:
                args.extend(["--edit", expr])
            else:
                messagebox.showwarning("Aviso", "Forneça uma expressão válida no modo avançado!")
                return
        else:
            mode_display = self.edit_mode.get()
            mode_value = self.mode_options.get(mode_display, "audio")
           
            if mode_value != "none":
                threshold_val = self.threshold.get().strip()
                if threshold_val:
                    mode_arg = f"{mode_value}:threshold={threshold_val}"
                else:
                    mode_arg = mode_value
                args.extend(["--edit", mode_arg])
         
        if self.margin.get().strip():
            args.extend(["--margin", self.margin.get()])
         
        export_display = self.export_format.get()
        export_format = self.export_options.get(export_display, "none")
         
        if export_format != "none":
            export_value = export_format
           
            if export_format in ["premiere", "resolve", "final-cut-pro"]:
                timeline_name = self.timeline_name.get().strip()
                if timeline_name:
                    export_value = f'{export_format}:name="{timeline_name}"'
           
            args.extend(["--export", export_value])
         
        self.log_output("\n" + "="*40, "info")
        self.log_output(f"🚀 Comando: {os.path.basename(self.auto_editor_exe)} {' '.join(args)}", "command")
        self.log_output(f"🔧 FFmpeg: {self.ffmpeg_dir}", "info")
        self.log_output("="*40 + "\n", "info")
         
        # Desabilitar botão durante processamento
        self.edit_btn.config(state=tk.DISABLED, text="⏳ Processando...")
        self.is_processing = True
        self.update_status("Processando...", self.colors['warning'])
         
        thread = threading.Thread(target=self._run_editor_thread, args=(args, input_file), daemon=True)
        thread.start()
   
    def _run_editor_thread(self, args, input_file):
        """Executa o auto-editor .exe em thread separada com FFmpeg integrado e teste de debug"""
        success = False
        process = None
        try:
            # Comando: [path_to_exe] + args
            cmd = [self.auto_editor_exe] + args
           
            # Detectar codificação do sistema
            system_encoding = locale.getpreferredencoding()
           
            # CWD seguro
            cwd = os.path.dirname(input_file) if input_file else None
           
            # Configurar ambiente com PATH incluindo dir do FFmpeg (igual ao código fornecido)
            env = os.environ.copy()
            env['PATH'] = self.ffmpeg_dir + os.pathsep + env.get('PATH', '')
            self.log_output(f"🔧 PATH atualizado com FFmpeg: {self.ffmpeg_dir} (PATH inicia: {env['PATH'][:100]}...)", "info")
           
            # Tentar modo text primeiro para evitar bloqueio em readline
            try:
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=1,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    cwd=cwd,
                    env=env
                )
            except UnicodeDecodeError:
                # Fallback para encoding do sistema
                self.log_output(f"⚠️ Tentando com codificação {system_encoding}...", "warning")
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=1,
                    text=True,
                    encoding=system_encoding,
                    errors='replace',
                    cwd=cwd,
                    env=env
                )
            except Exception as enc_err:
                # Fallback para modo binário se text falhar
                self.log_output(f"⚠️ Modo text falhou: {enc_err}. Usando binário.", "warning")
                process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    bufsize=1,
                    cwd=cwd,
                    env=env
                )
           
            if process is None:
                raise ValueError("Falha ao iniciar processo")
           
            # Ler output com check de poll para evitar travamento (melhorado para FFmpeg)
            encodings_to_try = ['utf-8', system_encoding, 'cp1252', 'latin-1', 'iso-8859-1']
           
            while True:
                if process.poll() is not None:
                    break  # Processo terminou, sai do loop
               
                try:
                    line = process.stdout.readline()
                    if not line:
                        break
                except Exception:
                    line = b''
               
                if isinstance(line, bytes):
                    decoded = None
                    for enc in encodings_to_try:
                        try:
                            decoded = line.decode(enc)
                            break
                        except UnicodeDecodeError:
                            continue
                    if decoded is None:
                        decoded = line.decode('utf-8', errors='replace')
                    line_stripped = decoded.strip()
                else:
                    line_stripped = line.strip()
               
                if line_stripped:
                    # Parsing melhorado para erros comuns do FFmpeg/auto-editor
                    lower_line = line_stripped.lower()
                    if any(word in lower_line for word in ["error", "erro", "ffmpeg error", "frame=0", "lsize=0kb", "bitrate=n/a"]):
                        self.log_output(line_stripped, "error")
                    elif any(word in lower_line for word in ["success", "concluído", "done"]):
                        self.log_output(line_stripped, "success")
                    elif any(word in lower_line for word in ["warning", "aviso", "ffmpeg"]):
                        self.log_output(line_stripped, "warning")
                    else:
                        self.log_output(line_stripped, "info")
           
            # Espera final e fecha
            if process:
                returncode = process.wait(timeout=10)  # Aumentado para 10s
                process.stdout.close()
           
            if returncode == 0:
                success = True
                self.log_output("\n" + "="*40, "info")
                self.log_output("✅ Edição concluída!", "success")
                self.log_output("📁 Arquivo salvo como 'input_edited.ext'", "success")
                self.log_output("="*40, "info")
               
                self.root.after(0, lambda: messagebox.showinfo("Sucesso! 🎉",
                    "Edição finalizada com sucesso!\n\nO arquivo editado foi salvo no mesmo diretório do arquivo original."))
            else:
                self.log_output(f"\n❌ Processo finalizado com código de erro: {returncode}", "error")
                self.log_output("💡 Possíveis causas: FFmpeg falhou (ver teste acima), arquivo inválido ou args errados. Rode com --debug para mais info.", "warning")
                success = False
               
        except subprocess.TimeoutExpired:
            self.log_output("⚠️ Timeout no wait do processo. Forçando término.", "warning")
            if process:
                process.kill()
                process.wait()
        except FileNotFoundError:
            error_msg = f"❌ {self.auto_editor_exe} não pode ser executado!"
            self.log_output(error_msg, "error")
            success = False
        except Exception as e:
            error_msg = str(e)
            self.log_output(f"\n❌ ERRO CRÍTICO: {error_msg}", "error")
            success = False
        finally:
            self.is_processing = False
            self.root.after(0, lambda: self.edit_btn.config(state=tk.NORMAL, text="▶️ Iniciar Edição"))


if __name__ == "__main__":
    root = tk.Tk()
    app = AutoEditorGUI(root)
    root.mainloop()