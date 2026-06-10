import { appState } from '../../state.js';
import { getBoard, getColumnByBehavior, batchAddTasks, TAG_COLORS } from '../../board-state.js';
import { createCustomSelect } from '../custom-select.js';

export interface ParsedTask {
  title: string;
  section: string;
  done: boolean;
}

const DONE_STATUS_EMOJI = /^[✅☑]/u;
const ANY_STATUS_EMOJI  = /^[✅☑⬜🟡🚧⏳⛔❌]/u;
// single-word status labels used in legend lines like "- ⬜ pending"
const LEGEND_WORDS = new Set(['pending', 'done', 'in-progress', 'blocked', 'complete', 'completed', 'todo', 'wip']);

function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').trim();
}

function cleanPlanTitle(text: string): string {
  return stripMarkdown(
    text
      .replace(/\s*—\s*\*\*Model:.*$/iu, '') // strip — **Model: X** annotation
      .replace(/\s*\(DONE[^)]*\)/gi, '')       // strip (DONE 2026-...) suffixes
  );
}

/**
 * Parse a markdown plan into tasks. Recognizes three task syntaxes:
 *   - GitHub checkboxes:        `- [ ] task` / `- [x] task`
 *   - emoji-status headers:     `#### ⬜ Phase` / `#### ✅ Phase`
 *   - emoji-status bullets:     `- ⬜ task` / `- ✅ task`
 * `done` marks completed items (✅/☑ or `[x]`) so callers can filter them.
 *
 * Splitting on /\r?\n/ (not '\n') is essential: CRLF files would otherwise leave
 * a trailing \r on every line, and JS `$` does not match before \r — which would
 * make every `$`-anchored pattern below fail and the whole file parse as empty.
 */
export function parsePlan(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let currentSection = '';
  for (const line of content.split(/\r?\n/)) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      const headerText = headerMatch[1].trim();
      if (ANY_STATUS_EMOJI.test(headerText)) {
        // Emoji-status header is a leaf task tagged with its parent (plain-header)
        // section. It intentionally does NOT become the section for following
        // siblings — otherwise sibling phases would tag each other.
        const titleRaw = headerText.replace(/^[✅☑⬜🟡🚧⏳⛔❌]\s*/u, '');
        const title = cleanPlanTitle(titleRaw);
        if (title) tasks.push({ title, section: currentSection, done: DONE_STATUS_EMOJI.test(headerText) });
      } else {
        currentSection = stripMarkdown(headerText);
      }
      continue;
    }
    // Emoji-status bullets: "- ⬜ task title" / "- ✅ done item"
    const emojiBullet = line.match(/^\s*-\s+([✅☑⬜🟡🚧⏳⛔❌])\s+(.+)$/u);
    if (emojiBullet) {
      const text = emojiBullet[2].trim();
      if (LEGEND_WORDS.has(text.toLowerCase())) continue; // skip legend lines
      tasks.push({ title: stripMarkdown(text), section: currentSection, done: DONE_STATUS_EMOJI.test(emojiBullet[1]) });
      continue;
    }
    // Standard GitHub-style checkboxes
    const unchecked = line.match(/^\s*-\s+\[\s?\]\s+(.+)$/);
    if (unchecked) {
      tasks.push({ title: stripMarkdown(unchecked[1]), section: currentSection, done: false });
      continue;
    }
    const checked = line.match(/^\s*-\s+\[x\]\s+(.+)$/i);
    if (checked) {
      tasks.push({ title: stripMarkdown(checked[1]), section: currentSection, done: true });
    }
  }
  return tasks;
}

function visibleTasks(all: ParsedTask[], skipChecked: boolean): ParsedTask[] {
  return skipChecked ? all.filter(t => !t.done) : all;
}

/**
 * Rank a candidate file so the modal can auto-select the most plausible plan
 * without the user picking. A file is only auto-selectable if it has open tasks.
 * Among those we prefer plan-ish filenames, then genuine progress trackers
 * (files that also contain *completed* items — a prompt template or a flat
 * roadmap list has none), then raw open-task count as a tiebreak.
 */
export function planScore(name: string, tasks: ParsedTask[]): number {
  const open = tasks.filter(t => !t.done).length;
  if (open === 0) return -1; // nothing to import → never auto-selected
  const done = tasks.length - open;
  const isPlanName = /progress|plan|todo|tasks|roadmap/.test(name.toLowerCase());
  return (isPlanName ? 1000 : 0) + (done > 0 ? 500 : 0) + open;
}

