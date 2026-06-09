import type { BoardTask, ProviderId } from '../../../shared/types.js';
import { addTask, updateTask, getBoard, addTag, getTagColor } from '../../board-state.js';
import { showModal, closeModal, setModalError, registerModalCleanup, type FieldDef } from '../modal.js';
import { createCustomSelect, type CustomSelectInstance } from '../custom-select.js';
import { createPlanModeRow } from '../../dom-utils.js';
import { findInvalidEnvLines } from '../../../shared/env-vars.js';
import {
  getAvailableProviderMetas,
  getProviderCapabilities,
  loadProviderAvailability,
} from '../../provider-availability.js';
import { appState } from '../../state.js';
import { runTask } from './board-card.js';

/**
 * Known model options per provider, used to populate the task Model dropdown.
 * The empty value means "provider default" (no `--model` flag passed). Providers
 * absent from this map show no Model picker. `--model <value>` is universal across
 * the supported CLIs, so adding a provider here is just listing its model ids.
 */
const CUSTOM_MODEL = '__custom__';
const MODEL_OPTIONS: Partial<Record<ProviderId, { value: string; label: string }[]>> = {
  claude: [
    { value: '', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
    { value: CUSTOM_MODEL, label: 'Custom…' },
  ],
};

export interface TaskModalPrefill {
  title?: string;
  prompt?: string;
  notes?: string;
  tags?: string[];
}

export function showTaskModal(
  mode: 'create' | 'edit',
  task?: BoardTask,
  defaultColumnId?: string,
  prefill?: TaskModalPrefill,
): void {
  const board = getBoard();
  if (!board) return;

  const columnOptions = [...board.columns]
    .sort((a, b) => a.order - b.order)
    .map(c => ({ value: c.id, label: c.title }));

  const fields: FieldDef[] = [
    {
      label: 'Title',
      id: 'taskTitle',
      placeholder: 'Task title',
      defaultValue: task?.title ?? prefill?.title ?? '',
    },
    {
      label: 'Prompt',
      id: 'prompt',
      type: 'textarea',
      placeholder: 'Instructions for Claude...',
      defaultValue: task?.prompt ?? prefill?.prompt ?? '',
      rows: 4,
      maxLength: 10000,
    },
    {
      label: 'Notes',
      id: 'notes',
      type: 'textarea',
      placeholder: 'Context, reasoning, acceptance criteria...',
      defaultValue: task?.notes ?? prefill?.notes ?? '',
      rows: 3,
    },
    {
      label: 'Environment Variables',
      id: 'envVars',
      type: 'textarea',
      placeholder: 'KEY=VALUE (one per line)\ne.g. ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic\nANTHROPIC_API_KEY=sk-...',
      defaultValue: task?.envVars ?? '',
      rows: 3,
    },
  ];

  if (mode === 'edit') {
    fields.push({
      label: 'Column',
      id: 'columnId',
      type: 'select',
      options: columnOptions,
      defaultValue: task?.columnId ?? defaultColumnId ?? board.columns[0]?.id,
    });
  }

  const title = mode === 'create' ? 'New Task' : 'Edit Task';

  const confirmLabel = mode === 'create' ? 'Create' : 'Update';

  const currentTags: string[] = [...(task?.tags ?? prefill?.tags ?? [])];

  let currentProviderId: ProviderId =
    task?.providerId
    ?? appState.preferences.defaultProvider
    ?? 'claude';
  let currentModel: string = task?.model ?? '';
  const initialPlanMode = task?.planMode ?? (mode === 'create');
  const { row: planModeRow, checkbox: planModeCheckbox } =
    createPlanModeRow('Plan mode', initialPlanMode);

  showModal(title, fields, (values) => {
    const prompt = values.prompt?.trim() ?? '';
    const taskTitle = values.taskTitle?.trim() ?? '';

    if (!taskTitle) {
      setModalError('taskTitle', 'Title is required');
      return;
    }

    const notes = values.notes?.trim() ?? '';

    const envVars = values.envVars?.trim() || undefined;
    if (envVars) {
      const invalid = findInvalidEnvLines(envVars);
      if (invalid.length > 0) {
        setModalError('envVars', `Invalid line(s): ${invalid.join(', ')}. Use KEY=VALUE.`);
        return;
      }
    }

    // Ensure all tags are in the palette (assigns colors)
    for (const t of currentTags) addTag(t);

    const planMode = planModeCheckbox.checked;

    if (mode === 'create') {
      const targetColumnId = defaultColumnId ?? board.columns.find(c => c.behavior === 'inbox')?.id ?? board.columns[0]?.id;
      addTask({
        title: taskTitle,
        prompt,
        notes: notes || undefined,
        columnId: targetColumnId,
        tags: currentTags.length > 0 ? currentTags : undefined,
        providerId: currentProviderId,
        model: currentModel || undefined,
        envVars,
        planMode,
      });
    } else if (task) {
      updateTask(task.id, {
        title: taskTitle,
        prompt,
        notes: notes || undefined,
        tags: currentTags.length > 0 ? currentTags : undefined,
        providerId: currentProviderId,
        model: currentModel || undefined,
        envVars,
        planMode,
        ...(values.columnId ? { columnId: values.columnId } : {}),
      });
    }

    closeModal();
  }, { confirmLabel });

  // Inject tags UI into modal (after Notes; before Column field in edit mode)
  const modalBody = document.getElementById('modal-body')!;
  const columnField = modalBody.querySelector('#modal-columnId')?.closest('.modal-field');

  const tagFieldDiv = document.createElement('div');
  tagFieldDiv.className = 'modal-field';

  const tagLabel = document.createElement('label');
  tagLabel.textContent = 'Tags';
  tagFieldDiv.appendChild(tagLabel);

  // Current tags as removable pills
  const tagPillsContainer = document.createElement('div');
  tagPillsContainer.className = 'modal-tag-pills';

  function renderModalTags(): void {
    tagPillsContainer.innerHTML = '';
    for (const tagName of currentTags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill modal-tag-pill';
      pill.dataset.color = getTagColor(tagName);
      pill.textContent = tagName;

      const removeBtn = document.createElement('span');
      removeBtn.className = 'modal-tag-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', () => {
        const idx = currentTags.indexOf(tagName);
        if (idx >= 0) currentTags.splice(idx, 1);
        renderModalTags();
      });
      pill.appendChild(removeBtn);
      tagPillsContainer.appendChild(pill);
    }
  }
  renderModalTags();
  tagFieldDiv.appendChild(tagPillsContainer);

  // Tag input with autocomplete
  const tagInputWrapper = document.createElement('div');
  tagInputWrapper.className = 'modal-tag-input-wrapper';
  tagInputWrapper.style.position = 'relative';

  const tagInput = document.createElement('input');
  tagInput.className = 'board-modal-tag-input';
  tagInput.placeholder = 'Add tag...';

  const autocompleteList = document.createElement('div');
  autocompleteList.className = 'tag-autocomplete';

  tagInput.addEventListener('input', () => {
    const val = tagInput.value.toLowerCase().trim();
    autocompleteList.innerHTML = '';
    if (!val) { autocompleteList.style.display = 'none'; return; }

    const boardTags = board.tags ?? [];
    const matches = boardTags.filter(t =>
      t.name.includes(val) && !currentTags.includes(t.name)
    );

    if (matches.length === 0) { autocompleteList.style.display = 'none'; return; }

    autocompleteList.style.display = 'block';
    for (const match of matches.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'tag-autocomplete-item';
      item.textContent = match.name;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        currentTags.push(match.name);
        tagInput.value = '';
        autocompleteList.style.display = 'none';
        renderModalTags();
      });
      autocompleteList.appendChild(item);
    }
  });

  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = tagInput.value.toLowerCase().trim();
      if (val && !currentTags.includes(val)) {
        addTag(val); // Register in palette immediately so it gets a color
        currentTags.push(val);
        tagInput.value = '';
        autocompleteList.style.display = 'none';
        renderModalTags();
      }
    }
  });

  tagInput.addEventListener('blur', () => {
    setTimeout(() => { autocompleteList.style.display = 'none'; }, 150);
  });

  tagInput.addEventListener('focus', () => tagInput.dispatchEvent(new Event('input')));

  tagInputWrapper.appendChild(tagInput);
  tagInputWrapper.appendChild(autocompleteList);
  tagFieldDiv.appendChild(tagInputWrapper);

  if (columnField) {
    modalBody.insertBefore(tagFieldDiv, columnField);
  } else {
    modalBody.appendChild(tagFieldDiv);
  }

  // Provider dropdown
  const providerFieldDiv = document.createElement('div');
  providerFieldDiv.className = 'modal-field';
  const providerLabel = document.createElement('label');
  providerLabel.textContent = 'Provider';
  providerFieldDiv.appendChild(providerLabel);

  const buildProviderOptions = () =>
    getAvailableProviderMetas().map(p => ({ value: p.id, label: p.displayName }));

  function refreshPlanModeAvailability(): void {
    const caps = getProviderCapabilities(currentProviderId);
    const supported = !!caps?.planModeArg;
    planModeCheckbox.disabled = !supported;
    if (!supported) planModeCheckbox.checked = false;
    planModeRow.title = supported ? '' : 'Provider does not support plan mode';
  }

  const onProviderChange = (value: string) => {
    currentProviderId = value as ProviderId;
    refreshPlanModeAvailability();
    refreshModelField();
  };

  const initialProviderOptions = buildProviderOptions();
  let providerSelect: CustomSelectInstance = createCustomSelect(
    'taskProvider',
    initialProviderOptions.length > 0
      ? initialProviderOptions
      : [{ value: currentProviderId, label: 'Loading…' }],
    currentProviderId,
    onProviderChange,
  );
  providerFieldDiv.appendChild(providerSelect.element);
  registerModalCleanup(() => providerSelect.destroy());

  // Model dropdown — passes `--model <value>` to the CLI on launch. Provider-aware:
  // only shown for providers with known model options (see MODEL_OPTIONS).
  const modelFieldDiv = document.createElement('div');
  modelFieldDiv.className = 'modal-field';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';
  modelFieldDiv.appendChild(modelLabel);
  let modelSelect: CustomSelectInstance | undefined;
  registerModalCleanup(() => modelSelect?.destroy());

  // Free-text input revealed when "Custom…" is picked (e.g. deepseek-chat).
  const modelCustomInput = document.createElement('input');
  modelCustomInput.type = 'text';
  modelCustomInput.id = 'modal-taskModelCustom';
  modelCustomInput.placeholder = 'Custom model id, e.g. deepseek-chat';
  modelCustomInput.style.marginTop = '6px';
  modelCustomInput.addEventListener('input', () => { currentModel = modelCustomInput.value.trim(); });

  function refreshModelField(): void {
    const options = MODEL_OPTIONS[currentProviderId];
    modelSelect?.destroy();
    modelFieldDiv.querySelector('.custom-select')?.remove();
    if (!options) {
      modelFieldDiv.style.display = 'none';
      modelCustomInput.style.display = 'none';
      currentModel = '';
      return;
    }
    modelFieldDiv.style.display = '';
    // A model that isn't one of the presets is treated as a custom value.
    const presetValues = options.map(o => o.value).filter(v => v !== CUSTOM_MODEL);
    const isCustom = !!currentModel && !presetValues.includes(currentModel);
    const selected = isCustom ? CUSTOM_MODEL : currentModel;
    modelCustomInput.value = isCustom ? currentModel : '';
    modelCustomInput.style.display = isCustom ? '' : 'none';
    modelSelect = createCustomSelect(
      'taskModel',
      options,
      selected,
      (value) => {
        if (value === CUSTOM_MODEL) {
          modelCustomInput.style.display = '';
          currentModel = modelCustomInput.value.trim();
          modelCustomInput.focus();
        } else {
          modelCustomInput.style.display = 'none';
          currentModel = value;
        }
      },
    );
    modelFieldDiv.appendChild(modelSelect.element);
    modelFieldDiv.appendChild(modelCustomInput);
  }

  const planModeFieldDiv = document.createElement('div');
  planModeFieldDiv.className = 'modal-field modal-field-checkbox';
  planModeFieldDiv.appendChild(planModeRow);

  refreshPlanModeAvailability();
  refreshModelField();

  if (columnField) {
    modalBody.insertBefore(providerFieldDiv, columnField);
    modalBody.insertBefore(modelFieldDiv, columnField);
    modalBody.insertBefore(planModeFieldDiv, columnField);
  } else {
    modalBody.appendChild(providerFieldDiv);
    modalBody.appendChild(modelFieldDiv);
    modalBody.appendChild(planModeFieldDiv);
  }

  if (initialProviderOptions.length === 0) {
    loadProviderAvailability().then(() => {
      if (!providerFieldDiv.isConnected) return;
      const opts = buildProviderOptions();
      if (opts.length === 0) return;
      providerSelect.destroy();
      providerSelect = createCustomSelect('taskProvider', opts, currentProviderId, onProviderChange);
      providerFieldDiv.querySelector('.custom-select')?.remove();
      providerFieldDiv.appendChild(providerSelect.element);
    });
  }

  // Add Run/Resume button in edit mode
  const footer = document.getElementById('modal-actions') as HTMLElement;
  if (footer) {
    footer.querySelectorAll('.board-modal-run-btn').forEach(el => el.remove());

    if (mode === 'edit' && task) {
      const runBtn = document.createElement('button');
      runBtn.className = 'board-modal-run-btn';
      const hasActiveSession = !!task.sessionId;
      const canResume = !hasActiveSession && !!task.cliSessionId;
      runBtn.textContent = hasActiveSession ? 'Focus Session' : canResume ? 'Resume' : 'Run';
      runBtn.addEventListener('click', () => {
        // Save current edits before running
        const prompt = (document.getElementById('modal-prompt') as HTMLTextAreaElement)?.value?.trim() ?? '';
        const taskTitle = (document.getElementById('modal-taskTitle') as HTMLInputElement)?.value?.trim() ?? '';
        const notes = (document.getElementById('modal-notes') as HTMLTextAreaElement)?.value?.trim() ?? '';
        const envVars = (document.getElementById('modal-envVars') as HTMLTextAreaElement)?.value?.trim() || undefined;
        const columnId = (document.getElementById('modal-columnId') as HTMLInputElement)?.value;

        if (envVars) {
          const invalid = findInvalidEnvLines(envVars);
          if (invalid.length > 0) {
            setModalError('envVars', `Invalid line(s): ${invalid.join(', ')}. Use KEY=VALUE.`);
            return;
          }
        }

        for (const t of currentTags) addTag(t);
        const planMode = planModeCheckbox.checked;
        updateTask(task.id, {
          title: taskTitle || task.title,
          prompt: prompt || task.prompt,
          notes: notes || undefined,
          tags: currentTags.length > 0 ? currentTags : undefined,
          providerId: currentProviderId,
          model: currentModel || undefined,
          envVars,
          planMode,
          ...(columnId ? { columnId } : {}),
        });

        closeModal();
        runTask({ ...task, envVars, model: currentModel || undefined, providerId: currentProviderId, planMode });
      });
      footer.insertBefore(runBtn, footer.firstChild);
      registerModalCleanup(() => runBtn.remove());
    }
  }
}
