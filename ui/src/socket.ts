import { RobotCanvasVisualizer } from './visualizer/robot_canvas';

export class SocketClient {
  private ws: WebSocket | null = null;
  private visualizer: RobotCanvasVisualizer;
  private statusElement: HTMLElement | null;
  private countElement: HTMLElement | null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;

  constructor(visualizer: RobotCanvasVisualizer) {
    this.visualizer = visualizer;
    this.statusElement = document.getElementById('connection-status');
    this.countElement = document.getElementById('active-agent-count');
    this.connect();
  }

  private connect() {
    this.intentionalClose = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const configuredKernel = (globalThis as typeof globalThis & { __AI_OS_WS_URL__?: string }).__AI_OS_WS_URL__;
    const baseWsUrl = configuredKernel || `${protocol}//${window.location.host}/ws`;
    const token = sessionStorage.getItem('ai_os_access_token');
    if (!token) return;
    console.log(`Connecting authenticated WebSocket to ${baseWsUrl}...`);

    this.ws = new WebSocket(baseWsUrl, ['ai-os-auth', token]);

    this.ws.onopen = () => {
      console.log('WebSocket Connected!');
      if (this.statusElement) {
        this.statusElement.textContent = '● Kernel Online';
        this.statusElement.className = 'status-online';
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleEvent(msg);
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };

    this.ws.onclose = (event) => {
      if (this.intentionalClose) return;
      if (event.code === 4401) {
        sessionStorage.removeItem('ai_os_access_token');
        return;
      }
      console.warn('WebSocket Disconnected. Reconnecting in 3s...');
      if (this.statusElement) {
        this.statusElement.textContent = '● Offline (Reconnecting...)';
        this.statusElement.className = 'status-offline';
      }
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
        break;
      case 'AGENT_STATE_UPDATE':
        this.visualizer.updateRobot(msg.data.agent_id, msg.data.status, msg.data.current_task);
        break;
      case 'AGENT_TERMINATED':
        this.visualizer.terminateRobot(msg.data.agent_id);
        this.updateCounter();
        break;
    }
  }

  private updateCounter() {
    const count = this.visualizer.getActiveCount();
    const text = `${count} Active Robot${count === 1 ? '' : 's'}`;
    if (this.countElement) {
      this.countElement.textContent = text;
    }
  }
}