export async function showImportPlanModal(): Promise<void> {
  const project = appState.activeProject;
  if (!project) return;

  let parsedTasks: ParsedTask[] = [];
  let allTasks: ParsedTask[] = []; // unfiltered tasks for the selected file
  let skipChecked = true;
  let fileSelect: ReturnType<typeof createCustomSelect> | null = null;
  // Parsed tasks per file path, populated once during the initial scan so
  // switching files / toggling "skip completed" never re-reads from disk.
  const tasksByPath = new Map<string, ParsedTask[]>();

  const overlay = document.createElement('div');
  overlay.className = 'board-import-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'board-import-dialog';

  const headerEl = document.createElement('div');
  headerEl.className = 'board-import-header';

  const titleEl = document.createElement('h3');
  titleEl.className = 'board-import-title';
  titleEl.textContent = 'Import from plan';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'board-import-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close');

  headerEl.appendChild(titleEl);
  headerEl.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'board-import-body';

  const fileField = document.createElement('div');
  fileField.className = 'board-import-field';

  const fileLabel = document.createElement('label');
  fileLabel.className = 'board-import-label';
  fileLabel.textContent = 'Plan file';

  const fileSelectWrap = document.createElement('div');

  fileField.appendChild(fileLabel);
  fileField.appendChild(fileSelectWrap);

  const optRow = document.createElement('label');
  optRow.className = 'board-import-option';

  const skipCb = document.createElement('input');
  skipCb.type = 'checkbox';
  skipCb.checked = true;

  optRow.appendChild(skipCb);
  optRow.appendChild(document.createTextNode(' Skip completed items'));

  const preview = document.createElement('div');
  preview.className = 'board-import-preview';

  body.appendChild(fileField);
  body.appendChild(optRow);
  body.appendChild(preview);

  const footer = document.createElement('div');
  footer.className = 'board-import-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';

  const importBtn = document.createElement('button');
  importBtn.className = 'btn-primary';
  importBtn.textContent = 'Import';
  importBtn.disabled = true;

  footer.appendChild(cancelBtn);
  footer.appendChild(importBtn);

  dialog.appendChild(headerEl);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  function close(): void {
    document.removeEventListener('keydown', onKeyDown);
    fileSelect?.destroy();
    overlay.remove();
  }

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKeyDown);

  function updateImportBtn(): void {
    if (parsedTasks.length === 0) {
      importBtn.disabled = true;
      importBtn.textContent = 'Import';
    } else {
      importBtn.disabled = false;
      importBtn.textContent = `Import ${parsedTasks.length} task${parsedTasks.length === 1 ? '' : 's'}`;
    }
  }

  function setMessage(text: string): void {
    preview.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'board-import-empty';
    el.textContent = text;
    preview.appendChild(el);
  }

  function renderPreview(): void {
    if (parsedTasks.length === 0) {
      setMessage(skipChecked ? 'No unchecked tasks found in this file.' : 'No tasks found in this file.');
      updateImportBtn();
      return;
    }

    updateImportBtn();
    preview.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'board-import-list';

    const sections = new Map<string, string[]>();
    for (const task of parsedTasks) {
      const key = task.section;
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key)!.push(task.title);
    }

    for (const [section, titles] of sections) {
      if (section) {
        const secEl = document.createElement('div');
        secEl.className = 'board-import-section-header';
        secEl.textContent = section;
        list.appendChild(secEl);
      }
      for (const title of titles) {
        const item = document.createElement('div');
        item.className = 'board-import-item';
        item.textContent = title;
        list.appendChild(item);
      }
    }

    preview.appendChild(list);
  }

  function selectFile(filePath: string): void {
    allTasks = tasksByPath.get(filePath) ?? [];
    parsedTasks = visibleTasks(allTasks, skipChecked);
    renderPreview();
  }

  skipCb.addEventListener('change', () => {
    skipChecked = skipCb.checked;
    parsedTasks = visibleTasks(allTasks, skipChecked);
    renderPreview();
  });

  importBtn.addEventListener('click', () => {
    if (parsedTasks.length === 0) return;

    const board = getBoard();
    const column = getColumnByBehavior('inbox') ?? board?.columns[0];
    if (!board || !column) return;

    // Skip tasks whose title is already on the board so re-importing is idempotent.
    const existing = new Set(board.tasks.map(t => (t.title || '').toLowerCase().trim()));
    const toImport = parsedTasks.filter(t => !existing.has(t.title.toLowerCase().trim()));
    if (toImport.length === 0) {
      close();
      return;
    }

    // Add new tags directly (no notifyBoardChanged per tag) — batchAddTasks emits the single notification.
    if (!board.tags) board.tags = [];
    for (const section of toImport.map(t => t.section).filter(Boolean)) {
      const normalized = section.toLowerCase().trim();
      if (!board.tags.some(t => t.name === normalized)) {
        board.tags.push({ name: normalized, color: TAG_COLORS[board.tags.length % TAG_COLORS.length] });
      }
    }

    batchAddTasks(toImport.map(t => ({
      title: t.title,
      prompt: t.title,
      columnId: column.id,
      tags: t.section ? [t.section.toLowerCase().trim()] : undefined,
    })));

    close();
  });

  setMessage('Scanning plan files…');
  document.body.appendChild(overlay);

  // Read & parse every root-level markdown file once, then auto-select the
  // richest plan. This is what makes detection automatic: the user does not
  // have to know which file holds the tasks.
  const dirEntries = await window.vibeyard.fs.listDir(project.path);
  const mdFiles = dirEntries.filter(e => !e.isDirectory && e.name.toLowerCase().endsWith('.md'));

  if (mdFiles.length === 0) {
    fileField.style.display = 'none';
    setMessage('No markdown files found in the project root.');
    return;
  }

  const scans = await Promise.all(mdFiles.map(async (f) => {
    try {
      const r = await window.vibeyard.fs.readFile(f.path);
      const tasks = r.ok ? parsePlan(r.content) : [];
      return { file: f, tasks };
    } catch {
      return { file: f, tasks: [] as ParsedTask[] };
    }
  }));

  if (!overlay.isConnected) return; // modal closed while scanning

  for (const s of scans) tasksByPath.set(s.file.path, s.tasks);

  scans.sort((a, b) => {
    const sd = planScore(b.file.name, b.tasks) - planScore(a.file.name, a.tasks);
    return sd !== 0 ? sd : a.file.name.localeCompare(b.file.name);
  });

  const options = scans.map((s) => {
    const open = s.tasks.filter(t => !t.done).length;
    return { value: s.file.path, label: open > 0 ? `${s.file.name} (${open})` : s.file.name };
  });

  fileSelect = createCustomSelect('board-import-file-select', options, options[0].value, (val) => {
    selectFile(val);
  });
  fileSelectWrap.appendChild(fileSelect.element);
  selectFile(options[0].value);
}
