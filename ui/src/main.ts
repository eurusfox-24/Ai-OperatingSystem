import { RobotCanvasVisualizer } from './visualizer/robot_canvas';
import { SocketClient } from './socket';
import { initI18n, setLanguage, getLanguage, t } from './i18n';

const AUTH_TOKEN_KEY = 'ai_os_access_token';

// Intercept fetch to automatically prepend backend host when running from file://
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  let url = input;
  if (typeof url === 'string' && url.startsWith('/api') && window.location.protocol === 'file:') {
    url = 'http://127.0.0.1:8000' + url;
  }
  const target = typeof url === 'string' ? url : url instanceof Request ? url.url : String(url);
  const isApiRequest = target.startsWith('/api') || target.startsWith('http://127.0.0.1:8000/api');
  const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (isApiRequest && token) {
    const headers = new Headers(init?.headers || (url instanceof Request ? url.headers : undefined));
    headers.set('Authorization', `Bearer ${token}`);
    init = { ...init, headers };
  }
  const response = await originalFetch(url, init);
  if (
    response.status === 401
    && token
    && sessionStorage.getItem(AUTH_TOKEN_KEY) === token
    && !target.endsWith('/api/auth/login')
  ) {
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    window.dispatchEvent(new CustomEvent('ai-os-auth-expired'));
  }
  return response;
};

interface UserProfile {
  username: string;
  display_name: string;
  role: string;
  tone_style: string;
  custom_instructions: string;
  language?: string;
}

interface RuntimeProvider {
  name?: string;
  icon?: string;
  available_models?: string[];
  default_model?: string;
  is_configured?: boolean;
}

interface ProviderRegistryEntry {
  id: string;
  name: string;
  icon: string;
  adapter: string;
  description: string;
  endpoint: string;
  models: string[];
  default_model: string;
  state: 'operational' | 'needs_credentials' | 'draft';
  runtime_available: boolean;
  editable: boolean;
  note: string;
}

let loadedPromptsCache: Record<string, any> = {};
let refreshNotebookWorkspace: (() => Promise<void>) | undefined;
let refreshChatSessionSidebar: (() => Promise<void>) | undefined;
let currentUser: UserProfile | null = null;

