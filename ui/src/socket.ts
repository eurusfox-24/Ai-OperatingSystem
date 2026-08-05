import { RobotCanvasVisualizer } from './visualizer/robot_canvas';

export class SocketClient {
  private ws: WebSocket | null = null;
  private visualizer: RobotCanvasVisualizer;
  private statusElement: HTMLElement | null;
  private countElement: HTMLElement | null;
  private navBadgeElement: HTMLElement | null;
  private cardsContainer: HTMLElement | null;
  private logFeed: HTMLElement | null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  constructor(visualizer: RobotCanvasVisualizer) {
    this.visualizer = visualizer;
    this.statusElement = document.getElementById('connection-status');
    this.countElement = document.getElementById('active-agent-count');
    this.navBadgeElement = document.getElementById('nav-agent-badge');
    this.cardsContainer = document.getElementById('agent-cards-container');
    this.logFeed = document.getElementById('agent-log-feed');
    this.connect();
  }

  private connect() {
    this.intentionalClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const configuredKernel = (globalThis as typeof globalThis & { __AI_OS_WS_URL__?: string }).__AI_OS_WS_URL__;
    const wsUrl = configuredKernel || `${protocol}//${window.location.host}/ws`;
    console.log(`Connecting WebSocket to ${wsUrl}...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket Connected!');
      if (this.statusElement) {
        this.statusElement.textContent = '● Kernel Online';
        this.statusElement.className = 'status-online';
      }
      this.appendLog('system', 'Kernel Online • WebSocket telemetry established.');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleEvent(msg);
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };

    this.ws.onclose = () => {
      if (this.intentionalClose) return;
      console.warn('WebSocket Disconnected. Reconnecting in 3s...');
      if (this.statusElement) {
        this.statusElement.textContent = '● Offline (Reconnecting...)';
        this.statusElement.className = 'status-offline';
      }
      this.appendLog('system', 'WebSocket Disconnected. Reconnecting...');
      this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
    };
  }

  public disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private handleEvent(msg: { type: string; data: any }) {
    window.dispatchEvent(new CustomEvent('ai-os-agent-event', { detail: msg }));
    switch (msg.type) {
      case 'AGENT_SPAWNED':
        this.visualizer.spawnRobot(msg.data);
        this.updateCounter();
        this.addAgentCard(msg.data);
        this.appendLog('spawn', `🚀 AGENT SPAWNED: [${msg.data.name}] (${msg.data.role_label})`);
        break;
      case 'AGENT_STATE_UPDATE':
        this.visualizer.updateRobot(msg.data.agent_id, msg.data.status, msg.data.current_task);
        this.updateAgentCard(msg.data.agent_id, msg.data.status, msg.data.current_task);
        this.appendLog('update', `⚡ STATE UPDATE: [${msg.data.agent_id}] Status: ${msg.data.status} | Task: ${msg.data.current_task}`);
        break;
      case 'AGENT_TERMINATED':
        this.visualizer.terminateRobot(msg.data.agent_id);
        this.updateCounter();
        this.removeAgentCard(msg.data.agent_id);
        this.appendLog('terminate', `🛑 AGENT TERMINATED: [${msg.data.agent_id}] Process complete.`);
        break;
      case 'WORKFLOW_UPDATED':
        this.appendLog('update', `WORKFLOW: ${msg.data.action}`);
        break;
      case 'REASONING_SUMMARY':
        this.appendLog('update', `SUMMARY: ${msg.data.summary}`);
        break;
      case 'KANBAN_TASK_UPDATED':
        this.appendLog('update', `TASK: ${msg.data.status}`);
        break;
    }
  }

  private updateCounter() {
    const count = this.visualizer.getActiveCount();
    const text = `${count} Active Robot${count === 1 ? '' : 's'}`;
    if (this.countElement) {
      this.countElement.textContent = text;
    }
    if (this.navBadgeElement) {
      this.navBadgeElement.textContent = `${count} Active`;
    }
  }

  private addAgentCard(data: { agent_id: string; name: string; agent_type: string; role_label: string; color?: string }) {
    if (!this.cardsContainer) return;

    // Clear empty state if present
    const emptyState = this.cardsContainer.querySelector('.empty-cards-state');
    if (emptyState) {
      emptyState.remove();
    }

    // Check if card already exists
    let card = document.getElementById(`card-${data.agent_id}`);
    if (!card) {
      card = document.createElement('div');
      card.id = `card-${data.agent_id}`;
      card.className = 'subagent-card';
      this.cardsContainer.prepend(card);
    }

    card.innerHTML = `
      <div class="card-top">
        <span class="card-name" style="color: ${data.color || '#10b981'}">🤖 ${data.name}</span>
        <span class="card-type">${data.agent_type.toUpperCase()}</span>
      </div>
      <div class="card-task" id="card-task-${data.agent_id}">
        <strong>Role:</strong> ${data.role_label}<br/>
        <strong>Task:</strong> Initializing sub-process...
      </div>
    `;
  }

  private updateAgentCard(agentId: string, status: string, currentTask: string) {
    const taskElem = document.getElementById(`card-task-${agentId}`);
    if (taskElem) {
      taskElem.innerHTML = `
        <strong>Status:</strong> <span style="color: #34d399">${status.toUpperCase()}</span><br/>
        <strong>Current Task:</strong> ${currentTask}
      `;
    }
  }

  private removeAgentCard(agentId: string) {
    const card = document.getElementById(`card-${agentId}`);
    if (card) {
      card.remove();
    }

    if (this.cardsContainer && this.cardsContainer.children.length === 0) {
      this.cardsContainer.innerHTML = `
        <div class="empty-cards-state">
          <span>💤 No active background subagents. Ask the AI Board Member to perform a multi-agent task to observe real-time telemetry here.</span>
        </div>
      `;
    }
  }

  private appendLog(type: 'system' | 'spawn' | 'update' | 'terminate', text: string) {
    if (!this.logFeed) return;
    const timeStr = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">[${timeStr}]</span> ${text}`;
    this.logFeed.appendChild(entry);
    this.logFeed.scrollTop = this.logFeed.scrollHeight;
  }
}
