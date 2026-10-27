import { getIcon } from "./icons";
import { getBrandLogo } from "./logos";

/**
 * Dropdown próprio.
 *
 * O `<select>` nativo não desenha ícone nem descrição dentro das opções — o
 * navegador renderiza aquela lista com o widget do sistema, e nada de CSS entra
 * lá. Como as opções aqui precisam mostrar o que cada modo faz, e não só o
 * nome, o jeito é desenhar a lista.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Nome de um ícone de `icons.ts`. */
  icon?: string;
  /** Nome de um logo de marca em `logos.ts`. Tem prioridade sobre `icon`. */
  logo?: string;
  /** Uma linha explicando o que a opção faz. */
  hint?: string;
}

/** Logo da marca quando houver; senão o ícone genérico. */
function markFor(option: SelectOption, size: number): string {
  if (option.logo) {
    const logo = getBrandLogo(option.logo, size);
    if (logo) return logo;
  }
  return option.icon ? getIcon(option.icon, size) : "";
}

export interface SelectHandle {
  el: HTMLDivElement;
  value: string;
  setValue: (value: string, notify?: boolean) => void;
  setDisabled: (disabled: boolean) => void;
}

interface SelectConfig {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Vira o `aria-label` do gatilho. */
  label?: string;
  id?: string;
}

/** Fecha qualquer dropdown aberto antes de abrir outro. */
let openSelect: (() => void) | null = null;

export function createSelect(config: SelectConfig): SelectHandle {
  const { options, onChange } = config;

  const el = document.createElement("div");
  el.className = "select";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  if (config.label) trigger.setAttribute("aria-label", config.label);
  if (config.id) trigger.id = config.id;

  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  el.appendChild(trigger);
  el.appendChild(menu);

  let current = config.value;
  let highlighted = 0;
  let isOpen = false;

  const optionButtons: HTMLButtonElement[] = options.map((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "select-option";
    button.setAttribute("role", "option");
    button.dataset.value = option.value;
    button.innerHTML = `
      <span class="select-option-icon">${markFor(option, 17)}</span>
      <span class="select-option-text">
        <span class="select-option-label"></span>
        ${option.hint ? `<span class="select-option-hint"></span>` : ""}
      </span>
      <span class="select-option-check">${getIcon("check", 13)}</span>
    `;
    // textContent e não innerHTML: nome de timeline e afins são texto do usuário.
    button.querySelector(".select-option-label")!.textContent = option.label;
    const hintEl = button.querySelector(".select-option-hint");
    if (hintEl && option.hint) hintEl.textContent = option.hint;

    // Fecha antes de avisar: o `onChange` dispara o trabalho da tela, e se ele
    // falhar a lista não pode ficar aberta por cima do que o usuário escolheu.
    button.addEventListener("click", () => {
      close();
      trigger.focus();
      setValue(option.value, true);
    });
    button.addEventListener("mousemove", () => setHighlighted(index));
    menu.appendChild(button);
    return button;
  });

  function optionFor(value: string): SelectOption | undefined {
    return options.find((o) => o.value === value);
  }

  function renderTrigger() {
    const option = optionFor(current) ?? options[0];
    trigger.innerHTML = `
      <span class="select-value-icon">${option ? markFor(option, 16) : ""}</span>
      <span class="select-value-label"></span>
      <span class="select-chevron">${getIcon("chevron", 14)}</span>
    `;
    trigger.querySelector(".select-value-label")!.textContent = option?.label ?? "";
  }

  function renderSelection() {
    optionButtons.forEach((button) => {
      const selected = button.dataset.value === current;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  }

  function setHighlighted(index: number) {
    highlighted = Math.max(0, Math.min(options.length - 1, index));
    optionButtons.forEach((button, i) => {
      button.classList.toggle("is-active", i === highlighted);
    });
    optionButtons[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    if (isOpen || trigger.disabled) return;
    openSelect?.();
    openSelect = close;
    isOpen = true;
    menu.hidden = false;
    el.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");

    // Abre para cima quando não cabe embaixo: o painel rola, e uma lista que
    // sai pela borda inferior fica cortada em vez de rolar junto.
    const room = window.innerHeight - trigger.getBoundingClientRect().bottom;
    el.classList.toggle("drops-up", room < menu.offsetHeight + 16);

    setHighlighted(Math.max(0, options.findIndex((o) => o.value === current)));
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    el.classList.remove("is-open", "drops-up");
    trigger.setAttribute("aria-expanded", "false");
    if (openSelect === close) openSelect = null;
  }

  function setValue(value: string, notify = false) {
    if (!optionFor(value)) return;
    const changed = value !== current;
    current = value;
    renderTrigger();
    renderSelection();
    if (changed && notify) onChange(value);
  }

  trigger.addEventListener("click", () => (isOpen ? close() : open()));

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      if (!isOpen) {
        e.preventDefault();
        open();
      }
    }
  });

  el.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        trigger.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        setHighlighted(highlighted + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted(highlighted - 1);
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(0);
        break;
      case "End":
        e.preventDefault();
        setHighlighted(options.length - 1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const chosen = options[highlighted].value;
        close();
        trigger.focus();
        setValue(chosen, true);
        break;
      }
    }
  });

  // `mousedown` e não `click`: fechar já no apertar evita que o clique de fora
  // caia num elemento que a lista tinha coberto.
  document.addEventListener("mousedown", (e) => {
    if (isOpen && !el.contains(e.target as Node)) close();
  });

  el.addEventListener("focusout", () => {
    // Espera o foco assentar: sair de uma opção para outra passa por "nada".
    window.setTimeout(() => {
      if (isOpen && !el.contains(document.activeElement)) close();
    }, 0);
  });

  renderTrigger();
  renderSelection();

  return {
    el,
    get value() {
      return current;
    },
    setValue,
    setDisabled(disabled: boolean) {
      trigger.disabled = disabled;
      if (disabled) close();
    },
  };
}
