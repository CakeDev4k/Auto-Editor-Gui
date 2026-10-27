# O que mudou no auto-editor e o que isso significa para o Auto-Cut

Levantamento feito em **15/08/2026**, comparando o que o app usa hoje com as
releases do [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor)
até a **31.5.0** (13/08/2026).

Versões em jogo:

| Onde | Versão |
| --- | --- |
| `src-tauri/binaries/auto_editor-x86_64-pc-windows-msvc.exe` (o que vai no instalador) | **29.3.1** |
| `auto_editor.exe` na raiz do repo | **30.1.6** |
| Última release publicada | **31.5.0** |

O sidecar empacotado está **duas versões maiores atrás**. O updater novo
(ícone de pacote na barra do topo) resolve isso sem precisar rebuildar o
instalador, mas vale trocar o arquivo em `src-tauri/binaries/` também, para que
uma instalação nova já nasça atualizada.

---

## 1. Nada do que o app usa hoje quebrou

Conferi cada argumento que o `buildArgs`/`buildEditOnlyArgs`
([src/runner.ts](src/runner.ts)) monta contra o `--help` da 30.1.6 e contra as
notas de release da 31.x:

- `--edit audio:threshold=…,stream=…` e as expressões `(or audio:… audio:…)` — **ok**
- `--margin` — **ok**
- `--export premiere|resolve|final-cut-pro|shotcut|kdenlive|clip-sequence` — **ok**
- `--export v1` (base do preview de cortes) — **ok**, e a doc reafirma que v1 é
  formato estável e que terceiros podem usá-lo
- `-o/--output` — **ok**

Duas remoções aconteceram no caminho, mas em opções que o app não usa:

- **30.0.0** deixou de aceitar opções com underscore (`--sample_rate`), e
  `--edit audio:mincut=,minclip=` saiu em favor de `--smooth`.
- **31.0.0** removeu o valor `all/e` do `--edit` (agora `all` ou `0`).

**Conclusão: atualizar para a 31.5.0 não exige mudar código.**

---

## 2. O que MERECE atenção: limite de resolução sem licença

Esta é a mudança que muda o resultado na mão do usuário, e ela não aparece como
erro — aparece como um aviso no log.