document.addEventListener('DOMContentLoaded', () => {
  initI18n(); // Initialize language from localStorage
  const visualizer = new RobotCanvasVisualizer('robot-canvas');
  let socketClient: SocketClient | null = null;
  const appShell = document.getElementById('app');
  currentUser = null;

  // Language Toggle
  const langEnBtn = document.getElementById('lang-en') as HTMLButtonElement;
  const langFiBtn = document.getElementById('lang-fi') as HTMLButtonElement;

  function updateLangToggleUI() {
    const lang = getLanguage();
    if (lang === 'en') {
      langEnBtn?.classList.add('active');
      langFiBtn?.classList.remove('active');
    } else {
      langFiBtn?.classList.add('active');
      langEnBtn?.classList.remove('active');
    }
  }

  async function handleLanguageToggle(lang: 'en' | 'fi') {
    setLanguage(lang);
    updateLangToggleUI();

    const payload = {
      username: currentUser?.username || 'alex',
      tone_style: currentUser?.tone_style || 'formal_executive',
      custom_instructions: currentUser?.custom_instructions || '',
      language: lang,
    };

    try {
      const res = await fetch('/api/user/customization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        if (currentUser) {
          currentUser.language = data.user?.language || lang;
        }
      } else {
        console.warn('Failed to persist language customization to backend:', await res.text());
      }
    } catch (err) {
      console.error('Error persisting language customization:', err);
    }
  }

  if (langEnBtn && langFiBtn) {
    updateLangToggleUI();
    langEnBtn.addEventListener('click', () => { void handleLanguageToggle('en'); });
    langFiBtn.addEventListener('click', () => { void handleLanguageToggle('fi'); });
  }

  window.addEventListener('languageChanged', () => {
    // Re-render kanban to apply dynamic translations
    if (viewDashboard && viewDashboard.style.display !== 'none') {
        // fetchAndRenderKanbanTasks is module-scoped and can refresh translated labels.
        // wait, fetchAndRenderKanbanTasks is at module scope.
        fetchAndRenderKanbanTasks();
    }
  });

  // 3-Mode Theme Switcher (Nordic White, Warm Dark, Warm Sand)
  const themeBtns = document.querySelectorAll('.theme-btn[data-theme-set]') as NodeListOf<HTMLButtonElement>;
  function applyTheme(themeName: string) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('ai_os_theme', themeName);
    themeBtns.forEach(btn => {
      const themeSet = btn.getAttribute('data-theme-set');
      if (!themeSet) return;
      if (themeSet === themeName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  let savedTheme = localStorage.getItem('ai_os_theme') || 'light';
  applyTheme(savedTheme);

  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-theme-set');
      if (theme) applyTheme(theme);
    });
  });

  // Tab View Navigation Elements
  const tabDashboard = document.getElementById('tab-dashboard') as HTMLButtonElement;
  const tabMvpShowcase = document.getElementById('tab-mvp-showcase') as HTMLButtonElement | null;
  const tabCustomization = document.getElementById('tab-customization') as HTMLButtonElement | null;
  const tabIngestion = document.getElementById('tab-ingestion') as HTMLButtonElement | null;
  const tabHabitat = document.getElementById('tab-habitat') as HTMLButtonElement | null;
  const backToDashboardBtn = document.getElementById('back-to-dashboard-btn') as HTMLButtonElement | null;
  const viewDashboard = document.getElementById('view-dashboard') as HTMLDivElement;
  const viewMvpShowcase = document.getElementById('view-mvp-showcase') as HTMLDivElement | null;
  const viewCustomization = document.getElementById('view-customization') as HTMLDivElement | null;
  const viewIngestion = document.getElementById('view-ingestion') as HTMLDivElement | null;
  const viewHabitat = document.getElementById('view-habitat') as HTMLDivElement | null;

  // Habitat Agent Controls
  const habitatAgentSelect = document.getElementById('habitat-agent-select') as HTMLSelectElement | null;
  const habitatPromptTextarea = document.getElementById('habitat-prompt-textarea') as HTMLTextAreaElement | null;
  const habitatProviderSelect = document.getElementById('habitat-provider-select') as HTMLSelectElement | null;
  const habitatModelSelect = document.getElementById('habitat-model-select') as HTMLSelectElement | null;
  const habitatTemperatureInput = document.getElementById('habitat-temperature-input') as HTMLInputElement | null;
  const habitatMaxTokensInput = document.getElementById('habitat-max-tokens-input') as HTMLInputElement | null;
  const saveHabitatPromptBtn = document.getElementById('save-habitat-prompt-btn') as HTMLButtonElement | null;
  const habitatSaveStatus = document.getElementById('habitat-save-status') as HTMLSpanElement | null;
  const tabKanbanHeader = document.getElementById('tab-kanban') as HTMLButtonElement | null;
  const viewKanbanPage = document.getElementById('view-kanban') as HTMLDivElement | null;
  const tabAgenticGoals = document.getElementById('tab-agentic-goals') as HTMLButtonElement | null;
  const viewAgenticGoals = document.getElementById('view-agentic-goals') as HTMLDivElement | null;
  const agentWorkGoalsMode = document.getElementById('agent-work-goals-mode') as HTMLButtonElement | null;
  const agentWorkBoardMode = document.getElementById('agent-work-board-mode') as HTMLButtonElement | null;
  const agentWorkGoalsPanel = document.getElementById('agent-work-goals-panel') as HTMLDivElement | null;
  const agentWorkBoardPanel = document.getElementById('agent-work-board-panel') as HTMLDivElement | null;
  const tabMonitoring = document.getElementById('tab-monitoring') as HTMLButtonElement | null;
  const viewMonitoring = document.getElementById('view-monitoring') as HTMLDivElement | null;
  const tabEmail = document.getElementById('tab-email') as HTMLButtonElement | null;
  const viewEmail = document.getElementById('view-email') as HTMLDivElement | null;
  const emailSyncBtn = document.getElementById('email-sync-btn') as HTMLButtonElement | null;
  const emailSyncInterval = document.getElementById('email-sync-interval') as HTMLSelectElement | null;
  const emailStatus = document.getElementById('email-status') as HTMLParagraphElement | null;
  const emailLastSync = document.getElementById('email-last-sync') as HTMLSpanElement | null;
  const emailSummary = document.getElementById('email-summary') as HTMLDivElement | null;
  const emailMessageList = document.getElementById('email-message-list') as HTMLDivElement | null;
  const emailPreview = document.getElementById('email-preview') as HTMLElement | null;
  const emailDraftList = document.getElementById('email-draft-list') as HTMLDivElement | null;
  let selectedEmailMessageId = '';
  const tabAgentLogs = document.getElementById('tab-agent-logs') as HTMLButtonElement | null;
  const viewAgentLogs = document.getElementById('view-agent-logs') as HTMLDivElement | null;
  const agentLogsList = document.getElementById('agent-logs-list') as HTMLDivElement | null;
  const agentLogsStatus = document.getElementById('agent-logs-status') as HTMLParagraphElement | null;
  const refreshAgentLogsBtn = document.getElementById('refresh-agent-logs-btn') as HTMLButtonElement | null;
  const providerRegistryGrid = document.getElementById('provider-registry-grid') as HTMLDivElement | null;
  const providerRegistrySummary = document.getElementById('provider-registry-summary') as HTMLSpanElement | null;
  const addProviderDraftBtn = document.getElementById('add-provider-draft-btn') as HTMLButtonElement | null;
  const providerSetupModal = document.getElementById('provider-setup-modal') as HTMLDivElement | null;
  const providerSetupForm = document.getElementById('provider-setup-form') as HTMLFormElement | null;
  const providerSetupTitle = document.getElementById('provider-setup-title') as HTMLHeadingElement | null;
  const providerSetupSubtext = document.getElementById('provider-setup-subtext') as HTMLParagraphElement | null;
  const closeProviderSetupBtn = document.getElementById('close-provider-setup-btn') as HTMLButtonElement | null;
  const providerSetupStatus = document.getElementById('provider-setup-status') as HTMLSpanElement | null;
  const providerDraftName = document.getElementById('provider-draft-name') as HTMLInputElement | null;
  const providerDraftId = document.getElementById('provider-draft-id') as HTMLInputElement | null;
  const providerDraftAdapter = document.getElementById('provider-draft-adapter') as HTMLSelectElement | null;
  const providerDraftEndpoint = document.getElementById('provider-draft-endpoint') as HTMLInputElement | null;
  const providerDraftModels = document.getElementById('provider-draft-models') as HTMLTextAreaElement | null;
  const providerDraftNote = document.getElementById('provider-draft-note') as HTMLTextAreaElement | null;
  let runtimeProviders: Record<string, RuntimeProvider> = {};
  let providerRegistry: ProviderRegistryEntry[] = [];
  let editingProviderId: string | null = null;

  const existingKanbanLayout = viewKanbanPage?.querySelector('.kanban-layout');
  if (existingKanbanLayout && agentWorkBoardPanel) agentWorkBoardPanel.appendChild(existingKanbanLayout);

  function setAgentWorkMode(mode: 'goals' | 'board') {
    if (agentWorkGoalsPanel) agentWorkGoalsPanel.style.display = mode === 'goals' ? 'grid' : 'none';
    if (agentWorkBoardPanel) agentWorkBoardPanel.style.display = mode === 'board' ? 'block' : 'none';
    agentWorkGoalsMode?.classList.toggle('active', mode === 'goals');
    agentWorkBoardMode?.classList.toggle('active', mode === 'board');
    if (mode === 'goals') void fetchAndRenderAgenticGoals();
    if (mode === 'board') void fetchAndRenderKanbanTasks();
  }

  agentWorkGoalsMode?.addEventListener('click', () => setAgentWorkMode('goals'));
  agentWorkBoardMode?.addEventListener('click', () => setAgentWorkMode('board'));
  window.addEventListener('open-agent-work-goal', (event: Event) => {
    const goalId = String((event as CustomEvent).detail?.goalId || '');
    if (!goalId) return;
    switchView('agentic-goals');
    setAgentWorkMode('goals');
    void selectAgenticGoal(goalId);
  });

  function setProviderSetupStatus(message = '') {
    if (providerSetupStatus) providerSetupStatus.textContent = message;
  }

  function closeProviderSetup() {
    if (providerSetupModal) providerSetupModal.style.display = 'none';
    editingProviderId = null;
    setProviderSetupStatus();
  }

  function openProviderSetup(entry?: ProviderRegistryEntry) {
    if (!providerSetupModal || !providerDraftName || !providerDraftId || !providerDraftAdapter || !providerDraftEndpoint || !providerDraftModels || !providerDraftNote) return;
    editingProviderId = entry?.id || null;
    if (providerSetupTitle) providerSetupTitle.textContent = entry ? `Edit ${entry.name} draft` : 'Add Provider Draft';
    if (providerSetupSubtext) providerSetupSubtext.textContent = entry
      ? 'Update this setup blueprint. It will not change agent routing until a runtime adapter is enabled.'
      : 'Define a future connection without changing the live Azure runtime.';
    providerDraftName.value = entry?.name || '';
    providerDraftId.value = entry?.id || '';
    providerDraftId.disabled = Boolean(entry);
    providerDraftAdapter.value = entry?.adapter || 'custom_adapter';
    providerDraftEndpoint.value = entry?.endpoint || '';
    providerDraftModels.value = (entry?.models || []).join('\n');
    providerDraftNote.value = entry?.note || '';
    setProviderSetupStatus();
    providerSetupModal.style.display = 'flex';
  }

  function buildProviderCard(entry: ProviderRegistryEntry) {
    const card = document.createElement('article');
    card.className = `provider-registry-card provider-state-${entry.state}`;

    const header = document.createElement('div');
    header.className = 'provider-card-header';
    const heading = document.createElement('h4');
    heading.textContent = `${entry.icon || '🔌'} ${entry.name}`;
    const state = document.createElement('span');
    state.className = `provider-state-pill state-${entry.state}`;
    state.textContent = entry.state === 'operational' ? 'Operational' : entry.state === 'needs_credentials' ? 'Needs credentials' : 'Draft';
    header.append(heading, state);

    const adapter = document.createElement('div');
    adapter.className = 'provider-card-adapter';
    adapter.textContent = entry.adapter.replace(/_/g, ' ');
    const description = document.createElement('p');
    description.className = 'provider-card-description';
    description.textContent = entry.description;
    const details = document.createElement('p');
    details.className = 'provider-card-details';
    const modelText = entry.models.length ? `${entry.models.length} catalog model${entry.models.length === 1 ? '' : 's'}` : 'No models catalogued yet';
    details.textContent = `${modelText}${entry.endpoint ? ' · endpoint noted' : ''}`;
    const note = document.createElement('p');
    note.className = 'provider-card-note';
    note.textContent = entry.note;

    const footer = document.createElement('div');
    footer.className = 'provider-card-footer';
    if (entry.editable) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'chip-btn btn-sm';
      editButton.textContent = 'Configure draft';
      editButton.addEventListener('click', () => openProviderSetup(entry));
      footer.appendChild(editButton);
    } else {
      const managed = document.createElement('span');
      managed.className = 'subtext';
      managed.textContent = 'Runtime managed server-side';
      footer.appendChild(managed);
    }

    card.append(header, adapter, description, details, note, footer);
    return card;
  }

  async function fetchAndRenderProviderRegistry() {
    if (!providerRegistryGrid) return;
    try {
      const response = await fetch('/api/providers/registry');
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      providerRegistry = Array.isArray(data.providers) ? data.providers : [];
      providerRegistryGrid.replaceChildren(...providerRegistry.map(buildProviderCard));
      const operational = providerRegistry.filter((provider) => provider.runtime_available).length;
      const drafts = providerRegistry.filter((provider) => provider.state === 'draft').length;
      if (providerRegistrySummary) providerRegistrySummary.textContent = `${operational} operational · ${drafts} draft${drafts === 1 ? '' : 's'}`;
    } catch (error) {
      providerRegistryGrid.replaceChildren();
      const message = document.createElement('p');
      message.className = 'provider-registry-error';
      message.textContent = 'Provider registry is unavailable. Check that the local kernel is running.';
      providerRegistryGrid.appendChild(message);
      if (providerRegistrySummary) providerRegistrySummary.textContent = 'Registry unavailable';
      console.warn('Could not load provider registry:', error);
    }
  }

  function renderRuntimeProviderOptions(preferredProvider?: string) {
    if (!habitatProviderSelect) return;
    const entries = Object.entries(runtimeProviders).filter(([, provider]) => provider.is_configured !== false);
    habitatProviderSelect.replaceChildren();
    if (!entries.length) {
      habitatProviderSelect.add(new Option('No runtime provider configured', ''));
      habitatProviderSelect.disabled = true;
      return;
    }
    entries.forEach(([id, provider]) => habitatProviderSelect.add(new Option(`${provider.icon || '🔌'} ${provider.name || id}`, id)));
    habitatProviderSelect.disabled = false;
    habitatProviderSelect.value = entries.some(([id]) => id === preferredProvider) ? preferredProvider! : entries[0][0];
  }

  function renderRuntimeModelOptions(providerId: string, preferredModel?: string) {
    if (!habitatModelSelect) return;
    const provider = runtimeProviders[providerId];
    const models = provider?.available_models || [];
    habitatModelSelect.replaceChildren();
    if (!models.length) {
      habitatModelSelect.add(new Option('No models available', ''));
      habitatModelSelect.disabled = true;
      return;
    }
    models.forEach((model) => habitatModelSelect.add(new Option(model, model)));
    habitatModelSelect.disabled = false;
    habitatModelSelect.value = models.includes(preferredModel || '') ? preferredModel! : (provider.default_model || models[0]);
  }

  if (addProviderDraftBtn) addProviderDraftBtn.addEventListener('click', () => openProviderSetup());
  if (closeProviderSetupBtn) closeProviderSetupBtn.addEventListener('click', closeProviderSetup);
  if (providerSetupModal) providerSetupModal.addEventListener('click', (event) => {
    if (event.target === providerSetupModal) closeProviderSetup();
  });
  if (providerSetupForm && providerDraftName && providerDraftId && providerDraftAdapter && providerDraftEndpoint && providerDraftModels && providerDraftNote) {
    providerSetupForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const providerId = editingProviderId || providerDraftId.value || providerDraftName.value;
      const payload = {
        provider_id: providerId,
        name: providerDraftName.value,
        adapter: providerDraftAdapter.value,
        endpoint: providerDraftEndpoint.value,
        models: providerDraftModels.value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean),
        note: providerDraftNote.value,
      };
      setProviderSetupStatus('Saving draft...');
      try {
        const response = await fetch(
          editingProviderId ? `/api/providers/registry/${encodeURIComponent(editingProviderId)}` : '/api/providers/registry',
          {
            method: editingProviderId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!response.ok) throw new Error((await response.json()).detail || 'Could not save provider draft.');
        closeProviderSetup();
        await fetchAndRenderProviderRegistry();
      } catch (error) {
        setProviderSetupStatus(error instanceof Error ? error.message : 'Could not save provider draft.');
      }
    });
  }
  if (habitatProviderSelect) habitatProviderSelect.addEventListener('change', () => renderRuntimeModelOptions(habitatProviderSelect.value));

  function formatLogTime(value?: string) {
    if (!value) return 'Not started';
    const date = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
  }

  function trimLogText(value?: string, maxLength = 360) {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
  }

  async function fetchAndRenderAgentLogs() {
    if (!agentLogsList) return;
    if (agentLogsStatus) agentLogsStatus.textContent = 'Loading activity…';
    try {
      const response = await fetch('/api/autonomy/tasks?limit=100');
      if (!response.ok) throw new Error('Could not load agent activity.');
      const data = await response.json();
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      agentLogsList.replaceChildren();
      if (!tasks.length) {
        const empty = document.createElement('p');
        empty.className = 'agent-logs-empty';
        empty.textContent = 'No autonomous agent activity has been recorded yet.';
        agentLogsList.appendChild(empty);
      }
      tasks.forEach((task: any) => {
        const card = document.createElement('article');
        card.className = 'agent-log-card';
        const status = document.createElement('span');
        status.className = `agent-log-status status-${task.status || 'queued'}`;
        status.textContent = task.status || 'queued';
        const title = document.createElement('h3');
        title.textContent = task.query || 'Untitled agent task';
        const meta = document.createElement('p');
        meta.className = 'agent-log-meta';
        meta.textContent = `Autonomous research · ${formatLogTime(task.completed_at || task.started_at || task.created_at)} · ${task.step_count || 0} step${task.step_count === 1 ? '' : 's'}`;
        const action = document.createElement('p');
        action.className = 'agent-log-action';
        action.textContent = trimLogText(task.error_message || task.result_md || task.last_action || 'No activity detail recorded yet.');
        card.append(status, title, meta, action);
        agentLogsList.appendChild(card);
      });
      if (agentLogsStatus) agentLogsStatus.textContent = `${tasks.length} recorded task${tasks.length === 1 ? '' : 's'}`;
    } catch (error) {
      agentLogsList.replaceChildren();
      if (agentLogsStatus) agentLogsStatus.textContent = 'Agent activity is unavailable. Check that the local kernel is running.';
      console.warn('Could not load agent logs:', error);
    }
  }

  // Goal-driven Agent Control Center
  const agenticGoalList = document.getElementById('agentic-goal-list') as HTMLDivElement | null;
  const agenticGoalDetail = document.getElementById('agentic-goal-detail') as HTMLElement | null;
  const agenticGoalsStatus = document.getElementById('agentic-goals-status') as HTMLParagraphElement | null;
  const refreshAgenticGoalsBtn = document.getElementById('refresh-agentic-goals-btn') as HTMLButtonElement | null;
  const newAgenticGoalBtn = document.getElementById('new-agentic-goal-btn') as HTMLButtonElement | null;
  const newAgenticGoalModal = document.getElementById('new-agentic-goal-modal') as HTMLDivElement | null;
  const closeAgenticGoalModalBtn = document.getElementById('close-agentic-goal-modal-btn') as HTMLButtonElement | null;
  const newAgenticGoalForm = document.getElementById('new-agentic-goal-form') as HTMLFormElement | null;
  const agenticGoalTitle = document.getElementById('agentic-goal-title') as HTMLInputElement | null;
  const agenticGoalObjective = document.getElementById('agentic-goal-objective') as HTMLTextAreaElement | null;
  const agenticGoalCriteria = document.getElementById('agentic-goal-criteria') as HTMLTextAreaElement | null;
  const agenticGoalProject = document.getElementById('agentic-goal-project') as HTMLSelectElement | null;
  const agenticGoalRuntime = document.getElementById('agentic-goal-runtime') as HTMLSelectElement | null;
  const agenticGoalWeb = document.getElementById('agentic-goal-web') as HTMLInputElement | null;
  const agenticGoalFormStatus = document.getElementById('agentic-goal-form-status') as HTMLSpanElement | null;
  let selectedAgenticGoalId = '';

  function agenticText(tag: string, className: string, value: unknown) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(value ?? '');
    return element;
  }

  function agenticStatusLabel(status: string) {
    return status.replace(/_/g, ' ');
  }

  async function loadAgenticProjectOptions() {
    if (!agenticGoalProject) return;
    try {
      const response = await fetch('/api/notebooks');
      if (!response.ok) throw new Error('Could not load projects');
      const data = await response.json();
      const projects = Array.isArray(data.notebooks) ? data.notebooks : Array.isArray(data) ? data : [];
      const selected = agenticGoalProject.value;
      agenticGoalProject.replaceChildren(new Option('Organization-wide (no private project documents)', ''));
      projects.forEach((project: any) => agenticGoalProject.add(new Option(project.name || project.id, project.id)));
      if (projects.some((project: any) => project.id === selected)) agenticGoalProject.value = selected;
    } catch (error) {
      console.warn('Could not load goal project boundaries:', error);
    }
  }

  async function fetchAndRenderAgenticGoals(preserveSelection = true) {
    if (!agenticGoalList) return;
    if (agenticGoalsStatus) agenticGoalsStatus.textContent = 'Loading goals…';
    try {
      const response = await fetch('/api/agentic/goals?limit=100');
      if (!response.ok) throw new Error('Could not load agent goals');
      const data = await response.json();
      const goals = Array.isArray(data.goals) ? data.goals : [];
      agenticGoalList.replaceChildren();
      goals.forEach((goal: any) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `agentic-goal-list-item${goal.id === selectedAgenticGoalId ? ' active' : ''}`;
        const top = document.createElement('span');
        top.className = 'agentic-goal-list-top';
        top.append(
          agenticText('strong', '', goal.title || 'Untitled goal'),
          agenticText('em', `agentic-status status-${goal.status || 'draft'}`, agenticStatusLabel(goal.status || 'draft')),
        );
        const progress = `${goal.completed_task_count || 0}/${goal.task_count || 0} tasks`;
        button.append(top, agenticText('small', '', progress), agenticText('p', '', trimLogText(goal.objective, 120)));
        button.addEventListener('click', () => void selectAgenticGoal(goal.id));
        agenticGoalList.appendChild(button);
      });
      if (!goals.length) {
        const empty = agenticText('div', 'agentic-list-empty', 'No goals yet. Create one to let the AI Board Member plan and coordinate a bounded outcome.');
        agenticGoalList.appendChild(empty);
      }
      if (agenticGoalsStatus) agenticGoalsStatus.textContent = `${goals.length} goal${goals.length === 1 ? '' : 's'}`;
      if (preserveSelection && selectedAgenticGoalId) await selectAgenticGoal(selectedAgenticGoalId, false);
    } catch (error) {
      if (agenticGoalsStatus) agenticGoalsStatus.textContent = 'Goals are unavailable. Check that the local kernel is running.';
      console.warn('Could not load agentic goals:', error);
    }
  }

  async function selectAgenticGoal(goalId: string, refreshList = true) {
    selectedAgenticGoalId = goalId;
    if (refreshList) {
      agenticGoalList?.querySelectorAll('.agentic-goal-list-item').forEach((item) => item.classList.remove('active'));
    }
    try {
      const response = await fetch(`/api/agentic/goals/${encodeURIComponent(goalId)}`);
      if (!response.ok) throw new Error('Could not load goal details');
      renderAgenticGoalDetail(await response.json());
      if (refreshList) void fetchAndRenderAgenticGoals(false);
    } catch (error) {
      if (agenticGoalDetail) agenticGoalDetail.replaceChildren(agenticText('p', 'agentic-error', 'This goal could not be loaded.'));
      console.warn(error);
    }
  }

  function renderAgenticGoalDetail(goal: any) {
    if (!agenticGoalDetail) return;
    const header = document.createElement('header');
    header.className = 'agentic-detail-header';
    const heading = document.createElement('div');
    heading.append(
      agenticText('span', `agentic-status status-${goal.status}`, agenticStatusLabel(goal.status)),
      agenticText('h2', '', goal.title),
      agenticText('p', '', goal.objective),
    );
    const controls = document.createElement('div');
    controls.className = 'agentic-control-actions';
    const addControl = (label: string, action: string, style = 'chip-btn') => {
      const button = agenticText('button', style, label) as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => void controlAgenticGoal(goal.id, action));
      controls.appendChild(button);
    };
    if (['draft', 'failed'].includes(goal.status)) addControl('Start', 'start', 'save-btn');
    if (['planning', 'running', 'queued'].includes(goal.status)) addControl('Pause', 'pause');
    if (goal.status === 'paused') addControl('Resume', 'resume', 'save-btn');
    if (!['completed', 'failed', 'cancelled'].includes(goal.status)) addControl('Cancel', 'cancel', 'cancel-btn');
    header.append(heading, controls);

    const metrics = document.createElement('div');
    metrics.className = 'agentic-metrics';
    const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
    const completed = tasks.filter((task: any) => task.status === 'completed').length;
    [
      ['Progress', `${completed}/${tasks.length} tasks`],
      ['Plan', `Version ${goal.plan_version || 0}`],
      ['Web', goal.web_access ? 'Permitted' : 'Off'],
      ['Step limit', goal.max_steps],
      ['Runtime', `${goal.max_runtime_minutes} min`],
      ['Approvals', `${(goal.proposals || []).filter((item: any) => item.status === 'pending').length} pending`],
    ].forEach(([label, value]) => {
      const card = document.createElement('div');
      card.append(agenticText('small', '', label), agenticText('strong', '', value));
      metrics.appendChild(card);
    });

    const steering = document.createElement('div');
    steering.className = 'agentic-steering';
    const steeringInput = document.createElement('input');
    steeringInput.placeholder = 'Add direction for the next safe task boundary…';
    steeringInput.maxLength = 2000;
    const steeringButton = agenticText('button', 'chip-btn', 'Steer') as HTMLButtonElement;
    steeringButton.type = 'button';
    steeringButton.disabled = ['completed', 'failed', 'cancelled'].includes(goal.status);
    steeringButton.addEventListener('click', async () => {
      const direction = steeringInput.value.trim();
      if (!direction) return;
      await controlAgenticGoal(goal.id, 'steer', { direction });
      steeringInput.value = '';
    });
    steering.append(steeringInput, steeringButton);

    const planSection = document.createElement('section');
    planSection.className = 'agentic-detail-section';
    planSection.append(agenticText('h3', '', 'Execution plan'));
    const plan = document.createElement('div');
    plan.className = 'agentic-plan-list';
    tasks.forEach((task: any, index: number) => {
      const card = document.createElement('article');
      card.className = `agentic-task-card task-${task.status}`;
      const number = agenticText('span', 'agentic-task-number', String(index + 1));
      const body = document.createElement('div');
      const taskTop = document.createElement('div');
      taskTop.className = 'agentic-task-top';
      taskTop.append(agenticText('strong', '', task.title), agenticText('em', `agentic-status status-${task.status}`, agenticStatusLabel(task.status)));
      body.append(taskTop, agenticText('small', '', `${task.agent_type} · ${String(task.capability).replace(/_/g, ' ')} · ${String(task.risk_level).replace(/_/g, ' ')}`));
      const detail = task.error_message || task.output?.summary || task.instructions;
      body.append(agenticText('p', '', trimLogText(detail, 420)));
      card.append(number, body);
      plan.appendChild(card);
    });
    if (!tasks.length) plan.appendChild(agenticText('p', 'subtext', 'The plan will appear when this goal starts.'));
    planSection.appendChild(plan);

    const proposalSection = document.createElement('section');
    proposalSection.className = 'agentic-detail-section';
    proposalSection.append(agenticText('h3', '', 'Approval proposals'));
    const proposals = Array.isArray(goal.proposals) ? goal.proposals : [];
    if (!proposals.length) proposalSection.append(agenticText('p', 'subtext', 'No consequential actions have been proposed.'));
    proposals.forEach((proposal: any) => {
      const card = document.createElement('article');
      card.className = 'agentic-proposal-card';
      card.append(agenticText('strong', '', proposal.action_type), agenticText('p', '', proposal.summary), agenticText('small', '', `Status: ${proposal.status}`));
      if (proposal.status === 'pending') {
        const buttons = document.createElement('div');
        ['approved', 'rejected'].forEach((decision) => {
          const button = agenticText('button', decision === 'approved' ? 'save-btn' : 'cancel-btn', decision === 'approved' ? 'Approve proposal' : 'Reject') as HTMLButtonElement;
          button.type = 'button';
          button.addEventListener('click', () => void decideAgenticProposal(proposal.id, decision));
          buttons.appendChild(button);
        });
        card.appendChild(buttons);
      }
      proposalSection.appendChild(card);
    });

    const artifactSection = document.createElement('section');
    artifactSection.className = 'agentic-detail-section';
    artifactSection.append(agenticText('h3', '', 'Artifacts'));
    const artifacts = Array.isArray(goal.artifacts) ? goal.artifacts : [];
    if (!artifacts.length) artifactSection.append(agenticText('p', 'subtext', 'The decision brief will be saved here when the plan completes.'));
    artifacts.forEach((artifact: any) => {
      const details = document.createElement('details');
      const summary = agenticText('summary', '', artifact.title || artifact.artifact_type);
      const content = agenticText('pre', 'agentic-artifact-content', artifact.content_md);
      details.append(summary, content);
      artifactSection.appendChild(details);
    });

    const eventsSection = document.createElement('section');
    eventsSection.className = 'agentic-detail-section';
    eventsSection.append(agenticText('h3', '', 'Audit trail'));
    const eventList = document.createElement('div');
    eventList.className = 'agentic-event-list';
    (goal.events || []).slice(-30).reverse().forEach((event: any) => {
      const row = document.createElement('div');
      row.append(agenticText('time', '', formatLogTime(event.created_at)), agenticText('strong', '', String(event.event_type).replace(/_/g, ' ')), agenticText('p', '', event.message));
      eventList.appendChild(row);
    });
    eventsSection.appendChild(eventList);

    const resultSection = document.createElement('section');
    resultSection.className = 'agentic-detail-section agentic-result-section';
    resultSection.append(agenticText('h3', '', 'Current outcome'));
    resultSection.append(agenticText('pre', 'agentic-artifact-content', goal.error_message || goal.result_md || 'Work has not produced a final outcome yet.'));

    agenticGoalDetail.replaceChildren(header, metrics, steering, planSection, proposalSection, artifactSection, resultSection, eventsSection);
  }

  async function controlAgenticGoal(goalId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const response = await fetch(`/api/agentic/goals/${encodeURIComponent(goalId)}/${action}`, {
        method: 'POST',
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Could not ${action} goal`);
      }
      await fetchAndRenderAgenticGoals();
    } catch (error) {
      alert(error instanceof Error ? error.message : `Could not ${action} goal`);
    }
  }

  async function decideAgenticProposal(proposalId: number, decision: string) {
    try {
      const response = await fetch(`/api/agentic/proposals/${proposalId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, decided_by: currentUser?.username || 'alex' }),
      });
      if (!response.ok) {
        alert('This proposal could not be updated. It may already have been decided.');
        return;
      }
      if (selectedAgenticGoalId) await selectAgenticGoal(selectedAgenticGoalId);
    } catch (err) {
      console.error('Error updating proposal decision:', err);
      alert(`Could not update proposal: ${err instanceof Error ? err.message : 'network error'}`);
    }
  }

  function closeAgenticGoalModal() {
    if (newAgenticGoalModal) newAgenticGoalModal.style.display = 'none';
    if (agenticGoalFormStatus) agenticGoalFormStatus.textContent = '';
  }

  newAgenticGoalBtn?.addEventListener('click', () => {
    void loadAgenticProjectOptions();
    if (newAgenticGoalModal) newAgenticGoalModal.style.display = 'flex';
  });
  closeAgenticGoalModalBtn?.addEventListener('click', closeAgenticGoalModal);
  newAgenticGoalModal?.addEventListener('click', (event) => {
    if (event.target === newAgenticGoalModal) closeAgenticGoalModal();
  });
  refreshAgenticGoalsBtn?.addEventListener('click', () => void fetchAndRenderAgenticGoals());
  newAgenticGoalForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!agenticGoalTitle || !agenticGoalObjective || !agenticGoalCriteria || !agenticGoalProject || !agenticGoalRuntime || !agenticGoalWeb) return;
    if (agenticGoalFormStatus) agenticGoalFormStatus.textContent = 'Creating goal…';
    try {
      const response = await fetch('/api/agentic/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: agenticGoalTitle.value,
          objective: agenticGoalObjective.value,
          success_criteria_md: agenticGoalCriteria.value,
          username: currentUser?.username || 'alex',
          notebook_ids: agenticGoalProject.value ? [agenticGoalProject.value] : [],
          web_access: agenticGoalWeb.checked,
          max_steps: 12,
          max_retries: 1,
          max_runtime_minutes: Number(agenticGoalRuntime.value) || 30,
          max_cost_usd: 5,
          auto_start: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not create goal');
      selectedAgenticGoalId = data.id;
      newAgenticGoalForm.reset();
      if (agenticGoalCriteria) agenticGoalCriteria.value = 'Produce an evidence-grounded board brief with financial implications, feasibility, risks, unknowns, and recommended next steps.';
      closeAgenticGoalModal();
      await fetchAndRenderAgenticGoals();
    } catch (error) {
      if (agenticGoalFormStatus) agenticGoalFormStatus.textContent = error instanceof Error ? error.message : 'Could not create goal.';
    }
  });
  window.setInterval(() => {
    if (viewAgenticGoals?.style.display !== 'none') void fetchAndRenderAgenticGoals();
  }, 3500);

  // Project-scoped external source connectors and relevance-ranked signals.
  const connectorList = document.getElementById('connector-instance-list') as HTMLDivElement | null;
  const connectorStatus = document.getElementById('connector-status') as HTMLParagraphElement | null;
  const signalGrid = document.getElementById('signal-card-grid') as HTMLDivElement | null;
  const signalStatus = document.getElementById('signal-status') as HTMLParagraphElement | null;
  const signalMinimumScore = document.getElementById('signal-minimum-score') as HTMLSelectElement | null;
  const refreshConnectorsBtn = document.getElementById('refresh-connectors-btn') as HTMLButtonElement | null;
  const newConnectorBtn = document.getElementById('new-connector-btn') as HTMLButtonElement | null;
  const connectorModal = document.getElementById('connector-modal') as HTMLDivElement | null;
  const closeConnectorModalBtn = document.getElementById('close-connector-modal-btn') as HTMLButtonElement | null;
  const connectorForm = document.getElementById('connector-form') as HTMLFormElement | null;
  const connectorName = document.getElementById('connector-name') as HTMLInputElement | null;
  const connectorFeedUrl = document.getElementById('connector-feed-url') as HTMLInputElement | null;
  const connectorInterest = document.getElementById('connector-interest-query') as HTMLTextAreaElement | null;
  const connectorProject = document.getElementById('connector-project') as HTMLSelectElement | null;
  const connectorPollMinutes = document.getElementById('connector-poll-minutes') as HTMLSelectElement | null;
  const connectorMinimum = document.getElementById('connector-minimum-relevance') as HTMLInputElement | null;
  const connectorMinimumOutput = document.getElementById('connector-minimum-output') as HTMLOutputElement | null;
  const connectorFormStatus = document.getElementById('connector-form-status') as HTMLSpanElement | null;

  function monitoringText(tag: string, className: string, value: unknown) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = String(value ?? '');
    return element;
  }

  function monitoringTime(value: unknown) {
    if (!value) return 'Not yet';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  async function loadMonitoringProjects() {
    if (!connectorProject) return;
    const selected = connectorProject.value;
    try {
      const response = await fetch('/api/notebooks');
      const data = await response.json();
      const projects = Array.isArray(data.notebooks) ? data.notebooks : [];
      connectorProject.replaceChildren(new Option('Organization-wide', ''));
      projects.forEach((project: any) => connectorProject.add(new Option(project.name || project.id, project.id)));
      if (projects.some((project: any) => project.id === selected)) connectorProject.value = selected;
    } catch (error) {
      console.warn('Could not load connector project boundaries:', error);
    }
  }

  async function setConnectorEnabled(instance: any, enabled: boolean) {
    const response = await fetch(`/api/connectors/instances/${encodeURIComponent(instance.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error((await response.json()).detail || 'Could not update connector');
    await loadConnectors();
  }

  async function syncConnector(instanceId: string, button?: HTMLButtonElement) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Syncing…';
    }
    try {
      const response = await fetch(`/api/connectors/instances/${encodeURIComponent(instanceId)}/sync`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Feed synchronization failed');
      await Promise.all([loadConnectors(), loadSignals()]);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Feed synchronization failed');
      await loadConnectors();
    }
  }

  async function loadConnectors() {
    if (!connectorList) return;
    if (connectorStatus) connectorStatus.textContent = 'Loading connectors…';
    try {
      const response = await fetch('/api/connectors/instances');
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not load connectors');
      const instances = Array.isArray(data.instances) ? data.instances : [];
      connectorList.replaceChildren();
      instances.forEach((instance: any) => {
        const card = document.createElement('article');
        card.className = 'connector-instance-card';
        const header = document.createElement('header');
        const health = monitoringText('span', `connector-health is-${instance.status || 'idle'}`, instance.status || 'idle');
        header.append(monitoringText('strong', '', instance.name || 'RSS feed'), health);
        const url = monitoringText('p', '', instance.config?.feed_url || 'Feed URL unavailable');
        const interest = monitoringText('p', '', instance.interest_query ? `Monitoring: ${instance.interest_query}` : 'Monitoring every feed item');
        const timing = monitoringText('small', '', `Last sync: ${monitoringTime(instance.last_sync_at)} · Next: ${monitoringTime(instance.next_sync_at)}`);
        const actions = document.createElement('div');
        actions.className = 'connector-instance-actions';
        const sync = monitoringText('button', 'chip-btn btn-sm', 'Sync now') as HTMLButtonElement;
        sync.type = 'button';
        sync.disabled = instance.status === 'syncing';
        sync.addEventListener('click', () => void syncConnector(instance.id, sync));
        const toggle = monitoringText('button', 'chip-btn btn-sm', instance.enabled ? 'Pause' : 'Enable') as HTMLButtonElement;
        toggle.type = 'button';
        toggle.addEventListener('click', () => void setConnectorEnabled(instance, !instance.enabled).catch((error) => alert(error.message)));
        actions.append(sync, toggle);
        card.append(header, url, interest, timing);
        if (instance.last_error) card.append(monitoringText('p', 'agentic-error', instance.last_error));
        card.append(actions);
        connectorList.appendChild(card);
      });
      if (!instances.length) connectorList.append(monitoringText('div', 'agentic-list-empty', 'No external sources yet. Connect a public RSS or Atom feed to begin monitoring.'));
      if (connectorStatus) connectorStatus.textContent = `${instances.length} connected source${instances.length === 1 ? '' : 's'}`;
    } catch (error) {
      if (connectorStatus) connectorStatus.textContent = 'Connectors are unavailable. Check that the local kernel is running.';
      console.warn('Could not load connectors:', error);
    }
  }

  async function promoteSignal(signal: any, button: HTMLButtonElement) {
    button.disabled = true;
    button.textContent = 'Creating goal…';
    try {
      const response = await fetch(`/api/signals/${encodeURIComponent(signal.id)}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser?.username || 'alex', auto_start: false }),
      });
      const goal = await response.json();
      if (!response.ok) throw new Error(goal.detail || 'Could not create goal');
      await loadSignals();
      switchView('agentic-goals');
      setAgentWorkMode('goals');
      await fetchAndRenderAgenticGoals();
      await selectAgenticGoal(goal.id);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Create assessment goal';
      alert(error instanceof Error ? error.message : 'Could not create goal');
    }
  }

  async function loadSignals() {
    if (!signalGrid) return;
    if (signalStatus) signalStatus.textContent = 'Loading signals…';
    try {
      const minimum = Number(signalMinimumScore?.value || 0);
      const response = await fetch(`/api/signals?minimum_relevance=${minimum}&limit=100`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not load signals');
      const signals = Array.isArray(data.signals) ? data.signals : [];
      signalGrid.replaceChildren();
      signals.forEach((signal: any) => {
        const card = document.createElement('article');
        card.className = `signal-card${Number(signal.relevance_score) >= 70 ? ' is-high-relevance' : ''}`;
        const header = document.createElement('header');
        const source = monitoringText('div', 'signal-meta', `${signal.source_name || 'External source'} · ${monitoringTime(signal.published_at || signal.retrieved_at)}`);
        header.append(source, monitoringText('span', 'signal-score', signal.relevance_score));
        card.append(header, monitoringText('h4', '', signal.title || 'Untitled signal'));
        card.append(monitoringText('p', '', signal.summary || signal.content || 'No summary supplied by the feed.'));
        card.append(monitoringText('div', 'signal-reason', signal.relevance_reason || 'Relevance explanation unavailable.'));
        const actions = document.createElement('div');
        actions.className = 'signal-actions';
        if (/^https?:\/\//i.test(signal.source_url || '')) {
          const link = document.createElement('a');
          link.href = signal.source_url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Open source';
          actions.appendChild(link);
        }
        if (signal.promoted_goal_id) {
          actions.append(monitoringText('span', 'signal-promoted', 'Assessment goal created'));
        } else {
          const promote = monitoringText('button', 'save-btn btn-sm', 'Create assessment goal') as HTMLButtonElement;
          promote.type = 'button';
          promote.addEventListener('click', () => void promoteSignal(signal, promote));
          actions.appendChild(promote);
        }
        card.appendChild(actions);
        signalGrid.appendChild(card);
      });
      if (!signals.length) signalGrid.append(monitoringText('div', 'agentic-list-empty', 'No matching signals yet. Connect or synchronize a source, or lower the relevance threshold.'));
      if (signalStatus) signalStatus.textContent = `${signals.length} signal${signals.length === 1 ? '' : 's'} at relevance ${minimum}+`;
    } catch (error) {
      if (signalStatus) signalStatus.textContent = 'Signals are unavailable. Check that the local kernel is running.';
      console.warn('Could not load signals:', error);
    }
  }

  newConnectorBtn?.addEventListener('click', () => {
    void loadMonitoringProjects();
    if (connectorModal) connectorModal.style.display = 'flex';
  });
  closeConnectorModalBtn?.addEventListener('click', () => { if (connectorModal) connectorModal.style.display = 'none'; });
  connectorModal?.addEventListener('click', (event) => { if (event.target === connectorModal) connectorModal.style.display = 'none'; });
  connectorMinimum?.addEventListener('input', () => { if (connectorMinimumOutput) connectorMinimumOutput.value = connectorMinimum.value; });
  signalMinimumScore?.addEventListener('change', () => void loadSignals());
  refreshConnectorsBtn?.addEventListener('click', () => void Promise.all([loadConnectors(), loadSignals()]));
  connectorForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!connectorName || !connectorFeedUrl || !connectorInterest || !connectorProject || !connectorPollMinutes || !connectorMinimum) return;
    if (connectorFormStatus) connectorFormStatus.textContent = 'Connecting and checking the feed…';
    try {
      const response = await fetch('/api/connectors/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: connectorName.value,
          feed_url: connectorFeedUrl.value,
          username: currentUser?.username || 'alex',
          project_id: connectorProject.value,
          interest_query: connectorInterest.value,
          poll_minutes: Number(connectorPollMinutes.value),
          minimum_relevance: Number(connectorMinimum.value),
          enabled: true,
        }),
      });
      const instance = await response.json();
      if (!response.ok) throw new Error(instance.detail || 'Could not connect the feed');
      await syncConnector(instance.id);
      connectorForm.reset();
      if (connectorMinimumOutput) connectorMinimumOutput.value = '40';
      if (connectorModal) connectorModal.style.display = 'none';
      if (connectorFormStatus) connectorFormStatus.textContent = '';
    } catch (error) {
      if (connectorFormStatus) connectorFormStatus.textContent = error instanceof Error ? error.message : 'Could not connect the feed';
    }
  });

  window.addEventListener('ai-os-agent-event', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.type === 'SIGNALS_UPDATED' && viewMonitoring?.style.display !== 'none') void Promise.all([loadConnectors(), loadSignals()]);
    if (detail?.type === 'EMAIL_UPDATED' && detail.data?.username === currentUser?.username && viewEmail?.style.display !== 'none') {
      void loadEmailCenter();
    }
  });

  async function loadEmailCenter() {
    if (!emailStatus || !emailMessageList || !emailDraftList || !emailPreview) return;
    try {
      const [statusResponse, messagesResponse, draftsResponse] = await Promise.all([
        fetch('/api/email/status'), fetch('/api/email/messages'), fetch('/api/email/drafts'),
      ]);
      const status = await statusResponse.json();
      if (!status.configured) {
        emailStatus.textContent = 'Email is not configured. Add AGENTMAIL_API_KEY and AGENTMAIL_MANAGER_INBOX to the backend .env file.';
      } else {
        emailStatus.textContent = `Manager inbox: ${status.inbox_id} · Draft approval required`;
      }
      const messages = messagesResponse.ok ? (await messagesResponse.json()).messages || [] : [];
      const drafts = draftsResponse.ok ? (await draftsResponse.json()).drafts || [] : [];
      const sync = status.sync || {};
      if (emailSyncInterval) emailSyncInterval.value = String(sync.poll_minutes ?? 15);
      if (emailLastSync) emailLastSync.textContent = sync.last_error ? `Auto-sync issue: ${sync.last_error}` : (sync.last_synced_at ? `Last synced ${new Date(`${sync.last_synced_at}Z`).toLocaleString()}` : 'Not synced yet');
      const inbound = messages.filter((message: any) => message.direction === 'inbound').length;
      const pending = drafts.filter((draft: any) => draft.status === 'pending_approval').length;
      if (emailSummary) emailSummary.innerHTML = `<span>${inbound} inbox message${inbound === 1 ? '' : 's'}</span><span>${pending} awaiting approval</span><span>${sync.poll_minutes ? `Auto-sync every ${sync.poll_minutes} min` : 'Manual sync'}</span>`;
      if (!selectedEmailMessageId && messages[0]) selectedEmailMessageId = messages[0].message_id;
      if (selectedEmailMessageId && !messages.some((message: any) => message.message_id === selectedEmailMessageId)) selectedEmailMessageId = messages[0]?.message_id || '';
      emailMessageList.innerHTML = messages.length ? messages.map((message: any) => `<button class="email-message-item ${message.message_id === selectedEmailMessageId ? 'selected' : ''}" data-email-id="${escapeHtml(message.message_id)}" type="button"><span class="email-direction">${message.direction === 'inbound' ? 'IN' : 'OUT'}</span><span class="email-message-copy"><strong>${escapeHtml(message.subject || '(no subject)')}</strong><small>${escapeHtml(message.sender || '')}</small><em>${escapeHtml((message.text_body || '').slice(0, 100))}</em></span></button>`).join('') : '<p class="subtext">No synced messages yet.</p>';
      const selected = messages.find((message: any) => message.message_id === selectedEmailMessageId);
      emailPreview.innerHTML = selected ? `<div class="email-preview-header"><span class="email-direction">${selected.direction === 'inbound' ? 'INCOMING' : 'SENT'}</span><h3>${escapeHtml(selected.subject || '(no subject)')}</h3><p>From ${escapeHtml(selected.sender || 'Unknown sender')}</p></div><div class="email-preview-body">${escapeHtml(selected.text_body || 'No message body.').replace(/\n/g, '<br>')}</div><div class="email-preview-actions"><button class="chip-btn email-create-task-btn" data-email-id="${escapeHtml(selected.message_id)}" type="button">Create task</button><button class="save-btn email-reply-btn" data-email-id="${escapeHtml(selected.message_id)}" type="button">Draft reply</button></div>` : '<div class="email-empty-state"><strong>Select an email</strong><span>Read the message, then create work or prepare a reply.</span></div>';
      emailDraftList.innerHTML = drafts.length ? drafts.map((draft: any) => `<article class="email-draft-card"><span>${escapeHtml(draft.status.replace('_', ' '))}</span><strong>${escapeHtml(draft.subject || 'Reply draft')}</strong><p>${escapeHtml(draft.text_body || '').slice(0, 220)}</p>${draft.status === 'pending_approval' ? `<div class="email-draft-actions"><button class="save-btn email-send-draft-btn" data-draft-id="${escapeHtml(draft.draft_id)}" type="button">Approve & send</button><button class="cancel-btn email-reject-draft-btn" data-draft-id="${escapeHtml(draft.draft_id)}" type="button">Reject</button></div>` : ''}</article>`).join('') : '<div class="email-empty-state"><strong>No drafts awaiting approval</strong><span>AI-prepared replies will appear here for your review.</span></div>';
    } catch (error) {
      emailStatus.textContent = error instanceof Error ? error.message : 'Could not load Email Center.';
    }
  }

  async function emailAction(url: string, options: RequestInit = {}) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || 'Email action failed');
    await loadEmailCenter();
  }

  emailSyncBtn?.addEventListener('click', () => void emailAction('/api/email/sync', { method: 'POST' }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; }));
  emailSyncInterval?.addEventListener('change', () => {
    void fetch('/api/email/sync-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poll_minutes: Number(emailSyncInterval.value) }) })
      .then(async response => { const payload = await response.json(); if (!response.ok) throw new Error(payload.detail || 'Could not save auto-sync preference'); await loadEmailCenter(); })
      .catch(error => { if (emailStatus) emailStatus.textContent = error instanceof Error ? error.message : 'Could not save auto-sync preference'; });
  });
  emailMessageList?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    const messageId = button?.dataset.emailId;
    if (!button || !messageId) return;
    if (button.classList.contains('email-message-item')) {
      selectedEmailMessageId = messageId;
      void loadEmailCenter();
    } else if (button.classList.contains('email-create-task-btn')) {
      void emailAction(`/api/email/messages/${encodeURIComponent(messageId)}/create-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; });
    } else if (button.classList.contains('email-reply-btn')) {
      const text = window.prompt('Draft reply text');
      if (text) void emailAction('/api/email/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, in_reply_to: messageId }) }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; });
    }
  });
  emailPreview?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!button) return;
    const messageId = button.dataset.emailId;
    if (!messageId) return;
    if (button.classList.contains('email-create-task-btn')) void emailAction(`/api/email/messages/${encodeURIComponent(messageId)}/create-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; });
    if (button.classList.contains('email-reply-btn')) { const text = window.prompt('Draft reply text'); if (text) void emailAction('/api/email/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, in_reply_to: messageId }) }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; }); }
  });
  emailDraftList?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    const draftId = button?.dataset.draftId;
    if (!button || !draftId) return;
    const suffix = button.classList.contains('email-send-draft-btn') ? 'approve-send' : 'reject';
    if (suffix !== 'approve-send' || window.confirm('Send this approved draft externally?')) void emailAction(`/api/email/drafts/${encodeURIComponent(draftId)}/${suffix}`, { method: 'POST' }).catch(error => { if (emailStatus) emailStatus.textContent = error.message; });
  });

  function switchView(target: 'dashboard' | 'mvp-showcase' | 'customization' | 'ingestion' | 'habitat' | 'kanban' | 'agent-logs' | 'agentic-goals' | 'monitoring' | 'email') {
    tabDashboard.classList.remove('active');
    if (tabMvpShowcase) tabMvpShowcase.classList.remove('active');
    if (tabCustomization) tabCustomization.classList.remove('active');
    if (tabIngestion) tabIngestion.classList.remove('active');
    if (tabHabitat) tabHabitat.classList.remove('active');
    if (tabKanbanHeader) tabKanbanHeader.classList.remove('active');
    if (tabAgenticGoals) tabAgenticGoals.classList.remove('active');
    if (tabMonitoring) tabMonitoring.classList.remove('active');
    if (tabEmail) tabEmail.classList.remove('active');
    if (tabAgentLogs) tabAgentLogs.classList.remove('active');

    viewDashboard.style.display = target === 'dashboard' ? 'block' : 'none';
    if (viewMvpShowcase) viewMvpShowcase.style.display = target === 'mvp-showcase' ? 'block' : 'none';
    if (viewCustomization) viewCustomization.style.display = target === 'customization' ? 'flex' : 'none';
    if (viewIngestion) viewIngestion.style.display = target === 'ingestion' ? 'flex' : 'none';
    if (viewHabitat) viewHabitat.style.display = target === 'habitat' ? 'flex' : 'none';
    if (viewKanbanPage) viewKanbanPage.style.display = 'none';
    if (viewAgenticGoals) viewAgenticGoals.style.display = target === 'agentic-goals' || target === 'kanban' ? 'block' : 'none';
    if (viewMonitoring) viewMonitoring.style.display = target === 'monitoring' ? 'block' : 'none';
    if (viewEmail) viewEmail.style.display = target === 'email' ? 'block' : 'none';
    if (viewAgentLogs) viewAgentLogs.style.display = target === 'agent-logs' ? 'block' : 'none';

    if (target === 'dashboard') {
      tabDashboard.classList.add('active');
    } else if (target === 'mvp-showcase') {
      if (tabMvpShowcase) tabMvpShowcase.classList.add('active');
    } else if (target === 'customization') {
      if (tabCustomization) tabCustomization.classList.add('active');
      fetchAndRenderAgentPrompts();
      loadAgentConfiguration();
      fetchAndRenderProviderRegistry();
      fetchAndRenderApiUsage();
      fetchDBTables();
    } else if (target === 'ingestion') {
      if (tabIngestion) tabIngestion.classList.add('active');
      fetchDBTables();
    } else if (target === 'habitat') {
      if (tabHabitat) tabHabitat.classList.add('active');
      setTimeout(() => {
        visualizer.resizeCanvas();
      }, 50);
      fetchAndRenderAgentPrompts();
      loadAgentConfiguration();
    } else if (target === 'agent-logs') {
      if (tabAgentLogs) tabAgentLogs.classList.add('active');
      void fetchAndRenderAgentLogs();
    } else if (target === 'agentic-goals') {
      if (tabAgenticGoals) tabAgenticGoals.classList.add('active');
      setAgentWorkMode('goals');
      void fetchAndRenderAgenticGoals();
    } else if (target === 'monitoring') {
      if (tabMonitoring) tabMonitoring.classList.add('active');
      void Promise.all([loadConnectors(), loadSignals()]);
    } else if (target === 'email') {
      if (tabEmail) tabEmail.classList.add('active');
      void loadEmailCenter();
    } else if (target === 'kanban') {
      if (tabAgenticGoals) tabAgenticGoals.classList.add('active');
      setAgentWorkMode('board');
    }
  }

  tabDashboard.addEventListener('click', () => switchView('dashboard'));
  if (tabMvpShowcase) tabMvpShowcase.addEventListener('click', () => switchView('mvp-showcase'));
  if (tabCustomization) tabCustomization.addEventListener('click', () => switchView('customization'));
  if (tabIngestion) tabIngestion.addEventListener('click', () => switchView('ingestion'));
  if (tabHabitat) tabHabitat.addEventListener('click', () => switchView('habitat'));
  if (tabKanbanHeader) tabKanbanHeader.addEventListener('click', () => switchView('kanban'));
  if (tabAgenticGoals) tabAgenticGoals.addEventListener('click', () => switchView('agentic-goals'));
  if (tabMonitoring) tabMonitoring.addEventListener('click', () => switchView('monitoring'));
  if (tabEmail) tabEmail.addEventListener('click', () => switchView('email'));
  if (tabAgentLogs) tabAgentLogs.addEventListener('click', () => switchView('agent-logs'));
  if (refreshAgentLogsBtn) refreshAgentLogsBtn.addEventListener('click', () => void fetchAndRenderAgentLogs());
  if (backToDashboardBtn) backToDashboardBtn.addEventListener('click', () => switchView('dashboard'));

  // Supervisor-facing MVP showcase. All interactions are local, illustrative UI only.
  const mvpOverviewTab = document.getElementById('mvp-overview-tab') as HTMLButtonElement | null;
  const mvpConfigTab = document.getElementById('mvp-config-tab') as HTMLButtonElement | null;
  const mvpConnectTab = document.getElementById('mvp-connect-tab') as HTMLButtonElement | null;
  const mvpOverviewPanel = document.getElementById('mvp-overview-panel') as HTMLDivElement | null;
  const mvpConfigPanel = document.getElementById('mvp-config-panel') as HTMLDivElement | null;
  const mvpConnectPanel = document.getElementById('mvp-connect-panel') as HTMLDivElement | null;
  const mvpRunDemoBtn = document.getElementById('mvp-run-demo-btn') as HTMLButtonElement | null;
  const mvpDemoStatus = document.getElementById('mvp-demo-status') as HTMLSpanElement | null;
  const mvpPreviewContextBtn = document.getElementById('mvp-preview-context-btn') as HTMLButtonElement | null;
  const mvpGoalInput = document.getElementById('mvp-context-goal') as HTMLTextAreaElement | null;
  const mvpRegionInput = document.getElementById('mvp-context-region') as HTMLInputElement | null;
  const mvpDeadlineInput = document.getElementById('mvp-context-deadline') as HTMLInputElement | null;
  const mvpFocusInput = document.getElementById('mvp-context-focus') as HTMLSelectElement | null;
  const mvpPreviewGoal = document.getElementById('mvp-preview-goal') as HTMLElement | null;
  const mvpPreviewRegion = document.getElementById('mvp-preview-region') as HTMLElement | null;
  const mvpPreviewFocus = document.getElementById('mvp-preview-focus') as HTMLElement | null;
  const mvpContextSaved = document.getElementById('mvp-context-saved') as HTMLSpanElement | null;
  const mvpWeightInputs = Array.from(document.querySelectorAll('.mvp-weight-input')) as HTMLInputElement[];
  const mvpWeightTotal = document.getElementById('mvp-weight-total') as HTMLSpanElement | null;

  function showMvpPanel(target: 'overview' | 'config' | 'connect') {
    if (mvpOverviewPanel) mvpOverviewPanel.style.display = target === 'overview' ? 'block' : 'none';
    if (mvpConfigPanel) mvpConfigPanel.style.display = target === 'config' ? 'block' : 'none';
    if (mvpConnectPanel) mvpConnectPanel.style.display = target === 'connect' ? 'block' : 'none';
    mvpOverviewTab?.classList.toggle('active', target === 'overview');
    mvpConfigTab?.classList.toggle('active', target === 'config');
    mvpConnectTab?.classList.toggle('active', target === 'connect');
  }

  mvpOverviewTab?.addEventListener('click', () => showMvpPanel('overview'));
  mvpConfigTab?.addEventListener('click', () => showMvpPanel('config'));
  mvpConnectTab?.addEventListener('click', () => showMvpPanel('connect'));

  const mvpLiveSignalList = document.getElementById('mvp-live-signal-list') as HTMLDivElement | null;
  const mvpLiveSignalCount = document.getElementById('mvp-live-signal-count') as HTMLSpanElement | null;
  const mvpKpi = (id: string, value: number, max = 10) => { const valueEl = document.getElementById(`mvp-kpi-${id}`); const bar = document.getElementById(`mvp-kpi-${id}-bar`) as HTMLElement | null; if (valueEl) valueEl.textContent = String(value); if (bar) bar.style.width = `${Math.min(100, Math.round((value / Math.max(1, max)) * 100))}%`; };
  const relativeTime = (value: unknown) => {
    const date = new Date(String(value || ''));
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (Number.isNaN(minutes)) return 'Recently';
    if (minutes < 60) return `${minutes || 1}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  };
  async function loadMvpLiveSignals() {
    if (!mvpLiveSignalList) return;
    try {
      const [signalResponse, connectorResponse, goalResponse] = await Promise.all([fetch('/api/signals?minimum_relevance=0&limit=100'), fetch('/api/connectors/instances'), fetch('/api/agentic/goals?limit=100')]);
      const data = await signalResponse.json();
      const connectorData = await connectorResponse.json();
      const goalData = await goalResponse.json();
      if (!signalResponse.ok) throw new Error(data.detail || 'Could not load live signals');
      const signals = Array.isArray(data.signals) ? data.signals : [];
      const sources = Array.isArray(connectorData.instances) ? connectorData.instances : [];
      const goals = Array.isArray(goalData.goals) ? goalData.goals : [];
      mvpKpi('sources', sources.length, 6); mvpKpi('signals', signals.length, 50); mvpKpi('high', signals.filter((item: any) => Number(item.relevance_score) >= 70).length, Math.max(1, signals.length)); mvpKpi('goals', goals.length, 10);
      mvpLiveSignalList.replaceChildren();
      signals.slice(0, 3).forEach((signal: any, index: number) => {
        const card = document.createElement('article');
        card.className = `mvp-signal-card${index === 0 ? ' featured' : ''}`;
        const top = document.createElement('div'); top.className = 'mvp-signal-top';
        top.append(monitoringText('span', 'mvp-source-pill', signal.source_name || 'RSS source'), monitoringText('span', '', relativeTime(signal.published_at || signal.retrieved_at)));
        card.append(top, monitoringText('h4', '', signal.title || 'Untitled signal'), monitoringText('p', '', signal.summary || signal.content || 'No summary was provided.'));
        const footer = document.createElement('div'); footer.className = 'mvp-signal-footer';
        footer.append(monitoringText('span', '', `Relevance ${signal.relevance_score || 0}%`));
        if (/^https?:\/\//i.test(signal.source_url || '')) { const link = document.createElement('a'); link.className = 'mvp-text-action'; link.href = signal.source_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Read source'; footer.append(link); }
        card.append(footer); mvpLiveSignalList.append(card);
      });
      if (!signals.length) mvpLiveSignalList.append(monitoringText('p', 'subtext', 'No live signals yet. Add the free RSS starter pack, then allow the first sync to complete.'));
      if (mvpLiveSignalCount) mvpLiveSignalCount.textContent = `${signals.length} live signal${signals.length === 1 ? '' : 's'}`;
      if (mvpDemoStatus) mvpDemoStatus.textContent = signals.length ? 'Live RSS signals ready' : 'RSS starter pack not connected';
    } catch { if (mvpDemoStatus) mvpDemoStatus.textContent = 'Live sources unavailable'; }
  }
  mvpRunDemoBtn?.addEventListener('click', async () => {
    if (!mvpDemoStatus || !mvpRunDemoBtn) return;
    mvpRunDemoBtn.disabled = true; mvpDemoStatus.textContent = 'Connecting free sources and starting their first sync…';
    try {
      const response = await fetch('/api/connectors/recommended/add', { method: 'POST' }); const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Could not connect recommended feeds');
      mvpDemoStatus.textContent = data.count ? `${data.count} free feeds connected · syncing now` : 'Starter pack already connected · refreshing live wall';
      window.setTimeout(() => void loadMvpLiveSignals(), 2500);
    } catch (error) { mvpDemoStatus.textContent = error instanceof Error ? error.message : 'Could not connect sources'; }
    finally { mvpRunDemoBtn.disabled = false; }
  });
  void loadMvpLiveSignals();

  function buildMvpContextPreview() {
    if (mvpPreviewGoal && mvpGoalInput) mvpPreviewGoal.textContent = mvpGoalInput.value.trim() || 'No goal configured';
    if (mvpPreviewRegion && mvpRegionInput && mvpDeadlineInput) {
      const deadline = mvpDeadlineInput.value
        ? new Date(`${mvpDeadlineInput.value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        : 'no deadline';
      mvpPreviewRegion.textContent = `${mvpRegionInput.value.trim() || 'No region'} · target ${deadline}`;
    }
    if (mvpPreviewFocus && mvpFocusInput) mvpPreviewFocus.textContent = `${mvpFocusInput.value} · structured opportunity cards`;
    if (mvpContextSaved) {
      mvpContextSaved.textContent = 'Context preview updated · prototype only';
      window.setTimeout(() => { if (mvpContextSaved) mvpContextSaved.textContent = 'Prototype only · not saved'; }, 2200);
    }
  }

  mvpPreviewContextBtn?.addEventListener('click', buildMvpContextPreview);

  function updateMvpWeightTotal() {
    if (!mvpWeightTotal) return;
    const total = mvpWeightInputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    mvpWeightTotal.textContent = total === 100 ? '100% allocated' : `${total}% allocated · adjust to 100%`;
    mvpWeightTotal.classList.toggle('invalid', total !== 100);
  }
  mvpWeightInputs.forEach(input => input.addEventListener('input', updateMvpWeightTotal));

  // Document Upload Modal Hooks
  const btnUploadDoc = document.getElementById('btn-upload-doc');
  const addNotebookBtn = document.querySelector('.add-notebook-btn');
  const newNotebookBtn = document.getElementById('new-notebook-btn');
  const docUploadModal = document.getElementById('doc-upload-modal');
  const closeUploadModalBtn = document.getElementById('close-upload-modal-btn');
  const fileInputPage = document.getElementById('file-input-page') as HTMLInputElement | null;
  const selectFileBtnPage = document.getElementById('select-file-btn-page');
  const dropZonePage = document.getElementById('drop-zone-page');
  const uploadStatusPage = document.getElementById('upload-status-page');
  const uploadNotebookSelect = document.getElementById('upload-notebook-select') as HTMLSelectElement | null;
  const notebookListContainer = document.getElementById('notebook-list-container');
  const notebookSourcesList = document.createElement('div');
  const summaryText = document.getElementById('summary-text');
  const activeContextBadge = document.getElementById('active-context-badge');
  const knowledgeScopeStatus = document.getElementById('knowledge-scope-status');
  const deepResearchMode = document.getElementById('deep-research-mode') as HTMLInputElement | null;
  const composerActions = deepResearchMode?.closest('details') as HTMLDetailsElement | null;
  const projectWorkspaceModal = document.getElementById('project-workspace-modal') as HTMLDivElement | null;
  const projectWorkspaceForm = document.getElementById('project-workspace-form') as HTMLFormElement | null;
  const closeProjectWorkspaceBtn = document.getElementById('close-project-workspace-btn') as HTMLButtonElement | null;
  const projectWorkspaceName = document.getElementById('project-workspace-name') as HTMLInputElement | null;
  const projectCompanySelect = document.getElementById('project-company-select') as HTMLSelectElement | null;
  const projectWorkspaceDescription = document.getElementById('project-workspace-description') as HTMLTextAreaElement | null;
  const projectWorkspaceBrief = document.getElementById('project-workspace-brief') as HTMLTextAreaElement | null;
  const projectWorkspaceBoundary = document.getElementById('project-workspace-boundary') as HTMLTextAreaElement | null;
  const projectWorkspaceStatus = document.getElementById('project-workspace-status') as HTMLSpanElement | null;
  const projectWorkspaceTitle = document.getElementById('project-workspace-title') as HTMLElement | null;
  const projectWorkspaceSubmit = document.getElementById('project-workspace-submit') as HTMLButtonElement | null;
  const businessContextSummary = document.getElementById('business-context-summary') as HTMLElement | null;
  const openDnaContextBtn = document.getElementById('open-dna-context-btn') as HTMLButtonElement | null;
  const openCompaniesContextBtn = document.getElementById('open-companies-context-btn') as HTMLButtonElement | null;
  const dnaContextModal = document.getElementById('dna-context-modal') as HTMLDivElement | null;
  const companiesContextModal = document.getElementById('companies-context-modal') as HTMLDivElement | null;
  const closeDnaContextBtn = document.getElementById('close-dna-context-btn') as HTMLButtonElement | null;
  const closeCompaniesContextBtn = document.getElementById('close-companies-context-btn') as HTMLButtonElement | null;
  const organizationContextForm = document.getElementById('organization-context-form') as HTMLFormElement | null;
  const organizationContextName = document.getElementById('organization-context-name') as HTMLInputElement | null;
  const organizationContextMission = document.getElementById('organization-context-mission') as HTMLTextAreaElement | null;
  const organizationContextPriorities = document.getElementById('organization-context-priorities') as HTMLTextAreaElement | null;
  const organizationContextConstraints = document.getElementById('organization-context-constraints') as HTMLTextAreaElement | null;
  const organizationContextPrinciples = document.getElementById('organization-context-principles') as HTMLTextAreaElement | null;
  const organizationContextStatus = document.getElementById('organization-context-status') as HTMLElement | null;
  const partnerCompanyForm = document.getElementById('partner-company-form') as HTMLFormElement | null;
  const partnerCompanyName = document.getElementById('partner-company-name') as HTMLInputElement | null;
  const partnerCompanyContext = document.getElementById('partner-company-context') as HTMLTextAreaElement | null;
  const partnerCompanyPriorities = document.getElementById('partner-company-priorities') as HTMLTextAreaElement | null;
  const partnerCompanyConstraints = document.getElementById('partner-company-constraints') as HTMLTextAreaElement | null;
  const partnerCompanyStatus = document.getElementById('partner-company-status') as HTMLElement | null;
  const partnerCompanySaveBtn = document.getElementById('partner-company-save-btn') as HTMLButtonElement | null;
  const partnerCompanyList = document.getElementById('partner-company-list') as HTMLElement | null;
  let activeProjectId: string | null = null;
  type PartnerCompany = { id: string; name: string; context_md?: string; priorities_md?: string; constraints_md?: string };
  type ProjectWorkspace = { id: string; name: string; company_id?: string; company_name?: string; description?: string; project_brief_md?: string; knowledge_boundary_md?: string; doc_names: string[] };
  let projectWorkspaces: ProjectWorkspace[] = [];
  let partnerCompanies: PartnerCompany[] = [];
  let editingCompanyId: string | null = null;
  let editingProjectId: string | null = null;
  const selectedSourcesByProject = new Map<string, Set<string>>();
  const selectedProjectIds = new Set<string>();

  const selectedNotebookIds = () => Array.from(selectedProjectIds);
  const selectedSourceDocumentNames = () => projectWorkspaces
    .filter((project) => selectedProjectIds.has(project.id))
    .flatMap((project) => project.doc_names || []);
  const selectedProjectScopeId = () => {
    const ids = selectedNotebookIds().sort();
    return ids.length ? `projects:${ids.join('|')}` : '';
  };
  // Ordinary chat stays fast and local by default. The separate Deep Research
  // action explicitly opts into public-web research below.
  const selectedResearchMode = () => 'auto';

  const updateResearchModeBadge = () => {
    if (!activeContextBadge) return;
    if (deepResearchMode?.checked) {
      activeContextBadge.textContent = 'Deep research workflow enabled';
      return;
    }
    const selectedCount = selectedProjectIds.size;
    if (!selectedCount) {
      activeContextBadge.textContent = 'Reasoning & Internet';
    } else {
      activeContextBadge.textContent = `${selectedCount} project${selectedCount === 1 ? '' : 's'} + Internet`;
    }
  };

  const updateProjectKnowledgeScope = () => {
    const selectedProjects = projectWorkspaces.filter((project) => selectedProjectIds.has(project.id));
    const selectedSources = selectedSourceDocumentNames();
    if (summaryText) {
      summaryText.textContent = selectedProjects.length
        ? `${selectedProjects.map((project) => project.name).join(', ')} · ${selectedSources.length} file${selectedSources.length === 1 ? '' : 's'} in scope`
        : 'No project selected · web and general reasoning only';
    }
    if (knowledgeScopeStatus) {
      knowledgeScopeStatus.textContent = selectedProjects.length
        ? `${selectedProjects.length} project${selectedProjects.length === 1 ? '' : 's'} selected · all folder files available to agents`
        : 'Select one or more project folders for internal RAG';
      knowledgeScopeStatus.classList.toggle('is-grounded', selectedProjects.length > 0);
    }
  };

  const businessContextApiBase = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';

  function renderPartnerCompanyOptions(selectedCompanyId: string = '') {
    if (!projectCompanySelect) return;
    projectCompanySelect.replaceChildren();
    const internal = document.createElement('option');
    internal.value = '';
    internal.textContent = 'Internal project';
    projectCompanySelect.appendChild(internal);
    partnerCompanies.forEach((company) => {
      const option = document.createElement('option');
      option.value = company.id;
      option.textContent = company.name;
      option.selected = company.id === selectedCompanyId;
      projectCompanySelect.appendChild(option);
    });
    projectCompanySelect.value = selectedCompanyId;
  }

  function resetPartnerCompanyForm() {
    editingCompanyId = null;
    if (partnerCompanyForm) partnerCompanyForm.reset();
    if (partnerCompanyStatus) partnerCompanyStatus.textContent = '';
    if (partnerCompanySaveBtn) partnerCompanySaveBtn.textContent = 'Save partner company';
  }

  function renderPartnerCompanyList() {
    if (!partnerCompanyList) return;
    partnerCompanyList.replaceChildren();
    if (!partnerCompanies.length) {
      const empty = document.createElement('p');
      empty.className = 'business-context-empty';
      empty.textContent = 'No partner companies yet. Internal projects do not need one.';
      partnerCompanyList.appendChild(empty);
      return;
    }
    partnerCompanies.forEach((company) => {
      const item = document.createElement('div');
      item.className = 'partner-company-item';

      const content = document.createElement('div');
      content.className = 'partner-company-item-content';

      const title = document.createElement('strong');
      title.textContent = company.name;
      const detail = document.createElement('span');
      detail.textContent = company.context_md || company.priorities_md || 'Company context ready to edit';
      content.append(title, detail);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'partner-company-delete-btn';
      deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
      deleteBtn.title = 'Delete company';

      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Are you sure you want to delete ${company.name}?`)) return;
        try {
          const response = await fetch(`${businessContextApiBase()}/api/business-context/companies/${encodeURIComponent(company.id)}`, {
            method: 'DELETE'
          });
          if (!response.ok) throw new Error(await response.text());
          await loadBusinessContext();
        } catch (error) {
          console.error('Failed to delete company:', error);
          if (partnerCompanyStatus) partnerCompanyStatus.textContent = 'Error deleting company.';
        }
      });

      item.addEventListener('click', () => {
        editingCompanyId = company.id;
        if (partnerCompanyName) partnerCompanyName.value = company.name || '';
        if (partnerCompanyContext) partnerCompanyContext.value = company.context_md || '';
        if (partnerCompanyPriorities) partnerCompanyPriorities.value = company.priorities_md || '';
        if (partnerCompanyConstraints) partnerCompanyConstraints.value = company.constraints_md || '';
        if (partnerCompanySaveBtn) partnerCompanySaveBtn.textContent = 'Update partner company';
        if (partnerCompanyStatus) partnerCompanyStatus.textContent = `Editing ${company.name}`;
      });

      item.append(content, deleteBtn);
      partnerCompanyList.appendChild(item);
    });
  }

  async function loadBusinessContext() {
    try {
      const response = await fetch(`${businessContextApiBase()}/api/business-context`);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      const organization = payload.organization || {};
      partnerCompanies = Array.isArray(payload.companies) ? payload.companies : [];
      if (organizationContextName) organizationContextName.value = organization.name || 'The Company';
      if (organizationContextMission) organizationContextMission.value = organization.mission_md || '';
      if (organizationContextPriorities) organizationContextPriorities.value = organization.priorities_md || '';
      if (organizationContextConstraints) organizationContextConstraints.value = organization.constraints_md || '';
      if (organizationContextPrinciples) organizationContextPrinciples.value = organization.decision_principles_md || '';
      if (businessContextSummary) {
        businessContextSummary.textContent = organization.mission_md || organization.priorities_md || organization.constraints_md
          ? `${organization.name || 'The Company'} DNA active · ${partnerCompanies.length} partner ${partnerCompanies.length === 1 ? 'company' : 'companies'}`
          : 'Add Organization DNA to guide every project answer';
      }
      renderPartnerCompanyOptions(projectCompanySelect?.value || '');
      renderPartnerCompanyList();
    } catch (error) {
      if (businessContextSummary) businessContextSummary.textContent = 'Business context is unavailable. Check the local kernel.';
      console.warn('Could not load business context:', error);
    }
  }

  function closeBusinessContext() {
    if (dnaContextModal) dnaContextModal.style.display = 'none';
    if (companiesContextModal) companiesContextModal.style.display = 'none';
    resetPartnerCompanyForm();
  }

  async function openDnaContext() {
    await loadBusinessContext();
    if (dnaContextModal) dnaContextModal.style.display = 'flex';
  }

  async function openCompaniesContext() {
    await loadBusinessContext();
    if (companiesContextModal) companiesContextModal.style.display = 'flex';
  }

  function openProjectWorkspace(project?: ProjectWorkspace) {
    editingProjectId = project?.id || null;
    if (projectWorkspaceForm) projectWorkspaceForm.reset();
    renderPartnerCompanyOptions(project?.company_id || '');
    if (projectWorkspaceName) projectWorkspaceName.value = project?.name || '';
    if (projectWorkspaceDescription) projectWorkspaceDescription.value = project?.description || '';
    if (projectWorkspaceBrief) projectWorkspaceBrief.value = project?.project_brief_md || '';
    if (projectWorkspaceBoundary) projectWorkspaceBoundary.value = project?.knowledge_boundary_md || '';
    if (projectWorkspaceTitle) projectWorkspaceTitle.textContent = project ? 'Edit project workspace' : 'Create project workspace';
    if (projectWorkspaceSubmit) projectWorkspaceSubmit.textContent = project ? 'Save project' : 'Create project';
    if (projectWorkspaceStatus) projectWorkspaceStatus.textContent = '';
    if (projectWorkspaceModal) projectWorkspaceModal.style.display = 'flex';
  }

  if (openDnaContextBtn) openDnaContextBtn.addEventListener('click', () => void openDnaContext());
  if (openCompaniesContextBtn) openCompaniesContextBtn.addEventListener('click', () => void openCompaniesContext());

  if (closeDnaContextBtn) closeDnaContextBtn.addEventListener('click', closeBusinessContext);
  if (closeCompaniesContextBtn) closeCompaniesContextBtn.addEventListener('click', closeBusinessContext);

  if (dnaContextModal) dnaContextModal.addEventListener('click', (event) => {
    if (event.target === dnaContextModal) closeBusinessContext();
  });
  if (companiesContextModal) companiesContextModal.addEventListener('click', (event) => {
    if (event.target === companiesContextModal) closeBusinessContext();
  });
  if (organizationContextForm) organizationContextForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (organizationContextStatus) organizationContextStatus.textContent = 'Saving Organization DNA…';
    try {
      const response = await fetch(`${businessContextApiBase()}/api/business-context/organization`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: organizationContextName?.value || 'The Company',
          mission_md: organizationContextMission?.value || '',
          priorities_md: organizationContextPriorities?.value || '',
          constraints_md: organizationContextConstraints?.value || '',
          decision_principles_md: organizationContextPrinciples?.value || '',
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (organizationContextStatus) organizationContextStatus.textContent = 'Organization DNA saved.';
      await loadBusinessContext();
    } catch (error) {
      if (organizationContextStatus) organizationContextStatus.textContent = error instanceof Error ? error.message : 'Could not save Organization DNA.';
    }
  });
  if (partnerCompanyForm) partnerCompanyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!partnerCompanyName?.value.trim()) {
      if (partnerCompanyStatus) partnerCompanyStatus.textContent = 'A company name is required.';
      return;
    }
    if (partnerCompanyStatus) partnerCompanyStatus.textContent = 'Saving partner company…';
    try {
      const response = await fetch(
        `${businessContextApiBase()}/api/business-context/companies${editingCompanyId ? `/${encodeURIComponent(editingCompanyId)}` : ''}`,
        {
          method: editingCompanyId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: partnerCompanyName.value,
            context_md: partnerCompanyContext?.value || '',
            priorities_md: partnerCompanyPriorities?.value || '',
            constraints_md: partnerCompanyConstraints?.value || '',
          }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      await loadBusinessContext();
      resetPartnerCompanyForm();
      if (partnerCompanyStatus) partnerCompanyStatus.textContent = 'Partner company saved.';
    } catch (error) {
      if (partnerCompanyStatus) partnerCompanyStatus.textContent = error instanceof Error ? error.message : 'Could not save partner company.';
    }
  });

  refreshNotebookWorkspace = async () => {
    if (!notebookListContainer || !notebookSourcesList) return;
    try {
      const response = await fetch('/api/notebooks');
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      projectWorkspaces = Array.isArray(payload.notebooks) ? payload.notebooks : [];
      if (!activeProjectId || !projectWorkspaces.some((project) => project.id === activeProjectId)) {
        activeProjectId = projectWorkspaces[0]?.id || null;
      }
      projectWorkspaces.forEach((project) => {
        const validNames = new Set(project.doc_names || []);
        const existing = selectedSourcesByProject.get(project.id) || new Set<string>();
        selectedSourcesByProject.set(project.id, new Set(Array.from(existing).filter((name) => validNames.has(name))));
      });

      notebookListContainer.replaceChildren();
      projectWorkspaces.forEach((project) => {
        const item = document.createElement('div');
        item.className = `notebook-item project-workspace-item${project.id === activeProjectId ? ' active-project' : ''}`;
        item.dataset.notebookId = project.id;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'notebook-checkbox';
        checkbox.id = `project-${project.id}`;
        const sourceNames = project.doc_names || [];
        const selectedNames = selectedSourcesByProject.get(project.id) || new Set<string>();
        checkbox.checked = sourceNames.length > 0 && sourceNames.every((name) => selectedNames.has(name));
        checkbox.indeterminate = selectedNames.size > 0 && !checkbox.checked;
        const label = document.createElement('label');
        label.className = 'project-workspace-label';
        const title = document.createElement('span');
        title.className = 'notebook-title';
        title.textContent = `🗂️ ${project.name}`;
        const count = document.createElement('span');
        count.className = 'project-source-count';
        count.textContent = `${selectedNames.size}/${sourceNames.length}`;
        label.append(title, count);
        if (project.description) {
          const description = document.createElement('span');
          description.className = 'project-workspace-description';
          description.textContent = project.description;
          label.appendChild(description);
        }
        checkbox.addEventListener('change', () => {
          activeProjectId = project.id;
          selectedSourcesByProject.set(project.id, checkbox.checked ? new Set(sourceNames) : new Set());
          refreshNotebookWorkspace?.();
        });
        label.addEventListener('click', () => {
          activeProjectId = project.id;
          refreshNotebookWorkspace?.();
        });
        item.append(checkbox, label);
        notebookListContainer.appendChild(item);
      });

      notebookSourcesList.replaceChildren();
      const activeProject = projectWorkspaces.find((project) => project.id === activeProjectId);
      const sources = activeProject?.doc_names || [];
      const selectedSources = activeProjectId ? (selectedSourcesByProject.get(activeProjectId) || new Set<string>()) : new Set<string>();
      if (!activeProject) {
        notebookSourcesList.textContent = 'Create or select a project workspace to manage its knowledge tree.';
      } else if (!sources.length) {
        notebookSourcesList.textContent = 'No sources in this project yet. Use + to upload shared project material.';
      } else {
        sources.forEach(fileName => {
          const item = document.createElement('div');
          item.className = 'notebook-item project-source-item';
          const sourceCheckbox = document.createElement('input');
          sourceCheckbox.type = 'checkbox';
          sourceCheckbox.className = 'notebook-checkbox project-source-checkbox';
          sourceCheckbox.id = `source-${activeProject.id}-${fileName}`;
          sourceCheckbox.checked = selectedSources.has(fileName);
          const name = document.createElement('span');
          name.className = 'notebook-title';
          name.textContent = `📄 ${fileName}`;
          name.title = 'Check to allow this source in the AI Board Member and delegated-agent context.';
          sourceCheckbox.addEventListener('change', () => {
            if (sourceCheckbox.checked) selectedSources.add(fileName);
            else selectedSources.delete(fileName);
            if (activeProjectId) selectedSourcesByProject.set(activeProjectId, selectedSources);
            refreshNotebookWorkspace?.();
          });
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'remove-source-btn';
          remove.textContent = '×';
          remove.title = 'Remove source from this project. The original document is preserved.';
          remove.addEventListener('click', async () => {
            if (!activeProjectId || !confirm(`Remove ${fileName} from this project?`)) return;
            try {
              const res = await fetch(`/api/notebooks/${encodeURIComponent(activeProjectId)}/documents/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
              if (!res.ok) throw new Error(await res.text());
              selectedSources.delete(fileName);
              await refreshNotebookWorkspace?.();
            } catch (err) {
              console.error('Failed to remove document source:', err);
              alert(`Could not remove document: ${err instanceof Error ? err.message : 'network error'}`);
            }
          });
          item.append(sourceCheckbox, name, remove);
          notebookSourcesList.appendChild(item);
        });
      }

      if (uploadNotebookSelect) {
        uploadNotebookSelect.replaceChildren();
        projectWorkspaces.forEach((project) => {
          const option = document.createElement('option');
          option.value = project.id;
          option.textContent = project.name;
          option.selected = project.id === activeProjectId;
          uploadNotebookSelect.appendChild(option);
        });
      }
      updateProjectKnowledgeScope();
      updateResearchModeBadge();
    } catch (error) {
      console.error('Could not load project workspaces:', error);
      notebookListContainer.textContent = 'Project workspace service unavailable.';
    }
  };

  // Unified folder tree: selecting a project includes every file beneath it.
  refreshNotebookWorkspace = async () => {
    if (!notebookListContainer) return;
    try {
      const response = await fetch('/api/notebooks');
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      projectWorkspaces = Array.isArray(payload.notebooks) ? payload.notebooks : [];
      const validIds = new Set(projectWorkspaces.map((project) => project.id));
      Array.from(selectedProjectIds).forEach((id) => { if (!validIds.has(id)) selectedProjectIds.delete(id); });
      if (!activeProjectId || !validIds.has(activeProjectId)) activeProjectId = projectWorkspaces[0]?.id || null;

      notebookListContainer.replaceChildren();
      if (!projectWorkspaces.length) {
        notebookListContainer.textContent = 'Create a project folder, then add files to begin.';
      }

      projectWorkspaces.forEach((project) => {
        const folder = document.createElement('section');
        folder.className = 'project-tree-folder';

        const header = document.createElement('div');
        header.className = `project-tree-header${selectedProjectIds.has(project.id) ? ' is-selected' : ''}`;
        header.addEventListener('click', () => {
          activeProjectId = project.id;
          if (selectedProjectIds.has(project.id)) {
            selectedProjectIds.delete(project.id);
          } else {
            selectedProjectIds.add(project.id);
          }
          updateProjectKnowledgeScope();
          updateResearchModeBadge();
          void refreshNotebookWorkspace?.();
        });

        const icon = document.createElement('span');
        icon.className = 'project-tree-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

        const title = document.createElement('span');
        title.className = 'project-tree-title';
        title.textContent = project.name;

        const actions = document.createElement('div');
        actions.className = 'project-tree-actions';

        const editProject = document.createElement('button');
        editProject.type = 'button';
        editProject.className = 'project-tree-action-btn';
        editProject.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
        editProject.title = `Edit context for ${project.name}`;
        editProject.addEventListener('click', async (e) => {
          e.stopPropagation();
          await loadBusinessContext();
          openProjectWorkspace(project);
        });

        const addFile = document.createElement('button');
        addFile.type = 'button';
        addFile.className = 'project-tree-action-btn';
        addFile.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        addFile.title = `Add a file to ${project.name}`;
        addFile.addEventListener('click', async (e) => {
          e.stopPropagation();
          activeProjectId = project.id;
          await openDocumentUpload();
        });

        actions.append(editProject, addFile);
        header.append(icon, title, actions);
        folder.appendChild(header);

        if (selectedProjectIds.has(project.id)) {
          const files = document.createElement('div');
          files.className = 'project-tree-files';
          const documentNames = project.doc_names || [];
          if (!documentNames.length) {
            const empty = document.createElement('div');
            empty.className = 'project-tree-empty';
            empty.textContent = 'No files yet';
            files.appendChild(empty);
          }
          documentNames.forEach((fileName) => {
            const file = document.createElement('div');
            file.className = 'project-tree-file-item';

            const fileIcon = document.createElement('span');
            fileIcon.className = 'project-tree-icon';
            fileIcon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';

            const name = document.createElement('span');
            name.className = 'project-tree-title';
            name.textContent = fileName;
            name.title = `${fileName} is included whenever ${project.name} is selected.`;

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'project-tree-action-btn';
            remove.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
            remove.title = `Remove ${fileName} from ${project.name}`;
            remove.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (!confirm(`Remove ${fileName} from ${project.name}?`)) return;
              try {
                const res = await fetch(`/api/notebooks/${encodeURIComponent(project.id)}/documents/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(await res.text());
                await refreshNotebookWorkspace?.();
              } catch (err) {
                console.error('Failed to remove document from project:', err);
                alert(`Could not remove document: ${err instanceof Error ? err.message : 'network error'}`);
              }
            });

            file.append(fileIcon, name, remove);
            files.appendChild(file);
          });
          folder.appendChild(files);
        }
        notebookListContainer.appendChild(folder);
      });

      if (uploadNotebookSelect) {
        uploadNotebookSelect.replaceChildren();
        projectWorkspaces.forEach((project) => {
          const option = document.createElement('option');
          option.value = project.id;
          option.textContent = project.name;
          option.selected = project.id === activeProjectId;
          uploadNotebookSelect.appendChild(option);
        });
      }
      updateProjectKnowledgeScope();
      updateResearchModeBadge();
    } catch (error) {
      console.error('Could not load project folders:', error);
      notebookListContainer.textContent = 'Project folder service unavailable.';
    }
  };

  const openDocumentUpload = async () => {
    await refreshNotebookWorkspace?.();
    if (docUploadModal) docUploadModal.style.display = 'flex';
  };
  if (btnUploadDoc) btnUploadDoc.addEventListener('click', openDocumentUpload);
  if (addNotebookBtn) addNotebookBtn.addEventListener('click', openDocumentUpload);

  if (closeUploadModalBtn && docUploadModal) {
    closeUploadModalBtn.addEventListener('click', () => {
      docUploadModal.style.display = 'none';
    });
  }
  if (selectFileBtnPage && fileInputPage) selectFileBtnPage.addEventListener('click', () => fileInputPage.click());

  const uploadDocument = async (file: File) => {
    if (!uploadNotebookSelect?.value) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('notebook_id', uploadNotebookSelect.value);
    if (uploadStatusPage) { uploadStatusPage.style.display = 'block'; uploadStatusPage.textContent = `Indexing ${file.name}…`; }
    try {
      const response = await fetch('/api/documents/upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await response.text());
      if (uploadStatusPage) uploadStatusPage.textContent = `${file.name} is ready in this project's knowledge tree.`;
      await refreshNotebookWorkspace?.();
    } catch (error) {
      if (uploadStatusPage) uploadStatusPage.textContent = `Upload failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  };
  if (fileInputPage) fileInputPage.addEventListener('change', () => { const file = fileInputPage.files?.[0]; if (file) uploadDocument(file); });
  if (dropZonePage) {
    dropZonePage.addEventListener('dragover', event => event.preventDefault());
    dropZonePage.addEventListener('drop', event => { event.preventDefault(); const file = event.dataTransfer?.files?.[0]; if (file) uploadDocument(file); });
  }
  const closeProjectWorkspace = () => {
    if (projectWorkspaceModal) projectWorkspaceModal.style.display = 'none';
    if (projectWorkspaceStatus) projectWorkspaceStatus.textContent = '';
    editingProjectId = null;
  };
  if (newNotebookBtn) newNotebookBtn.addEventListener('click', () => void (async () => {
    await loadBusinessContext();
    openProjectWorkspace();
  })());
  if (closeProjectWorkspaceBtn) closeProjectWorkspaceBtn.addEventListener('click', closeProjectWorkspace);
  if (projectWorkspaceModal) projectWorkspaceModal.addEventListener('click', (event) => {
    if (event.target === projectWorkspaceModal) closeProjectWorkspace();
  });
  if (projectWorkspaceForm && projectWorkspaceName && projectWorkspaceDescription && projectWorkspaceBrief && projectWorkspaceBoundary) {
    projectWorkspaceForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (projectWorkspaceStatus) projectWorkspaceStatus.textContent = 'Creating project…';
      try {
        if (editingProjectId) {
          const response = await fetch(`/api/notebooks/${encodeURIComponent(editingProjectId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: projectWorkspaceName.value,
              company_id: projectCompanySelect?.value || '',
              description: projectWorkspaceDescription.value,
              project_brief_md: projectWorkspaceBrief.value,
              knowledge_boundary_md: projectWorkspaceBoundary.value,
            }),
          });
          if (!response.ok) throw new Error(await response.text());
          activeProjectId = editingProjectId;
          closeProjectWorkspace();
          await refreshNotebookWorkspace?.();
          return;
        }
        const response = await fetch('/api/notebooks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projectWorkspaceName.value,
            company_id: projectCompanySelect?.value || '',
            description: projectWorkspaceDescription.value,
            project_brief_md: projectWorkspaceBrief.value,
            knowledge_boundary_md: projectWorkspaceBoundary.value,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const created = await response.json();
        const createdProjectId = String(created.notebook_id || '');
        if (!createdProjectId) throw new Error('Kernel did not return a project ID.');
        activeProjectId = createdProjectId;
        selectedProjectIds.clear();
        selectedProjectIds.add(createdProjectId);
        selectedSourcesByProject.set(createdProjectId, new Set());
        closeProjectWorkspace();
        await refreshNotebookWorkspace?.();
      } catch (error) {
        if (projectWorkspaceStatus) projectWorkspaceStatus.textContent = error instanceof Error ? error.message : 'Could not create project.';
      }
    });
  }
  updateResearchModeBadge();
  if (deepResearchMode) deepResearchMode.addEventListener('change', updateResearchModeBadge);
  refreshNotebookWorkspace();
  void loadBusinessContext();

  // Office Canvas Controls & Agent Focus Wiring
  document.querySelectorAll('.btn-focus-agent').forEach(btn => {
    btn.addEventListener('click', () => {
      const agentId = btn.getAttribute('data-agent');
      if (agentId) visualizer.focusAgent(agentId);
    });
  });

  // Task Dispatcher Board Wiring
  document.querySelectorAll('.btn-dispatch-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      const agentType = btn.getAttribute('data-agent');
      const prompt = btn.getAttribute('data-prompt');
      if (!agentType || !prompt) return;

      const activeUser = currentUser ? currentUser.username : 'alex';

      try {
        const res = await fetch('/api/agents/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_type: agentType,
            prompt,
            username: activeUser,
            project_id: selectedProjectScopeId(),
            source_document_names: selectedSourceDocumentNames(),
          })
        });
        if (res.ok) {
          visualizer.spawnRobot({
            agent_id: `${agentType.toLowerCase()}_manual`,
            name: agentType,
            agent_type: agentType,
            role_label: prompt
          });
        }
      } catch (e) {
        console.warn("Error dispatching agent task:", e);
      }
    });
  });
  // LOGIN PORTAL LOGIC
  // ==========================================================================
  // Note: currentUser is initialized at top of DOMContentLoaded scope
  const loginModal = document.getElementById('login-modal');
  const loginForm = document.getElementById('login-form') as HTMLFormElement;
  const loginUsername = document.getElementById('login-username') as HTMLInputElement;
  const loginPassword = document.getElementById('login-password') as HTMLInputElement;
  const loginError = document.getElementById('login-error');
  const userBadge = document.getElementById('user-badge');
  const userNameDisplay = document.getElementById('user-name-display');
  const connectionStatus = document.getElementById('connection-status');
  const exitMvpShowcaseBtn = document.getElementById('mvp-exit-showcase-btn') as HTMLButtonElement | null;
  const passwordChangeModal = document.getElementById('password-change-modal') as HTMLDivElement | null;
  const passwordChangeForm = document.getElementById('password-change-form') as HTMLFormElement | null;
  const currentPasswordInput = document.getElementById('current-password') as HTMLInputElement | null;
  const newPasswordInput = document.getElementById('new-password') as HTMLInputElement | null;
  const confirmNewPasswordInput = document.getElementById('confirm-new-password') as HTMLInputElement | null;
  const passwordChangeStatus = document.getElementById('password-change-status');
  const closePasswordChangeButton = document.getElementById('close-password-change-btn') as HTMLButtonElement | null;

  const setAuthenticated = (authenticated: boolean) => {
    if (appShell) appShell.classList.toggle('authenticated', authenticated);
    if (authenticated && !socketClient) socketClient = new SocketClient(visualizer);
    if (!authenticated && socketClient) {
      socketClient.disconnect();
      socketClient = null;
    }
  };
  setAuthenticated(false);

  const signOut = async (notifyServer = true) => {
    if (notifyServer && sessionStorage.getItem(AUTH_TOKEN_KEY)) {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // Local cleanup still signs the user out when the kernel is unavailable.
      }
    }
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    currentUser = null;
    activeChatSessionId = null;
    void refreshChatSessionSidebar?.();
    setAuthenticated(false);
    switchView('dashboard');
    if (loginModal) loginModal.style.display = 'flex';
    if (userBadge) userBadge.style.display = 'none';
    if (passwordChangeModal) passwordChangeModal.style.display = 'none';
    if (loginError) loginError.style.display = 'none';
    if (connectionStatus) {
      connectionStatus.textContent = '● Kernel Offline';
      connectionStatus.className = 'status-offline';
    }
  };

  exitMvpShowcaseBtn?.addEventListener('click', () => void signOut());
  window.addEventListener('ai-os-auth-expired', () => void signOut(false));

  const completeAuthentication = (user: UserProfile) => {
    currentUser = user;
    if (currentUser.language) {
      setLanguage(currentUser.language as 'en' | 'fi');
      updateLangToggleUI();
    }
    activeChatSessionId = null;
    void refreshChatSessionSidebar?.();
    setAuthenticated(true);
    if (loginModal) loginModal.style.display = 'none';
    if (userBadge) userBadge.style.display = 'flex';
    if (userNameDisplay) userNameDisplay.textContent = `👤 ${currentUser.display_name}`;
    if (connectionStatus) {
      connectionStatus.textContent = '● Kernel Online';
      connectionStatus.className = 'status-online';
    }
    switchView('dashboard');
  };

  async function restoreAuthentication() {
    if (!sessionStorage.getItem(AUTH_TOKEN_KEY)) return;
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) throw new Error('Session expired');
      const payload = await response.json();
      completeAuthentication(payload.user);
    } catch {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      setAuthenticated(false);
      if (loginModal) loginModal.style.display = 'flex';
    }
  }
  void restoreAuthentication();

  const closePasswordChange = () => {
    if (passwordChangeModal) passwordChangeModal.style.display = 'none';
    passwordChangeForm?.reset();
    if (passwordChangeStatus) passwordChangeStatus.textContent = '';
  };
  userBadge?.addEventListener('click', () => {
    if (passwordChangeModal) passwordChangeModal.style.display = 'flex';
    currentPasswordInput?.focus();
  });
  closePasswordChangeButton?.addEventListener('click', closePasswordChange);
  passwordChangeModal?.addEventListener('click', (event) => {
    if (event.target === passwordChangeModal) closePasswordChange();
  });
  passwordChangeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentPasswordInput || !newPasswordInput || !confirmNewPasswordInput || !passwordChangeStatus) return;
    if (newPasswordInput.value !== confirmNewPasswordInput.value) {
      passwordChangeStatus.textContent = 'The new passwords do not match.';
      return;
    }
    passwordChangeStatus.textContent = 'Updating…';
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPasswordInput.value, new_password: newPasswordInput.value }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || 'Password could not be changed.');
      }
      passwordChangeStatus.textContent = 'Password updated. Signing you out…';
      window.setTimeout(() => void signOut(false), 1200);
    } catch (error) {
      passwordChangeStatus.textContent = error instanceof Error ? error.message : 'Password could not be changed.';
    }
  });

  // Quick profile select buttons enter the MVP immediately; password sign-in remains
  // available below for the regular credential-based flow.
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.getAttribute('data-user');
      if (!u) return;

      if (loginError) loginError.style.display = 'none';
      const profileButton = btn as HTMLButtonElement;
      profileButton.disabled = true;
      try {
        const res = await fetch('/api/auth/quick-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
          throw new Error(data.detail || 'Profile could not be opened.');
        }
        sessionStorage.setItem(AUTH_TOKEN_KEY, data.access_token);
        completeAuthentication(data.user);
      } catch (error) {
        if (loginError) {
          loginError.textContent = error instanceof Error ? error.message : 'Profile could not be opened.';
          loginError.style.display = 'block';
        }
      } finally {
        profileButton.disabled = false;
      }
    });
  });

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = loginUsername.value.trim();
      const password = loginPassword.value.trim();

      if (!username || !password) {
        if (loginError) {
          loginError.textContent = 'Please provide both username and password.';
          loginError.style.display = 'block';
        }
        return;
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (res.ok) {
          const data = await res.json();
          if (!data.access_token) throw new Error('Kernel did not return an access token');
          sessionStorage.setItem(AUTH_TOKEN_KEY, data.access_token);
          completeAuthentication(data.user);
        } else {
          if (loginError) {
            loginError.textContent = 'Invalid credentials. Try again.';
            loginError.style.display = 'block';
          }
        }
      } catch (err) {
        if (loginError) {
          loginError.textContent = 'Error connecting to Kernel Backend.';
          loginError.style.display = 'block';
        }
      }
    });
  }

  // ==========================================================================
  // CHAT / RAG LOGIC
  // ==========================================================================
  const chatForm = document.getElementById('chat-form') as HTMLFormElement;
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const chatStream = document.getElementById('chat-stream');
  const workflowActivityPanel = document.getElementById('workflow-activity-panel') as HTMLDetailsElement | null;
  const workflowActivityTitle = document.getElementById('workflow-activity-title') as HTMLElement | null;
  const workflowActivityStatus = document.getElementById('workflow-activity-status') as HTMLElement | null;
  const workflowActivityAction = document.getElementById('workflow-activity-action') as HTMLElement | null;
  const workflowActivitySteps = document.getElementById('workflow-activity-steps') as HTMLOListElement | null;
  const workflowSteeringControls = document.getElementById('workflow-steering-controls') as HTMLElement | null;
  const workflowSteeringInput = document.getElementById('workflow-steering-input') as HTMLInputElement | null;
  const workflowSteeringBtn = document.getElementById('workflow-steering-btn') as HTMLButtonElement | null;
  const workflowStopBtn = document.getElementById('workflow-stop-btn') as HTMLButtonElement | null;
  const workflowControlNote = document.getElementById('workflow-control-note') as HTMLElement | null;
  let activeWorkflowTaskId: string | null = null;
  let activeWorkflowTerminal = true;
  type ReasoningSummaryView = {
    root: HTMLDetailsElement;
    title: HTMLElement;
    status: HTMLElement;
    steps: HTMLOListElement;
    entries: string[];
    startedAt: number;
  };
  let activeChatReasoningView: ReasoningSummaryView | null = null;
  let isLiveModeActive = false;
  let currentWebcamFrame: string | null = null;

  let currentAttachedImageData: string | null = null;
  const attachedImageContainer = document.getElementById('attached-image-container') as HTMLDivElement | null;
  const attachedImagePreview = document.getElementById('attached-image-preview') as HTMLImageElement | null;
  const attachImageButton = document.getElementById('btn-attach-image') as HTMLButtonElement | null;
  const attachedImageInput = document.getElementById('chat-image-input') as HTMLInputElement | null;
  const removeAttachedImageButton = document.getElementById('remove-attached-image-btn') as HTMLButtonElement | null;
  const chatSessionList = document.getElementById('chat-session-list');
  const newChatSessionBtn = document.getElementById('new-chat-session-btn') as HTMLButtonElement | null;
  const chatSessionProjectLabel = document.getElementById('chat-session-project-label');
  const managerPromptQueue = document.getElementById('manager-prompt-queue') as HTMLElement | null;
  let activeChatSessionId: string | null = null;
  type ManagerPromptQueueItem = {
    id: string;
    prompt: string;
    imageData: string | null;
    deepResearch: boolean;
    state: 'queued' | 'steering';
    status?: string;
  };
  type ManagerSteeringTarget = { kind: 'chat'; sessionId: string } | { kind: 'research'; taskId: string };
  const pendingManagerPrompts: ManagerPromptQueueItem[] = [];
  let managerExecutionActive = false;
  let activeManagerSteeringTarget: ManagerSteeringTarget | null = null;
  let managerQueueDrainTimer: number | null = null;

  const chatApiBase = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
  const activeChatUser = () => currentUser ? currentUser.username : 'alex';

  const workflowApiBase = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';

  function workflowStepLabel(step: any): string {
    const labels: Record<string, string> = {
      notebook_search: 'Search selected notebook sources',
      public_web_research: 'Research public web sources',
      evidence_synthesis: 'Synthesize cited report',
      evidence_verification: 'Verify and refine evidence-based claims',
    };
    return labels[step.tool_name] || String(step.tool_name || 'Workflow step').replace(/_/g, ' ');
  }

  function syncWorkflowSteeringVisibility() {
    const hasPendingPrompt = pendingManagerPrompts.some((item) => item.state === 'queued');
    const isRunningResearch = Boolean(
      activeWorkflowTaskId
      && activeManagerSteeringTarget?.kind === 'research'
      && !activeWorkflowTerminal
    );
    const shouldShow = isRunningResearch && hasPendingPrompt;
    if (workflowSteeringControls) workflowSteeringControls.hidden = !shouldShow;
    if (workflowControlNote) workflowControlNote.hidden = !shouldShow;
  }

  function renderWorkflowActivity(task: any) {
    if (!workflowActivityPanel) return;
    workflowActivityPanel.hidden = false;
    if (workflowActivityTitle) workflowActivityTitle.textContent = task.task_type === 'deep_research' ? 'Deep research' : 'Agent workflow';
    if (workflowActivityStatus) workflowActivityStatus.textContent = String(task.status || 'queued');
    if (workflowActivityAction) workflowActivityAction.textContent = task.last_action || 'Preparing the workflow…';

    if (workflowActivitySteps) {
      workflowActivitySteps.replaceChildren();
      const steps = Array.isArray(task.steps) ? task.steps : [];
      if (!steps.length) {
        const pending = document.createElement('li');
        pending.className = 'workflow-step is-running';
        pending.textContent = 'Preparing the workflow steps…';
        workflowActivitySteps.appendChild(pending);
      }
      steps.forEach((step: any, index: number) => {
        const item = document.createElement('li');
        const state = String(step.status || 'queued');
        item.className = `workflow-step is-${state}`;
        const marker = document.createElement('span');
        marker.className = 'workflow-step-marker';
        marker.textContent = state === 'completed' ? '✓' : state === 'running' ? '…' : state === 'cancelled' ? '×' : String(index + 1);
        const detail = document.createElement('span');
        const suffix = state === 'completed' && step.output_summary ? ` — ${step.output_summary}` : '';
        detail.textContent = `${workflowStepLabel(step)} · ${state}${suffix}`;
        item.append(marker, detail);
        workflowActivitySteps.appendChild(item);
      });
    }

    const terminal = ['completed', 'failed', 'cancelled'].includes(String(task.status));
    activeWorkflowTerminal = terminal;
    // Keep progress visible while it is useful, then reclaim the chat space.
    // The completed summary remains available by clicking the header.
    workflowActivityPanel.open = !terminal;
    syncWorkflowSteeringVisibility();
    if (workflowControlNote) {
      workflowControlNote.textContent = task.cancel_requested
        ? 'Stop requested. The agent will finish its current safe boundary and will not start another step.'
        : 'You can steer the next safe step or stop this workflow. Internal reasoning is not exposed.';
    }
  }

  async function refreshActiveWorkflow() {
    if (!activeWorkflowTaskId) return null;
    const response = await fetch(`${workflowApiBase()}/api/autonomy/tasks/${encodeURIComponent(activeWorkflowTaskId)}`);
    if (!response.ok) throw new Error(await response.text());
    const task = await response.json();
    renderWorkflowActivity(task);
    return task;
  }

  async function submitWorkflowSteering() {
    const direction = workflowSteeringInput?.value.trim();
    if (!activeWorkflowTaskId || !direction) return;
    if (workflowSteeringBtn) workflowSteeringBtn.disabled = true;
    try {
      const response = await fetch(`${workflowApiBase()}/api/autonomy/tasks/${encodeURIComponent(activeWorkflowTaskId)}/steer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (workflowSteeringInput) workflowSteeringInput.value = '';
      await refreshActiveWorkflow();
    } catch (error) {
      if (workflowControlNote) workflowControlNote.textContent = `Could not apply direction: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
      if (workflowSteeringBtn) workflowSteeringBtn.disabled = false;
    }
  }

  async function stopActiveWorkflow() {
    if (!activeWorkflowTaskId || !workflowStopBtn) return;
    workflowStopBtn.disabled = true;
    try {
      const response = await fetch(`${workflowApiBase()}/api/autonomy/tasks/${encodeURIComponent(activeWorkflowTaskId)}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error(await response.text());
      await refreshActiveWorkflow();
    } catch (error) {
      workflowStopBtn.disabled = false;
      if (workflowControlNote) workflowControlNote.textContent = `Could not stop workflow: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  if (workflowSteeringBtn) workflowSteeringBtn.addEventListener('click', () => void submitWorkflowSteering());
  if (workflowStopBtn) workflowStopBtn.addEventListener('click', () => void stopActiveWorkflow());

  function createReasoningSummaryView(entries: string[] = [], live: boolean = true): ReasoningSummaryView {
    const root = document.createElement('details');
    root.className = 'reasoning-summary';
    root.open = live;

    const header = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'reasoning-summary-title';
    title.textContent = live ? 'Thinking' : 'Reasoning summary';
    const status = document.createElement('span');
    status.className = 'reasoning-summary-status';
    status.textContent = live ? 'Starting…' : 'Complete';
    header.append(title, status);

    const body = document.createElement('div');
    body.className = 'reasoning-summary-body';
    const steps = document.createElement('ol');
    steps.className = 'reasoning-summary-steps';
    const note = document.createElement('p');
    note.className = 'reasoning-summary-note';
    note.textContent = 'Safe activity summary — private chain-of-thought and sensitive tool data are not exposed.';
    body.append(steps, note);
    root.append(header, body);

    const view: ReasoningSummaryView = { root, title, status, steps, entries: [], startedAt: Date.now() };
    entries.forEach((entry) => appendReasoningSummary(view, entry));
    if (!live) finishReasoningSummary(view, false, false);
    return view;
  }

  function appendReasoningSummary(view: ReasoningSummaryView, rawSummary: string) {
    const summary = String(rawSummary || '').replace(/\s+/g, ' ').trim();
    if (!summary || view.entries.includes(summary)) return;
    const previous = view.steps.lastElementChild as HTMLElement | null;
    previous?.classList.remove('is-active');
    previous?.classList.add('is-complete');
    const item = document.createElement('li');
    item.className = 'reasoning-summary-step is-active';
    item.textContent = summary;
    view.steps.appendChild(item);
    view.entries.push(summary);
    view.status.textContent = 'Working…';
  }

  function finishReasoningSummary(view: ReasoningSummaryView, failed: boolean = false, showElapsed: boolean = true) {
    const current = view.steps.lastElementChild as HTMLElement | null;
    current?.classList.remove('is-active');
    current?.classList.add(failed ? 'is-failed' : 'is-complete');
    view.title.textContent = failed ? 'Activity summary' : 'Reasoning summary';
    const elapsedSeconds = Math.max(0.1, (Date.now() - view.startedAt) / 1000);
    view.status.textContent = failed ? 'Stopped' : showElapsed ? `Done in ${elapsedSeconds.toFixed(1)}s` : 'Complete';
    view.root.open = failed;
  }

  const displayedScheduledTaskResults = new Set<string>();

  window.addEventListener('ai-os-agent-event', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.type === 'WORKFLOW_UPDATED' && detail?.data?.workflow_id === activeWorkflowTaskId) {
      void refreshActiveWorkflow().catch(() => undefined);
    }
    if (activeChatReasoningView && detail?.type === 'REASONING_SUMMARY') {
      const activeSessionId = activeManagerSteeringTarget?.kind === 'chat'
        ? activeManagerSteeringTarget.sessionId
        : null;
      if (detail?.data?.session_id === activeSessionId) {
        appendReasoningSummary(activeChatReasoningView, detail.data.summary);
      }
    }
    if (
      detail?.type === 'KANBAN_TASK_UPDATED'
      && detail?.data?.status === 'done'
      && detail?.data?.chat_session_id === activeChatSessionId
      && !displayedScheduledTaskResults.has(detail.data.task_id)
    ) {
      displayedScheduledTaskResults.add(detail.data.task_id);
      void (async () => {
        try {
          const response = await fetch(`${chatApiBase()}/api/tasks/${encodeURIComponent(detail.data.task_id)}`);
          if (!response.ok) return;
          const payload = await response.json();
          const result = payload?.task?.result_md;
          if (result) appendMessage('agent', `✅ <strong>Scheduled Manager task complete</strong><br><br>${formatEvidenceResponse(result)}`);
        } catch {
          // The result remains available in Kanban even if this live update cannot load.
        }
      })();
    }
  });

  function renderChatWelcome() {
    if (!chatStream) return;
    chatStream.replaceChildren();
    const welcome = document.createElement('div');
    welcome.className = 'system-msg';
    welcome.innerHTML = '👋 <strong>New conversation.</strong> I am your AI Board Member. Choose only the project sources you want me to use, then ask a question.';
    chatStream.appendChild(welcome);
  }

  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  function formatEvidenceResponse(response: string) {
    const citations: string[] = [];
    const tokenized = response.replace(/\[Source:\s*([^\]\n]+)\]/gi, (_match, rawSource: string) => {
      const source = String(rawSource).split('|', 1)[0].trim();
      if (!source) return '';
      const token = `@@AIOSCITATION${citations.length}@@`;
      citations.push(source);
      return token;
    });
    let formatted = escapeHtml(tokenized)
      .replace(/### (.*?)\n/g, '<h3>$1</h3>')
      .replace(/## (.*?)\n/g, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br/>');
    citations.forEach((source, index) => {
      const safeSource = escapeHtml(source);
      formatted = formatted.replace(
        `@@AIOSCITATION${index}@@`,
        `<button type="button" class="citation-link" data-source="${safeSource}">[Source: ${safeSource}]</button>`,
      );
    });
    return formatted;
  }

  const citationInspectorModal = document.getElementById('citation-inspector-modal') as HTMLDivElement | null;
  const citationInspectorTitle = document.getElementById('citation-inspector-title');
  const citationInspectorMeta = document.getElementById('citation-inspector-meta');
  const citationInspectorStatus = document.getElementById('citation-inspector-status');
  const citationInspectorContent = document.getElementById('citation-inspector-content');
  const closeCitationInspectorButton = document.getElementById('close-citation-inspector-btn') as HTMLButtonElement | null;

  const closeCitationInspector = () => {
    if (citationInspectorModal) citationInspectorModal.style.display = 'none';
  };

  async function inspectDocumentSource(source: string) {
    if (!citationInspectorModal || !citationInspectorTitle || !citationInspectorMeta || !citationInspectorStatus || !citationInspectorContent) return;
    citationInspectorModal.style.display = 'flex';
    citationInspectorTitle.textContent = source;
    citationInspectorMeta.textContent = '';
    citationInspectorContent.textContent = '';
    citationInspectorStatus.textContent = 'Loading source…';
    try {
      const response = await fetch(`/api/documents/detail?file_name=${encodeURIComponent(source)}`);
      if (!response.ok) throw new Error(response.status === 404 ? 'The cited source is no longer in the document vault.' : 'Could not load this source.');
      const detail = await response.json();
      citationInspectorMeta.textContent = `${detail.file_type || 'document'} · ${detail.chunks_indexed || 0} indexed section${detail.chunks_indexed === 1 ? '' : 's'}`;
      citationInspectorContent.textContent = detail.extracted_text || detail.summary || 'No extracted text is available.';
      citationInspectorStatus.textContent = '';
    } catch (error) {
      citationInspectorStatus.textContent = error instanceof Error ? error.message : 'Could not load this source.';
    }
  }

  chatStream?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const citation = target.closest<HTMLButtonElement>('.citation-link');
    if (citation?.dataset.source) void inspectDocumentSource(citation.dataset.source);
  });
  closeCitationInspectorButton?.addEventListener('click', closeCitationInspector);
  citationInspectorModal?.addEventListener('click', (event) => {
    if (event.target === citationInspectorModal) closeCitationInspector();
  });
  window.addEventListener('inspect-document-source', (event: Event) => {
    const source = String((event as CustomEvent).detail?.source || '');
    if (source) void inspectDocumentSource(source);
  });

  function makeModelFooter(provider?: string, model?: string, label: string = 'Key Verified') {
    const safeProvider = escapeHtml((provider || 'azure').toUpperCase());
    const safeModel = escapeHtml(model || 'mvp-gpt-54-mini');
    return '<div class="msg-model-footer" style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15); font-size: 0.78rem; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between;"><span>Response generated via <strong style="color: #a78bfa;">' + safeProvider + '</strong> (<span style="color: var(--accent-blue);">' + safeModel + '</span>)</span><span class="subtext" style="font-size: 0.7rem; color: var(--accent-green);">' + label + '</span></div>';
  }

  function renderStoredSessionMessages(messages: Array<any>) {
    if (!chatStream) return;
    chatStream.replaceChildren();
    if (!messages.length) {
      renderChatWelcome();
      return;
    }
    messages.forEach((message) => {
      const messageEl = document.createElement('div');
      messageEl.className = message.role === 'user' ? 'user-msg' : 'agent-msg';
      if (message.role === 'user') {
        messageEl.textContent = message.content_md;
      } else {
        const metadata = message.metadata || {};
        const isResearch = metadata.kind === 'deep_research';
        const summaries = Array.isArray(metadata.reasoning_summary)
          ? metadata.reasoning_summary.filter((entry: unknown) => typeof entry === 'string')
          : [];
        if (summaries.length) {
          messageEl.appendChild(createReasoningSummaryView(summaries, false).root);
        }
        const responseBody = document.createElement('div');
        responseBody.className = 'assistant-response-body';
        responseBody.innerHTML = formatEvidenceResponse(message.content_md) + (isResearch
          ? '<div class="msg-model-footer" style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15); font-size: 0.78rem; color: var(--text-muted);">Autonomous evidence report</div>'
          : makeModelFooter(metadata.provider, metadata.model));
        messageEl.appendChild(responseBody);
      }
      chatStream.appendChild(messageEl);
    });
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  async function loadChatSession(sessionId: string) {
    try {
      const params = new URLSearchParams({ username: activeChatUser() });
      const response = await fetch(`${chatApiBase()}/api/chat/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      activeChatSessionId = data.session.id;
      renderStoredSessionMessages(Array.isArray(data.messages) ? data.messages : []);
      await refreshChatSessionSidebar?.();
    } catch (error) {
      console.error('Could not load chat session:', error);
      renderChatWelcome();
    }
  }

  async function createNewChatSession() {
    try {
      const response = await fetch(`${chatApiBase()}/api/chat/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: activeChatUser(), project_id: '', title: 'New chat' }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      activeChatSessionId = data.session.id;
      renderChatWelcome();
      await refreshChatSessionSidebar?.();
      return activeChatSessionId;
    } catch (error) {
      console.error('Could not create chat session:', error);
      return null;
    }
  }

  async function ensureActiveChatSession() {
    if (activeChatSessionId) return activeChatSessionId;
    return createNewChatSession();
  }

  async function persistSessionMessage(role: 'user' | 'assistant', content_md: string, metadata: Record<string, unknown> = {}) {
    const sessionId = await ensureActiveChatSession();
    if (!sessionId) return;
    const response = await fetch(`${chatApiBase()}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: activeChatUser(),
        project_id: '',
        role,
        content_md,
        metadata,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  }

  refreshChatSessionSidebar = async () => {
    if (!chatSessionList) return;
    if (chatSessionProjectLabel) chatSessionProjectLabel.textContent = 'All conversations';
    try {
      const params = new URLSearchParams({ username: activeChatUser() });
      const response = await fetch(`${chatApiBase()}/api/chat/sessions?${params.toString()}`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (!sessions.some((session: any) => session.id === activeChatSessionId)) {
        activeChatSessionId = sessions[0]?.id || null;
        if (activeChatSessionId) {
          await loadChatSession(activeChatSessionId);
          return;
        }
        renderChatWelcome();
      }
      chatSessionList.replaceChildren();
      if (!sessions.length) {
        const empty = document.createElement('p');
        empty.className = 'chat-session-empty';
        empty.textContent = 'No conversations yet. Start a new chat when you are ready.';
        chatSessionList.appendChild(empty);
        return;
      }
      sessions.forEach((session: any) => {
        const item = document.createElement('div');
        item.className = `chat-session-item${session.id === activeChatSessionId ? ' is-active' : ''}`;
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'chat-session-open';
        const title = document.createElement('span');
        title.className = 'chat-session-title';
        title.textContent = session.title || 'New chat';
        const meta = document.createElement('span');
        meta.className = 'chat-session-meta';
        meta.textContent = `${session.message_count || 0} message${Number(session.message_count) === 1 ? '' : 's'} · ${String(session.updated_at || '').slice(0, 16).replace('T', ' ') || 'new'}`;
        open.append(title, meta);
        open.addEventListener('click', () => void loadChatSession(session.id));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chat-session-delete';
        remove.title = 'Delete this chat session';
        remove.setAttribute('aria-label', `Delete ${session.title || 'chat session'}`);
        remove.textContent = '×';
        remove.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!confirm(`Delete the chat session “${session.title || 'New chat'}”?`)) return;
          try {
            const params = new URLSearchParams({ username: activeChatUser() });
            const deleted = await fetch(`${chatApiBase()}/api/chat/sessions/${encodeURIComponent(session.id)}?${params.toString()}`, { method: 'DELETE' });
            if (!deleted.ok) {
              alert('Could not delete this chat session.');
              return;
            }
            if (activeChatSessionId === session.id) {
              activeChatSessionId = null;
            }
            await refreshChatSessionSidebar?.();
          } catch (err) {
            console.error('Failed to delete chat session:', err);
            alert(`Could not delete chat session: ${err instanceof Error ? err.message : 'network error'}`);
          }
        });
        item.append(open, remove);
        chatSessionList.appendChild(item);
      });
    } catch (error) {
      console.error('Could not load chat sessions:', error);
      chatSessionList.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'chat-session-empty';
      empty.textContent = 'Conversation history is unavailable. Check the local kernel.';
      chatSessionList.appendChild(empty);
    }
  };

  if (newChatSessionBtn) newChatSessionBtn.addEventListener('click', () => void createNewChatSession());
  void refreshChatSessionSidebar();

  function syncManagerComposerState() {
    if (!sendBtn) return;
    sendBtn.disabled = false;
    sendBtn.textContent = managerExecutionActive ? 'Queue ↵' : 'Send ↵';
    sendBtn.title = managerExecutionActive
      ? 'Add this prompt to run after the current task'
      : 'Send message';
  }

  function renderManagerPromptQueue() {
    if (!managerPromptQueue) return;
    managerPromptQueue.hidden = pendingManagerPrompts.length === 0;
    managerPromptQueue.replaceChildren();
    pendingManagerPrompts.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'manager-prompt-queue-item';

      const icon = document.createElement('span');
      icon.className = 'manager-prompt-queue-icon';
      icon.textContent = '↳';
      icon.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('div');
      copy.className = 'manager-prompt-queue-copy';
      const prompt = document.createElement('span');
      prompt.className = 'manager-prompt-queue-text';
      prompt.textContent = item.prompt;
      const status = document.createElement('span');
      status.className = 'manager-prompt-queue-status';
      status.textContent = item.status || 'Queued — runs automatically when the current task finishes';
      copy.append(prompt, status);

      const actions = document.createElement('div');
      actions.className = 'manager-prompt-queue-actions';
      const steer = document.createElement('button');
      steer.type = 'button';
      steer.className = 'manager-prompt-steer-btn';
      const canRunManually = !managerExecutionActive && !activeManagerSteeringTarget;
      steer.textContent = canRunManually ? 'Run next' : '↳ Steer';
      steer.disabled = item.state === 'steering' || (managerExecutionActive && !activeManagerSteeringTarget);
      steer.title = activeManagerSteeringTarget
        ? 'Apply this prompt to the current task at its next safe checkpoint'
        : canRunManually
          ? 'Run this prompt now'
          : 'The current task is preparing its first checkpoint';
      steer.addEventListener('click', () => void steerQueuedManagerPrompt(item.id));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'manager-prompt-remove-btn';
      remove.textContent = '⌫';
      remove.title = 'Remove queued prompt';
      remove.setAttribute('aria-label', `Remove queued prompt: ${item.prompt}`);
      remove.addEventListener('click', () => {
        const index = pendingManagerPrompts.findIndex((queued) => queued.id === item.id);
        if (index >= 0) pendingManagerPrompts.splice(index, 1);
        if (managerQueueDrainTimer !== null) {
          window.clearTimeout(managerQueueDrainTimer);
          managerQueueDrainTimer = null;
        }
        renderManagerPromptQueue();
        drainPendingManagerQueue();
      });
      actions.append(steer, remove);
      row.append(icon, copy, actions);
      managerPromptQueue.appendChild(row);
    });
    syncWorkflowSteeringVisibility();
  }

  async function steerQueuedManagerPrompt(itemId: string) {
    const item = pendingManagerPrompts.find((queued) => queued.id === itemId);
    const target = activeManagerSteeringTarget;
    if (!item) return;
    if (!target) {
      if (managerExecutionActive) return;
      const index = pendingManagerPrompts.findIndex((queued) => queued.id === itemId);
      if (index >= 0) pendingManagerPrompts.splice(index, 1);
      if (managerQueueDrainTimer !== null) {
        window.clearTimeout(managerQueueDrainTimer);
        managerQueueDrainTimer = null;
      }
      renderManagerPromptQueue();
      void runManagerPrompt(item);
      return;
    }
    item.state = 'steering';
    item.status = 'Sending to checkpoint…';
    renderManagerPromptQueue();
    const url = target.kind === 'research'
      ? `${workflowApiBase()}/api/autonomy/tasks/${encodeURIComponent(target.taskId)}/steer`
      : `${chatApiBase()}/api/chat/sessions/${encodeURIComponent(target.sessionId)}/steer`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: item.prompt }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'checkpoint_closed' : await response.text());
      const index = pendingManagerPrompts.findIndex((queued) => queued.id === itemId);
      if (index >= 0) pendingManagerPrompts.splice(index, 1);
      const visibleSteer = document.createElement('div');
      visibleSteer.className = 'user-msg manager-steer-msg';
      visibleSteer.textContent = `↳ Steer: ${item.prompt}`;
      chatStream?.appendChild(visibleSteer);
      if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
    } catch (error) {
      item.state = 'queued';
      item.status = error instanceof Error && error.message === 'checkpoint_closed'
        ? 'Checkpoint closed — this will run as the next task'
        : 'Could not steer — this will still run as the next task';
    }
    renderManagerPromptQueue();
    drainPendingManagerQueue();
  }

  function drainPendingManagerQueue() {
    if (managerExecutionActive || managerQueueDrainTimer !== null) return;
    const next = pendingManagerPrompts[0];
    if (!next || next.state === 'steering') return;
    next.status = 'Previous task complete — starting next…';
    renderManagerPromptQueue();
    managerQueueDrainTimer = window.setTimeout(() => {
      managerQueueDrainTimer = null;
      if (managerExecutionActive) return;
      const queued = pendingManagerPrompts[0];
      if (!queued || queued.id !== next.id || queued.state !== 'queued') {
        drainPendingManagerQueue();
        return;
      }
      pendingManagerPrompts.shift();
      renderManagerPromptQueue();
      void runManagerPrompt(queued);
    }, 600);
  }

  function takeComposerImage(): string | null {
    const imageData = currentAttachedImageData;
    currentAttachedImageData = null;
    if (attachedImageContainer) attachedImageContainer.hidden = true;
    if (attachedImagePreview) attachedImagePreview.src = '';
    if (attachedImageInput) attachedImageInput.value = '';
    return imageData;
  }

  attachImageButton?.addEventListener('click', () => attachedImageInput?.click());
  removeAttachedImageButton?.addEventListener('click', () => { void takeComposerImage(); });
  attachedImageInput?.addEventListener('change', () => {
    const file = attachedImageInput.files?.[0];
    if (!file) return;
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowed.has(file.type) || file.size > 5 * 1024 * 1024) {
      window.alert('Choose a PNG, JPEG, WebP, or GIF image no larger than 5 MB.');
      attachedImageInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      currentAttachedImageData = reader.result;
      if (attachedImagePreview) attachedImagePreview.src = reader.result;
      if (attachedImageContainer) attachedImageContainer.hidden = false;
      if (composerActions) composerActions.open = false;
    };
    reader.onerror = () => window.alert('The selected image could not be read.');
    reader.readAsDataURL(file);
  });

  function queueOrExecuteManagerPrompt(rawPrompt: string) {
    const useDeepResearch = Boolean(deepResearchMode?.checked);
    const item: ManagerPromptQueueItem = {
      id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      prompt: rawPrompt,
      imageData: takeComposerImage(),
      deepResearch: useDeepResearch,
      state: 'queued',
    };
    // Deep Research is a one-shot action. Reset and close the More menu so a
    // later simple question cannot accidentally start another research run.
    if (useDeepResearch && deepResearchMode) deepResearchMode.checked = false;
    if (composerActions) composerActions.open = false;
    if (chatInput) chatInput.value = '';
    if (managerExecutionActive) {
      pendingManagerPrompts.push(item);
      renderManagerPromptQueue();
      syncManagerComposerState();
      return;
    }
    void runManagerPrompt(item);
  }

  async function runManagerPrompt(item: ManagerPromptQueueItem) {
    managerExecutionActive = true;
    activeManagerSteeringTarget = null;
    syncManagerComposerState();
    renderManagerPromptQueue();
    let completedSuccessfully = false;
    try {
      completedSuccessfully = await executeChatPrompt(item.prompt, item.imageData, item.deepResearch);
    } finally {
      managerExecutionActive = false;
      activeManagerSteeringTarget = null;
      syncManagerComposerState();
      renderManagerPromptQueue();
      if (completedSuccessfully) {
        drainPendingManagerQueue();
      } else if (pendingManagerPrompts[0]) {
        pendingManagerPrompts[0].status = 'Previous task did not complete — choose Run next when ready';
        renderManagerPromptQueue();
      }
    }
  }

  async function executeChatPrompt(rawPrompt: string, imageData: string | null = null, useDeepResearch: boolean = false): Promise<boolean> {
    if (useDeepResearch) {
      return runDeepResearch(rawPrompt);
    }
    if (!chatStream) return false;
    const sessionId = await ensureActiveChatSession();
    if (!sessionId) {
      appendMessage('agent', '❌ <strong>Unable to start a chat session.</strong> Select a project and check that the local kernel is running.');
      return false;
    }

    activeManagerSteeringTarget = { kind: 'chat', sessionId };
    renderManagerPromptQueue();

    const userMsgDiv = document.createElement('div');
    userMsgDiv.className = 'user-msg';

    const attachedImageForThisPayload = imageData;
    if (attachedImageForThisPayload) {
      const content = document.createElement('div');
      const preview = document.createElement('img');
      preview.src = attachedImageForThisPayload;
      preview.alt = 'Attached image';
      preview.className = 'chat-attached-image';
      content.append(preview, document.createTextNode(rawPrompt));
      userMsgDiv.appendChild(content);
    } else {
      userMsgDiv.textContent = rawPrompt;
    }

    chatStream.appendChild(userMsgDiv);
    if (chatInput) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
    }

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'agent-msg loading-msg';
    const reasoningView = createReasoningSummaryView();
    const answerBody = document.createElement('div');
    answerBody.className = 'assistant-response-body';
    answerBody.hidden = true;
    loadingDiv.append(reasoningView.root, answerBody);
    chatStream.appendChild(loadingDiv);
    activeChatReasoningView = reasoningView;
    chatStream.scrollTop = chatStream.scrollHeight;
    syncManagerComposerState();

    try {
      const activeUser = currentUser ? currentUser.username : 'alex';
      const apiUrl = (window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '') + '/api/chat/stream';
      const payload: any = {
        prompt: rawPrompt,
        username: activeUser,
        session_id: sessionId,
        image_data: attachedImageForThisPayload,
        research_mode: selectedResearchMode(),
        notebook_ids: selectedNotebookIds(),
        project_id: selectedProjectScopeId(),
        source_document_names: selectedSourceDocumentNames(),
      };
      if (isLiveModeActive && currentWebcamFrame) {
        payload.image_data = currentWebcamFrame;
        currentWebcamFrame = null;
      }

      let response: Response;
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) throw new Error(await response.text());
      if (!response.body) throw new Error('The Manager stream was unavailable.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedText = '';
      let data: any = null;
      const consumeEvent = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'delta') {
          streamedText += String(event.text || '');
          answerBody.hidden = false;
          answerBody.style.whiteSpace = 'pre-wrap';
          answerBody.textContent = streamedText;
          if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
        } else if (event.type === 'done') {
          data = event.data;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'The Manager stream failed.');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(consumeEvent);
        if (done) break;
      }
      if (buffer.trim()) consumeEvent(buffer);
      if (!data) throw new Error('The Manager stream ended before completion.');

      activeChatSessionId = data.session_id || sessionId;
      const completeResponse = data.response || streamedText;
      const formattedResponse = formatEvidenceResponse(completeResponse);
      const usedProvider = (data.provider || 'azure').toUpperCase();
      const usedModel = data.model || 'mvp-gpt-54-mini';
      if (Array.isArray(data.reasoning_summary)) {
        data.reasoning_summary.forEach((entry: unknown) => {
          if (typeof entry === 'string') appendReasoningSummary(reasoningView, entry);
        });
      }
      finishReasoningSummary(reasoningView);
      loadingDiv.classList.remove('loading-msg');
      loadingDiv.classList.add('is-complete');
      answerBody.style.removeProperty('white-space');
      answerBody.innerHTML = formattedResponse + makeModelFooter(usedProvider, usedModel);
      answerBody.hidden = false;
      void refreshChatSessionSidebar?.();

      if (isLiveModeActive) {
        speakResponseOutLoud(completeResponse);
      }
      return true;
    } catch (err) {
      if (chatStream) {
        finishReasoningSummary(reasoningView, true);
        loadingDiv.classList.remove('loading-msg');
        answerBody.innerHTML = '❌ <strong>Error connecting to AI OS Kernel:</strong> Make sure Python backend daemon is running on port 8000.';
        answerBody.hidden = false;
      }
      return false;
    } finally {
      if (activeChatReasoningView === reasoningView) activeChatReasoningView = null;
      syncManagerComposerState();
    }
  }

  function handleChatSubmission(e: Event) {
    e.preventDefault();
    if (!chatInput) return;
    const rawPrompt = chatInput.value.trim();
    if (rawPrompt) {
      queueOrExecuteManagerPrompt(rawPrompt);
    }
  }

  async function runDeepResearch(questionOverride: string = ''): Promise<boolean> {
    const question = questionOverride || chatInput?.value.trim();
    if (!question || !chatStream) return false;
    const sessionId = await ensureActiveChatSession();
    if (!sessionId) {
      appendMessage('agent', '❌ <strong>Unable to start a chat session.</strong> Select a project and check that the local kernel is running.');
      return false;
    }

    const userMessage = document.createElement('div');
    userMessage.className = 'user-msg';
    userMessage.textContent = `Deep research: ${question}`;
    chatStream.appendChild(userMessage);
    chatInput.value = '';
    chatInput.style.height = 'auto';

    const progress = document.createElement('div');
    progress.className = 'agent-msg loading-msg';
    progress.textContent = '🔎 Deep Research Agent is planning the mission…';
    chatStream.appendChild(progress);
    chatStream.scrollTop = chatStream.scrollHeight;
    syncManagerComposerState();

    try {
      await persistSessionMessage('user', `Deep research: ${question}`, { kind: 'deep_research_request' });
      const activeUser = currentUser ? currentUser.username : 'alex';
      const baseUrl = window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
      const createResponse = await fetch(`${baseUrl}/api/autonomy/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: question,
          username: activeUser,
          notebook_ids: selectedNotebookIds(),
          project_id: selectedProjectScopeId(),
          source_document_names: selectedSourceDocumentNames(),
          max_web_sources: 3,
          research_mode: 'rag_internet',
        }),
      });
      if (!createResponse.ok) throw new Error(await createResponse.text());
      const created = await createResponse.json();
      const taskId = created.task_id;
      activeWorkflowTaskId = taskId;
      activeWorkflowTerminal = false;
      activeManagerSteeringTarget = { kind: 'research', taskId };
      renderManagerPromptQueue();
      const deadline = Date.now() + 180_000;
      let task: any = null;

      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 1_000));
        const taskResponse = await fetch(`${baseUrl}/api/autonomy/tasks/${encodeURIComponent(taskId)}`);
        if (!taskResponse.ok) throw new Error(await taskResponse.text());
        task = await taskResponse.json();
        renderWorkflowActivity(task);
        const currentStep = (task.steps || []).find((step: any) => step.status === 'running');
        progress.textContent = currentStep
          ? `🔎 Deep Research Agent: ${currentStep.tool_name.replace(/_/g, ' ')}…`
          : `🔎 Deep Research Agent: ${task.status}…`;
        if (['completed', 'failed', 'cancelled'].includes(task.status)) break;
      }

      if (!task || task.status === 'queued' || task.status === 'running') {
        throw new Error('Research is still running. Please try again in a moment.');
      }
      if (task.status !== 'completed') throw new Error(task.error_message || 'Research task failed');
      const artifacts = task.artifacts || [];
      const report = task.result_md || (artifacts.length ? artifacts[artifacts.length - 1].content_md : '') || 'No report was returned.';
      await persistSessionMessage('assistant', report, { kind: 'deep_research' });
      void refreshChatSessionSidebar?.();
      if (progress.parentNode) progress.parentNode.removeChild(progress);
      appendMessage('agent', formatEvidenceResponse(report) + '<div class="msg-model-footer" style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15); font-size: 0.78rem; color: var(--text-muted);">🔎 Autonomous evidence report · plan and sources saved in Database</div>');
      return true;
    } catch (error) {
      if (progress.parentNode) progress.parentNode.removeChild(progress);
      appendMessage('agent', `❌ Deep research failed: ${escapeHtml(error instanceof Error ? error.message : 'unknown error')}`);
      return false;
    } finally {
      activeWorkflowTaskId = null;
      activeWorkflowTerminal = true;
      syncWorkflowSteeringVisibility();
      syncManagerComposerState();
    }
  }

  if (chatForm) {
    chatForm.addEventListener('submit', handleChatSubmission);
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // Prevent default newline
        handleChatSubmission(e); // Submit the form
      }
    });

    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = chatInput.scrollHeight + 'px';
    });
  }

  function appendMessage(sender: 'user' | 'agent', text: string) {
    const msgDiv = document.createElement('div');
    msgDiv.className = sender === 'user' ? 'user-msg' : 'agent-msg';
    msgDiv.innerHTML = text;
    if (chatStream) {
      chatStream.appendChild(msgDiv);
      chatStream.scrollTop = chatStream.scrollHeight;
    }
  }

  // ==========================================================================
  // MEETING VAULT LOGIC
  // ==========================================================================
  const btnSaveMeeting = document.getElementById('btn-save-meeting');
  if (btnSaveMeeting) {
    btnSaveMeeting.addEventListener('click', async () => {
      if (!chatStream) return;
      const historyText = Array.from(chatStream.querySelectorAll('.user-msg, .agent-msg, .system-msg'))
        .map(el => el.textContent?.trim())
        .join('\n\n');

      const dateStr = new Date().toISOString().slice(0,10);
      const filename = `Meeting_Transcript_${dateStr}.txt`;
      const blob = new Blob([historyText], { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', blob, filename);
      if (activeProjectId) formData.append('notebook_id', activeProjectId);

      try {
        btnSaveMeeting.textContent = '⏳ Saving...';
        const res = await fetch('/api/documents/upload', {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          btnSaveMeeting.textContent = '✅ Saved to Vault';
          setTimeout(() => btnSaveMeeting.textContent = '💾 Save to Vault', 3000);
        } else {
          btnSaveMeeting.textContent = '❌ Failed';
        }
      } catch(e) {
        btnSaveMeeting.textContent = '❌ Error';
      }
    });
  }

  // ==========================================================================
  // LIVE VISION & VOICE LOGIC
  // ==========================================================================
  const btnGoLive = document.getElementById('btn-go-live');
  const liveContainer = document.getElementById('live-vision-container');
  const webcamFeed = document.getElementById('webcam-feed') as HTMLVideoElement;
  const webcamCanvas = document.getElementById('webcam-canvas') as HTMLCanvasElement;
  const liveStatusText = document.getElementById('live-status-text');

  let mediaStream: MediaStream | null = null;
  let recognition: any = null;
  let isSpeaking = false;

  function captureWebcamFrame() {
    if (!webcamFeed || !webcamCanvas) return null;
    webcamCanvas.width = webcamFeed.videoWidth || 640;
    webcamCanvas.height = webcamFeed.videoHeight || 480;
    const ctx = webcamCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(webcamFeed, 0, 0, webcamCanvas.width, webcamCanvas.height);
      return webcamCanvas.toDataURL('image/jpeg', 0.6);
    }
    return null;
  }

  function initSpeechRecognition() {
    // @ts-ignore
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      alert("Browser does not support Speech Recognition.");
      return null;
    }
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;

    rec.onstart = () => {
      if (liveStatusText && !isSpeaking) liveStatusText.textContent = 'Live Mode: Listening...';
    };

    rec.onresult = (event: any) => {
      if (isSpeaking) return; // ignore room echo if speaking
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      }
      if (finalTranscript.trim()) {
        if (liveStatusText) liveStatusText.textContent = 'Live Mode: Thinking...';
        currentWebcamFrame = captureWebcamFrame();
        queueOrExecuteManagerPrompt(finalTranscript.trim());
      }
    };

    rec.onend = () => {
      if (isLiveModeActive && !isSpeaking) {
        try { rec.start(); } catch(e) {}
      }
    };
    return rec;
  }

  function speakResponseOutLoud(text: string) {
    if (!window.speechSynthesis) return;

    // Strip markdown formatting for cleaner speech
    const cleanText = text.replace(/[#*\[\]]/g, '').replace(/Source:.*?\)/g, '');

    const utterance = new SpeechSynthesisUtterance(cleanText);
    const lang = getLanguage() === 'fi' ? 'fi-FI' : 'en-US';
    utterance.lang = lang;
    utterance.rate = 1.05; // slightly faster for conversational feel

    // Attempt to pick a good voice
    const voices = window.speechSynthesis.getVoices();
    const targetVoices = voices.filter(v => v.lang.startsWith(lang.split('-')[0]));
    if (targetVoices.length > 0) {
      // Prefer Google or Microsoft native voices
      const premium = targetVoices.find(v => v.name.includes('Google') || v.name.includes('Microsoft'));
      utterance.voice = premium || targetVoices[0];
    }

    utterance.onstart = () => {
      isSpeaking = true;
      if (recognition) recognition.stop();
      if (liveStatusText) liveStatusText.textContent = 'Live Mode: Speaking...';
      if (btnGoLive) btnGoLive.classList.remove('pulse-glow-btn');
    };

    utterance.onend = () => {
      isSpeaking = false;
      if (liveStatusText) liveStatusText.textContent = 'Live Mode: Listening...';
      if (btnGoLive) btnGoLive.classList.add('pulse-glow-btn');
      if (isLiveModeActive && recognition) {
        try { recognition.start(); } catch(e) {}
      }
    };

    window.speechSynthesis.speak(utterance);
  }
  (window as typeof window & { speakResponseOutLoud?: (text: string) => void }).speakResponseOutLoud = speakResponseOutLoud;

  if (btnGoLive) {
    btnGoLive.addEventListener('click', async () => {
      if (isLiveModeActive) {
        // TURN OFF
        isLiveModeActive = false;
        btnGoLive.classList.remove('active');
        btnGoLive.innerHTML = '🎙️ Go Live';
        if (liveContainer) liveContainer.style.display = 'none';

        if (mediaStream) {
          mediaStream.getTracks().forEach(t => t.stop());
          mediaStream = null;
        }
        if (recognition) {
          recognition.stop();
          recognition = null;
        }
        window.speechSynthesis.cancel();
      } else {
        // TURN ON
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); // Audio captured via SpeechRec
          if (webcamFeed) webcamFeed.srcObject = mediaStream;

          isLiveModeActive = true;
          btnGoLive.classList.add('active');
          btnGoLive.innerHTML = '🛑 Stop Live';
          if (liveContainer) liveContainer.style.display = 'flex';

          recognition = initSpeechRecognition();
          if (recognition) {
            recognition.lang = getLanguage() === 'fi' ? 'fi-FI' : 'en-US';
            recognition.start();
          }
        } catch (err) {
          alert("Could not access webcam. Please allow permissions.");
        }
      }
    });
  }


  async function loadAgentConfiguration() {
    if (!habitatAgentSelect || !habitatPromptTextarea || !habitatProviderSelect || !habitatModelSelect) return;
    try {
      const response = await fetch('/api/agents/prompts');
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      loadedPromptsCache = payload.prompts || {};
      const agent = loadedPromptsCache[habitatAgentSelect.value] as any;
      if (!agent) return;
      runtimeProviders = payload.available_providers || {};
      habitatPromptTextarea.value = agent.system_prompt || '';
      renderRuntimeProviderOptions(agent.provider);
      renderRuntimeModelOptions(habitatProviderSelect.value, agent.model);
      if (habitatTemperatureInput) habitatTemperatureInput.value = Number(agent.temperature ?? 0.7).toFixed(2);
      if (habitatMaxTokensInput) habitatMaxTokensInput.value = String(agent.max_tokens ?? 1500);
    } catch (error) {
      if (habitatSaveStatus) {
        habitatSaveStatus.style.display = 'inline';
        habitatSaveStatus.textContent = 'Could not load agent configuration.';
      }
      console.error('Could not load agent configuration:', error);
    }
  }

  if (habitatAgentSelect) {
    habitatAgentSelect.addEventListener('change', () => {
      loadAgentConfiguration();
    });
  }

  if (saveHabitatPromptBtn && habitatAgentSelect && habitatPromptTextarea && habitatProviderSelect && habitatModelSelect) {
    saveHabitatPromptBtn.addEventListener('click', async () => {
      if (habitatSaveStatus) {
        habitatSaveStatus.style.display = 'inline';
        habitatSaveStatus.textContent = 'Saving agent profile…';
      }
      try {
        const response = await fetch('/api/agents/prompt/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_type: habitatAgentSelect.value,
            system_prompt: habitatPromptTextarea.value,
            provider: habitatProviderSelect.value,
            model: habitatModelSelect.value,
            temperature: habitatTemperatureInput ? Number(habitatTemperatureInput.value) : 0.7,
            max_tokens: habitatMaxTokensInput ? Number(habitatMaxTokensInput.value) : 1500,
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const saved = await response.json();
        habitatProviderSelect.value = saved.provider || habitatProviderSelect.value;
        renderRuntimeModelOptions(habitatProviderSelect.value, saved.model || habitatModelSelect.value);
        if (habitatSaveStatus) {
          habitatSaveStatus.textContent = `Saved · ${habitatProviderSelect.options[habitatProviderSelect.selectedIndex]?.text || habitatProviderSelect.value} / ${habitatModelSelect.value}`;
        }
        await loadAgentConfiguration();
      } catch (error) {
        if (habitatSaveStatus) {
          habitatSaveStatus.textContent = `Save failed: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
      }
    });
  }

  async function fetchAndRenderAgentPrompts() {
    try {
      const res = await fetch('/api/agents/prompts');
      if (res.ok) {
        const data = await res.json();
        loadedPromptsCache = data.prompts || {};
      }
    } catch (e) { console.warn(e); }
  }

  async function fetchAndRenderApiUsage() {
    const requests = document.getElementById('usage-requests');
    const promptTokens = document.getElementById('usage-prompt-tokens');
    const completionTokens = document.getElementById('usage-completion-tokens');
    const cost = document.getElementById('usage-cost');
    const providerBody = document.getElementById('usage-provider-body');
    try {
      const response = await fetch('/api/providers/usage');
      if (!response.ok) throw new Error(await response.text());
      const usage = await response.json();
      if (requests) requests.textContent = Number(usage.total_requests || 0).toLocaleString();
      if (promptTokens) promptTokens.textContent = Number(usage.total_prompt_tokens || 0).toLocaleString();
      if (completionTokens) completionTokens.textContent = Number(usage.total_completion_tokens || 0).toLocaleString();
      if (cost) cost.textContent = `$${Number(usage.total_cost_usd || 0).toFixed(4)}`;
      if (providerBody) {
        providerBody.replaceChildren();
        const providers = Object.entries(usage.providers || {}) as Array<[string, Record<string, number>]>;
        if (!providers.length) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.className = 'placeholder-rag';
          cell.textContent = 'No usage data yet.';
          row.appendChild(cell);
          providerBody.appendChild(row);
        } else {
          providers.forEach(([provider, metrics]) => {
            const row = document.createElement('tr');
            [provider, metrics.requests || 0, metrics.prompt_tokens || 0, metrics.completion_tokens || 0, `$${Number(metrics.cost_usd || 0).toFixed(4)}`]
              .forEach((value) => {
                const cell = document.createElement('td');
                cell.textContent = String(value);
                row.appendChild(cell);
              });
            providerBody.appendChild(row);
          });
        }
      }
    } catch (error) {
      console.warn('Could not fetch API usage:', error);
    }
  }

  document.getElementById('refresh-usage-btn')?.addEventListener('click', () => {
    void fetchAndRenderApiUsage();
  });



// ==========================================
// Database Studio Dashboard Logic
// ==========================================

async function fetchDBTables() {
  if (!dbTablesList) return;
  try {
    const res = await fetch('/api/db/tables');
    if (res.ok) {
      const data = await res.json();
      dbTablesList.innerHTML = '';
      data.tables.forEach((table: string) => {
        const div = document.createElement('div');
        div.className = 'notebook-item';
        const label = document.createElement('div');
        label.className = 'db-table-nav-item';
        const icon = document.createElement('span');
        icon.className = 'notebook-icon';
        icon.textContent = '🗄️';
        const name = document.createElement('span');
        name.className = 'notebook-title';
        name.textContent = table;
        label.append(icon, name);
        div.appendChild(label);
        div.addEventListener('click', () => {
          document.querySelectorAll('#db-tables-list .notebook-item').forEach(el => el.classList.remove('active-table'));
          div.classList.add('active-table');
          loadTableData(table);
        });
        dbTablesList.appendChild(div);
      });
    }
  } catch (e) {
    console.warn("Could not fetch tables", e);
  }
}


const dbTablesList = document.getElementById('db-tables-list');
const dbCurrentTableTitle = document.getElementById('db-current-table-title');
const dbRefreshBtn = document.getElementById('db-refresh-btn');
const dbPlaceholderMsg = document.getElementById('db-placeholder-msg');
const dbDataTable = document.getElementById('db-data-table');
const dbDataThead = document.getElementById('db-data-thead');
const dbDataTbody = document.getElementById('db-data-tbody');
const dbRowModal = document.getElementById('db-row-modal');
const closeDbRowBtn = document.getElementById('close-db-row-btn');
const dbRowForm = document.getElementById('db-row-form');
const dbRowFieldsContainer = document.getElementById('db-row-fields-container');
let currentActiveTable: string | null = null;
let currentTableSchema: Array<{ name: string; type: string; pk: number }> = [];
let currentEditingPkCol: string | null = null;
let currentEditingPkVal: string | number | null = null;
let isCreatingDbRow = false;
let dbAddRowBtn = document.getElementById('db-add-row-btn') as HTMLButtonElement | null;

if (!dbAddRowBtn && dbRefreshBtn) {
  dbAddRowBtn = document.createElement('button');
  dbAddRowBtn.type = 'button';
  dbAddRowBtn.id = 'db-add-row-btn';
  dbAddRowBtn.className = 'chip-btn';
  dbAddRowBtn.textContent = '+ New Row';
  dbAddRowBtn.style.display = 'none';
  dbRefreshBtn.insertAdjacentElement('afterend', dbAddRowBtn);
}

if (dbRefreshBtn) {

  dbRefreshBtn.addEventListener('click', () => {
    if (currentActiveTable) loadTableData(currentActiveTable);
  });
}

async function loadTableData(table: string) {
  currentActiveTable = table;
  if (dbCurrentTableTitle) dbCurrentTableTitle.innerText = `🗄️ ${table}`;
  if (dbRefreshBtn) dbRefreshBtn.style.display = 'inline-block';
  if (dbAddRowBtn) dbAddRowBtn.style.display = 'inline-block';
  if (dbPlaceholderMsg) dbPlaceholderMsg.style.display = 'none';
  if (dbDataTable) dbDataTable.style.display = 'table';

  if (!dbDataThead || !dbDataTbody) return;

  try {
    const res = await fetch(`/api/db/tables/${table}`);
    if (res.ok) {
      const data = await res.json();
      currentTableSchema = data.schema;

      const headerRow = document.createElement('tr');
      data.schema.forEach((col: any) => {
        const header = document.createElement('th');
        header.textContent = `${col.name}${col.pk ? ' 🔑' : ''}`;
        headerRow.appendChild(header);
      });
      const actionHeader = document.createElement('th');
      actionHeader.textContent = t('action_actions');
      headerRow.appendChild(actionHeader);
      dbDataThead.replaceChildren(headerRow);

      dbDataTbody.replaceChildren();
      if (data.rows.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = data.schema.length + 1;
        cell.className = 'db-empty-cell';
        cell.textContent = t('msg_no_rows').replace('{table}', table);
        row.appendChild(cell);
        dbDataTbody.appendChild(row);
      } else {
        const pkCol = data.schema.find((c: any) => c.pk === 1)?.name || data.schema[0].name;
        data.rows.forEach((row: Record<string, unknown>) => {
          const tableRow = document.createElement('tr');
          data.schema.forEach((col: any) => {
            const cell = document.createElement('td');
            const value = row[col.name];
            const display = value === null || value === undefined ? 'NULL' : String(value);
            cell.textContent = display.length > 120 ? `${display.slice(0, 120)}...` : display;
            cell.title = display;
            tableRow.appendChild(cell);
          });

          const actions = document.createElement('td');
          const editButton = document.createElement('button');
          editButton.type = 'button';
          editButton.className = 'action-sm-btn';
          editButton.textContent = t('action_edit');
          editButton.addEventListener('click', () => openEditModal(pkCol, row[pkCol], row));
          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.className = 'action-sm-btn delete-db-btn';
          deleteButton.textContent = t('action_delete');
          deleteButton.addEventListener('click', async () => {
            if (confirm(t('action_delete_confirm'))) {
              try {
                const res = await fetch(`/api/db/tables/${table}/${pkCol}/${encodeURIComponent(String(row[pkCol]))}`, { method: 'DELETE' });
                if (!res.ok) throw new Error(await res.text());
                loadTableData(table);
              } catch (err) {
                console.error('Failed to delete row:', err);
                alert(`Could not delete row: ${err instanceof Error ? err.message : 'network error'}`);
              }
            }
          });
          actions.append(editButton, deleteButton);
          tableRow.appendChild(actions);
          dbDataTbody.appendChild(tableRow);
        });
      }
    }
  } catch (e) {
    console.warn("Could not load table data", e);
  }
}

function openEditModal(pkCol: string, pkVal: any, rowData: any, creating = false) {
  isCreatingDbRow = creating;
  currentEditingPkCol = pkCol;
  currentEditingPkVal = pkVal;

  if (dbRowFieldsContainer) {
    dbRowFieldsContainer.replaceChildren();
    currentTableSchema.forEach((col) => {
      const div = document.createElement('div');
      div.className = 'input-group';
      const isPk = !creating && col.name === pkCol;
      const type = col.type.toLowerCase();

      let inputEl: HTMLInputElement | HTMLTextAreaElement;
      if (type.includes('text') && col.name.includes('md') || col.name.includes('prompt')) {
        inputEl = document.createElement('textarea');
        inputEl.rows = 6;
      } else {
        inputEl = document.createElement('input');
        inputEl.type = 'text';
      }
      inputEl.id = `edit-col-${col.name}`;
      inputEl.className = 'param-select full-width';
      inputEl.disabled = isPk;
      const label = document.createElement('label');
      label.htmlFor = inputEl.id;
      label.textContent = `${col.name} ${isPk ? '(Primary Key)' : ''}`;
      div.append(label, inputEl);
      dbRowFieldsContainer.appendChild(div);
      inputEl.value = rowData[col.name] !== null && rowData[col.name] !== undefined ? String(rowData[col.name]) : '';
    });
  }

  if (dbRowModal) dbRowModal.style.display = 'flex';
}

if (dbAddRowBtn) {
  dbAddRowBtn.addEventListener('click', () => {
    if (currentActiveTable && currentTableSchema.length) openEditModal('', null, {}, true);
  });
}

if (closeDbRowBtn) {
  closeDbRowBtn.addEventListener('click', () => {
    if (dbRowModal) dbRowModal.style.display = 'none';
  });
}

if (dbRowForm) {
  dbRowForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data: any = {};
    currentTableSchema.forEach((col) => {
      const inputEl = document.getElementById(`edit-col-${col.name}`) as HTMLInputElement;
      if (inputEl) {
        data[col.name] = inputEl.value;
      }
    });

    try {
      if (!currentActiveTable) return;
      if (!isCreatingDbRow && (!currentEditingPkCol || currentEditingPkVal === null)) return;
      const url = isCreatingDbRow
        ? `/api/db/tables/${currentActiveTable}`
        : `/api/db/tables/${currentActiveTable}/${currentEditingPkCol}/${encodeURIComponent(String(currentEditingPkVal))}`;
      const res = await fetch(url, {
        method: isCreatingDbRow ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        if (dbRowModal) dbRowModal.style.display = 'none';
        if (currentActiveTable) loadTableData(currentActiveTable);
      } else {
        alert('Failed to update row');
      }
    } catch (err) {
      console.error(err);
      alert('Error updating row');
    }
  });
}

// ==========================================
// Kanban Board Logic
// ==========================================

const tabKanban = document.getElementById('tab-kanban');
const viewKanban = document.getElementById('view-kanban');
const newTaskBtn = document.getElementById('new-task-btn');
const newTaskModal = document.getElementById('new-task-modal');
const closeTaskModalBtn = document.getElementById('close-task-modal-btn');
const newTaskForm = document.getElementById('new-task-form') as HTMLFormElement;
const taskPromptInput = document.getElementById('task-prompt') as HTMLTextAreaElement | null;
const taskProjectSelect = document.getElementById('task-project-select') as HTMLSelectElement | null;
const taskTimeInput = document.getElementById('task-time') as HTMLInputElement | null;
const taskModalTitle = document.getElementById('task-modal-title') as HTMLElement | null;
const taskModalSubmit = document.getElementById('task-modal-submit') as HTMLButtonElement | null;

const colPending = document.querySelector('#col-pending .kanban-task-list') as HTMLDivElement;
const colRun = document.querySelector('#col-run .kanban-task-list') as HTMLDivElement;
const colDone = document.querySelector('#col-done .kanban-task-list') as HTMLDivElement;

const countPending = document.getElementById('count-pending');
const countRun = document.getElementById('count-run');
const countDone = document.getElementById('count-done');
const taskArchiveModal = document.getElementById('task-archive-modal') as HTMLDivElement | null;
const closeTaskArchiveBtn = document.getElementById('close-task-archive-btn') as HTMLButtonElement | null;
const archiveTaskTitle = document.getElementById('archive-task-title');
const archiveTaskMeta = document.getElementById('archive-task-meta');
const archiveTaskResult = document.getElementById('archive-task-result');
const archiveVersionHistory = document.getElementById('archive-version-history');
const archiveTaskStatus = document.getElementById('archive-task-status');
const rerunArchiveTaskBtn = document.getElementById('rerun-archive-task-btn') as HTMLButtonElement | null;

let currentDraggedTask: any = null;
let archiveTaskId: string | null = null;
let editingKanbanTaskId: string | null = null;
const kanbanApiBase = () => window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : '';
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function loadKanbanProjectOptions() {
  if (!taskProjectSelect) return;
  const selectedId = taskProjectSelect.value;
  try {
    const response = await fetch(`${kanbanApiBase()}/api/notebooks`);
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    const projects = Array.isArray(payload.notebooks) ? payload.notebooks : [];
    taskProjectSelect.replaceChildren();
    const orgOption = document.createElement('option');
    orgOption.value = '';
    orgOption.textContent = 'Organization-wide task';
    taskProjectSelect.appendChild(orgOption);
    projects.forEach((project: any) => {
      const option = document.createElement('option');
      option.value = String(project.id || '');
      option.textContent = String(project.name || 'Untitled project');
      taskProjectSelect.appendChild(option);
    });
    taskProjectSelect.value = projects.some((project: any) => project.id === selectedId) ? selectedId : '';
  } catch (error) {
    console.warn('Could not load project scopes for Kanban task:', error);
  }
}

function taskNotebookIds(task: any): string[] {
  try {
    const ids = typeof task.notebook_ids_json === 'string'
      ? JSON.parse(task.notebook_ids_json)
      : task.notebook_ids_json;
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

async function openKanbanTaskModal(task: any | null = null) {
  if (!newTaskModal || !newTaskForm) return;
  editingKanbanTaskId = task?.id || null;
  newTaskForm.reset();
  if (taskPromptInput) taskPromptInput.value = task?.prompt || '';
  if (taskTimeInput) taskTimeInput.value = task?.schedule_enabled ? toLocalDateTimeInput(task.scheduled_time) : '';
  if (taskProjectSelect) taskProjectSelect.value = taskNotebookIds(task)[0] || '';
  if (taskModalTitle) taskModalTitle.textContent = editingKanbanTaskId ? '✏️ Edit Board Task' : '📋 Add Board Task';
  if (taskModalSubmit) taskModalSubmit.textContent = editingKanbanTaskId ? 'Save task' : 'Add to Pending';
  await loadKanbanProjectOptions();
  newTaskModal.style.display = 'flex';
}

function parseTaskDate(value: string): Date {
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return new Date(normalised);
}

function formatTaskTime(value: string): string {
  const date = parseTaskDate(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function toLocalDateTimeInput(value: string): string {
  const date = parseTaskDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatTaskCountdown(value: string): string {
  const dueAt = parseTaskDate(value).getTime();
  if (Number.isNaN(dueAt)) return 'Schedule unavailable';
  const seconds = Math.ceil((dueAt - Date.now()) / 1_000);
  if (seconds <= 0) return 'Due now — agent is starting…';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = days ? [`${days}d`, `${hours}h`] : hours ? [`${hours}h`, `${minutes}m`] : [`${minutes}m`, `${remainingSeconds}s`];
  return `Runs in ${parts.join(' ')}`;
}

function refreshKanbanCountdowns() {
  document.querySelectorAll<HTMLElement>('[data-kanban-countdown]').forEach((element) => {
    const scheduledTime = element.dataset.kanbanCountdown || '';
    element.textContent = formatTaskCountdown(scheduledTime);
  });
}

function makeKanbanAction(label: string, className: string, handler: () => void, iconSvg?: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  if (iconSvg) {
    button.innerHTML = `${iconSvg}<span>${label}</span>`;
  } else {
    button.textContent = label;
  }
  button.addEventListener('click', handler);
  return button;
}


if (newTaskBtn && newTaskModal) {
  newTaskBtn.addEventListener('click', () => {
    void openKanbanTaskModal();
  });
}

if (closeTaskModalBtn && newTaskModal) {
  closeTaskModalBtn.addEventListener('click', () => {
    newTaskModal.style.display = 'none';
    editingKanbanTaskId = null;
  });
}

if (newTaskForm) {
  newTaskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = taskPromptInput?.value.trim() || '';
    if (!prompt) {
      alert('Add clear instructions for the AI Board Member.');
      return;
    }

    try {
      const localScheduledTime = taskTimeInput?.value || '';
      const payload = {
        prompt,
        username: currentUser?.username || 'alex',
        notebook_ids: taskProjectSelect?.value ? [taskProjectSelect.value] : [],
        scheduled_time: localScheduledTime ? new Date(localScheduledTime).toISOString() : null,
        timezone: localTimeZone(),
      };
      const res = await fetch(
        editingKanbanTaskId
          ? `${kanbanApiBase()}/api/tasks/${encodeURIComponent(editingKanbanTaskId)}`
          : `${kanbanApiBase()}/api/tasks`,
        {
        method: editingKanbanTaskId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        if (newTaskModal) newTaskModal.style.display = 'none';
        editingKanbanTaskId = null;
        newTaskForm.reset();
        fetchAndRenderKanbanTasks();
      } else {
        alert(`Could not ${editingKanbanTaskId ? 'save' : 'add'} task.`);
      }
    } catch (err) {
      console.error(err);
      alert(`Could not ${editingKanbanTaskId ? 'save' : 'add'} task.`);
    }
  });
}

async function fetchAndRenderKanbanTasks() {
  try {
    const res = await fetch(`${kanbanApiBase()}/api/tasks`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (data.tasks) {
      renderKanbanBoard(data.tasks);
    }
  } catch (err) {
    console.error('Failed to fetch kanban tasks', err);
    renderKanbanBoard([]);
  }
}

function appendKanbanEmptyState(container: HTMLElement, title: string, detail: string) {
  const empty = document.createElement('div');
  empty.className = 'kanban-empty-state';
  const icon = document.createElement('span');
  icon.className = 'kanban-empty-icon';
  icon.textContent = '✓';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = detail;
  empty.append(icon, heading, copy);
  container.appendChild(empty);
}

function renderKanbanBoard(tasks: any[]) {
  if (!colPending || !colRun || !colDone) return;
  colPending.replaceChildren();
  colRun.replaceChildren();
  colDone.replaceChildren();
  let pCount = 0, rCount = 0, aCount = 0;

  tasks.forEach(task => {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = task.status === 'pending' && !task.managed_by_goal;
    card.dataset.taskId = task.id;

    const title = document.createElement('h4');
    title.textContent = task.prompt;
    if (task.managed_by_goal && task.goal_title) {
      const goalLabel = document.createElement('div');
      goalLabel.className = 'task-goal-label';
      goalLabel.textContent = task.goal_title;
      card.appendChild(goalLabel);
    }
    const metadata = document.createElement('div');
    metadata.className = 'task-time';
    const isScheduled = Boolean(task.schedule_enabled);
    const timeLabel = task.status === 'pending'
      ? (isScheduled ? 'Scheduled' : 'Created')
      : task.status === 'running' ? 'Started' : 'Completed';
    const shownTime = task.status === 'pending'
      ? (isScheduled ? task.scheduled_time : (task.created_at || task.scheduled_time))
      : (task.started_at || task.completed_at || task.scheduled_time);
    metadata.textContent = `${timeLabel}: ${formatTaskTime(shownTime)}`;
    const version = document.createElement('span');
    version.className = 'task-version';
    version.textContent = `Version ${task.version || 1}`;
    card.append(title, metadata);
    if (task.status === 'pending' && isScheduled) {
      const countdown = document.createElement('div');
      countdown.className = 'task-countdown';
      countdown.dataset.kanbanCountdown = task.scheduled_time;
      countdown.textContent = formatTaskCountdown(task.scheduled_time);
      card.appendChild(countdown);
    }
    card.appendChild(version);

    if (task.result_summary) {
      const summary = document.createElement('div');
      summary.className = 'task-summary';
      summary.textContent = task.result_summary;
      card.appendChild(summary);
    }

    const actions = document.createElement('div');
    actions.className = 'kanban-card-actions';
    const runIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    const editIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
    const deleteIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    const viewIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    const rerunIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;

    if (task.managed_by_goal) {
      const managed = document.createElement('span');
      managed.className = 'task-running-label';
      managed.textContent = `Goal step · ${String(task.step_status || task.status).replace('_', ' ')}`;
      actions.appendChild(managed);
    } else if (task.status === 'pending') {
      actions.append(
        makeKanbanAction(t('action_run'), 'action-sm-btn action-primary', () => void runKanbanTaskNow(task.id), runIcon),
        makeKanbanAction(t('action_edit'), 'action-sm-btn', () => void openKanbanTaskModal(task), editIcon),
        makeKanbanAction(t('action_delete'), 'action-sm-btn delete-db-btn', () => void deleteKanbanTask(task.id), deleteIcon),
      );
    } else if (task.status === 'running') {
      const running = document.createElement('span');
      running.className = 'task-running-label';
      running.textContent = t('status_loading');
      actions.appendChild(running);
    } else {
      actions.append(
        makeKanbanAction(t('action_view'), 'action-sm-btn', () => void openKanbanArchive(task.id), viewIcon),
        makeKanbanAction(t('action_run'), 'action-sm-btn action-primary', () => void rerunKanbanTask(task.id), rerunIcon),
        makeKanbanAction(t('action_delete'), 'action-sm-btn delete-db-btn', () => void deleteKanbanTask(task.id), deleteIcon),
      );
    }
    if (task.goal_id) {
      actions.append(makeKanbanAction('Goal', 'action-sm-btn', () => {
        window.dispatchEvent(new CustomEvent('open-agent-work-goal', { detail: { goalId: task.goal_id } }));
      }));
    }
    card.appendChild(actions);

    card.addEventListener('dragstart', () => {
      if (task.managed_by_goal) return;
      currentDraggedTask = task;
      setTimeout(() => card.style.opacity = '0.5', 0);
    });
    card.addEventListener('dragend', () => {
      currentDraggedTask = null;
      card.style.opacity = '1';
    });

    if (task.status === 'pending') { colPending.appendChild(card); pCount++; }
    else if (task.status === 'running') { colRun.appendChild(card); rCount++; }
    else if (task.status === 'done' || task.status === 'failed') { colDone.appendChild(card); aCount++; }
  });

  if (countPending) countPending.textContent = pCount.toString();
  if (countRun) countRun.textContent = rCount.toString();
  if (countDone) countDone.textContent = aCount.toString();
  if (!pCount) appendKanbanEmptyState(colPending, 'Nothing waiting for approval', 'Add a Board task here, then run it when you are ready.');
  if (!rCount) appendKanbanEmptyState(colRun, 'No task is running', 'Approved work appears here while the AI Board Member is executing it.');
  if (!aCount) appendKanbanEmptyState(colDone, 'No completed results yet', 'Completed and failed task results will be archived here.');
  refreshKanbanCountdowns();
}

async function runKanbanTaskNow(taskId: string) {
  try {
    const response = await fetch(`${kanbanApiBase()}/api/tasks/${encodeURIComponent(taskId)}/run`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    await fetchAndRenderKanbanTasks();
  } catch (error) {
    alert(`Could not start task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function deleteKanbanTask(taskId: string) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  try {
    const response = await fetch(`${kanbanApiBase()}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await response.text());
    await fetchAndRenderKanbanTasks();
  } catch (error) {
    alert(`Could not delete task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function openKanbanArchive(taskId: string) {
  try {
    const response = await fetch(`${kanbanApiBase()}/api/tasks/${encodeURIComponent(taskId)}`);
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    const task = payload.task;
    archiveTaskId = task.id;
    if (archiveTaskTitle) archiveTaskTitle.textContent = `${task.status === 'failed' ? 'Failed' : 'Completed'} task · Version ${task.version || 1}`;
    if (archiveTaskMeta) archiveTaskMeta.textContent = `Completed ${formatTaskTime(task.completed_at || task.scheduled_time)} · ${task.scheduled_timezone || localTimeZone()}`;
    if (archiveTaskResult) archiveTaskResult.textContent = task.result_md || task.error_message || task.result_summary || 'No detailed result was saved.';
    if (archiveVersionHistory) {
      archiveVersionHistory.replaceChildren();
      (payload.versions || []).forEach((version: any) => {
        const item = document.createElement('div');
        item.className = `archive-version-item is-${version.status}`;
        item.textContent = `Version ${version.version || 1} · ${version.status} · ${formatTaskTime(version.completed_at || version.started_at || version.scheduled_time)}`;
        archiveVersionHistory.appendChild(item);
      });
    }
    if (archiveTaskStatus) archiveTaskStatus.textContent = '';
    if (taskArchiveModal) taskArchiveModal.style.display = 'flex';
  } catch (error) {
    alert(`Could not open archive: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

async function rerunKanbanTask(taskId: string) {
  try {
    const response = await fetch(`${kanbanApiBase()}/api/tasks/${encodeURIComponent(taskId)}/rerun`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: localTimeZone() }),
    });
    if (!response.ok) throw new Error(await response.text());
    if (taskArchiveModal) taskArchiveModal.style.display = 'none';
    await fetchAndRenderKanbanTasks();
  } catch (error) {
    alert(`Could not rerun task: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

if (closeTaskArchiveBtn && taskArchiveModal) closeTaskArchiveBtn.addEventListener('click', () => { taskArchiveModal.style.display = 'none'; });
if (rerunArchiveTaskBtn) rerunArchiveTaskBtn.addEventListener('click', () => { if (archiveTaskId) void rerunKanbanTask(archiveTaskId); });

if (colRun) {
  colRun.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (colRun.parentElement) colRun.parentElement.style.borderColor = 'var(--accent-blue)';
  });
  colRun.addEventListener('dragleave', () => {
    if (colRun.parentElement) colRun.parentElement.style.borderColor = 'var(--panel-border)';
  });
  colRun.addEventListener('drop', (event) => {
    event.preventDefault();
    if (colRun.parentElement) colRun.parentElement.style.borderColor = 'var(--panel-border)';
    if (currentDraggedTask?.status === 'pending') void runKanbanTaskNow(currentDraggedTask.id);
  });
}

window.addEventListener('ai-os-agent-event', (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (detail?.type === 'KANBAN_TASK_UPDATED') void fetchAndRenderKanbanTasks();
});

// Polling is a fallback; WebSocket task events keep an open board in sync immediately.
setInterval(() => {
  const board = document.getElementById('agent-work-board-panel');
  if (board && board.offsetParent !== null) {
    fetchAndRenderKanbanTasks();
  }
}, 5000);

setInterval(() => {
  const board = document.getElementById('agent-work-board-panel');
  if (board && board.offsetParent !== null) {
    refreshKanbanCountdowns();
  }
}, 1000);

});

// Notebook sources are refreshed from their selected notebook membership above.
