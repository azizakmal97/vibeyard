import { appState } from '../../state.js';
import { getBoard, getColumnByBehavior, batchAddTasks, TAG_COLORS } from '../../board-state.js';
import { createCustomSelect } from '../custom-select.js';

interface ParsedTask {
  title: string;
  section: string;
}

function parsePlan(content: string, skipChecked: boolean): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let currentSection = '';
  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim();
      continue;
    }
    const unchecked = line.match(/^\s*-\s+\[\s?\]\s+(.+)$/);
    if (unchecked) {
      tasks.push({ title: unchecked[1].trim(), section: currentSection });
      continue;
    }
    if (!skipChecked) {
      const checked = line.match(/^\s*-\s+\[x\]\s+(.+)$/i);
      if (checked) tasks.push({ title: checked[1].trim(), section: currentSection });
    }
  }
  return tasks;
}

export async function showImportPlanModal(): Promise<void> {
  const project = appState.activeProject;
  if (!project) return;

  const dirEntries = await window.vibeyard.fs.listDir(project.path);
  const mdFiles = dirEntries
    .filter(e => !e.isDirectory && e.name.endsWith('.md'))
    .sort((a, b) => {
      const priority = (name: string) => {
        const l = name.toLowerCase();
        if (l === 'progress.md') return 0;
        if (['plan.md', 'todo.md', 'tasks.md'].includes(l)) return 1;
        return 2;
      };
      const pd = priority(a.name) - priority(b.name);
      return pd !== 0 ? pd : a.name.localeCompare(b.name);
    });

  let parsedTasks: ParsedTask[] = [];
  let skipChecked = true;
  let fileSelect: ReturnType<typeof createCustomSelect> | null = null;
  let loadGeneration = 0;

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

  function renderPreview(): void {
    preview.innerHTML = '';
    if (parsedTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'board-import-empty';
      empty.textContent = skipChecked
        ? 'No unchecked tasks found in this file.'
        : 'No tasks found in this file.';
      preview.appendChild(empty);
      updateImportBtn();
      return;
    }

    updateImportBtn();

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

  async function loadFile(filePath: string): Promise<void> {
    const gen = ++loadGeneration;
    preview.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'board-import-empty';
    loading.textContent = 'Loading…';
    preview.appendChild(loading);
    importBtn.disabled = true;

    const result = await window.vibeyard.fs.readFile(filePath);
    if (gen !== loadGeneration) return; // stale result from a superseded load
    if (!result.ok) {
      preview.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'board-import-empty';
      err.textContent = 'Failed to read file.';
      preview.appendChild(err);
      return;
    }

    parsedTasks = parsePlan(result.content, skipChecked);
    renderPreview();
  }

  skipCb.addEventListener('change', () => {
    skipChecked = skipCb.checked;
    if (fileSelect) loadFile(fileSelect.getValue());
  });

  if (mdFiles.length === 0) {
    fileField.style.display = 'none';
    const empty = document.createElement('div');
    empty.className = 'board-import-empty';
    empty.textContent = 'No markdown files found in the project root.';
    preview.appendChild(empty);
  } else {
    const options = mdFiles.map(f => ({ value: f.path, label: f.name }));
    fileSelect = createCustomSelect('board-import-file-select', options, options[0].value, (val) => {
      loadFile(val);
    });
    fileSelectWrap.appendChild(fileSelect.element);
    loadFile(options[0].value);
  }

  importBtn.addEventListener('click', () => {
    if (parsedTasks.length === 0) return;

    const board = getBoard();
    const column = getColumnByBehavior('inbox') ?? board?.columns[0];
    if (!board || !column) return;

    // Add new tags directly (no notifyBoardChanged per tag) — batchAddTasks emits the single notification.
    if (!board.tags) board.tags = [];
    for (const section of parsedTasks.map(t => t.section).filter(Boolean)) {
      const normalized = section.toLowerCase().trim();
      if (!board.tags.some(t => t.name === normalized)) {
        board.tags.push({ name: normalized, color: TAG_COLORS[board.tags.length % TAG_COLORS.length] });
      }
    }

    batchAddTasks(parsedTasks.map(t => ({
      title: t.title,
      prompt: t.title,
      columnId: column.id,
      tags: t.section ? [t.section.toLowerCase().trim()] : undefined,
    })));

    close();
  });

  document.body.appendChild(overlay);
}
