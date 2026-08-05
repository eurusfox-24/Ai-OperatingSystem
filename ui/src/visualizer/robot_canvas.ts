export interface RobotEntity {
  id: string;
  name: string;
  agentType: string;
  roleLabel: string;
  color: string;
  charSpriteIdx: number; // 0 to 5 for char_0.png ... char_5.png
  workCol: number;
  workRow: number;
  workFacing: 'down' | 'left' | 'right' | 'up';
  loungeCol: number;
  loungeRow: number;
  loungeFacing: 'down' | 'left' | 'right' | 'up';
  currentX: number; // Pixel center in base 16px tile space
  currentY: number; // Pixel center in base 16px tile space
  targetX: number;
  targetY: number;
  state: 'idle' | 'walking_to_work' | 'working' | 'thinking' | 'executing' | 'walking_to_lounge';
  currentTask: string;
  walkFrame: number;
  facing: 'down' | 'left' | 'right' | 'up';
  focused: boolean;
  activeTool?: string;
}

interface FurnitureSpec {
  id: string;
  type: string;
  col: number;
  row: number;
  src: string;
  footprintW: number;
  footprintH: number;
  mirrored?: boolean;
}

export class RobotCanvasVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private robots: Map<string, RobotEntity> = new Map();
  private hoverAgentId: string | null = null;
  private mouseX = 0;
  private mouseY = 0;
  private imageCache: Map<string, HTMLImageElement> = new Map();

  // Grid Dimensions matching Pixel Agents default-layout-1.json (21 cols x 22 rows, TILE_SIZE=16)
  private readonly COLS = 21;
  private readonly ROWS = 22;
  private readonly BASE_TILE_SIZE = 16;

  // Furniture Layout matching Pixel Agents default-layout-1.json
  private readonly FURNITURE_LIST: FurnitureSpec[] = [
    { id: 'f-1', type: 'TABLE_FRONT', col: 4, row: 16, src: '/assets/furniture/TABLE_FRONT/TABLE_FRONT.png', footprintW: 3, footprintH: 4 },
    { id: 'f-2', type: 'COFFEE_TABLE', col: 14, row: 14, src: '/assets/furniture/COFFEE_TABLE/COFFEE_TABLE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-3', type: 'SOFA_SIDE', col: 13, row: 14, src: '/assets/furniture/SOFA/SOFA_SIDE.png', footprintW: 1, footprintH: 2 },
    { id: 'f-4', type: 'SOFA_BACK', col: 14, row: 16, src: '/assets/furniture/SOFA/SOFA_BACK.png', footprintW: 2, footprintH: 1 },
    { id: 'f-5', type: 'SOFA_FRONT', col: 14, row: 13, src: '/assets/furniture/SOFA/SOFA_FRONT.png', footprintW: 2, footprintH: 1 },
    { id: 'f-6', type: 'SOFA_SIDE:left', col: 16, row: 14, src: '/assets/furniture/SOFA/SOFA_SIDE.png', footprintW: 1, footprintH: 2, mirrored: true },
    { id: 'f-7', type: 'HANGING_PLANT', col: 9, row: 9, src: '/assets/furniture/HANGING_PLANT/HANGING_PLANT.png', footprintW: 1, footprintH: 1 },
    { id: 'f-8', type: 'HANGING_PLANT', col: 1, row: 9, src: '/assets/furniture/HANGING_PLANT/HANGING_PLANT.png', footprintW: 1, footprintH: 1 },
    { id: 'f-9', type: 'DOUBLE_BOOKSHELF', col: 7, row: 9, src: '/assets/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png', footprintW: 2, footprintH: 2 },
    { id: 'f-10', type: 'DOUBLE_BOOKSHELF', col: 2, row: 9, src: '/assets/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png', footprintW: 2, footprintH: 2 },
    { id: 'f-11', type: 'SMALL_PAINTING', col: 12, row: 9, src: '/assets/furniture/SMALL_PAINTING/SMALL_PAINTING.png', footprintW: 1, footprintH: 1 },
    { id: 'f-12', type: 'CLOCK', col: 5, row: 9, src: '/assets/furniture/CLOCK/CLOCK.png', footprintW: 1, footprintH: 1 },
    { id: 'f-13', type: 'PLANT', col: 18, row: 10, src: '/assets/furniture/PLANT/PLANT.png', footprintW: 1, footprintH: 1 },
    { id: 'f-14', type: 'COFFEE', col: 14, row: 15, src: '/assets/furniture/COFFEE/COFFEE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-15', type: 'WOODEN_CHAIR_SIDE', col: 3, row: 18, src: '/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-16', type: 'WOODEN_CHAIR_SIDE', col: 3, row: 16, src: '/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-17', type: 'WOODEN_CHAIR_SIDE:left', col: 7, row: 16, src: '/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', footprintW: 1, footprintH: 1, mirrored: true },
    { id: 'f-18', type: 'WOODEN_CHAIR_SIDE:left', col: 7, row: 18, src: '/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png', footprintW: 1, footprintH: 1, mirrored: true },
    { id: 'f-19', type: 'DESK_FRONT', col: 2, row: 12, src: '/assets/furniture/DESK/DESK_FRONT.png', footprintW: 2, footprintH: 1 },
    { id: 'f-20', type: 'DESK_FRONT', col: 6, row: 12, src: '/assets/furniture/DESK/DESK_FRONT.png', footprintW: 2, footprintH: 1 },
    { id: 'f-21', type: 'CUSHIONED_BENCH', col: 3, row: 14, src: '/assets/furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png', footprintW: 1, footprintH: 1 },
    { id: 'f-22', type: 'CUSHIONED_BENCH', col: 7, row: 14, src: '/assets/furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png', footprintW: 1, footprintH: 1 },
    { id: 'f-29', type: 'PLANT_2', col: 11, row: 10, src: '/assets/furniture/PLANT_2/PLANT_2.png', footprintW: 1, footprintH: 1 },
    { id: 'f-30', type: 'LARGE_PAINTING', col: 14, row: 9, src: '/assets/furniture/LARGE_PAINTING/LARGE_PAINTING.png', footprintW: 2, footprintH: 1 },
    { id: 'f-31', type: 'BIN', col: 2, row: 20, src: '/assets/furniture/BIN/BIN.png', footprintW: 1, footprintH: 1 },
    { id: 'f-32', type: 'SMALL_TABLE_SIDE', col: 1, row: 18, src: '/assets/furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-33', type: 'COFFEE', col: 1, row: 19, src: '/assets/furniture/COFFEE/COFFEE.png', footprintW: 1, footprintH: 1 },
    { id: 'f-34', type: 'PLANT_2', col: 1, row: 17, src: '/assets/furniture/PLANT_2/PLANT_2.png', footprintW: 1, footprintH: 1 },
    { id: 'f-35', type: 'SMALL_PAINTING_2', col: 17, row: 9, src: '/assets/furniture/SMALL_PAINTING_2/SMALL_PAINTING_2.png', footprintW: 1, footprintH: 1 }
  ];

  public static readonly AGENT_CONFIGS: {
    [key: string]: {
      name: string;
      color: string;
      charIdx: number;
      workCol: number;
      workRow: number;
      workFacing: 'down' | 'left' | 'right' | 'up';
      loungeCol: number;
      loungeRow: number;
      loungeFacing: 'down' | 'left' | 'right' | 'up';
      role: string;
    }
  } = {
    'ManagerAgent': {
      name: 'Manager Agent (Mikko)',
      color: '#10b981',
      charIdx: 0,
      workCol: 3,
      workRow: 14,
      workFacing: 'up',
      loungeCol: 13,
      loungeRow: 14,
      loungeFacing: 'right',
      role: 'Executive Assistant & Board Chair'
    },
    'FinancialAdvisorAgent': {
      name: 'Financial Advisor (CFO)',
      color: '#f59e0b',
      charIdx: 1,
      workCol: 7,
      workRow: 14,
      workFacing: 'up',
      loungeCol: 16,
      loungeRow: 14,
      loungeFacing: 'left',
      role: 'CFO & Dealflow Strategist'
    },
    'MeetingNotesAgent': {
      name: 'Meeting Secretary',
      color: '#06b6d4',
      charIdx: 2,
      workCol: 3,
      workRow: 16,
      workFacing: 'right',
      loungeCol: 14,
      loungeRow: 13,
      loungeFacing: 'down',
      role: 'Chief Secretary & RAG Officer'
    },
    'ForesightAgent': {
      name: 'Foresight Radar',
      color: '#ea580c',
      charIdx: 3,
      workCol: 3,
      workRow: 18,
      workFacing: 'right',
      loungeCol: 14,
      loungeRow: 16,
      loungeFacing: 'up',
      role: 'Chief Intelligence Officer'
    },
    'IdeaScorerAgent': {
      name: 'Impact Evaluator',
      color: '#8b5cf6',
      charIdx: 4,
      workCol: 7,
      workRow: 16,
      workFacing: 'left',
      loungeCol: 18,
      loungeRow: 14,
      loungeFacing: 'left',
      role: 'Impact & ROI Evaluator'
    },
    'SusicornAgent': {
      name: 'Susicorn Accelerator',
      color: '#ec4899',
      charIdx: 5,
      workCol: 7,
      workRow: 18,
      workFacing: 'left',
      loungeCol: 12,
      loungeRow: 14,
      loungeFacing: 'right',
      role: 'Head of VC Acceleration'
    }
  };

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;

    this.preloadAssets();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());

    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('click', () => this.handleClick());

    this.initPermanentResidents();
    this.startLoop();
  }

  private preloadAssets() {
    const assets = [
      '/assets/floors/floor_0.png',
      '/assets/floors/floor_1.png',
      '/assets/walls/wall_0.png',
      '/assets/characters/char_0.png',
      '/assets/characters/char_1.png',
      '/assets/characters/char_2.png',
      '/assets/characters/char_3.png',
      '/assets/characters/char_4.png',
      '/assets/characters/char_5.png',
      '/assets/furniture/DESK/DESK_FRONT.png',
      '/assets/furniture/PC/PC_FRONT_OFF.png',
      '/assets/furniture/PC/PC_FRONT_ON_1.png',
      '/assets/furniture/PC/PC_FRONT_ON_2.png',
      '/assets/furniture/PC/PC_SIDE.png',
      '/assets/furniture/WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png',
      '/assets/furniture/CUSHIONED_BENCH/CUSHIONED_BENCH.png',
      '/assets/furniture/SOFA/SOFA_FRONT.png',
      '/assets/furniture/SOFA/SOFA_BACK.png',
      '/assets/furniture/SOFA/SOFA_SIDE.png',
      '/assets/furniture/COFFEE_TABLE/COFFEE_TABLE.png',
      '/assets/furniture/COFFEE/COFFEE.png',
      '/assets/furniture/PLANT/PLANT.png',
      '/assets/furniture/PLANT_2/PLANT_2.png',
      '/assets/furniture/DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png',
      '/assets/furniture/WHITEBOARD/WHITEBOARD.png',
      '/assets/furniture/LARGE_PAINTING/LARGE_PAINTING.png',
      '/assets/furniture/SMALL_PAINTING/SMALL_PAINTING.png',
      '/assets/furniture/SMALL_PAINTING_2/SMALL_PAINTING_2.png',
      '/assets/furniture/SMALL_TABLE/SMALL_TABLE_SIDE.png',
      '/assets/furniture/CLOCK/CLOCK.png',
      '/assets/furniture/HANGING_PLANT/HANGING_PLANT.png',
      '/assets/furniture/TABLE_FRONT/TABLE_FRONT.png',
      '/assets/furniture/BIN/BIN.png'
    ];

    let loadedCount = 0;
    assets.forEach((src) => {
      const img = new Image();
      img.onload = () => {
        loadedCount++;
        if (loadedCount >= assets.length) {
        }
      };
      img.src = src;
      this.imageCache.set(src, img);
    });
  }

  public resizeCanvas() {
    const parent = this.canvas.parentElement;
    if (parent) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = parent.clientWidth * dpr;
      this.canvas.height = parent.clientHeight * dpr;
      this.ctx.scale(dpr, dpr);
      this.recalculatePositions();
    }
  }

  private getEffectiveWidth(): number {
    return this.canvas.parentElement ? this.canvas.parentElement.clientWidth : this.canvas.width;
  }

  private getEffectiveHeight(): number {
    return this.canvas.parentElement ? this.canvas.parentElement.clientHeight : this.canvas.height;
  }

  // Calculate dynamic pixel zoom & alignment offsets (matching Pixel Agents renderer)
  private getZoomParams(): { zoom: number; offsetX: number; offsetY: number } {
    const w = this.getEffectiveWidth();
    const h = this.getEffectiveHeight();

    const activeRows = this.ROWS - 8;
    const officeW_px = this.COLS * this.BASE_TILE_SIZE; // 336px
    const officeH_px = activeRows * this.BASE_TILE_SIZE; // 224px

    const zoomX = w / officeW_px;
    const zoomY = h / officeH_px;
    const zoom = Math.min(zoomX, zoomY);

    const offsetX = (w - officeW_px * zoom) / 2;
    const offsetY = ((h - officeH_px * zoom) / 2) - (8 * this.BASE_TILE_SIZE * zoom);

    return { zoom, offsetX, offsetY };
  }

  private tileToPixelCenter(col: number, row: number): { x: number; y: number } {
    return {
      x: col * this.BASE_TILE_SIZE + this.BASE_TILE_SIZE / 2,
      y: row * this.BASE_TILE_SIZE + this.BASE_TILE_SIZE / 2
    };
  }

  private initPermanentResidents() {
    const agents = Object.keys(RobotCanvasVisualizer.AGENT_CONFIGS);

    agents.forEach((agentType) => {
      const cfg = RobotCanvasVisualizer.AGENT_CONFIGS[agentType];
      const loungePix = this.tileToPixelCenter(cfg.loungeCol, cfg.loungeRow);

      const bot: RobotEntity = {
        id: agentType,
        name: cfg.name,
        agentType: agentType,
        roleLabel: cfg.role,
        color: cfg.color,
        charSpriteIdx: cfg.charIdx,
        workCol: cfg.workCol,
        workRow: cfg.workRow,
        workFacing: cfg.workFacing,
        loungeCol: cfg.loungeCol,
        loungeRow: cfg.loungeRow,
        loungeFacing: cfg.loungeFacing,
        currentX: loungePix.x,
        currentY: loungePix.y,
        targetX: loungePix.x,
        targetY: loungePix.y,
        state: 'idle',
        currentTask: 'Coffee break in lounge',
        walkFrame: 0,
        facing: cfg.loungeFacing,
        focused: agentType === 'ManagerAgent'
      };
      this.robots.set(agentType, bot);
    });
    this.recalculatePositions();
  }

  private recalculatePositions() {
    this.robots.forEach((bot) => {
      const cfg = RobotCanvasVisualizer.AGENT_CONFIGS[bot.agentType];
      if (!cfg) return;

      if (bot.state === 'idle') {
        const loungePix = this.tileToPixelCenter(bot.loungeCol, bot.loungeRow);
        bot.currentX = loungePix.x;
        bot.currentY = loungePix.y;
        bot.targetX = loungePix.x;
        bot.targetY = loungePix.y;
        bot.facing = bot.loungeFacing;
      } else if (bot.state === 'working' || bot.state === 'thinking' || bot.state === 'executing') {
        const workPix = this.tileToPixelCenter(bot.workCol, bot.workRow);
        bot.currentX = workPix.x;
        bot.currentY = workPix.y;
        bot.targetX = workPix.x;
        bot.targetY = workPix.y;
        bot.facing = bot.workFacing;
      }
    });
  }

  private handleMouseMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;

    const { zoom, offsetX, offsetY } = this.getZoomParams();

    let found: string | null = null;
    this.robots.forEach((bot) => {
      const screenX = offsetX + bot.currentX * zoom;
      const screenY = offsetY + bot.currentY * zoom;
      const dist = Math.hypot(screenX - this.mouseX, screenY - this.mouseY);
      if (dist < 18 * zoom) {
        found = bot.id;
      }
    });
    this.hoverAgentId = found;
    this.canvas.style.cursor = found ? 'pointer' : 'default';
  }

  private handleClick() {
    if (this.hoverAgentId) {
      this.focusAgent(this.hoverAgentId);
    }
  }

  public focusAgent(agentId: string) {
    this.robots.forEach((bot) => {
      bot.focused = (bot.id === agentId || bot.agentType === agentId);
    });
  }

  public spawnRobot(data: { agent_id: string; name: string; agent_type: string; role_label: string; color?: string }) {
    let bot = this.robots.get(data.agent_type);
    if (!bot) {
      for (const [type, r] of this.robots.entries()) {
        if (data.agent_type.includes(type) || type.includes(data.agent_type)) {
          bot = r;
          break;
        }
      }
    }

    if (bot) {
      const workPix = this.tileToPixelCenter(bot.workCol, bot.workRow);
      bot.state = 'walking_to_work';
      bot.targetX = workPix.x;
      bot.targetY = workPix.y;
      bot.roleLabel = data.role_label;
      bot.currentTask = `Working: ${data.role_label}`;
    }
  }

  public updateRobot(agentId: string, status: string, currentTask: string, activeTool?: string) {
    let bot = this.robots.get(agentId);
    if (!bot) {
      for (const r of this.robots.values()) {
        if (agentId.includes(r.agentType) || r.agentType.includes(agentId)) {
          bot = r;
          break;
        }
      }
    }

    if (bot) {
      bot.currentTask = currentTask;
      if (activeTool) bot.activeTool = activeTool;

      if (status === 'working' || status === 'thinking' || status === 'executing') {
        const workPix = this.tileToPixelCenter(bot.workCol, bot.workRow);
        bot.state = status as any;
        bot.targetX = workPix.x;
        bot.targetY = workPix.y;
      }
    }
  }

  public terminateRobot(agentId: string) {
    let bot = this.robots.get(agentId);
    if (!bot) {
      for (const r of this.robots.values()) {
        if (agentId.includes(r.agentType) || r.agentType.includes(agentId)) {
          bot = r;
          break;
        }
      }
    }

    if (bot) {
      const loungePix = this.tileToPixelCenter(bot.loungeCol, bot.loungeRow);
      bot.state = 'walking_to_lounge';
      bot.targetX = loungePix.x;
      bot.targetY = loungePix.y;
    }
  }

  public sendAllToLounge() {
    this.robots.forEach((bot) => {
      const loungePix = this.tileToPixelCenter(bot.loungeCol, bot.loungeRow);
      bot.state = 'walking_to_lounge';
      bot.targetX = loungePix.x;
      bot.targetY = loungePix.y;
      bot.currentTask = 'Coffee break in lounge';
    });
  }

  public sendAllToWork() {
    this.robots.forEach((bot) => {
      const workPix = this.tileToPixelCenter(bot.workCol, bot.workRow);
      bot.state = 'walking_to_work';
      bot.targetX = workPix.x;
      bot.targetY = workPix.y;
      bot.currentTask = 'Processing directives at desk';
    });
  }

  public getActiveCount(): number {
    let active = 0;
    this.robots.forEach((r) => {
      if (r.state !== 'idle') active++;
    });
    return active;
  }

  private startLoop() {
    const render = () => {
      this.draw();
      requestAnimationFrame(render);
    };
    render();
  }

  private drawImageSafe(src: string, dx: number, dy: number, dw: number, dh: number) {
    const img = this.imageCache.get(src);
    if (img && img.complete && img.naturalWidth > 0) {
      this.ctx.drawImage(img, dx, dy, dw, dh);
    }
  }

  private draw() {
    const w = this.getEffectiveWidth();
    const h = this.getEffectiveHeight();
    const { zoom, offsetX, offsetY } = this.getZoomParams();
    const s = this.BASE_TILE_SIZE * zoom;
    const time = Date.now() * 0.003;

    // Crisp pixel art rendering settings
    this.ctx.imageSmoothingEnabled = false;

    // 1. Fill Background
    this.ctx.fillStyle = '#0a0e17';
    this.ctx.fillRect(0, 0, w, h);

    const floorWood = this.imageCache.get('/assets/floors/floor_0.png');
    const floorCarpet = this.imageCache.get('/assets/floors/floor_1.png');

    // 2. Render Tile Grid (Floors & Walls)
    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        const tx = offsetX + c * s;
        const ty = offsetY + r * s;

        if (r < 8) continue;

        // Outer Walls
        if (r === 8 || r === 21 || c === 0 || c === 20) {
          this.ctx.fillStyle = '#1e293b';
          this.ctx.fillRect(tx, ty, s, s);
          this.drawImageSafe('/assets/walls/wall_0.png', tx, ty, s, s);
          continue;
        }

        // Central Dividing Wall (col 10) with Doorway passage at rows 14-15
        if (c === 10) {
          if (r === 14 || r === 15) {
            if (floorWood && floorWood.complete) {
              this.ctx.drawImage(floorWood, tx, ty, s, s);
            } else {
              this.ctx.fillStyle = '#475569';
              this.ctx.fillRect(tx, ty, s, s);
            }
          } else {
            this.ctx.fillStyle = '#1e293b';
            this.ctx.fillRect(tx, ty, s, s);
            this.drawImageSafe('/assets/walls/wall_0.png', tx, ty, s, s);
          }
          continue;
        }

        // LEFT ROOM (cols 1-9): Wood Floor
        if (c >= 1 && c <= 9) {
          if (floorWood && floorWood.complete) {
            this.ctx.drawImage(floorWood, tx, ty, s, s);
          } else {
            this.ctx.fillStyle = '#78350f';
            this.ctx.fillRect(tx, ty, s, s);
          }
        }

        // RIGHT ROOM (cols 11-19): Lounge Carpet & Entrance
        if (c >= 11 && c <= 19) {
          if (r >= 19 && c <= 18) {
            const isWhite = (r + c) % 2 === 0;
            this.ctx.fillStyle = isWhite ? '#e2e8f0' : '#1e293b';
            this.ctx.fillRect(tx, ty, s, s);
          } else {
            this.ctx.fillStyle = '#7c2d12';
            this.ctx.fillRect(tx, ty, s, s);
            if (floorCarpet && floorCarpet.complete) {
              this.ctx.globalAlpha = 0.3;
              this.ctx.drawImage(floorCarpet, tx, ty, s, s);
              this.ctx.globalAlpha = 1.0;
            }
          }
        }
      }
    }

    // 3. Prepare Z-Drawable Queue for Furniture & Characters
    interface ZDrawable {
      zY: number;
      draw: (ctx: CanvasRenderingContext2D) => void;
    }
    const drawables: ZDrawable[] = [];

    // Enqueue Furniture Items
    this.FURNITURE_LIST.forEach((item) => {
      const fx = offsetX + item.col * s;
      const fy = offsetY + item.row * s;
      const dw = item.footprintW * s;
      const dh = item.footprintH * s;
      const zY = (item.row + item.footprintH) * 16;

      drawables.push({
        zY,
        draw: (c) => {
          if (item.mirrored) {
            c.save();
            c.translate(fx + dw, fy);
            c.scale(-1, 1);
            this.drawImageSafe(item.src, 0, 0, dw, dh);
            c.restore();
          } else {
            this.drawImageSafe(item.src, fx, fy, dw, dh);
          }
        }
      });
    });

    // Dynamic PC Monitors for Active Desks
    const mgr = this.robots.get('ManagerAgent');
    const mgrWorking = mgr && (mgr.state === 'working' || mgr.state === 'thinking' || mgr.state === 'executing');
    const mgrPcSrc = mgrWorking ? '/assets/furniture/PC/PC_FRONT_ON_1.png' : '/assets/furniture/PC/PC_FRONT_OFF.png';
    drawables.push({
      zY: 13 * 16,
      draw: () => this.drawImageSafe(mgrPcSrc, offsetX + 3 * s, offsetY + 12 * s, s, s)
    });

    const cfo = this.robots.get('FinancialAdvisorAgent');
    const cfoWorking = cfo && (cfo.state === 'working' || cfo.state === 'thinking' || cfo.state === 'executing');
    const cfoPcSrc = cfoWorking ? '/assets/furniture/PC/PC_FRONT_ON_1.png' : '/assets/furniture/PC/PC_FRONT_OFF.png';
    drawables.push({
      zY: 13 * 16,
      draw: () => this.drawImageSafe(cfoPcSrc, offsetX + 7 * s, offsetY + 12 * s, s, s)
    });

    // Quad Desk PC Monitors
    const sec = this.robots.get('MeetingNotesAgent');
    const secOn = sec && (sec.state === 'working' || sec.state === 'thinking' || sec.state === 'executing');
    drawables.push({
      zY: 17 * 16,
      draw: () => this.drawImageSafe(secOn ? '/assets/furniture/PC/PC_SIDE.png' : '/assets/furniture/PC/PC_SIDE.png', offsetX + 4 * s, offsetY + 16 * s, s, s)
    });

    const rad = this.robots.get('ForesightAgent');
    const radOn = rad && (rad.state === 'working' || rad.state === 'thinking' || rad.state === 'executing');
    drawables.push({
      zY: 19 * 16,
      draw: () => this.drawImageSafe(radOn ? '/assets/furniture/PC/PC_SIDE.png' : '/assets/furniture/PC/PC_SIDE.png', offsetX + 4 * s, offsetY + 18 * s, s, s)
    });

    drawables.push({
      zY: 17 * 16,
      draw: (c) => {
        c.save();
        c.translate(offsetX + 7 * s, offsetY + 16 * s);
        c.scale(-1, 1);
        this.drawImageSafe('/assets/furniture/PC/PC_SIDE.png', 0, 0, s, s);
        c.restore();
      }
    });

    drawables.push({
      zY: 19 * 16,
      draw: (c) => {
        c.save();
        c.translate(offsetX + 7 * s, offsetY + 18 * s);
        c.scale(-1, 1);
        this.drawImageSafe('/assets/furniture/PC/PC_SIDE.png', 0, 0, s, s);
        c.restore();
      }
    });

    // --- CHARACTERS (Pixel-Perfect 16x32 Character Frame Cutting & Anchoring) ---
    this.robots.forEach((bot) => {
      const dx = bot.targetX - bot.currentX;
      const dy = bot.targetY - bot.currentY;
      const dist = Math.hypot(dx, dy);

      if (dist > 1.5) {
        bot.currentX += (dx / dist) * 2.5;
        bot.currentY += (dy / dist) * 2.5;
        bot.walkFrame += 0.2;

        if (Math.abs(dx) > Math.abs(dy)) {
          bot.facing = dx > 0 ? 'right' : 'left';
        } else {
          bot.facing = dy > 0 ? 'down' : 'up';
        }

        if (dist < 4) {
          bot.currentX = bot.targetX;
          bot.currentY = bot.targetY;
          if (bot.state === 'walking_to_work') {
            bot.state = 'working';
            bot.facing = bot.workFacing;
          } else if (bot.state === 'walking_to_lounge') {
            bot.state = 'idle';
            bot.facing = bot.loungeFacing;
          }
        }
      }

      const rx = bot.currentX;
      const ry = bot.currentY;
      const isSeated = (bot.state === 'working' || bot.state === 'idle');
      const sittingOffset = isSeated ? 4 : 0; // CHARACTER_SITTING_OFFSET_PX = 4px

      const charZY = ry + 8 + 2; // Depth sort key

      drawables.push({
        zY: charZY,
        draw: (c) => {
          // Selection Highlight Ring
          if (bot.focused) {
            const scX = offsetX + rx * zoom;
            const scY = offsetY + (ry + sittingOffset) * zoom;
            c.strokeStyle = '#fdba74';
            c.lineWidth = 1.5;
            c.beginPath();
            c.arc(scX, scY - 8 * zoom, 12 * zoom, 0, Math.PI * 2);
            c.stroke();
          }

          // Character Sprite Sheet Cut: 112px x 96px PNGs with 16x32 frames
          const charSrc = `/assets/characters/char_${bot.charSpriteIdx}.png`;
          const charImg = this.imageCache.get(charSrc);

          if (charImg && charImg.complete && charImg.naturalWidth > 0) {
            // Source dimensions based on pixel-agents constant values
            const srcFrameW = 16;
            const srcFrameH = 32;

            let dirRow = 0; // 0: down, 1: up, 2: right
            let isFlipLeft = false;

            if (bot.facing === 'down') dirRow = 0;
            else if (bot.facing === 'up') dirRow = 1;
            else if (bot.facing === 'right') dirRow = 2;
            else if (bot.facing === 'left') {
              dirRow = 2; // Left is a mirrored right frame
              isFlipLeft = true;
            }

            let frameCol = 1; // Default standing/idle frame (walk 1)
            if (dist > 1.5) {
              const walkCycle = [0, 1, 2, 1];
              frameCol = walkCycle[Math.floor(bot.walkFrame) % 4];
            } else if (bot.state === 'working' || bot.state === 'thinking' || bot.state === 'executing') {
              frameCol = (Math.floor(time * 3) % 2 === 0) ? 3 : 4; // Typing hands frames 3 & 4
            }

            const srcX = frameCol * srcFrameW;
            const srcY = dirRow * srcFrameH;

            // Draw Anchor: 16px wide x 32px tall frame centered at tile center, feet at bottom + sittingOffset
            const drawW = 16 * zoom;
            const drawH = 32 * zoom;
            const drawX = Math.round(offsetX + rx * zoom - drawW / 2);
            const drawY = Math.round(offsetY + (ry + sittingOffset) * zoom - drawH);

            if (isFlipLeft) {
              c.save();
              c.translate(drawX + drawW, drawY);
              c.scale(-1, 1);
              c.drawImage(charImg, srcX, srcY, srcFrameW, srcFrameH, 0, 0, drawW, drawH);
              c.restore();
            } else {
              c.drawImage(charImg, srcX, srcY, srcFrameW, srcFrameH, drawX, drawY, drawW, drawH);
            }

            // Clean Pixel Thought Bubble above head (only when working)
            if (bot.state === 'working' || bot.state === 'thinking' || bot.state === 'executing') {
              const label = bot.activeTool ? bot.activeTool : 'Working';
              const bubbleX = offsetX + rx * zoom;
              const bubbleY = offsetY + (ry + sittingOffset - 34) * zoom; // 34px above feet (above 32px head)

              c.save();
              c.font = `600 ${Math.max(9, 7 * zoom)}px monospace`;
              const txtW = c.measureText(label).width;
              const padX = 5;
              const bW = txtW + padX * 2;
              const bH = Math.max(12, 9 * zoom);

              c.fillStyle = 'rgba(15, 23, 42, 0.9)';
              c.strokeStyle = bot.color;
              c.lineWidth = 1;
              c.beginPath();
              c.roundRect(bubbleX - bW / 2, bubbleY - bH, bW, bH, 3);
              c.fill();
              c.stroke();

              c.fillStyle = '#f8fafc';
              c.textAlign = 'center';
              c.textBaseline = 'middle';
              c.fillText(label, bubbleX, bubbleY - bH / 2);
              c.restore();
            }
          }
        }
      });
    });

    // Sort drawables by zY ascending
    drawables.sort((a, b) => a.zY - b.zY);

    // Draw sorted furniture & characters
    for (const item of drawables) {
      item.draw(this.ctx);
    }

    // 5. Sleek Mouse Hover Tooltip
    if (this.hoverAgentId && this.robots.has(this.hoverAgentId)) {
      const bot = this.robots.get(this.hoverAgentId)!;
      const tx = Math.min(this.mouseX + 12, w - 160);
      const ty = Math.max(this.mouseY - 45, 10);

      this.ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
      this.ctx.strokeStyle = bot.color;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.roundRect(tx, ty, 155, 48, 5);
      this.ctx.fill();
      this.ctx.stroke();

      this.ctx.fillStyle = bot.color;
      this.ctx.font = 'bold 10px monospace';
      this.ctx.textAlign = 'left';
      this.ctx.fillText(bot.name, tx + 10, ty + 16);

      this.ctx.fillStyle = '#94a3b8';
      this.ctx.font = '9px monospace';
      const statusText = (bot.state === 'working' || bot.state === 'thinking' || bot.state === 'executing') ? 'Working at desk' : 'Lounge coffee break';
      this.ctx.fillText(`State: ${statusText}`, tx + 10, ty + 30);
      this.ctx.fillText(`Role: ${bot.roleLabel.substring(0, 18)}`, tx + 10, ty + 42);
    }
  }
}