A partir da 30.0.0 o auto-editor adotou o modelo "FOSSIL" (código aberto +
chave de licença para certos recursos). Os limites atuais, lidos direto de
[`src/license.nim`](https://github.com/WyattBlue/auto-editor/blob/master/src/license.nim)
e [`src/render/format.nim`](https://github.com/WyattBlue/auto-editor/blob/master/src/render/format.nim):

| Situação | Sem chave de licença |
| --- | --- |
| Renderizar arquivo de **uma fonte** acima de **3200×1800** | Reduz sozinho a escala (`--scale 0.75`, etc.) e avisa no stderr |
| Renderizar **múltiplas fontes** acima de 720×576 | Reduz para SD e avisa |
| **Exportar timeline** com múltiplas fontes | Erro, exige chave |
| Ação `add` (overlay) | Erro, exige chave |

O que isso significa aqui:

- **Exportar para Premiere/Resolve/FCP continua livre.** O app processa um
  arquivo por vez, e o portão é só para timeline com múltiplas fontes.
- **Exportar arquivo (`Formato: Arquivo`) a partir de material 4K passa a sair
  em 2880×1620.** O 3840×2160 não cabe no limite de 3200×1800, então o
  auto-editor baixa a escala e segue em frente com um `warning`. O usuário
  recebe o arquivo, só que menor do que pediu — e hoje esse aviso se perde no
  meio do log.

**Sugestão de ajuste** (não implementei porque muda comportamento e é decisão
sua): o `runPreflight` em [src/preflight.ts](src/preflight.ts) já tem
`probe.width`/`probe.height` na mão. Dá para avisar antes de começar:

> "Este arquivo é 3840×2160 e o export é para arquivo. Sem chave de licença do
> auto-editor, a saída sai em 2880×1620."

E se você tiver chave, o auto-editor aceita `-k/--license-key` ou a variável de
ambiente `AE_PRIVATE_LK` — daria para guardar isso numa tela de configurações e
repassar no `buildArgs`.

---

## 3. Recursos novos que valem virar interface

Coisas que hoje não existem no app e que a 31.x entrega de graça:

### Já dá para usar digitando no "Modo avançado"

- **Threshold em dB** (`--edit audio:-19dB`) — unidade que editor de vídeo
  entende, muito mais intuitiva que `0.04`. Seria um botão de alternar unidade
  ao lado do campo Threshold.
- **Região do motion** (31.2.0): `--edit motion:x=0.25:w=0.5` restringe a
  análise a um pedaço do quadro. Útil para ignorar um relógio ou uma tela
  piscando no canto.
- **`blackdetect`** (31.0.0): marca frames majoritariamente pretos. Com
  `(not blackdetect:…)` você corta fade-to-black e "tela morta".
- **Canal nomeado** (31.3.0): `--edit audio:channel=NAME`.

### Precisariam de campo próprio

- **`--export premiere-otio`** (30.3.0): OpenTimelineIO. Diferente do XML FCP7,
  leva `invert`/`hflip`/`vflip` como efeitos nativos para o Premiere. É só
  adicionar a chave em `EXPORTS` no [src/types.ts](src/types.ts) — ele também
  aceita `:name=`, então entra em `NAMED_EXPORTS`.
- **`--transition dissolve:DURAÇÃO[:CORTE-MÍNIMO]`** (31.3.0): dissolve nos
  cortes elegíveis. Aviso: `v1` **não representa transições**, então a
  pré-visualização de cortes do app continuaria mostrando corte seco.
- **Ações por segmento** (`-w:0`/`-w:1`): em vez de só cortar o silêncio, dá
  para acelerá-lo (`-w:0 speed:4`), abaixar o volume, aplicar `pitch` (31.5.0),
  `pixelate` (31.2.0). É a mudança de maior impacto: transformaria o app de
  "cortador de silêncio" em "editor de primeiro passe".
- **`--edit:N` / `--when:N`** (31.0.0): até 255 rótulos, cada um com sua ação.
  Ex.: cortar silêncio **e** acelerar as partes menos altas.
- **`-crf`, `-preset`, `-pix_fmt`, `-g/--gop`**: controles de qualidade da
  saída, hoje inacessíveis pela interface.

### Ganhos automáticos (sem mexer em nada)

- **Rendering parcialmente lossless** (31.4.0) para H.264/HEVC/VP9: GOPs
  inteiros são copiados sem re-encodar. Export de arquivo fica bem mais rápido.
- Correções que afetam direto o que o app exporta: `--export premiere` não
  duplica mais IDs de clipitem nem força mono em par estéreo (30.2.2);
  Kdenlive/ShotCut não somam mais um frame por clipe (31.1.2); vídeo de celular
  em retrato não sai deitado (31.0.0).
- FFmpeg embutido subiu para 9.0.1 (31.5.0).

---

## 4. Um detalhe do preview a vigiar

O `parseProgress` em [src/runner.ts](src/runner.ts) casa `(\w+):\s+(\d+)%\|`, o
formato de barra do tqdm. O auto-editor foi reescrito em Nim na série 29 e mexeu
na barra de progresso pelo menos duas vezes desde então ("Fix progress bars
sometimes not clearing correctly", 30.3.0; "Fix wrong progress bar total",
31.1.0). O regex tem fallback para o `time=` do ffmpeg, então o pior caso é a
barra ficar parada — não quebra a edição. Vale conferir com um arquivo real
depois de atualizar; se mudou, existe `--progress` para escolher o formato.

---

## 5. Onde os créditos aparecem agora

O botão de informação na barra do topo abre a tela "Sobre", que credita:

- **auto-editor**, de WyattBlue, com link para o repositório e para
  auto-editor.com, e a nota de que o repositório está em domínio público
  (Unlicense) enquanto os binários das releases seguem as licenças dos projetos
  que embutem;
- **FFmpeg** e os builds "essentials" do gyan.dev;
- **Tauri**.

A versão em uso de cada um é lida do próprio binário e mostrada ali.
