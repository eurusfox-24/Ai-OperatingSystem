import { RobotCanvasVisualizer } from './visualizer/robot_canvas';
import { SocketClient } from './socket';
interface UserProfile {
  username: string;
  display_name: string;
  role: string;
  tone_style: string;
  custom_instructions: string;
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

document.addEventListener('DOMContentLoaded', () => {
  const visualizer = new RobotCanvasVisualizer('robot-canvas');
  let socketClient: SocketClient | null = null;
  const appShell = document.getElementById('app');

  // 3-Mode Theme Switcher (Nordic White, Warm Dark, Warm Sand)
  const themeBtns = document.querySelectorAll('.theme-btn') as NodeListOf<HTMLButtonElement>;
  function applyTheme(themeName: string) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('ai_os_theme', themeName);
    themeBtns.forEach(btn => {
      if (btn.getAttribute('data-theme-set') === themeName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
  let savedTheme = localStorage.getItem('ai_os_theme');
  if (!savedTheme || savedTheme === 'light') {
    savedTheme = 'dark';
  }
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
  const btnGoIngestion = document.getElementById('btn-go-ingestion') as HTMLButtonElement | null;
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
      const response = await fetch('http://localhost:8000/api/providers/registry');
      if (!response.ok) throw new Error(await response.text());
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
          editingProviderId ? `http://localhost:8000/api/providers/registry/${encodeURIComponent(editingProviderId)}` : 'http://localhost:8000/api/providers/registry',
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
      const response = await fetch('http://localhost:8000/api/autonomy/tasks?limit=100');
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

  function switchView(target: 'dashboard' | 'mvp-showcase' | 'customization' | 'ingestion' | 'habitat' | 'kanban' | 'agent-logs') {
    tabDashboard.classList.remove('active');
    if (tabMvpShowcase) tabMvpShowcase.classList.remove('active');
    if (tabCustomization) tabCustomization.classList.remove('active');
    if (tabIngestion) tabIngestion.classList.remove('active');
    if (tabHabitat) tabHabitat.classList.remove('active');
    if (tabKanbanHeader) tabKanbanHeader.classList.remove('active');
    if (tabAgentLogs) tabAgentLogs.classList.remove('active');

    viewDashboard.style.display = target === 'dashboard' ? 'block' : 'none';
    if (viewMvpShowcase) viewMvpShowcase.style.display = target === 'mvp-showcase' ? 'block' : 'none';
    if (viewCustomization) viewCustomization.style.display = target === 'customization' ? 'flex' : 'none';
    if (viewIngestion) viewIngestion.style.display = target === 'ingestion' ? 'flex' : 'none';
    if (viewHabitat) viewHabitat.style.display = target === 'habitat' ? 'flex' : 'none';
    if (viewKanbanPage) viewKanbanPage.style.display = target === 'kanban' ? 'block' : 'none';
    if (viewAgentLogs) viewAgentLogs.style.display = target === 'agent-logs' ? 'block' : 'none';

    if (target === 'dashboard') {
      tabDashboard.classList.add('active');
    } else if (target === 'mvp-showcase') {
      if (tabMvpShowcase) tabMvpShowcase.classList.add('active');
    } else if (target === 'customization') {
      if (tabCustomization) tabCustomization.classList.add('active');
      fetchAndRenderAgentPrompts();
      loadAgentConfiguration();
      updateLivePromptInspector();
      fetchAndRenderProviderRegistry();
      fetchAndRenderApiUsage();
          // @ts-ignore
      if (typeof fetchDBTables === 'function') fetchDBTables();
    } else if (target === 'ingestion') {
      if (tabIngestion) tabIngestion.classList.add('active');
      fetchDBTables();
    } else if (target === 'habitat') {
      if (tabHabitat) tabHabitat.classList.add('active');
      visualizer.resizeCanvas();
      fetchAndRenderAgentPrompts();
      loadAgentConfiguration();
    } else if (target === 'agent-logs') {
      if (tabAgentLogs) tabAgentLogs.classList.add('active');
      void fetchAndRenderAgentLogs();
    }
  }

  tabDashboard.addEventListener('click', () => switchView('dashboard'));
  if (tabMvpShowcase) tabMvpShowcase.addEventListener('click', () => switchView('mvp-showcase'));
  if (tabCustomization) tabCustomization.addEventListener('click', () => switchView('customization'));
  if (tabIngestion) tabIngestion.addEventListener('click', () => switchView('ingestion'));
  if (tabHabitat) tabHabitat.addEventListener('click', () => switchView('habitat'));
  if (tabKanbanHeader) tabKanbanHeader.addEventListener('click', () => switchView('kanban'));
  if (tabAgentLogs) tabAgentLogs.addEventListener('click', () => switchView('agent-logs'));
  if (refreshAgentLogsBtn) refreshAgentLogsBtn.addEventListener('click', () => void fetchAndRenderAgentLogs());
  if (btnGoIngestion) btnGoIngestion.addEventListener('click', () => switchView('ingestion'));
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

  mvpRunDemoBtn?.addEventListener('click', () => {
    if (!mvpDemoStatus || !mvpRunDemoBtn) return;
    mvpRunDemoBtn.disabled = true;
    mvpDemoStatus.textContent = 'Scanning 24 configured sources...';
    window.setTimeout(() => {
      mvpDemoStatus.textContent = '18 signals · 4 opportunities · brief ready';
      mvpRunDemoBtn.textContent = 'Demo scan complete';
      mvpRunDemoBtn.disabled = false;
    }, 900);
  });

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
  const businessContextBtn = document.getElementById('business-context-btn') as HTMLButtonElement | null;
  const businessContextSummary = document.getElementById('business-context-summary') as HTMLElement | null;
  const businessContextModal = document.getElementById('business-context-modal') as HTMLDivElement | null;
  const closeBusinessContextBtn = document.getElementById('close-business-context-btn') as HTMLButtonElement | null;
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
      activeContextBadge.textContent = '🔎 Deep research workflow enabled';
      return;
    }
    const selectedCount = selectedProjectIds.size;
    if (!selectedCount) {
      activeContextBadge.textContent = '🧠 + 🌐 Reasoning & Internet';
    } else {
      activeContextBadge.textContent = `🌲 ${selectedCount} project${selectedCount === 1 ? '' : 's'} + 🌐 Internet`;
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
    internal.textContent = 'Forest Joensuu internal project';
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
      empty.textContent = 'No partner companies yet. Internal Forest Joensuu projects do not need one.';
      partnerCompanyList.appendChild(empty);
      return;
    }
    partnerCompanies.forEach((company) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'partner-company-item';
      const title = document.createElement('strong');
      title.textContent = company.name;
      const detail = document.createElement('span');
      detail.textContent = company.context_md || company.priorities_md || 'Company context ready to edit';
      item.append(title, detail);
      item.addEventListener('click', () => {
        editingCompanyId = company.id;
        if (partnerCompanyName) partnerCompanyName.value = company.name || '';
        if (partnerCompanyContext) partnerCompanyContext.value = company.context_md || '';
        if (partnerCompanyPriorities) partnerCompanyPriorities.value = company.priorities_md || '';
        if (partnerCompanyConstraints) partnerCompanyConstraints.value = company.constraints_md || '';
        if (partnerCompanySaveBtn) partnerCompanySaveBtn.textContent = 'Update partner company';
        if (partnerCompanyStatus) partnerCompanyStatus.textContent = `Editing ${company.name}`;
      });
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
      if (organizationContextName) organizationContextName.value = organization.name || 'Forest Joensuu';
      if (organizationContextMission) organizationContextMission.value = organization.mission_md || '';
      if (organizationContextPriorities) organizationContextPriorities.value = organization.priorities_md || '';
      if (organizationContextConstraints) organizationContextConstraints.value = organization.constraints_md || '';
      if (organizationContextPrinciples) organizationContextPrinciples.value = organization.decision_principles_md || '';
      if (businessContextSummary) {
        businessContextSummary.textContent = organization.mission_md || organization.priorities_md || organization.constraints_md
          ? `${organization.name || 'Forest Joensuu'} DNA active · ${partnerCompanies.length} partner ${partnerCompanies.length === 1 ? 'company' : 'companies'}`
          : 'Add Forest Joensuu DNA to guide every project answer';
      }
      renderPartnerCompanyOptions(projectCompanySelect?.value || '');
      renderPartnerCompanyList();
    } catch (error) {
      if (businessContextSummary) businessContextSummary.textContent = 'Business context is unavailable. Check the local kernel.';
      console.warn('Could not load business context:', error);
    }
  }

  function closeBusinessContext() {
    if (businessContextModal) businessContextModal.style.display = 'none';
    resetPartnerCompanyForm();
  }

  async function openBusinessContext() {
    await loadBusinessContext();
    if (businessContextModal) businessContextModal.style.display = 'flex';
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

  if (businessContextBtn) businessContextBtn.addEventListener('click', () => void openBusinessContext());
  if (closeBusinessContextBtn) closeBusinessContextBtn.addEventListener('click', closeBusinessContext);
  if (businessContextModal) businessContextModal.addEventListener('click', (event) => {
    if (event.target === businessContextModal) closeBusinessContext();
  });
  if (organizationContextForm) organizationContextForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (organizationContextStatus) organizationContextStatus.textContent = 'Saving Forest Joensuu DNA…';
    try {
      const response = await fetch(`${businessContextApiBase()}/api/business-context/organization`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: organizationContextName?.value || 'Forest Joensuu',
          mission_md: organizationContextMission?.value || '',
          priorities_md: organizationContextPriorities?.value || '',
          constraints_md: organizationContextConstraints?.value || '',
          decision_principles_md: organizationContextPrinciples?.value || '',
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (organizationContextStatus) organizationContextStatus.textContent = 'Forest Joensuu DNA saved.';
      await loadBusinessContext();
    } catch (error) {
      if (organizationContextStatus) organizationContextStatus.textContent = error instanceof Error ? error.message : 'Could not save Forest Joensuu DNA.';
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
      const response = await fetch('http://localhost:8000/api/notebooks');
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
          name.title = 'Check to allow this source in the Manager and delegated-agent context.';
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
            await fetch(`http://localhost:8000/api/notebooks/${encodeURIComponent(activeProjectId)}/documents/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
            selectedSources.delete(fileName);
            await refreshNotebookWorkspace?.();
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
      const response = await fetch('http://localhost:8000/api/notebooks');
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
        folder.className = `project-tree-folder${selectedProjectIds.has(project.id) ? ' is-selected' : ''}`;

        const header = document.createElement('div');
        header.className = 'notebook-item project-workspace-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'notebook-checkbox';
        checkbox.id = `project-${project.id}`;
        checkbox.checked = selectedProjectIds.has(project.id);
        const label = document.createElement('label');
        label.className = 'project-workspace-label';
        label.htmlFor = checkbox.id;
        const title = document.createElement('span');
        title.className = 'notebook-title';
        title.textContent = `📁 ${project.name}`;
        const count = document.createElement('span');
        count.className = 'project-source-count';
        count.textContent = `${(project.doc_names || []).length} file${(project.doc_names || []).length === 1 ? '' : 's'}`;
        label.append(title, count);
        if (project.company_name) {
          const company = document.createElement('span');
          company.className = 'project-company-label';
          company.textContent = project.company_name;
          label.appendChild(company);
        }
        const addFile = document.createElement('button');
        addFile.type = 'button';
        addFile.className = 'remove-source-btn project-add-file-btn';
        addFile.textContent = '+';
        addFile.title = `Add a file to ${project.name}`;
        addFile.addEventListener('click', async () => {
          activeProjectId = project.id;
          await openDocumentUpload();
        });
        const editProject = document.createElement('button');
        editProject.type = 'button';
        editProject.className = 'remove-source-btn project-edit-btn';
        editProject.textContent = '⋯';
        editProject.title = `Edit context for ${project.name}`;
        editProject.addEventListener('click', async () => {
          await loadBusinessContext();
          openProjectWorkspace(project);
        });
        checkbox.addEventListener('change', () => {
          activeProjectId = project.id;
          if (checkbox.checked) selectedProjectIds.add(project.id);
          else selectedProjectIds.delete(project.id);
          updateProjectKnowledgeScope();
          updateResearchModeBadge();
          void refreshNotebookWorkspace?.();
        });
        header.append(checkbox, label, editProject, addFile);
        folder.appendChild(header);

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
          file.className = 'notebook-item project-source-item';
          const name = document.createElement('span');
          name.className = 'notebook-title';
          name.textContent = `📄 ${fileName}`;
          name.title = `${fileName} is included whenever ${project.name} is selected.`;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'remove-source-btn';
          remove.textContent = '×';
          remove.title = `Remove ${fileName} from ${project.name}`;
          remove.addEventListener('click', async () => {
            if (!confirm(`Remove ${fileName} from ${project.name}?`)) return;
            await fetch(`http://localhost:8000/api/notebooks/${encodeURIComponent(project.id)}/documents/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
            await refreshNotebookWorkspace?.();
          });
          file.append(name, remove);
          files.appendChild(file);
        });
        folder.appendChild(files);
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
      const response = await fetch('http://localhost:8000/api/documents/upload', { method: 'POST', body: formData });
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
          const response = await fetch(`http://localhost:8000/api/notebooks/${encodeURIComponent(editingProjectId)}`, {
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
        const response = await fetch('http://localhost:8000/api/notebooks', {
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
        activeProjectId = created.notebook_id;
        selectedProjectIds.clear();
        selectedProjectIds.add(activeProjectId);
        selectedSourcesByProject.set(activeProjectId, new Set());
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

  const btnWorkAll = document.getElementById('btn-work-all');
  if (btnWorkAll) btnWorkAll.addEventListener('click', () => visualizer.sendAllToWork());

  const btnLoungeAll = document.getElementById('btn-lounge-all');
  if (btnLoungeAll) btnLoungeAll.addEventListener('click', () => visualizer.sendAllToLounge());

  // Task Dispatcher Board Wiring
  document.querySelectorAll('.btn-dispatch-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      const agentType = btn.getAttribute('data-agent');
      const prompt = btn.getAttribute('data-prompt');
      if (!agentType || !prompt) return;

      const activeUser = currentUser ? currentUser.username : 'mikko';

      try {
        const res = await fetch('http://localhost:8000/api/agents/dispatch', {
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
  // ==========================================================================
  // HERMES 3-TIER PROMPT STUDIO & LIVE INSPECTOR LOGIC
  // ==========================================================================
  const tmplSelect = document.getElementById('tmpl-select') as HTMLSelectElement;
  const promptCodeInspector = document.getElementById('prompt-code-inspector') as HTMLPreElement;
  const tierTabBtns = document.querySelectorAll('.tier-tab-btn') as NodeListOf<HTMLButtonElement>;
  const tierTextInput = document.getElementById('tier-text-input') as HTMLTextAreaElement;
  const toneSelectPage = document.getElementById('tone-select-page') as HTMLSelectElement;
  const tempSlider = document.getElementById('temp-slider') as HTMLInputElement;
  const tempValDisplay = document.getElementById('temp-val-display') as HTMLSpanElement;
  const customDirectivesPage = document.getElementById('custom-directives-page') as HTMLTextAreaElement;
  const tierContentStore: Record<string, string> = {
    soul: `[SOUL.md - Permanently Cached Agent Identity]\nYou are the Strategic AI Board Member for Business Joensuu & North Karelia, Finland.\nCore Mission: Drive private-sector job creation (1,000 tech jobs by 2026), accelerate Susicorn venture scaling, and maximize inward VC capital.\nGuardrails: Maintain strict data confidentiality, high financial accuracy, and actionable strategic advice.`,
    user: `[USER.md - Human Caller Profile & Contract]\nUser: Mikko Järvilehto (Executive Board Lead)\nRole: Business Joensuu Board Director\nTone Preference: Formal Executive & Strategic\nContract: Keep introductory pleasantries brief; deliver bulleted scorecards with high strategic ROI.`,
    memory: `[MEMORY.md - Durable Curated Regional Facts]\nFact 1: Joensuu target bio-cluster active companies = 4 Susicorn ventures.\nFact 2: Current jobs created in bio-innovations = 420 of 1,000 target.\nFact 3: Inward VC dealflow target = €€€15.0M capital injection.`
  };
  let activeTier = 'soul';
  if (tierTextInput) tierTextInput.value = tierContentStore[activeTier];
  tierTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tierTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTier = btn.getAttribute('data-tier') || 'soul';
      if (tierTextInput) tierTextInput.value = tierContentStore[activeTier] || '';
      updateLivePromptInspector();
    });
  });

  if (tierTextInput) {
    tierTextInput.addEventListener('input', () => {
      tierContentStore[activeTier] = tierTextInput.value;
      updateLivePromptInspector();
    });
  }

  if (tempSlider && tempValDisplay) {
    tempSlider.addEventListener('input', () => {
      tempValDisplay.textContent = parseFloat(tempSlider.value).toFixed(2);
      updateLivePromptInspector();
    });
  }

  if (tmplSelect) {
    tmplSelect.addEventListener('change', () => {
      const selectedAgent = tmplSelect.value;
      if (loadedPromptsCache[selectedAgent] && tierTextInput) {
        tierTextInput.value = loadedPromptsCache[selectedAgent].system_prompt || '';
      }
      updateLivePromptInspector();
    });
  }

  if (toneSelectPage) toneSelectPage.addEventListener('change', updateLivePromptInspector);
  if (customDirectivesPage) customDirectivesPage.addEventListener('input', updateLivePromptInspector);

  async function updateLivePromptInspector() {
    if (!promptCodeInspector) return;
    const targetAgent = habitatAgentSelect ? habitatAgentSelect.value : (tmplSelect ? tmplSelect.value : 'ManagerAgent');
    let agentData = loadedPromptsCache[targetAgent];
    if (!agentData) {
      promptCodeInspector.textContent = `Streaming system prompt for ${targetAgent} from local SQLite...`;
      try {
        const res = await fetch('http://localhost:8000/api/agents/prompts');
        if (res.ok) {
          const data = await res.json();
          loadedPromptsCache = data.prompts || {};
          agentData = loadedPromptsCache[targetAgent];
        }
      } catch (e) {
        console.warn("Could not fetch prompts for streaming inspector:", e);
      }
    }
    const systemPromptText = (agentData && agentData.system_prompt) || '';
    promptCodeInspector.textContent = systemPromptText;
  }

  // ==========================================================================
  // LOGIN PORTAL LOGIC
  // ==========================================================================
  let currentUser: UserProfile | null = null;
  const loginModal = document.getElementById('login-modal');
  const loginForm = document.getElementById('login-form') as HTMLFormElement;
  const loginUsername = document.getElementById('login-username') as HTMLInputElement;
  const loginPassword = document.getElementById('login-password') as HTMLInputElement;
  const loginError = document.getElementById('login-error');
  const userBadge = document.getElementById('user-badge');
  const userNameDisplay = document.getElementById('user-name-display');
  const logoutBtn = document.getElementById('logout-btn');
  const connectionStatus = document.getElementById('connection-status');
  const exitMvpShowcaseBtn = document.getElementById('mvp-exit-showcase-btn') as HTMLButtonElement | null;

  const setAuthenticated = (authenticated: boolean) => {
    if (appShell) appShell.classList.toggle('authenticated', authenticated);
    if (authenticated && !socketClient) socketClient = new SocketClient(visualizer);
    if (!authenticated && socketClient) {
      socketClient.disconnect();
      socketClient = null;
    }
  };
  setAuthenticated(false);

  /* Removed duplicate mock-data login bypass.
    setAuthenticated(true);
    if (loginModal) loginModal.style.display = 'none';
    if (userBadge) userBadge.style.display = 'none';
    if (connectionStatus) {
      connectionStatus.textContent = 'Prototype · Mock data';
      connectionStatus.className = 'status-online';
    }
    switchView('mvp-showcase');
  */

  exitMvpShowcaseBtn?.addEventListener('click', () => {
    currentUser = null;
    activeChatSessionId = null;
    setAuthenticated(false);
    switchView('dashboard');
    if (loginModal) loginModal.style.display = 'flex';
    if (userBadge) userBadge.style.display = 'none';
    if (loginError) loginError.style.display = 'none';
    if (connectionStatus) {
      connectionStatus.textContent = '● Kernel Offline';
      connectionStatus.className = 'status-offline';
    }
  });

  // Quick profile select buttons
  document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = btn.getAttribute('data-user');
      const p = btn.getAttribute('data-pass');
      if (u && p && loginUsername && loginPassword) {
        loginUsername.value = u;
        loginPassword.value = p;
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
        const res = await fetch('http://localhost:8000/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        if (res.ok) {
          const data = await res.json();
          currentUser = data.user;
          activeChatSessionId = null;
          void refreshChatSessionSidebar?.();
          setAuthenticated(true);
          if (loginModal) loginModal.style.display = 'none';
          if (userBadge) userBadge.style.display = 'flex';
          if (userNameDisplay) userNameDisplay.textContent = '👤 ' + currentUser!.display_name;
          if (connectionStatus) {
            connectionStatus.textContent = '● Kernel Online';
            connectionStatus.className = 'status-online';
          }
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

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      currentUser = null;
      activeChatSessionId = null;
      void refreshChatSessionSidebar?.();
      setAuthenticated(false);
      if (loginModal) loginModal.style.display = 'flex';
      if (userBadge) userBadge.style.display = 'none';
      if (loginUsername) loginUsername.value = '';
      if (loginPassword) loginPassword.value = '';
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
  const langSelect = document.getElementById('global-lang-select') as HTMLSelectElement | null;
  let isLiveModeActive = false;
  let currentWebcamFrame: string | null = null;

  let currentAttachedImageData: string | null = null;
  const attachedImageContainer = document.getElementById('attached-image-container') as HTMLDivElement;
  const attachedImagePreview = document.getElementById('attached-image-preview') as HTMLImageElement;
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
  const activeChatUser = () => currentUser ? currentUser.username : 'mikko';

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
    return escapeHtml(response)
      .replace(/\[Source:\s*(.*?)\]/gi, '<a class="citation-link" data-source="$1" onclick="window.inspectDocument(\'$1\')">[Source: $1]</a>')
      .replace(/### (.*?)\n/g, '<h3>$1</h3>')
      .replace(/## (.*?)\n/g, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br/>');
  }

  function makeModelFooter(provider?: string, model?: string, label: string = '🟢 Key Verified') {
    const safeProvider = escapeHtml((provider || 'azure').toUpperCase());
    const safeModel = escapeHtml(model || 'mvp-gpt-54-mini');
    return '<div class="msg-model-footer" style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15); font-size: 0.78rem; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between;"><span>🧠 Response generated via <strong style="color: #a78bfa;">' + safeProvider + '</strong> (<span style="color: var(--accent-blue);">' + safeModel + '</span>)</span><span class="subtext" style="font-size: 0.7rem; color: var(--accent-green);">' + label + '</span></div>';
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
          ? '<div class="msg-model-footer" style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.15); font-size: 0.78rem; color: var(--text-muted);">🔎 Autonomous evidence report</div>'
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
    if (attachedImageContainer) attachedImageContainer.style.display = 'none';
    if (attachedImagePreview) attachedImagePreview.src = '';
    return imageData;
  }

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
      userMsgDiv.innerHTML = '<div><img src="' + attachedImageForThisPayload + '" style="max-width: 260px; max-height: 200px; border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--panel-border); display: block;" />' + escapeHtml(rawPrompt) + '</div>';
    } else {
      userMsgDiv.textContent = rawPrompt;
    }

    chatStream.appendChild(userMsgDiv);
    if (chatInput) chatInput.value = '';

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
      const activeUser = currentUser ? currentUser.username : 'mikko';
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
        response = await fetch('http://localhost:8000/api/chat/stream', {
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

    const progress = document.createElement('div');
    progress.className = 'agent-msg loading-msg';
    progress.textContent = '🔎 Deep Research Agent is planning the mission…';
    chatStream.appendChild(progress);
    chatStream.scrollTop = chatStream.scrollHeight;
    syncManagerComposerState();

    try {
      await persistSessionMessage('user', `Deep research: ${question}`, { kind: 'deep_research_request' });
      const activeUser = currentUser ? currentUser.username : 'mikko';
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
        const res = await fetch('http://localhost:8000/api/documents/upload', {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          btnSaveMeeting.textContent = '✅ Saved to Vault';
          fetchDocumentsFromDB(); // refresh hub
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
    const lang = langSelect ? langSelect.value : 'en-US';
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
            recognition.lang = langSelect ? langSelect.value : 'en-US';
            // update language if changed while live
            if (langSelect) {
              langSelect.addEventListener('change', () => {
                if (recognition) recognition.lang = langSelect.value;
              });
            }
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
      const response = await fetch('http://localhost:8000/api/agents/prompts');
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
      updateLivePromptInspector();
    });
  }

  if (saveHabitatPromptBtn && habitatAgentSelect && habitatPromptTextarea && habitatProviderSelect && habitatModelSelect) {
    saveHabitatPromptBtn.addEventListener('click', async () => {
      if (habitatSaveStatus) {
        habitatSaveStatus.style.display = 'inline';
        habitatSaveStatus.textContent = 'Saving agent profile…';
      }
      try {
        const response = await fetch('http://localhost:8000/api/agents/prompt/update', {
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

});
  async function fetchAndRenderAgentPrompts() {
    try {
      const res = await fetch('http://localhost:8000/api/agents/prompts');
      if (res.ok) {
        const data = await res.json();
        loadedPromptsCache = data.prompts || {};
      }
    } catch (e) { console.warn(e); }
  }

  async function fetchAndRenderApiUsage() {
    // mock implementation
  }

  async function fetchDocumentsFromDB() {
    const docTableBody = document.getElementById('doc-table-body');
    if (!docTableBody) return;
    try {
      const res = await fetch('http://localhost:8000/api/documents/list');
      if (res.ok) {
        const data = await res.json();
        docTableBody.innerHTML = '';
        if (data.documents && Array.isArray(data.documents) && data.documents.length > 0) {
          data.documents.forEach((doc: any) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>
                <div class="doc-cell">
                  <span class="doc-icon">📄</span>
                  <span class="doc-title">${doc.file_name}</span>
                </div>
              </td>
              <td>Document</td>
              <td>${doc.chunks_indexed || 1} Chunks</td>
              <td>1,536 dimensions</td>
              <td><span class="status-pill-green">Indexed</span></td>
              <td><button type="button" class="action-sm-btn">View Chunks</button></td>
            `;
            docTableBody.appendChild(tr);
          });
        } else {
          docTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">📄 No documents indexed in database yet.</td></tr>';
        }
      }
    } catch (e) {
      console.warn("Could not fetch documents list from backend:", e);
    }
  }

  // Restore the event listeners for custom directives and tone select if needed


// ==========================================
// Database Studio Dashboard Logic
// ==========================================

async function fetchDBTables() {
  if (!dbTablesList) return;
  try {
    const res = await fetch('http://localhost:8000/api/db/tables');
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
    const res = await fetch(`http://localhost:8000/api/db/tables/${table}`);
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
      actionHeader.textContent = 'Actions';
      headerRow.appendChild(actionHeader);
      dbDataThead.replaceChildren(headerRow);

      dbDataTbody.replaceChildren();
      if (data.rows.length === 0) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = data.schema.length + 1;
        cell.className = 'db-empty-cell';
        cell.textContent = `No rows found in ${table}.`;
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
          editButton.textContent = 'Edit';
          editButton.addEventListener('click', () => openEditModal(pkCol, row[pkCol], row));
          const deleteButton = document.createElement('button');
          deleteButton.type = 'button';
          deleteButton.className = 'action-sm-btn delete-db-btn';
          deleteButton.textContent = 'Delete';
          deleteButton.addEventListener('click', async () => {
            if (confirm('Are you sure you want to delete this row?')) {
              await fetch(`http://localhost:8000/api/db/tables/${table}/${pkCol}/${encodeURIComponent(String(row[pkCol]))}`, { method: 'DELETE' });
              loadTableData(table);
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
    dbRowFieldsContainer.innerHTML = '';
    currentTableSchema.forEach((col) => {
      const div = document.createElement('div');
      div.className = 'input-group';
      const isPk = !creating && col.name === pkCol;
      const type = col.type.toLowerCase();
      
      let inputHtml = '';
      if (type.includes('text') && col.name.includes('md') || col.name.includes('prompt')) {
        inputHtml = `<textarea id="edit-col-${col.name}" class="param-select full-width" rows="6" ${isPk ? 'disabled' : ''}></textarea>`;
      } else {
        inputHtml = `<input type="text" id="edit-col-${col.name}" class="param-select full-width" ${isPk ? 'disabled' : ''} />`;
      }
      
      div.innerHTML = `
        <label>${col.name} ${isPk ? '(Primary Key)' : ''}</label>
        ${inputHtml}
      `;
      dbRowFieldsContainer.appendChild(div);
      
      const inputEl = document.getElementById(`edit-col-${col.name}`) as HTMLInputElement;
      if (inputEl) inputEl.value = rowData[col.name] !== null ? rowData[col.name] : '';
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
        ? `http://localhost:8000/api/db/tables/${currentActiveTable}`
        : `http://localhost:8000/api/db/tables/${currentActiveTable}/${currentEditingPkCol}/${encodeURIComponent(String(currentEditingPkVal))}`;
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
    const forestOption = document.createElement('option');
    forestOption.value = '';
    forestOption.textContent = 'Forest Joensuu-wide task';
    taskProjectSelect.appendChild(forestOption);
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
  if (taskModalTitle) taskModalTitle.textContent = editingKanbanTaskId ? '✏️ Edit Manager Task' : '📋 Add Manager Task';
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

function makeKanbanAction(label: string, className: string, handler: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

if (tabKanban && viewKanban) {
  tabKanban.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.page-view').forEach(view => { (view as HTMLElement).style.display = 'none'; });
    
    tabKanban.classList.add('active');
    viewKanban.style.display = 'block';
    fetchAndRenderKanbanTasks();
  });
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
      alert('Add clear instructions for the Manager.');
      return;
    }
    
    try {
      const localScheduledTime = taskTimeInput?.value || '';
      const payload = {
        prompt,
        username: 'mikko',
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
    card.draggable = task.status === 'pending';
    card.dataset.taskId = task.id;

    const title = document.createElement('h4');
    title.textContent = task.prompt;
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
    if (task.status === 'pending') {
      actions.append(
        makeKanbanAction('Run now', 'action-sm-btn', () => void runKanbanTaskNow(task.id)),
        makeKanbanAction('Edit', 'action-sm-btn', () => void openKanbanTaskModal(task)),
        makeKanbanAction('Delete', 'action-sm-btn delete-db-btn', () => void deletePendingKanbanTask(task.id)),
      );
    } else if (task.status === 'running') {
      const running = document.createElement('span');
      running.className = 'task-running-label';
      running.textContent = 'Manager is running this task';
      actions.appendChild(running);
    } else {
      actions.append(
        makeKanbanAction('View result', 'action-sm-btn', () => void openKanbanArchive(task.id)),
        makeKanbanAction('Run again', 'action-sm-btn', () => void rerunKanbanTask(task.id)),
      );
    }
    card.appendChild(actions);

    card.addEventListener('dragstart', () => {
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
  if (!pCount) appendKanbanEmptyState(colPending, 'Nothing waiting for approval', 'Add a Manager task here, then run it when you are ready.');
  if (!rCount) appendKanbanEmptyState(colRun, 'No task is running', 'Approved work appears here while the Manager is executing it.');
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

async function deletePendingKanbanTask(taskId: string) {
  if (!confirm('Delete this pending task? This cannot be undone.')) return;
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
    colRun.parentElement!.style.borderColor = 'var(--accent-blue)';
  });
  colRun.addEventListener('dragleave', () => { colRun.parentElement!.style.borderColor = 'var(--panel-border)'; });
  colRun.addEventListener('drop', (event) => {
    event.preventDefault();
    colRun.parentElement!.style.borderColor = 'var(--panel-border)';
    if (currentDraggedTask?.status === 'pending') void runKanbanTaskNow(currentDraggedTask.id);
  });
}

window.addEventListener('ai-os-agent-event', (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (detail?.type === 'KANBAN_TASK_UPDATED') void fetchAndRenderKanbanTasks();
});

// Polling is a fallback; WebSocket task events keep an open board in sync immediately.
setInterval(() => {
  if (viewKanban && viewKanban.style.display === 'block') {
    fetchAndRenderKanbanTasks();
  }
}, 5000);

setInterval(() => {
  if (viewKanban && viewKanban.style.display === 'block') {
    refreshKanbanCountdowns();
  }
}, 1000);


// Notebook sources are refreshed from their selected notebook membership above.
