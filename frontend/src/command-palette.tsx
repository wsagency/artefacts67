import { createEffect, createMemo, createSignal, For } from 'solid-js';
import { Dialog } from './ui';

export type CommandEntry = {
  id: string;
  label: string;
  detail?: string;
  group: 'Commands' | 'Folders' | 'Artefacts';
  onSelect: () => void;
};

let nextPaletteId = 0;

export function CommandPalette(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: CommandEntry[];
  context?: string;
}) {
  const id = `command-palette-${++nextPaletteId}`;
  const [query, setQuery] = createSignal('');
  const [activeIndex, setActiveIndex] = createSignal(0);
  let input!: HTMLInputElement;
  let selecting = false;

  const matches = createMemo(() => {
    const terms = query().toLowerCase().trim().split(/\s+/).filter(Boolean);
    const groups: Record<CommandEntry['group'], CommandEntry[]> = {
      Commands: [], Folders: [], Artefacts: [],
    };
    for (const entry of props.entries) {
      const text = (entry.group === 'Commands' ? entry.label : `${entry.label} ${entry.detail ?? ''} ${entry.group}`).toLowerCase();
      if (terms.every(term => text.includes(term))) groups[entry.group].push(entry);
    }
    if (terms.length) {
      const exact = terms.join(' ');
      groups.Commands.sort((left, right) => Number(right.label.toLowerCase() === exact) - Number(left.label.toLowerCase() === exact));
    }
    const entries = [...groups.Commands, ...groups.Folders, ...groups.Artefacts];
    return entries.map((entry, index) => ({
      entry, index, startsGroup: index === 0 || entries[index - 1]?.group !== entry.group,
    }));
  });
  const selectedIndex = createMemo(() => matches().length ? Math.min(activeIndex(), matches().length - 1) : -1);

  createEffect(() => props.open, open => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    selecting = false;
    queueMicrotask(() => { if (props.open) input.focus(); });
  });
  createEffect(() => matches(), rows => {
    setActiveIndex(index => rows.length ? Math.min(index, rows.length - 1) : 0);
  });
  createEffect(() => ({ open: props.open, index: selectedIndex(), rows: matches() }), ({ open, index }) => {
    if (open && index >= 0) document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  });

  const select = (index: number) => {
    const row = matches()[index];
    if (!props.open || selecting || !row) return;
    selecting = true;
    props.onOpenChange(false);
    row.entry.onSelect();
  };

  return <Dialog title="Search and commands" open={props.open} onOpenChange={props.onOpenChange}>
    <div class="command-palette">
      {props.context && <p class="command-context">In {props.context}</p>}
      <input ref={input} class="command-search" type="search" autofocus autocomplete="off"
        role="combobox" aria-label="Search folders, artefacts and commands" aria-autocomplete="list"
        aria-expanded={props.open ? 'true' : 'false'} aria-controls={`${id}-results`}
        aria-activedescendant={selectedIndex() >= 0 ? `${id}-option-${selectedIndex()}` : undefined}
        aria-describedby={`${id}-hint`} value={query()}
        onInput={event => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
        onKeyDown={event => {
          if (event.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const count = matches().length;
            if (count) setActiveIndex((selectedIndex() + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            select(selectedIndex());
          }
        }} />
      <div id={`${id}-results`} class="command-results" role="listbox" aria-label="Commands and navigation results">
        <For each={matches()}>{row => <>
          {row.startsGroup && <div class="command-group" role="presentation">{row.entry.group}</div>}
          <button type="button" id={`${id}-option-${row.index}`} class="command-result" role="option" tabindex={-1}
            aria-selected={selectedIndex() === row.index ? 'true' : 'false'}
            aria-label={`${row.entry.label}${row.entry.detail ? ` — ${row.entry.detail}` : ''}`}
            onPointerDown={event => event.preventDefault()} onClick={() => select(row.index)}>
            <span>{row.entry.label}</span>{row.entry.detail && <small>{row.entry.detail}</small>}
          </button>
        </>}</For>
      </div>
      {!matches().length && <p class="command-empty" role="status">No matching folders, artefacts or commands.</p>}
      <p id={`${id}-hint`} class="command-hint">↑ ↓ to choose · Enter to open · Esc to close</p>
    </div>
  </Dialog>;
}
