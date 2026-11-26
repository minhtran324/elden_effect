import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync, execSync, spawn } from 'child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import {
  UPDATE_ASSET_NAME, UPDATE_SIZE_LIMIT, installedStudioVersion, installStudioUpdate, isNewerVersion,
  parseVersion, recoverStudioUpdate, removeUpdateWork, writeUpdateConfig
} from './studio-update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const RULES_FILE = path.join(__dirname, 'rules.json');
const JAR_CONFIG_FILE = path.join(__dirname, 'jar_config.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'videos');
const RENDER_DIR = path.join(UPLOADS_DIR, '.renders');
const DECOR_DIR = path.join(__dirname, 'public', 'uploads', 'decor');
const STICKERS_FILE = path.join(__dirname, 'jar_stickers.json');
const TEMPLATES_FILE = path.join(__dirname, 'jar_templates.json');
const TEMPLATES_DIR = path.join(__dirname, 'public', 'uploads', 'templates');
const TIKTOK_SETTINGS_FILE = path.join(__dirname, 'tiktok_settings.json');
const BUILTIN_JAR_DIR = path.join(__dirname, 'public', 'builtin', 'jar');
const BUILTIN_JAR_ART = new Set(['iridescent_fishbowl_transparent.png', 'iridescent_fishbowl_front_overlay.png']);

function loadTikTokSettings() {
  try {
    if (fs.existsSync(TIKTOK_SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TIKTOK_SETTINGS_FILE, 'utf8'));
      return {
        username: data.username || '',
        autoConnect: data.autoConnect !== false,
        signApiKey: data.signApiKey || '',
        signApiUrl: data.signApiUrl || '',
        sessionId: data.sessionId || ''
      };
    }
  } catch (err) {
    console.error('Lỗi đọc tiktok_settings.json:', err);
  }
  return { username: '', autoConnect: true, signApiKey: '', signApiUrl: '', sessionId: '' };
}

function saveTikTokSettings(settings) {
  try {
    const current = loadTikTokSettings();
    const merged = { ...current, ...settings };
    fs.writeFileSync(TIKTOK_SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi ghi tiktok_settings.json:', err);
  }
}

// ========================================================
// HỆ THỐNG CẬP NHẬT ỨNG DỤNG (AUTO-UPDATE ENGINE)
// ========================================================
const UPDATE_CONFIG_FILE = path.join(__dirname, 'update_config.json');
const TEMP_UPDATE_DIR = path.join(__dirname, 'temp_update');
fs.mkdirSync(TEMP_UPDATE_DIR, { recursive: true });
if (!fs.lstatSync(TEMP_UPDATE_DIR).isDirectory()) throw new Error('Thư mục cập nhật không hợp lệ.');
if (recoverStudioUpdate(__dirname, TEMP_UPDATE_DIR)) {
  const restored = spawn(process.execPath, process.argv.slice(1), {
    cwd: __dirname, detached: true, windowsHide: true, stdio: 'ignore'
  });
  await new Promise((resolve, reject) => restored.once('spawn', resolve).once('error', reject));
  restored.unref();
  process.exit(0);
}
let updateInProgress = false;
let restartingStudio = false;
let lastGitHubCheckTime;

function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (config && typeof config === 'object' && !Array.isArray(config)) return config;
    }
  } catch (err) {
    console.error('Lỗi đọc update_config.json:', err);
  }
  return { version: '1.0.0', githubRepo: '', autoCheckOnStartup: true, lastCheckTime: null };
}

const patchStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_UPDATE_DIR),
  filename: (req, file, cb) => cb(null, `patch_${randomUUID()}.zip`)
});
const patchUpload = multer({
  storage: patchStorage,
  limits: { fileSize: UPDATE_SIZE_LIMIT }
}).single('patchFile');

function loadJarTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
      if (Array.isArray(templates)) return templates;
    }
  } catch (err) {
    console.error('Lỗi đọc jar_templates.json:', err);
  }
  return [];
}

function saveJarTemplates(tmpls) {
  try {
    const pending = TEMPLATES_FILE + '.tmp';
    fs.writeFileSync(pending, JSON.stringify(tmpls, null, 2), 'utf8');
    fs.renameSync(pending, TEMPLATES_FILE);
    return true;
  } catch (err) {
    console.error('Lỗi ghi jar_templates.json:', err);
    return false;
  }
}

const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype === 'image/webp' ? '.webp' : '.png';
    cb(null, `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const templateUpload = multer({
  storage: templateStorage,
  fileFilter: (_req, file, cb) => cb(['image/png', 'image/webp'].includes(file.mimetype) ? null : new Error('Chỉ nhận ảnh PNG hoặc WebP.'), true),
  limits: { fileSize: 30 * 1024 * 1024 }
});
const renderUpload = multer({ dest: RENDER_DIR, limits: { fileSize: 250 * 1024 * 1024 } });
const executeFFmpeg = promisify(execFile);
const GIFTS_CACHE_FILE = path.join(__dirname, 'public', 'gifts_cache.json');

// Đảm bảo các thư mục lưu trữ tồn tại
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DECOR_DIR)) fs.mkdirSync(DECOR_DIR, { recursive: true });
fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

// Cấu hình Hũ Quà Rơi Vật Lý (Physics Jar) mặc định
const FISHBOWL_SKIN = {
  style: 'fishbowl',
  customJarImage: '/builtin/jar/iridescent_fishbowl_transparent.png',
  frontOverlayImage: '/builtin/jar/iridescent_fishbowl_front_overlay.png',
  hideDefaultJarOnCustom: true,
  jarAspect: 'square'
};

const JAR_GIFT_ACTIONS = new Set(['shake', 'crack', 'flip', 'burst', 'assemble', 'clear_shards', 'clear', 'reset']);
const JAR_ACTIONS = new Set([...JAR_GIFT_ACTIONS, 'remove_gift_type']);
const DEFAULT_JAR_CONFIG = {
  enabled: true,
  style: 'mason', // 'mason' | 'diamond' | 'fishbowl' | 'chest' | 'custom_image'
  customJarImage: '',
  frontOverlayImage: '',
  jarAspect: 'vertical',
  hideDefaultJarOnCustom: true, // Ẩn hũ gốc khi chọn ảnh riêng để không bị trùng lặp
  decorImage: '',
  decorText: '',
  decorPosition: 'center', // 'center' | 'top' | 'bottom' | 'neck'
  decorScale: 1.0,
  decorOpacity: 0.95,
  // TỌA ĐỘ & VỊ TRÍ HŨ TRONG KHUNG HÌNH (0 - 100%)
  jarPosX: 50, // 50% = giữa màn hình ngang
  jarPosY: 82, // 82% = nửa dưới màn hình
  jarScale: 1.0, // Phóng to / Thu nhỏ hũ (0.5 - 1.5)
  // ĐIỂM XUẤT PHÁT VÀ CHẾ ĐỘ RƠI QUÀ
  dropOrigin: 'top', // 'top' (trên cùng) | 'middle' (giữa màn hình / ngang streamer) | 'mouth' (ngay miệng hũ)
  dropMode: 'straight', // 'straight' (rơi thẳng lần lượt từng quả xuống) | 'shower' (cơn mưa tản nhẹ)
  dropSpread: 0.2, // độ tản rộng khi rơi (0.05 - 1.0)
  fallSpeed: 1.0, // tốc độ rơi (0.5 - 2.0)
  gravity: 1.0, // trọng lực vật lý (0.5 - 2.0)
  // RUNG LẮC THEO MỐC KIM CƯƠNG
  shakeThreshold: 50, // Chỉ rung lắc hũ khi quà từ số xu này trở lên
  flipSpeed: 1,
  // VẬT LÝ TRÀN HŨ & TÍCH TỤ DƯỚI ĐẤT
  enableFloorAccumulation: true, // Khi đầy hũ hoặc rơi ra ngoài thì rơi xuống đất và chồng chất lên nhau quanh hũ
  giftCapacity: 300, // Số lượng quà tối đa lưu trên màn hình
  giftCapacityUnlimited: false,
  giftActions: {},
  // KÍCH THƯỚC QUÀ TẶNG (TOÀN BỘ & TỪNG LOẠI)
  giftScaleGlobal: 1.0, // Tỉ lệ phóng to/thu nhỏ chung cho toàn bộ quà (0.5 - 1.6)
  giftSizeSmall: 15, // Quà nhỏ (1-9 xu: Hoa hồng, Thả tim, TikTok...)
  giftSizeMedium: 24, // Quà vừa (10-99 xu: Bánh vòng, Trà sữa...)
  giftSizeLarge: 35, // Quà to (100-999 xu: Mũ & Kính, Teddy, Tiền bay...)
  giftSizeVIP: 52, // Quà Siêu VIP (1000+ xu: Sư tử, Du thuyền, Vũ trụ...)
  // HIỆU ỨNG THỊ GIÁC & ÂM THANH
  glowEffect: true, // Hiệu ứng hào quang neon phát sáng quanh hũ
  sparkleEffect: true, // Vệt bụi sáng lấp lánh khi quà rơi
  bounciness: 0.35,
  soundEnabled: true,
  soundVolume: 0.7,
  // MỤC TIÊU & TỰ ĐỘNG NỔ
  goalEnabled: true,
  goalTargetCoins: 500,
  autoBurstOnGoal: true
};

function loadJarConfig() {
  try {
    if (fs.existsSync(JAR_CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(JAR_CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_JAR_CONFIG, ...data };
    }
  } catch (err) {
    console.error('Lỗi đọc jar_config.json:', err.message);
  }
  return { ...DEFAULT_JAR_CONFIG };
}

function saveJarConfig(cfg) {
  try {
    fs.writeFileSync(JAR_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Lỗi ghi jar_config.json:', err.message);
    return false;
  }
}

let jarConfig = loadJarConfig();

const uploadedStickerUrl = /^\/uploads\/decor\/decor_[\w-]+_\d{10,}\.(png|jpe?g|svg|webp)$/i;

function saveJarStickers(stickers) {
  const pending = `${STICKERS_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, JSON.stringify(stickers, null, 2), 'utf8');
    fs.renameSync(pending, STICKERS_FILE);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
}

function loadJarStickers() {
  try {
    return JSON.parse(fs.readFileSync(STICKERS_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Older Studio uploads shared a folder with jar artwork. Recover the images used as stickers.
  const designs = [jarConfig, ...loadJarTemplates().map(template => template.stateData?.design)];
  const stickers = new Map();
  for (const design of designs) {
    if (!Array.isArray(design?.stickers)) continue;
    for (const sticker of design.stickers) {
      if (!uploadedStickerUrl.test(sticker?.url) || stickers.has(sticker.url)) continue;
      const file = path.basename(sticker.url);
      if (!fs.existsSync(path.join(DECOR_DIR, file))) continue;
      stickers.set(sticker.url, { url: sticker.url, name: sticker.name || 'Sticker' });
    }
  }
  const entries = [...stickers.values()];
  if (entries.length) saveJarStickers(entries);
  return entries;
}

// Capture the old sticker references before edits or template changes can remove them.
try { loadJarStickers(); } catch (error) {
  console.error('Lỗi nạp sticker đã lưu:', error.message);
}

function saveAndPublishJarConfig(config) {
  if (!saveJarConfig(config)) return false;
  jarConfig = config;
  io.emit('jar_config_updated', config);
  return true;
}

// Session data survives Browser Source reloads and is rebuilt only when Studio starts.
const jarSession = { id: randomUUID(), sequence: 0, coins: 0, gifts: new Map(), checkpoints: new Map() };
const jarInventories = new Map();
const JAR_INVENTORY_ROOM = 'jar_inventory_watchers';
let jarInventoryTimer;

function isGiftKey(key) {
  return typeof key === 'string' && key.length <= 240 && /^(id|name):.+$/s.test(key);
}

function getJarInventory() {
  const queuedByKey = new Map();
  for (const inventory of jarInventories.values()) {
    for (const { key, queued } of inventory) {
      queuedByKey.set(key, Math.max(queuedByKey.get(key) || 0, queued));
    }
  }
  return [...jarSession.gifts.values()].map(gift => {
    const queued = Math.min(gift.count, queuedByKey.get(gift.giftKey) || 0);
    return { key: gift.giftKey, name: gift.inventoryName, count: gift.count - queued, queued };
  });
}

function scheduleJarInventory() {
  if (jarInventoryTimer) return;
  jarInventoryTimer = setTimeout(() => {
    jarInventoryTimer = undefined;
    io.to(JAR_INVENTORY_ROOM).emit('jar_inventory_updated', getJarInventory());
  }, 80);
}

function nextJarSessionEvent() {
  return { sessionId: jarSession.id, sequence: ++jarSession.sequence };
}

io.on('connection', socket => {
  socket.on('jar_watch_inventory', () => {
    socket.join(JAR_INVENTORY_ROOM);
    socket.emit('jar_inventory_updated', getJarInventory());
  });
  socket.on('jar_report_inventory', inventory => {
    if (!Array.isArray(inventory)) return;
    jarInventories.set(socket.id, inventory.filter(gift => isGiftKey(gift?.key) &&
      Number.isSafeInteger(gift.queued) && gift.queued > 0));
    scheduleJarInventory();
  });
  socket.on('jar_sync_session', (view, respond) => {
    if (typeof respond !== 'function' || !['obs', 'preview'].includes(view)) return;
    socket.data.jarView = view;
    respond({
      sessionId: jarSession.id, sequence: jarSession.sequence, coins: jarSession.coins,
      gifts: [...jarSession.gifts.values()], positions: jarSession.checkpoints.get(view)
    });
  });
  socket.on('jar_checkpoint', snapshot => {
    const view = socket.data.jarView;
    if (!view || snapshot?.sessionId !== jarSession.id || snapshot.sequence !== jarSession.sequence ||
        !Array.isArray(snapshot.positions) || snapshot.positions.length > 1800) return;
    const positions = snapshot.positions.filter(item =>
      Array.isArray(item) && item.length === 5 && jarSession.gifts.has(item[0]) &&
      item.slice(1, 4).every(Number.isFinite) && typeof item[4] === 'boolean' &&
      item[1] >= 0 && item[1] <= 1 && item[2] >= 0 && item[2] <= 1);
    jarSession.checkpoints.set(view, positions);
  });
  socket.on('disconnect', () => {
    if (jarInventories.delete(socket.id)) scheduleJarInventory();
  });
});

// Bộ nhớ cache danh mục quà TikTok kèm icon ảnh
let liveGiftsCache = [];
try {
  if (fs.existsSync(GIFTS_CACHE_FILE)) {
    liveGiftsCache = JSON.parse(fs.readFileSync(GIFTS_CACHE_FILE, 'utf-8'));
    console.log(`🎁 [CACHE] Đã nạp ${liveGiftsCache.length} quà tặng kèm icon ảnh TikTok CDN.`);
  }
} catch (_) {}

// Cấu hình Multer lưu video tải lên
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 } // Giới hạn 250MB
});

// Cấu hình Multer lưu ảnh Decor PNG/SVG xoá phông cho Hũ Quà
const decorStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DECOR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, `decor_${base}_${randomUUID()}_${Date.now()}${ext}`);
  }
});
const decorUpload = multer({
  storage: decorStorage,
  limits: { fileSize: 25 * 1024 * 1024 } // Giới hạn 25MB
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Keep old saved template URLs usable even if the bundled art was not in the uploads folder.
app.get('/uploads/decor/:file', (req, res, next) => {
  const file = req.params.file;
  if (!BUILTIN_JAR_ART.has(file) && file !== 'jar_template_guide.svg') return next();
  res.sendFile(file, { root: BUILTIN_JAR_DIR }, error => { if (error) next(error); });
});

// Endpoint kiểm tra máy chủ còn sống (Watchdog Ping cho OBS Browser Source tự động kết nối lại)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Trạng thái hệ thống
let currentLiveStatus = {
  isConnected: false,
  isConnecting: false,
  isWaitingLive: false,
  username: '',
  roomId: '',
  viewerCount: 0,
  error: null
};

let recentLogs = [];
function addLog(type, message, details = {}) {
  const logItem = {
    id: Date.now() + Math.random(),
    time: new Date().toLocaleTimeString('vi-VN'),
    type, // 'info' | 'hit' | 'miss' | 'gift' | 'error'
    message,
    details
  };
  recentLogs.unshift(logItem);
  if (recentLogs.length > 50) recentLogs.pop();
  io.emit('new_log', logItem);
}

// Đọc danh sách Rules
function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Lỗi đọc rules.json:', err);
  }
  return [];
}

// Lưu danh sách Rules
function saveRules(rules) {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Lỗi ghi rules.json:', err);
    return false;
  }
}

let activeRules = loadRules();
let activeTiktokConn = null;

// Từ điển quà tặng TikTok phổ biến tại Việt Nam (Tra cứu theo ID hoặc tên)
const KNOWN_TIKTOK_GIFTS = {
  // 1 xu
  '5655': { name: 'Hoa Hồng', coins: 1 },
  '5827': { name: 'Kem Ốc Quế', coins: 1 },
  '8913': { name: 'Thả Tim Cho Tôi', coins: 1 },
  '5269': { name: 'TikTok', coins: 1 },
  '6064': { name: 'Cây Kem', coins: 1 },
  '5760': { name: 'Tạ Tay', coins: 1 },
  // 5 xu
  '5487': { name: 'Ngón Tay Thả Tim', coins: 5 },
  // 9 - 10 xu
  '5764': { name: 'Trà Sữa', coins: 9 },
  // 20 xu
  '626064': { name: 'Nghệ Sĩ Đường Phố G.O.A.T.', coins: 20 },
  '5509': { name: 'Nước Hoa', coins: 20 },
  // 30 xu (Bánh Vòng)
  '5879': { name: 'Bánh Vòng', coins: 30 },
  '5659': { name: 'Bánh Vòng', coins: 30 },
  '6508': { name: 'Bánh Vòng', coins: 30 },
  '6267': { name: 'Bánh Vòng', coins: 30 },
  // 99 xu
  '5650': { name: 'Mũ & Kính', coins: 99 },
  '5778': { name: 'Mũ Lông Vũ', coins: 99 },
  '5779': { name: 'Vòng Tay Tình Yêu', coins: 99 },
  // 100 xu
  '5585': { name: 'Gấu Bông Teddy', coins: 100 },
  '5780': { name: 'Trái Tim Giấy', coins: 100 },
  // 199 xu
  '5881': { name: 'Kính Râm', coins: 199 },
  // 299 xu
  '5897': { name: 'Găng Tay Đấm Bốc', coins: 299 },
  // 500 - 1088 xu
  '5800': { name: 'Tiền Bay', coins: 500 },
  '5700': { name: 'Thiên Nga', coins: 699 },
  '5701': { name: 'Pháo Hoa', coins: 1088 },
  // Quà VIP
  '5702': { name: 'Xe Thể Thao', coins: 7000 },
  '5705': { name: 'Du Thuyền', coins: 7050 },
  '5703': { name: 'Sư Tử', coins: 29999 },
  '5704': { name: 'Vũ Trụ TikTok', coins: 44999 }
};

// Chuẩn hóa chuỗi để so sánh tên quà chính xác tuyệt đối
function normalizeGiftStr(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function stripVietnameseDiacritics(str) {
  if (!str) return '';
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// So sánh tên quà: KHỚP CHÍNH XÁC TOÀN BỘ (Exact Match) hỗ trợ có dấu, không dấu, và alias Anh - Việt 1-1
// Tuyệt đối KHÔNG dùng substring (.includes) để tránh trùng lặp 1-2 từ đầu (như "Hoa hồng" vs "Hoa hồng vĩnh cửu")
function matchGiftName(ruleGiftName, incomingGiftName) {
  if (!ruleGiftName || !incomingGiftName) return false;
  const r = normalizeGiftStr(ruleGiftName);
  const inc = normalizeGiftStr(incomingGiftName);

  // 1. So khớp chính xác 100%
  if (r === inc) return true;

  // 2. So khớp chính xác 100% sau khi bỏ dấu tiếng Việt (ví dụ "hoa hồng" === "hoa hong")
  const rClean = stripVietnameseDiacritics(r);
  const incClean = stripVietnameseDiacritics(inc);
  if (rClean === incClean) return true;

  // 3. Danh sách bí danh tương đương chuẩn xác 1-1 giữa tiếng Việt và tiếng Anh TikTok
  // CHÚ Ý: Mọi phần tử ở đây phải khớp CHÍNH XÁC toàn bộ cụm từ, KHÔNG dùng includes()
  const aliases = [
    ['hoa hồng', 'hoa hong', 'rose'],
    ['kem ốc quế', 'kem oc que', 'ice cream cone', 'ice cream'],
    ['bánh vòng', 'banh vong', 'bánh donut', 'banh donut', 'donut', 'doughnut'],
    ['thả tim cho tôi', 'tha tim cho toi', 'heart me', 'like'],
    ['ngón tay thả tim', 'ngon tay tha tim', 'finger heart'],
    ['trà sữa', 'tra sua', 'boba', 'bubble tea'],
    ['kính râm', 'kính mát', 'kinh ram', 'kinh mat', 'sunglasses'],
    ['mũ & kính', 'mu & kinh', 'cap and mustache'],
    ['thiên nga', 'thien nga', 'swan'],
    ['pháo hoa', 'phao hoa', 'fireworks'],
    ['du thuyền', 'du thuyen', 'yacht'],
    ['sư tử', 'su tu', 'lion'],
    ['vũ trụ tiktok', 'vu tru tiktok', 'tiktok universe'],
    ['nghệ sĩ đường phố g.o.a.t.', 'nghe si duong pho g.o.a.t.', 'g.o.a.t. busker', 'goat busker', 'busker'],
    ['gấu trúc', 'gau truc', 'panda'],
    ['tiền bay', 'tien bay', 'money gun'],
    ['kim cương', 'kim cuong', 'diamond']
  ];

  for (const group of aliases) {
    const rMatch = group.some(a => r === a || rClean === stripVietnameseDiacritics(a));
    const incMatch = group.some(a => inc === a || incClean === stripVietnameseDiacritics(a));
    if (rMatch && incMatch) return true;
  }

  return false;
}

// Bóc tách thông tin từ WebcastGiftMessage (hỗ trợ cả Protobuf v2/v3, Legacy flattened, và Simulator)
function parseGiftPayload(data) {
  if (!data) return null;
  if (data._isParsed) return data;

  const user = data.user || {};
  const giftDetails = data.giftDetails || data.gift || {};
  const extGift = data.extendedGiftInfo || {};

  // 1. Tên người gửi & Nickname (không bao giờ bị undefined)
  const sender = data.sender || 
                 data.uniqueId || 
                 user.uniqueId || 
                 user.displayId || 
                 user.idStr || 
                 user.id || 
                 'Người Xem';

  const nickname = data.nickname || 
                   user.nickname || 
                   user.displayId || 
                   sender || 
                   'Người Xem';

  // 2. Avatar
  const avatar = data.avatar || 
                 data.profilePictureUrl || 
                 user.profilePictureUrl ||
                 user.avatarThumb?.urlList?.[0] || 
                 user.avatarMedium?.urlList?.[0] || 
                 user.avatarLarge?.urlList?.[0] || 
                 '';

  // 3. ID món quà
  let giftId = String(data.giftId || giftDetails.id || giftDetails.gift_id || extGift.id || '');

  // 4. Tên món quà gốc từ TikTok Webcast event (thường là tiếng Anh: "G.O.A.T. Busker", "Rose", "Ice Cream Cone")
  const rawGiftName = data.rawGiftName ||
                      data.giftName || 
                      giftDetails.giftName || 
                      giftDetails.name || 
                      giftDetails.describe || 
                      extGift.name || 
                      '';

  // Tra cứu quà trong cache TikTok chính thức (gifts_cache.json) theo giftId hoặc tên
  let cachedGift = null;
  if (giftId && Array.isArray(liveGiftsCache)) {
    cachedGift = liveGiftsCache.find(g => String(g.id) === giftId);
  }
  if (!cachedGift && rawGiftName && Array.isArray(liveGiftsCache)) {
    cachedGift = liveGiftsCache.find(g => matchGiftName(g.name, rawGiftName));
    if (cachedGift && !giftId) giftId = String(cachedGift.id);
  }

  // Tên tiếng Việt chính thức nếu có trong kho 760+ quà
  const localizedName = cachedGift?.name || (giftId && KNOWN_TIKTOK_GIFTS[giftId] ? KNOWN_TIKTOK_GIFTS[giftId].name : '');

  // Tên quà chính: ưu tiên tiếng Việt nếu có trong kho quà, fallback về tên gốc TikTok
  let giftName = localizedName || rawGiftName;
  if (!giftName && data.common?.describe) {
    giftName = data.common.describe.replace(/\{.*?\}/g, '').trim();
  }
  if (!giftName) {
    giftName = giftId ? `Quà #${giftId}` : 'Quà TikTok';
  }

  // 5. Số xu (diamondCount)
  let diamondCount = Number(
    data.diamondCount || 
    giftDetails.diamondCount || 
    giftDetails.diamond_count || 
    extGift.diamond_count || 
    (cachedGift ? cachedGift.coins : 0) ||
    (giftId && KNOWN_TIKTOK_GIFTS[giftId] ? KNOWN_TIKTOK_GIFTS[giftId].coins : 0) || 
    1
  );
  if (!diamondCount || isNaN(diamondCount) || diamondCount <= 0) diamondCount = 1;

  // 6. Số lượng quà (repeatCount)
  let repeatCount = Number(
    data.repeatCount || 
    giftDetails.repeatCount || 
    giftDetails.repeat_count || 
    data.groupCount || 
    data.comboCount || 
    1
  );
  if (!repeatCount || isNaN(repeatCount) || repeatCount <= 0) repeatCount = 1;

  // 7. Icon món quà (Ảnh CDN WebP)
  let iconUrl = data.iconUrl || 
                cachedGift?.iconUrl ||
                giftDetails.icon?.urlList?.[0] || 
                giftDetails.image?.urlList?.[0] || 
                data.image?.url_list?.[0] || 
                data.icon?.url_list?.[0] || 
                '';

  if (!iconUrl && Array.isArray(liveGiftsCache)) {
    const found = (giftId ? liveGiftsCache.find(g => String(g.id) === String(giftId)) : null) ||
                  liveGiftsCache.find(g => matchGiftName(g.name, giftName));
    if (found && found.iconUrl) iconUrl = found.iconUrl;
  }

  // 8. Combo
  const isComboGift = Boolean(giftDetails.combo || Number(giftDetails.giftType ?? giftDetails.gift_type) === 1 || Number(data.giftType) === 1);
  const isComboFinished = !isComboGift || Number(data.repeatEnd ?? data.repeat_end ?? giftDetails.repeat_end) === 1;

  return {
    _isParsed: true,
    sender,
    nickname,
    giftName,
    rawGiftName,
    localizedName,
    diamondCount,
    repeatCount,
    avatar,
    giftId,
    iconUrl,
    isComboGift,
    isComboFinished,
    comboGroup: String(data.groupId || data.group_id || '').replace(/^0$/, ''),
    messageId: String(data.common?.msgId || data.msgId || '')
  };
}

// Kiểm tra xem một rule có khớp với món quà đang nhận hay không
function isRuleMatchingGift(rule, parsed) {
  if (!rule || !rule.enabled || !parsed) return false;
  const isSpecific = rule.ruleType === 'specific_gift' || rule.ruleType === 'random_pool' || (!rule.ruleType && rule.giftName && rule.giftName.trim());
  if (!isSpecific) return false;

  const { giftId, giftName, rawGiftName, localizedName } = parsed;

  // 1. So khớp theo ID quà (Chính xác tuyệt đối 100%, không bị ảnh hưởng bởi ngôn ngữ Anh / Việt)
  let ruleGiftId = rule.giftId ? String(rule.giftId) : null;
  if (!ruleGiftId && rule.giftName && Array.isArray(liveGiftsCache)) {
    const f = liveGiftsCache.find(g => normalizeGiftStr(g.name) === normalizeGiftStr(rule.giftName));
    if (f) ruleGiftId = String(f.id);
  }

  // NẾU CẢ RULE VÀ MÓN QUÀ NHẬN ĐƯỢC ĐỀU CÓ GIFT ID:
  // So khớp ID là chuẩn xác nhất: bằng ID thì trúng, KHÁC ID thì CHẮC CHẮN SAI (không được so sánh chữ lung tung)
  if (ruleGiftId && giftId) {
    return ruleGiftId === String(giftId);
  }

  // 2. So khớp theo tên quà (chỉ dùng khi rule hoặc quà không có giftId, ví dụ tự gõ tên test simulator)
  // Chỉ so khớp CHÍNH XÁC (Exact Match), tuyệt đối không dùng substring để tránh trùng lặp 1-2 từ đầu
  const candidateNames = [giftName, rawGiftName, localizedName].filter(Boolean);
  for (const cand of candidateNames) {
    if (matchGiftName(rule.giftName, cand)) return true;
  }

  return false;
}

function sendGiftToJar(parsed, count, runAction = true, autoShakeCoins) {
  const found = findJarGift(parsed.giftId, parsed.giftName);
  publishJarGift({
    giftId: parsed.giftId || found?.id || '',
    inventoryName: found?.name || parsed.giftName,
    giftName: parsed.giftName,
    diamondCount: parsed.diamondCount,
    count,
    iconUrl: parsed.iconUrl || found?.iconUrl,
    autoShakeCoins
  }, runAction);
}

const liveJarCombos = new Map();

function handleLiveGift(data) {
  const parsed = parseGiftPayload(data);
  if (!parsed) return;
  if (!parsed.isComboGift) {
    handleGift(parsed);
    return;
  }

  const now = Date.now();
  for (const [key, item] of liveJarCombos) {
    if (now - item.updatedAt < 120_000) break;
    liveJarCombos.delete(key);
  }
  const key = JSON.stringify([parsed.sender, parsed.giftId || parsed.giftName, parsed.comboGroup || '']);
  let previous = liveJarCombos.get(key);
  if (!parsed.comboGroup && previous?.finished &&
      (!parsed.isComboFinished || (previous.messageId !== parsed.messageId && now - previous.updatedAt > 1000))) {
    previous = undefined;
  }
  const rawCount = Math.max(1, Math.trunc(parsed.repeatCount));
  const sent = previous?.sent || 0;
  const delta = rawCount - sent;
  if (delta > 0) {
    const threshold = Number(jarConfig.shakeThreshold);
    const cumulativeCoins = rawCount * parsed.diamondCount;
    const shakeCoins = sent * parsed.diamondCount < threshold && cumulativeCoins >= threshold ? cumulativeCoins : 0;
    sendGiftToJar(parsed, delta, sent === 0, shakeCoins);
  }
  const finished = Boolean(previous?.finished || parsed.isComboFinished);
  liveJarCombos.delete(key);
  liveJarCombos.set(key, {
    sent: Math.max(sent, rawCount), finished, updatedAt: now, messageId: parsed.messageId
  });
  if (parsed.isComboFinished && !previous?.finished) handleGift(parsed, false);
}

// ---------- THUẬT TOÁN XỬ LÝ QUÀ & TỈ LỆ TRÚNG/XỊT ----------
function handleGift(giftData, includeJar = true) {
  const parsed = parseGiftPayload(giftData);
  if (!parsed) return;

  const { sender, nickname, giftName, rawGiftName, localizedName, diamondCount, repeatCount, avatar, iconUrl, giftId } = parsed;
  const coins = diamondCount * repeatCount;
  if (includeJar) sendGiftToJar(parsed, repeatCount);

  // Tên quà hiển thị đầy đủ, rõ ràng cho streamer xem trong nhật ký
  const displayGiftName = (localizedName && rawGiftName && localizedName.toLowerCase() !== rawGiftName.toLowerCase())
    ? `${localizedName} (${rawGiftName})`
    : giftName;

  // Ghi log sự kiện quà tặng
  addLog('gift', `${nickname} đã gửi ${repeatCount}x ${displayGiftName} (${coins} xu)`, {
    sender,
    giftName: displayGiftName,
    coins,
    avatar
  });

  console.log(`🎁 [NHẬN QUÀ] ${nickname} (@${sender}) tặng ${repeatCount}x "${displayGiftName}" [ID: ${giftId}] (${coins} xu)`);

  // Tìm rule phù hợp theo thứ tự ưu tiên:
  // ƯU TIÊN 1: Đúng loại quà chỉ định (Specific Gift Rule hoặc Random Pool cho quà đó)
  let matchedRule = activeRules.find(rule => isRuleMatchingGift(rule, parsed));

  // ƯU TIÊN 2: Mốc xu tối thiểu (Minimum Coin Rule) - Dành cho các quà không có quy tắc riêng
  if (!matchedRule) {
    matchedRule = activeRules
      .filter(rule => {
        if (!rule.enabled) return false;
        const isMinCoins = rule.ruleType === 'min_coins' || (!rule.ruleType && (!rule.giftName || !rule.giftName.trim()) && rule.minCoins > 0);
        return isMinCoins && (rule.minCoins || 0) > 0 && coins >= rule.minCoins;
      })
      .sort((a, b) => (b.minCoins || 0) - (a.minCoins || 0))[0];
  }

  if (!matchedRule) {
    addLog('info', `[Bỏ qua] Món quà "${displayGiftName}" (${coins} xu) không có quy tắc nào khớp.`);
    console.log(`[BỎ QUA] Món quà "${displayGiftName}" (${coins} xu) không khớp quy tắc nào.`);
    return;
  }

  // 1. KIỂM TRA TỈ LỆ TRÚNG / XỊT (Gacha Rate)
  const successRate = typeof matchedRule.successRate === 'number' ? matchedRule.successRate : 100;
  const roll = Math.random() * 100;

  if (roll >= successRate) {
    // ❌ XỊT (Miss)
    const missMsg = matchedRule.missMessage || 'Tiếc quá, xịt rồi! Chúc bạn may mắn lần sau 💨';
    addLog('miss', `❌ XỊT (${roll.toFixed(1)}% >= ${successRate}%): ${nickname} tặng ${giftName} nhưng không trúng hiệu ứng!`, {
      rule: matchedRule.name,
      roll: roll.toFixed(1),
      rate: successRate
    });

    io.emit('trigger_effect', {
      result: 'miss',
      sender: nickname || sender,
      giftName,
      coins,
      avatar,
      message: missMsg,
      ruleName: matchedRule.name
    });
    return;
  }

  // 🎯 TRÚNG (Hit) -> Chọn ngẫu nhiên video theo TRỌNG SỐ (WEIGHT)
  const pool = matchedRule.videoPool || [];
  if (pool.length === 0) {
    addLog('error', `Quy tắc "${matchedRule.name}" chưa có video nào trong danh sách!`);
    return;
  }

  const totalWeight = pool.reduce((sum, v) => sum + (Number(v.weight) || 0), 0);
  let chosenVideo = pool[0];

  if (totalWeight > 0) {
    let randWeight = Math.random() * totalWeight;
    for (const v of pool) {
      const w = Number(v.weight) || 0;
      if (randWeight < w) {
        chosenVideo = v;
        break;
      }
      randWeight -= w;
    }
  }

  const videoUrl = chosenVideo.file;
  const duration = Number(chosenVideo.duration) || 10;

  addLog('hit', `🎯 TRÚNG HIỆU ỨNG! (${roll.toFixed(1)}% < ${successRate}%): Chạy video "${chosenVideo.name}"`, {
    sender: nickname || sender,
    giftName,
    coins,
    video: chosenVideo.name,
    videoUrl,
    rule: matchedRule.name
  });

  io.emit('trigger_effect', {
    result: 'hit',
    sender: nickname || sender,
    giftName,
    coins,
    avatar,
    videoUrl,
    videoName: chosenVideo.name,
    duration,
    ruleName: matchedRule.name
  });
}

// ---------- API ENDPOINTS ----------

// Lấy danh sách rules
app.get('/api/rules', (req, res) => {
  res.json({ success: true, rules: activeRules });
});

// Lưu rules mới
app.post('/api/rules', (req, res) => {
  if (!Array.isArray(req.body.rules)) {
    return res.status(400).json({ success: false, error: 'Dữ liệu rules phải là một mảng' });
  }
  activeRules = req.body.rules;
  saveRules(activeRules);
  addLog('info', 'Đã lưu và cập nhật cấu hình quy tắc mới.');
  io.emit('rules_updated', activeRules);
  res.json({ success: true, rules: activeRules });
});

// Helper: Thăm dò thông tin video gốc bằng FFmpeg (FPS, độ phân giải, thời lượng)
function probeVideoInfo(filePath) {
  try {
    execFileSync(ffmpegPath, ['-i', filePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
    const resMatch = stderr.match(/, (\d{3,4})x(\d{3,4})/);
    const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);

    let duration = 0;
    if (durMatch) {
      duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
    }

    const rawFps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;
    const roundedFps = Math.round(rawFps);
    return {
      fps: rawFps,
      roundedFps,
      width: resMatch ? parseInt(resMatch[1]) : 720,
      height: resMatch ? parseInt(resMatch[2]) : 1280,
      duration
    };
  }
  return { fps: 30, roundedFps: 30, width: 720, height: 1280, duration: 10 };
}

// API thăm dò FPS và thông tin video
app.get('/api/probe-video', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ success: false, error: 'Thiếu url' });
  const filename = path.basename(url);
  const fullPath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy file video' });
  }
  const info = probeVideoInfo(fullPath);
  res.json({ success: true, info });
});

// Chuẩn hóa track âm thanh để Web Audio có thể dựng và trộn trên timeline.
async function sendEditorAudio(filePath, res) {
  try {
    const { stdout } = await executeFFmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0:a:0',
      '-vn', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, windowsHide: true });
    res.type('audio/ogg').send(stdout);
  } catch (error) {
    if (/matches no streams/i.test(String(error.stderr || ''))) {
      res.status(204).end();
    } else {
      res.status(422).json({ success: false, error: 'Không đọc được âm thanh trong video.' });
    }
  }
}

app.get('/api/editor/source-audio', async (req, res) => {
  if (typeof req.query.url !== 'string' || !req.query.url.startsWith('/uploads/videos/')) {
    return res.status(400).json({ success: false, error: 'Chưa chọn video trong Studio.' });
  }
  const filePath = path.join(UPLOADS_DIR, path.basename(req.query.url));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy video.' });
  }
  await sendEditorAudio(filePath, res);
});

app.post('/api/editor/source-audio', renderUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Chưa chọn video.' });
  try {
    await sendEditorAudio(req.file.path, res);
  } finally {
    try { fs.rmSync(req.file.path, { force: true }); } catch (_) {}
  }
});

// API Xuất video đã chỉnh sửa với FPS tùy chọn & Tên chỉ định
app.post('/api/render-export', renderUpload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa nhận được file video' });
  }

  const customName = String(req.body.customName || '').trim() || 'Effect_Idol_Edited';
  let targetFps = req.body.targetFps || '30';
  const sourceUrl = req.body.sourceUrl || '';

  if (targetFps === 'original' && sourceUrl) {
    const srcFilename = path.basename(sourceUrl);
    const srcPath = path.join(UPLOADS_DIR, srcFilename);
    if (fs.existsSync(srcPath)) {
      const probe = probeVideoInfo(srcPath);
      targetFps = String(probe.roundedFps || 30);
    } else {
      targetFps = '30';
    }
  }
  const fps = Number(targetFps);
  targetFps = Number.isInteger(fps) && fps >= 1 && fps <= 120 ? String(fps) : '30';

  // Tên file sạch đẹp giữ nguyên tên do user nhập, không thêm dãy ID
  const sanitized = customName.replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]/g, '_').substring(0, 80) || 'Effect_Idol';
  const finalFilename = sanitized.toLowerCase().endsWith('.webm') ? sanitized : `${sanitized}.webm`;
  const finalPath = path.join(UPLOADS_DIR, finalFilename);
  const renderPath = req.file.path + '.render.webm';

  try {
    // Xây dựng chuỗi filter FFmpeg: khử nền xanh (nếu có khoảng trống) -> chuẩn yuva420p -> Fade In/Out trực tiếp trên kênh Alpha
    const vfParts = ['colorkey=0x00FF00:0.32:0.12', 'format=yuva420p'];
    try {
      const fades = req.body.fadesJson ? JSON.parse(req.body.fadesJson) : [];
      if (Array.isArray(fades)) {
        for (const c of fades) {
          const st = Number(c.startTime) || 0;
          const dur = Number(c.duration) || 0;
          const fIn = Number(c.fadeIn) || 0;
          const fOut = Number(c.fadeOut) || 0;
          if (fIn > 0) {
            const endIn = st + fIn;
            vfParts.push(`fade=t=in:st=${st.toFixed(3)}:d=${fIn.toFixed(3)}:alpha=1:enable=between(t\\,${st.toFixed(3)}\\,${endIn.toFixed(3)})`);
          }
          if (fOut > 0 && dur > fOut) {
            const outSt = st + dur - fOut;
            const endOut = st + dur;
            vfParts.push(`fade=t=out:st=${outSt.toFixed(3)}:d=${fOut.toFixed(3)}:alpha=1:enable=between(t\\,${outSt.toFixed(3)}\\,${endOut.toFixed(3)})`);
          }
        }
      }
    } catch (_) {}

    // Dùng FFmpeg chuẩn hóa FPS, chuyển phông xanh/khoảng trống & hiệu ứng mờ dần thành TRONG SUỐT (yuva420p)
    await executeFFmpeg(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', req.file.path,
      '-r', targetFps,
      '-vf', vfParts.join(','),
      '-c:v', 'libvpx-vp9',
      '-auto-alt-ref', '0',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', '8M',
      '-c:a', 'libopus',
      '-b:a', '128k',
      renderPath
    ], { windowsHide: true });
    fs.renameSync(renderPath, finalPath);
  } catch (err) {
    console.warn('FFmpeg không xuất được video:', err.message);
    return res.status(422).json({ success: false, error: 'Không xuất được WebM trong suốt. Kiểm tra video nguồn và thử lại.' });
  } finally {
    for (const file of [req.file.path, renderPath]) {
      if (file !== finalPath) {
        try { fs.rmSync(file, { force: true }); } catch (_) {}
      }
    }
  }

  const fileUrl = `/uploads/videos/${finalFilename}`;
  const fileSize = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : req.file.size;
  addLog('info', `Đã xuất video: "${customName}" (${targetFps} FPS, ${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
  io.emit('media_updated');

  res.json({
    success: true,
    fileName: customName,
    fileUrl,
    savedName: finalFilename,
    fps: Number(targetFps),
    size: fileSize
  });
});

// Tải lên file video
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file video' });
  }
  const fileUrl = `/uploads/videos/${req.file.filename}`;
  addLog('info', `Đã tải lên video mới: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  io.emit('media_updated');
  res.json({
    success: true,
    fileUrl,
    fileName: req.file.originalname,
    savedName: req.file.filename,
    size: req.file.size
  });
});

// Danh sách video đã upload có sẵn trên máy
app.get('/api/videos', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const videoList = files
      .filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f))
      .map(f => {
        const fullPath = path.join(UPLOADS_DIR, f);
        const stat = fs.statSync(fullPath);
        return {
          name: f,
          url: `/uploads/videos/${f}`,
          size: stat.size,
          mtime: stat.mtime
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ success: true, videos: videoList });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Xóa file video khỏi kho lưu trữ
app.delete('/api/videos/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy file' });
  }

  try {
    fs.unlinkSync(filePath);
    addLog('info', `Đã xóa video: ${filename}`);
    io.emit('media_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Đổi tên file video trong kho lưu trữ
app.post('/api/videos/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) {
    return res.status(400).json({ success: false, error: 'Thiếu tên cũ hoặc mới' });
  }

  const safeOld = path.basename(oldName);
  const ext = path.extname(safeOld);
  const safeBaseNew = path.basename(newName, path.extname(newName)).replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]/g, '_');
  const safeNew = `${safeBaseNew}${ext}`;

  const oldPath = path.join(UPLOADS_DIR, safeOld);
  const newPath = path.join(UPLOADS_DIR, safeNew);

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy file cũ' });
  }

  try {
    fs.renameSync(oldPath, newPath);
    // Cập nhật đường dẫn trong rules nếu có
    const oldUrl = `/uploads/videos/${safeOld}`;
    const newUrl = `/uploads/videos/${safeNew}`;
    let rulesChanged = false;

    activeRules.forEach(rule => {
      if (rule.videoPool) {
        rule.videoPool.forEach(v => {
          if (v.file === oldUrl) {
            v.file = newUrl;
            rulesChanged = true;
          }
        });
      }
    });

    if (rulesChanged) {
      saveRules(activeRules);
      io.emit('rules_updated', activeRules);
    }

    addLog('info', `Đổi tên video: "${safeOld}" ➔ "${safeNew}"`);
    io.emit('media_updated');
    res.json({ success: true, newName: safeNew, newUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Giả lập tặng quà (Live Test Simulator)
app.post('/api/simulate', (req, res) => {
  const { sender, giftName, diamondCount, repeatCount, giftId, iconUrl } = req.body;
  if (!giftName) return res.status(400).json({ success: false, error: 'Thiếu tên quà' });

  handleGift({
    sender: sender || 'Tester_Pro',
    nickname: sender || 'Người Xem Test',
    giftName: giftName || 'Bánh Vòng',
    giftId: giftId ? String(giftId) : '',
    iconUrl: iconUrl || '',
    diamondCount: Number(diamondCount) || 30,
    repeatCount: Number(repeatCount) || 1,
    avatar: 'https://p16-sign-va.tiktokcdn.com/tos-maliva-avt-0068/7310892257913307142~c5_100x100.jpeg'
  });

  res.json({ success: true });
});

// Lấy lịch sử log gần đây
app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs: recentLogs });
});

// Cài đặt kết nối TikTok (EulerStream API Key / Session ID / Username / AutoConnect)
app.get('/api/tiktok/settings', (req, res) => {
  res.json({ success: true, settings: loadTikTokSettings() });
});

app.post('/api/tiktok/settings', (req, res) => {
  const current = loadTikTokSettings();
  const updated = {
    username: typeof req.body?.username === 'string' ? req.body.username.replace(/^@/, '').trim() : (current.username || ''),
    autoConnect: req.body?.autoConnect !== undefined ? Boolean(req.body.autoConnect) : (current.autoConnect !== false),
    signApiKey: typeof req.body?.signApiKey === 'string' ? req.body.signApiKey.trim() : (current.signApiKey || ''),
    signApiUrl: typeof req.body?.signApiUrl === 'string' ? req.body.signApiUrl.trim() : (current.signApiUrl || ''),
    sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : (current.sessionId || '')
  };
  saveTikTokSettings(updated);
  res.json({ success: true, settings: updated });
});

let isCheckingLiveStatus = false;

// Hàm kiểm tra và tự động kết nối khi Idol bật Live
async function checkAndAutoConnectTikTok() {
  if (isCheckingLiveStatus) return;
  const settings = loadTikTokSettings();
  const user = (settings.username || '').replace(/^@/, '').trim();
  if (!user || settings.autoConnect === false) return;

  // Nếu đang kết nối phòng live rồi thì không làm gì
  if (activeTiktokConn && currentLiveStatus.isConnected) return;

  isCheckingLiveStatus = true;
  try {
    const signApiKey = (settings.signApiKey || process.env.SIGN_API_KEY || '').trim();
    const signApiUrl = (settings.signApiUrl || process.env.SIGN_API_URL || '').trim();
    const sessionId = (settings.sessionId || process.env.TIKTOK_SESSION_ID || '').trim();

    try {
      const host = signApiUrl ? new URL(signApiUrl).host : 'api.eulerstream.com';
      process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = host;
    } catch (_) {
      process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = 'api.eulerstream.com';
    }

    if (signApiUrl) {
      SignConfig.basePath = signApiUrl;
      SignConfig.cachedInstance = undefined;
    }
    if (signApiKey) {
      SignConfig.apiKey = signApiKey;
      SignConfig.cachedInstance = undefined;
    }

    const connOptions = {
      processInitialData: true,
      enableExtendedGiftInfo: false
    };
    if (signApiKey) connOptions.signApiKey = signApiKey;
    if (sessionId) {
      connOptions.session = { cookie: `sessionid=${sessionId};` };
      connOptions.authenticateWs = true;
    }

    const probeConn = new TikTokLiveConnection(user, connOptions);
    const isLive = await probeConn.fetchIsLive().catch(() => null);

    if (isLive === true) {
      addLog('info', `🎯 Phát hiện kênh @${user} ĐANG BẬT LIVE! Đang tự động kết nối...`);
      await performConnectTikTok(user, { signApiKey, signApiUrl, sessionId });
    } else {
      if (!currentLiveStatus.isConnected && !currentLiveStatus.isConnecting) {
        if (!currentLiveStatus.isWaitingLive || currentLiveStatus.username !== user) {
          currentLiveStatus = {
            isConnected: false,
            isConnecting: false,
            isWaitingLive: true,
            username: user,
            roomId: '',
            viewerCount: 0,
            error: null
          };
          io.emit('tiktok_status', currentLiveStatus);
        }
      }
    }
  } catch (err) {
    // Lỗi kiểm tra live nhẹ nhàng không ném ra ngoài
  } finally {
    isCheckingLiveStatus = false;
  }
}

// Hàm thực thi kết nối TikTok Live
async function performConnectTikTok(cleanUser, options = {}) {
  const settings = loadTikTokSettings();
  const signApiKey = (options.signApiKey || settings.signApiKey || process.env.SIGN_API_KEY || '').trim();
  const signApiUrl = (options.signApiUrl || settings.signApiUrl || process.env.SIGN_API_URL || '').trim();
  const sessionId = (options.sessionId || settings.sessionId || process.env.TIKTOK_SESSION_ID || '').trim();

  if (activeTiktokConn) {
    try { activeTiktokConn.disconnect(); } catch (_) {}
    activeTiktokConn = null;
  }

  currentLiveStatus = {
    isConnected: false,
    isConnecting: true,
    isWaitingLive: false,
    username: cleanUser,
    roomId: '',
    viewerCount: 0,
    error: null
  };
  io.emit('tiktok_status', currentLiveStatus);

  try {
    const host = signApiUrl ? new URL(signApiUrl).host : 'api.eulerstream.com';
    process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = host;
  } catch (_) {
    process.env.WHITELIST_AUTHENTICATED_SESSION_ID_HOST = 'api.eulerstream.com';
  }

  if (signApiUrl) {
    SignConfig.basePath = signApiUrl;
    SignConfig.cachedInstance = undefined;
  }
  if (signApiKey) {
    SignConfig.apiKey = signApiKey;
    SignConfig.cachedInstance = undefined;
  }

  const connOptions = {
    processInitialData: true,
    enableExtendedGiftInfo: false
  };
  if (signApiKey) connOptions.signApiKey = signApiKey;
  if (sessionId) {
    connOptions.session = { cookie: `sessionid=${sessionId};` };
    connOptions.authenticateWs = true;
  }

  const conn = new TikTokLiveConnection(cleanUser, connOptions);

  conn.on('connected', (state) => {
    currentLiveStatus = {
      isConnected: true,
      isConnecting: false,
      isWaitingLive: false,
      username: cleanUser,
      roomId: state?.roomId || '',
      viewerCount: 0,
      error: null
    };
    addLog('info', `✅ Đã kết nối phòng Live @${cleanUser} (Room ID: ${state?.roomId})`);
    io.emit('tiktok_status', currentLiveStatus);
  });

  conn.on('disconnected', () => {
    activeTiktokConn = null;
    const cfg = loadTikTokSettings();
    if (cfg.autoConnect !== false && cfg.username) {
      currentLiveStatus = {
        isConnected: false,
        isConnecting: false,
        isWaitingLive: true,
        username: cleanUser,
        roomId: '',
        viewerCount: 0,
        error: null
      };
      addLog('info', `Mất kết nối với phòng Live @${cleanUser}. Đang tiếp tục tự động lắng nghe...`);
    } else {
      currentLiveStatus = { ...currentLiveStatus, isConnected: false, isConnecting: false, isWaitingLive: false };
      addLog('info', `Mất kết nối với phòng Live @${cleanUser}`);
    }
    io.emit('tiktok_status', currentLiveStatus);
  });

  conn.on('streamEnd', () => {
    try { conn.disconnect(); } catch (_) {}
    activeTiktokConn = null;
    const cfg = loadTikTokSettings();
    if (cfg.autoConnect !== false && cfg.username) {
      currentLiveStatus = {
        isConnected: false,
        isConnecting: false,
        isWaitingLive: true,
        username: cleanUser,
        roomId: '',
        viewerCount: 0,
        error: null
      };
      addLog('info', `Phiên Live @${cleanUser} đã kết thúc. Hệ thống đang tiếp tục lắng nghe phiên Live kế tiếp...`);
    } else {
      currentLiveStatus = { ...currentLiveStatus, isConnected: false, isConnecting: false, isWaitingLive: false, error: 'Phiên Live đã kết thúc' };
      addLog('info', `Phiên Live @${cleanUser} đã kết thúc`);
    }
    io.emit('tiktok_status', currentLiveStatus);
  });

  conn.on('roomUser', (data) => {
    if (typeof data?.viewerCount === 'number') {
      currentLiveStatus.viewerCount = data.viewerCount;
      io.emit('tiktok_status', currentLiveStatus);
    }
  });

  // Bắt sự kiện Quà tặng từ TikTok Live thật
  conn.on('gift', data => {
    try {
      handleLiveGift(data);
    } catch (err) {
      console.error('Lỗi xử lý sự kiện quà tặng:', err);
    }
  });

  activeTiktokConn = conn;

  const isLive = await conn.fetchIsLive().catch(() => null);
  if (isLive === false) {
    // Kênh chưa live -> chuyển sang chế độ LẮNG NGHE TỰ ĐỘNG
    currentLiveStatus = {
      isConnected: false,
      isConnecting: false,
      isWaitingLive: true,
      username: cleanUser,
      roomId: '',
      viewerCount: 0,
      error: null
    };
    io.emit('tiktok_status', currentLiveStatus);
    addLog('info', `📡 Kênh @${cleanUser} hiện chưa phát Live. Hệ thống đang chế độ lắng nghe, sẽ TỰ ĐỘNG KẾT NỐI ngay khi Idol bấm Live!`);
    return { success: true, isWaitingLive: true };
  }

  const state = await Promise.race([
    conn.connect(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Quá 25s không kết nối được phòng live. Vui lòng kiểm tra kênh đã phát live chưa.')), 25000))
  ]);

  return { success: true, roomId: state?.roomId };
}

// Kết nối TikTok Live
app.post('/api/tiktok/connect', async (req, res) => {
  const cleanUser = String(req.body?.username || '').replace(/^@/, '').trim();
  if (!cleanUser) {
    return res.status(400).json({ success: false, error: 'Chưa nhập TikTok ID' });
  }

  // Tự động lưu TikTok ID và bật AutoConnect
  saveTikTokSettings({ username: cleanUser, autoConnect: true });

  try {
    const result = await performConnectTikTok(cleanUser, req.body);
    res.json(result);
  } catch (err) {
    let rawMsg = err.message || String(err);
    let msg = rawMsg;
    if (
      rawMsg.includes("illegal web id") ||
      rawMsg.includes("webcast URL") ||
      rawMsg.includes("fetchSignedWebSocketFromEulerRoute") ||
      rawMsg.includes("Failed to retrieve Room ID") ||
      rawMsg.includes("Failed to retrieve live status") ||
      rawMsg.includes("UserOfflineError") ||
      rawMsg.includes("isn't online") ||
      rawMsg.includes("not online") ||
      rawMsg.includes("offline")
    ) {
      // Kênh chưa live -> chuyển sang chế độ tự động lắng nghe
      currentLiveStatus = {
        isConnected: false,
        isConnecting: false,
        isWaitingLive: true,
        username: cleanUser,
        roomId: '',
        viewerCount: 0,
        error: null
      };
      io.emit('tiktok_status', currentLiveStatus);
      addLog('info', `📡 Kênh @${cleanUser} hiện chưa phát Live. Hệ thống đang tự động lắng nghe, sẽ KẾT NỐI NGAY khi Idol phát Live!`);
      return res.json({ success: true, isWaitingLive: true, message: `Đang tự động lắng nghe kênh @${cleanUser}` });
    } else if (rawMsg.includes("requires a Business plan") || rawMsg.includes("Failed to sign a request")) {
      msg = `EulerStream báo lỗi: Cần API Key hoặc gói Business để ký Webcast TikTok. Vui lòng mở "Cài đặt kết nối nâng cao" bên dưới để nhập Euler API Key hoặc Session ID, hoặc dùng tab "🎮 Bắn Test & Giả Lập" để trải nghiệm hiệu ứng ngay tức thì!`;
    }
    currentLiveStatus = { ...currentLiveStatus, isConnected: false, isConnecting: false, isWaitingLive: false, error: msg };
    io.emit('tiktok_status', currentLiveStatus);
    res.status(400).json({ success: false, error: msg });
  }
});

app.post('/api/tiktok/disconnect', (req, res) => {
  if (activeTiktokConn) {
    try { activeTiktokConn.disconnect(); } catch (_) {}
    activeTiktokConn = null;
  }
  // Tạm dừng tự động kết nối khi người dùng bấm ngắt chủ động
  saveTikTokSettings({ autoConnect: false });
  currentLiveStatus = { isConnected: false, isConnecting: false, isWaitingLive: false, username: '', roomId: '', viewerCount: 0, error: null };
  io.emit('tiktok_status', currentLiveStatus);
  res.json({ success: true });
});

function getSmartEmoji(name, coins) {
  const n = (name || '').toLowerCase();
  if (n.includes('hồng') || n.includes('rose')) return '🌹';
  if (n.includes('bánh vòng') || n.includes('donut')) return '🍩';
  if (n.includes('sư tử') || n.includes('lion')) return '🦁';
  if (n.includes('vũ trụ') || n.includes('universe')) return '🌌';
  if (n.includes('tên lửa') || n.includes('rocket')) return '🚀';
  if (n.includes('hành tinh') || n.includes('planet')) return '🪐';
  if (n.includes('xe') || n.includes('ô tô') || n.includes('thể thao')) return '🏎️';
  if (n.includes('mô tô') || n.includes('xe máy')) return '🏍️';
  if (n.includes('máy bay') || n.includes('chuyên cơ')) return '✈️';
  if (n.includes('thuyền') || n.includes('du thuyền') || n.includes('tàu')) return '🛥️';
  if (n.includes('vương miện') || n.includes('crown')) return '👑';
  if (n.includes('kim cương') || n.includes('diamond') || n.includes('nhẫn')) return '💍';
  if (n.includes('kính') || n.includes('glasses')) return '🕶️';
  if (n.includes('mũ') || n.includes('nón') || n.includes('cap')) return '🧢';
  if (n.includes('tim') || n.includes('heart') || n.includes('love')) return '💖';
  if (n.includes('kem') || n.includes('ice cream')) return '🍦';
  if (n.includes('trà sữa') || n.includes('boba')) return '🧋';
  if (n.includes('cà phê') || n.includes('coffee')) return '☕';
  if (n.includes('pháo hoa') || n.includes('firework')) return '🎆';
  if (n.includes('tiền') || n.includes('money')) return '💸';
  if (n.includes('gấu') || n.includes('bear') || n.includes('teddy')) return '🧸';
  if (n.includes('bánh')) return '🎂';
  if (n.includes('micro') || n.includes('mic')) return '🎤';
  if (n.includes('nhạc') || n.includes('album') || n.includes('nốt')) return '🎵';
  if (n.includes('rồng') || n.includes('dragon')) return '🐉';
  if (n.includes('ngựa')) return '🦄';
  if (n.includes('lâu đài') || n.includes('castle')) return '🏰';
  if (n.includes('hoa')) return '🌸';
  if (coins === 1) return '🌹';
  if (coins <= 9) return '🫰';
  if (coins <= 29) return '💖';
  if (coins <= 98) return '👑';
  if (coins <= 198) return '🕶️';
  if (coins <= 499) return '🥊';
  if (coins <= 999) return '💸';
  if (coins <= 4999) return '🚀';
  return '🦁';
}

// Hàm tự động fetch danh mục quà tặng TikTok Việt Nam chính thức từ TikTok Webcast API
async function refreshOfficialTikTokVnGifts() {
  const url = 'https://webcast.tiktok.com/webcast/gift/list/?aid=1988&app_language=vi-VN&webcast_language=vi-VN&device_platform=web_pc&region=VN';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const data = await res.json();
    const rawGifts = data.data?.gifts || [];
    if (!Array.isArray(rawGifts) || rawGifts.length === 0) {
      return liveGiftsCache;
    }

    const seenIds = new Set();
    const processed = [];

    for (const g of rawGifts) {
      const id = String(g.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const name = (g.name || '').trim();
      if (!name) continue;

      const coins = Number(g.diamond_count || 1);
      const iconUrl = g.image?.url_list?.[0] || g.icon?.url_list?.[0] || '';

      let category = 'popular';
      if (coins === 1) category = '1';
      else if (coins <= 9) category = 'low';
      else if (coins <= 29) category = 'medium';
      else if (coins <= 98) category = 'popular';
      else if (coins <= 198) category = 'high';
      else if (coins <= 499) category = 'vip';
      else if (coins <= 999) category = 'super';
      else if (coins <= 4999) category = 'mega';
      else category = 'ultra';

      const emoji = getSmartEmoji(name, coins);

      processed.push({
        id,
        name,
        coins,
        icon: emoji,
        iconUrl,
        category
      });
    }

    processed.sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name, 'vi'));
    liveGiftsCache = processed;

    try {
      fs.writeFileSync(GIFTS_CACHE_FILE, JSON.stringify(liveGiftsCache, null, 2), 'utf-8');
      const giftsDataJs = path.join(__dirname, 'public', 'gifts-data.js');
      const jsContent = `// Danh mục đầy đủ quà tặng TikTok Live Việt Nam chính thức từ TikTok Webcast API kèm icon ảnh TikTok CDN\nconst TIKTOK_GIFTS_CATALOG = ${JSON.stringify(liveGiftsCache, null, 2)};\n`;
      fs.writeFileSync(giftsDataJs, jsContent, 'utf-8');
    } catch (_) {}

    console.log(`🎁 [TIKTOK] Đã cập nhật thành công ${liveGiftsCache.length} món quà kèm icon ảnh từ TikTok Webcast API!`);
    io.emit('gifts_updated', liveGiftsCache);
    return liveGiftsCache;
  } catch (err) {
    console.warn('Lỗi tải danh mục quà từ TikTok API:', err.message);
    return liveGiftsCache;
  }
}

app.post('/api/tiktok/refresh-gifts', async (req, res) => {
  const gifts = await refreshOfficialTikTokVnGifts();
  res.json({ success: true, count: gifts.length, gifts });
});

app.get('/api/tiktok/gifts', async (req, res) => {
  if (liveGiftsCache.length > 0) {
    return res.json({ success: true, count: liveGiftsCache.length, gifts: liveGiftsCache });
  }
  const gifts = await refreshOfficialTikTokVnGifts();
  res.json({ success: true, count: gifts.length, gifts });
});

app.get('/api/tiktok/status', (req, res) => res.json(currentLiveStatus));

// ==========================================
// API QUẢN LÝ HŨ QUÀ RƠI VẬT LÝ (PHYSICS JAR)
// ==========================================

// 1. Lấy cấu hình hũ
app.get('/api/jar/config', (req, res) => {
  res.json({ success: true, config: jarConfig, actions: [...JAR_ACTIONS], supportsJarLayers: true });
});

function discardJarUploads(files) {
  for (const file of Object.values(files).flat()) {
    try { fs.rmSync(file.path, { force: true }); } catch (error) {
      console.warn('Không dọn được ảnh hũ tải tạm:', error.message);
    }
  }
}

function receiveJarArtwork(receive) {
  return (req, res, next) => receive(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'Ảnh hũ vượt quá dung lượng cho phép.' : error.message;
    res.status(400).json({ success: false, error: message });
  });
}

async function getJarArtworkSize(file) {
  try {
    const { stderr } = await executeFFmpeg(ffmpegPath, [
      '-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'
    ], { windowsHide: true });
    const size = stderr.match(/Stream [^\r\n]*?Video: (?:png|webp)\b[^\r\n]*?\b(\d+)x(\d+)\b/);
    if (size) return size[1] + ' × ' + size[2];
  } catch (_) {}
  throw new Error('Không đọc được ảnh PNG hoặc WebP của hũ.');
}

async function validateJarArtworkPair(rearPath, frontPath) {
  const [rear, front] = await Promise.all([
    rearPath && getJarArtworkSize(rearPath),
    frontPath && getJarArtworkSize(frontPath)
  ]);
  if (front && rear && front !== rear) throw new Error('Mặt trước cần đúng ' + rear + ' px như mặt sau.');
}

function findStoredJarArtwork(url) {
  if (typeof url !== 'string') return;
  const file = path.posix.basename(url);
  if (BUILTIN_JAR_ART.has(file) && url === `/builtin/jar/${file}`) return path.join(BUILTIN_JAR_DIR, file);
  if (!/^\/uploads\/(decor|templates)\/[\w.-]+\.(png|webp)$/i.test(url)) return;
  const local = path.join(__dirname, 'public', url);
  if (url === `/uploads/decor/${file}` && BUILTIN_JAR_ART.has(file) && !fs.existsSync(local)) {
    return path.join(BUILTIN_JAR_DIR, file);
  }
  return local;
}

const receiveJarConfigLayers = receiveJarArtwork(decorUpload.fields([
  { name: 'jarRear', maxCount: 1 }, { name: 'jarFront', maxCount: 1 }
]));

app.post('/api/jar/config', (req, res, next) => {
  if (req.is('multipart/form-data')) return receiveJarConfigLayers(req, res, next);
  next();
}, async (req, res) => {
  const files = req.files || {};
  const rear = files.jarRear?.[0];
  const front = files.jarFront?.[0];
  let patch = req.body;
  try {
    if (req.files) patch = JSON.parse(req.body.config ?? 'null');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Cấu hình hũ không hợp lệ');
    if (Object.hasOwn(patch, 'flipSpeed') && (!Number.isFinite(patch.flipSpeed) || patch.flipSpeed < 0.5 || patch.flipSpeed > 2)) {
      throw new Error('Tốc độ lật hũ phải từ 0,5× đến 2,0×');
    }
    if (front || rear) {
      const rearPath = rear?.path || findStoredJarArtwork(patch.customJarImage ?? jarConfig.customJarImage);
      if (front && !rearPath) throw new Error('Hãy nhập ảnh mặt sau PNG hoặc WebP trước.');
      await validateJarArtworkPair(rearPath, front?.path);
      if (rear) patch.customJarImage = '/uploads/decor/' + rear.filename;
      if (front) patch.frontOverlayImage = '/uploads/decor/' + front.filename;
    }
  } catch (error) {
    discardJarUploads(files);
    return res.status(400).json({ success: false, error: error.message });
  }
  const nextConfig = { ...jarConfig, ...patch };
  if (!saveAndPublishJarConfig(nextConfig)) {
    discardJarUploads(files);
    return res.status(500).json({ success: false, error: 'Không lưu được cài đặt hũ' });
  }
  addLog('info', 'Đã lưu cài đặt Hũ Quà Rơi Vật Lý');
  res.json({ success: true, config: jarConfig });
});

app.post('/api/jar/gift-action', (req, res) => {
  const { giftKey, giftName, action } = req.body || {};
  if (!isGiftKey(giftKey) || (action !== '' && !JAR_GIFT_ACTIONS.has(action))) {
    return res.status(400).json({ success: false, error: 'Loại quà hoặc thao tác không hợp lệ' });
  }
  const giftActions = { ...jarConfig.giftActions };
  if (action === '') delete giftActions[giftKey];
  else {
    const name = typeof giftName === 'string' ? giftName.trim().slice(0, 160) : '';
    if (!name) return res.status(400).json({ success: false, error: 'Chọn loại quà trước khi lưu' });
    giftActions[giftKey] = { name, action };
  }
  if (!saveAndPublishJarConfig({ ...jarConfig, giftActions })) {
    return res.status(500).json({ success: false, error: 'Không lưu được thao tác theo quà' });
  }
  res.json({ success: true, config: jarConfig });
});

// 3. Kích hoạt hành động tương tác (Lắc, Nứt, Lật, Nổ, Dọn, Reset)
app.post('/api/jar/action', (req, res) => {
  const { action, intensity, giftKey } = req.body || {};
  if (!JAR_ACTIONS.has(action)) return res.status(400).json({ success: false, error: 'Thao tác hũ không hợp lệ' });
  if (!jarConfig.enabled) return res.status(409).json({ success: false, error: 'Bật hũ trước khi gửi thao tác' });
  if (action === 'remove_gift_type' && !isGiftKey(giftKey)) {
    return res.status(400).json({ success: false, error: 'Loại quà không hợp lệ' });
  }
  // Persistent session actions also affect OBS sources that are closed.
  let sessionEvent = {};
  if (action === 'clear') {
    jarSession.gifts.clear();
    jarSession.checkpoints.clear();
    sessionEvent = nextJarSessionEvent();
  } else if (action === 'remove_gift_type') {
    jarSession.gifts.delete(giftKey);
    for (const [view, positions] of jarSession.checkpoints) {
      jarSession.checkpoints.set(view, positions.filter(item => item[0] !== giftKey));
    }
    sessionEvent = nextJarSessionEvent();
  } else if (action === 'reset') {
    jarSession.coins = 0;
    sessionEvent = nextJarSessionEvent();
  }
  if (sessionEvent.sessionId) scheduleJarInventory();
  io.emit('jar_action', { ...sessionEvent, action, intensity: Math.max(0.1, Math.min(2, Number(intensity) || 1)), giftKey });
  addLog('info', `Kích hoạt hiệu ứng hũ: [${action.toUpperCase()}]`);
  res.json({ success: true, action });
});

function findJarGift(giftId, giftName) {
  if (!Array.isArray(liveGiftsCache)) return;
  return (giftId && liveGiftsCache.find(gift => String(gift.id) === String(giftId))) ||
    (giftName && liveGiftsCache.find(gift => matchGiftName(gift.name, giftName)));
}

function publishJarGift({ sender, avatar, ...gift }, runAction = true) {
  const count = Math.max(1, Math.trunc(Number(gift.count)) || 1);
  const unitCoins = Math.max(1, Math.trunc(Number(gift.diamondCount ?? gift.coins)) || 1);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(unitCoins)) return;
  const id = String(gift.giftId ?? '').trim().slice(0, 180);
  const name = String(gift.inventoryName || gift.giftName || 'Quà tặng').trim().slice(0, 160) || 'Quà tặng';
  const giftKey = id && id !== 'custom' ? 'id:' + id : 'name:' + name.normalize('NFC').toLocaleLowerCase('vi');
  const action = runAction ? jarConfig.giftActions?.[giftKey]?.action : undefined;
  if (action === 'clear') {
    jarSession.gifts.clear();
    jarSession.checkpoints.clear();
  } else if (action === 'reset') {
    jarSession.coins = 0;
  }
  const retained = {
    giftKey, inventoryName: name, giftName: gift.giftName || name, iconUrl: gift.iconUrl,
    diamondCount: unitCoins, count: (jarSession.gifts.get(giftKey)?.count || 0) + count
  };
  jarSession.gifts.set(giftKey, retained);
  jarSession.coins += count * unitCoins;
  io.emit('jar_drop_gift', {
    ...retained, count, autoShakeCoins: gift.autoShakeCoins,
    ...nextJarSessionEvent(), jarAction: JAR_GIFT_ACTIONS.has(action) ? action : undefined
  });
  scheduleJarInventory();
}

// 4. Bắn test quà rơi vào hũ
app.post('/api/jar/drop', (req, res) => {
  if (!jarConfig.enabled) return res.status(409).json({ success: false, error: 'Bật hũ trước khi thả thử' });
  const { giftId, giftName, coins, count, sender, avatar, iconUrl } = req.body || {};
  const resolvedId = giftId === 'custom' ? '' : giftId;
  const found = findJarGift(resolvedId, giftName);

  const dropData = {
    giftId: resolvedId || found?.id || 'custom',
    inventoryName: found?.name || giftName || 'Quà Test',
    giftName: giftName || 'Quà Test',
    coins: Math.max(1, Math.min(1_000_000, Math.trunc(Number(coins)) || 1)),
    count: Math.max(1, Math.min(50, Math.trunc(Number(count)) || 1)),
    sender: sender || 'Đại Gia Test',
    avatar: avatar || '',
    iconUrl: iconUrl || found?.iconUrl
  };

  publishJarGift(dropData);
  addLog('gift', `[TEST HŨ] Đã bắn ${dropData.count}x ${dropData.giftName} (${dropData.coins} xu) vào hũ`);
  res.json({ success: true, dropped: dropData });
});

// 5. Tải lên file ảnh Decor PNG/SVG xoá phông
app.post('/api/jar/upload-decor', decorUpload.single('decor'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file decor' });
  }
  const fileUrl = `/uploads/decor/${req.file.filename}`;
  if (typeof req.body.stickerName === 'string' && req.body.apply === 'false') {
    if (!uploadedStickerUrl.test(fileUrl)) {
      discardJarUploads({ sticker: [req.file] });
      return res.status(400).json({ success: false, error: 'Hãy chọn ảnh PNG, JPG, SVG hoặc WebP.' });
    }
    const name = req.body.stickerName.trim().slice(0, 255) || 'Sticker';
    try {
      saveJarStickers([{ name, url: fileUrl }, ...loadJarStickers()]);
    } catch (error) {
      discardJarUploads({ sticker: [req.file] });
      console.error('Lỗi lưu sticker:', error.message);
      return res.status(500).json({ success: false, error: 'Không lưu được sticker vào thư viện.' });
    }
  } else if (req.body.apply !== 'false') {
    const nextConfig = { ...jarConfig, decorImage: fileUrl };
    if (!saveJarConfig(nextConfig)) return res.status(500).json({ success: false, error: 'Không lưu được ảnh trang trí' });
    jarConfig = nextConfig;
    io.emit('jar_config_updated', jarConfig);
  }
  addLog('info', `Đã tải ảnh trang trí hũ: ${req.file.originalname}`);
  res.json({ success: true, fileUrl, fileName: req.file.originalname });
});

app.get('/api/jar/stickers', (req, res) => {
  try {
    const stickers = loadJarStickers().filter(({ url }) => uploadedStickerUrl.test(url) &&
      fs.existsSync(path.join(DECOR_DIR, path.basename(url))));
    res.json({ success: true, stickers });
  } catch (error) {
    console.error('Lỗi nạp sticker đã lưu:', error.message);
    res.status(500).json({ success: false, error: 'Không tải được sticker đã lưu.' });
  }
});

// 6. Danh sách các file Decor có sẵn
app.get('/api/jar/decor-list', (req, res) => {
  try {
    const files = fs.readdirSync(DECOR_DIR)
      .filter(f => /_\d{10,}\.(png|svg|webp|jpg|jpeg)$/i.test(f))
      .map(f => ({
        name: f,
        url: `/uploads/decor/${f}`
      }));
    res.json({ success: true, decors: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Tải lên ảnh Mẫu Hũ Tùy Chỉnh (Custom Jar Skin Image từ ảnh do user gửi hoặc upload)
// --- API QUẢN LÝ THƯ VIỆN MẪU HŨ (JAR TEMPLATES) ---
// 1. Lấy danh sách mẫu hũ đã lưu
app.get('/api/jar/templates', (req, res) => {
  const templates = loadJarTemplates().map(template => ({
    ...template,
    isActive: template.imageUrl === jarConfig.customJarImage && getJarTemplateFront(template) === (jarConfig.frontOverlayImage || '')
  }));
  res.json({ success: true, templates });
});

function getJarTemplateFront(template) {
  return template.frontImageUrl || template.stateData?.design?.frontOverlayImage || '';
}

function jarConfigForTemplate(template) {
  const design = template.stateData?.design;
  const fields = ['hitbox', 'hideDefaultJarOnCustom', 'shimmerRimEffect', 'shimmerRimSpeed', 'shimmerSparkles', 'clipGiftsToJar', 'glassRealism', 'stickers', 'decorImage', 'decorText'];
  const settings = design && typeof design === 'object'
    ? Object.fromEntries(fields.filter(field => Object.hasOwn(design, field)).map(field => [field, design[field]]))
    : {};
  return {
    ...jarConfig, style: 'custom_image', customJarImage: template.imageUrl, frontOverlayImage: getJarTemplateFront(template),
    jarAspect: template.aspect || 'vertical', jarPadding: template.padding || { top: 0, bottom: 0, left: 0, right: 0 },
    hideDefaultJarOnCustom: true, ...settings
  };
}

// 2. Lưu mẫu hũ mới vào thư viện
const receiveJarTemplateLayers = receiveJarArtwork(templateUpload.fields([
  { name: 'templateImage', maxCount: 1 }, { name: 'frontImage', maxCount: 1 }
]));

app.post('/api/jar/save-template', receiveJarTemplateLayers, async (req, res) => {
  const files = req.files || {};
  const rear = files.templateImage?.[0];
  const front = files.frontImage?.[0];
  try {
    if (!rear) throw new Error('Hãy nhập ảnh mặt sau của hũ.');
    await validateJarArtworkPair(rear.path, front?.path);
  } catch (error) {
    discardJarUploads(files);
    return res.status(400).json({ success: false, error: error.message });
  }
  let committed = false;
  try {
    const fileUrl = '/uploads/templates/' + rear.filename;
    const frontImageUrl = front ? '/uploads/templates/' + front.filename : '';
    const tmpls = loadJarTemplates();

    const id = path.parse(rear.filename).name;
    const name = String(req.body.name || '').trim().slice(0, 80) || 'Mẫu hũ';
    const aspect = ['square', 'horizontal', 'vertical'].includes(req.body.aspect) ? req.body.aspect : 'vertical';
    const canvasWidth = Number(req.body.canvasWidth) || 500;
    const canvasHeight = Number(req.body.canvasHeight) || 640;
    let padding = { top: 0, bottom: 0, left: 0, right: 0 };
    try {
      if (req.body.padding) padding = JSON.parse(req.body.padding);
    } catch (_) {}

    let stateData = {};
    try {
      if (req.body.stateData) stateData = JSON.parse(req.body.stateData);
    } catch (_) {}

    const applyNow = req.body.applyNow === 'true' || req.body.applyNow === true;

    const newTemplate = {
      id,
      name,
      aspect,
      canvasWidth,
      canvasHeight,
      padding,
      imageUrl: fileUrl,
      previewUrl: fileUrl,
      frontImageUrl,
      isActive: applyNow,
      createdAt: new Date().toISOString(),
      stateData
    };

    tmpls.unshift(newTemplate);
    if (!saveJarTemplates(tmpls)) {
      discardJarUploads(files);
      return res.status(500).json({ success: false, error: 'Không ghi được thư viện mẫu hũ' });
    }
    committed = true;

    if (applyNow) {
      if (!saveAndPublishJarConfig(jarConfigForTemplate(newTemplate))) {
        return res.status(500).json({ success: false, error: 'Mẫu đã lưu vào thư viện. Studio chưa áp dụng được lên OBS.' });
      }
      addLog('info', `Đã lưu & áp dụng mẫu hũ mới: "${name}" (${aspect})`);
    } else {
      addLog('info', `Đã lưu mẫu hũ vào thư viện: "${name}"`);
    }

    res.json({ success: true, template: newTemplate });
  } catch (err) {
    if (!committed) discardJarUploads(files);
    console.error('Lỗi lưu template:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Xoá mẫu hũ khỏi thư viện
app.delete('/api/jar/template/:id', (req, res) => {
  const { id } = req.params;
  let tmpls = loadJarTemplates();
  const target = tmpls.find(t => t.id === id);
  if (!target) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy mẫu hũ' });
  }

  if (jarConfig.customJarImage === target.imageUrl) {
    const fallback = { ...jarConfig, ...FISHBOWL_SKIN, hitbox: { shape: 'sphere' } };
    if (!saveJarConfig(fallback)) return res.status(500).json({ success: false, error: 'Không thể chuyển về mẫu hũ mặc định' });
    jarConfig = fallback;
    io.emit('jar_config_updated', jarConfig);
  }

  tmpls = tmpls.filter(t => t.id !== id);
  if (!saveJarTemplates(tmpls)) return res.status(500).json({ success: false, error: 'Không ghi được thư viện mẫu hũ' });
  const referenced = new Set([
    jarConfig.customJarImage,
    jarConfig.frontOverlayImage,
    ...tmpls.flatMap(template => [template.imageUrl, getJarTemplateFront(template)])
  ]);
  for (const url of new Set([target.imageUrl, target.frontImageUrl])) {
    if (!url?.startsWith('/uploads/templates/') || referenced.has(url)) continue;
    const file = findStoredJarArtwork(url);
    if (file) discardJarUploads({ deleted: [{ path: file }] });
  }

  addLog('info', `Đã xoá mẫu hũ khỏi thư viện: "${target.name}"`);
  res.json({ success: true, id });
});

// 4. Kích hoạt mẫu hũ lên OBS
app.post('/api/jar/apply-template/:id', (req, res) => {
  const { id } = req.params;
  const tmpls = loadJarTemplates();
  const target = tmpls.find(t => t.id === id);
  if (!target) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy mẫu hũ' });
  }

  if (!saveAndPublishJarConfig(jarConfigForTemplate(target))) {
    return res.status(500).json({ success: false, error: 'Không áp dụng được mẫu hũ' });
  }

  addLog('info', `Đã áp dụng mẫu hũ "${target.name}" (${target.aspect}) lên OBS`);
  res.json({ success: true, config: jarConfig, template: { ...target, isActive: true } });
});


app.post('/api/jar/upload-jar-skin', decorUpload.single('jarSkin'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file ảnh hũ' });
  }
  const fileUrl = `/uploads/decor/${req.file.filename}`;
  if (req.body.apply !== 'false') {
    const nextConfig = {
      ...jarConfig, style: 'custom_image', customJarImage: fileUrl,
      frontOverlayImage: '', hideDefaultJarOnCustom: true
    };
    if (!saveJarConfig(nextConfig)) return res.status(500).json({ success: false, error: 'Không lưu được mẫu hũ' });
    jarConfig = nextConfig;
    io.emit('jar_config_updated', jarConfig);
  }
  addLog('info', `Đã tải ảnh mẫu hũ: ${req.file.originalname}`);
  res.json({ success: true, fileUrl, fileName: req.file.originalname });
});

// ========================================================
// CÁC HÀM XỬ LÝ NÂNG CẤP VÀ BẢO VỆ DỮ LIỆU STREAMER
// ========================================================
const GITHUB_HEADERS = { 'User-Agent': 'EldenEffect-Studio-Updater' };

function updateError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function getLatestStudioRelease(repo) {
  if (typeof repo !== 'string' || !/^[\w-]+\/[\w.-]+$/.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw updateError(400, 'Nhập GitHub Repo theo định dạng username/repository.');
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { ...GITHUB_HEADERS, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 404) throw updateError(404, `Repo ${repo} chưa có bản phát hành công khai.`);
  if (!response.ok) throw updateError(502, `Không đọc được bản phát hành từ GitHub (HTTP ${response.status}).`);

  const release = await response.json();
  const version = parseVersion(release.tag_name);
  if (!version) throw updateError(422, 'Bản phát hành GitHub cần có tag dạng v1.0.1.');
  const expectedUrl = `https://github.com/${repo}/releases/download/${release.tag_name}/${UPDATE_ASSET_NAME}`;
  const asset = release.assets?.find(file => file.name === UPDATE_ASSET_NAME &&
    file.browser_download_url?.toLowerCase() === expectedUrl.toLowerCase());
  return { release, version, asset };
}

async function downloadStudioRelease(asset, zip) {
  if (asset.size > UPDATE_SIZE_LIMIT) throw updateError(413, 'Gói cập nhật vượt quá 50 MB.');
  const response = await fetch(asset.browser_download_url, {
    headers: GITHUB_HEADERS,
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok || !response.body) throw updateError(502, `Không tải được gói cập nhật (HTTP ${response.status}).`);

  const fd = fs.openSync(zip, 'wx');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > UPDATE_SIZE_LIMIT) throw updateError(413, 'Gói cập nhật vượt quá 50 MB.');
      hash.update(chunk);
      fs.writeFileSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = `sha256:${hash.digest('hex')}`;
  if (!size || (typeof asset.size === 'number' && asset.size !== size) || (asset.digest && asset.digest !== digest)) {
    throw updateError(422, 'Gói tải về không khớp với bản phát hành GitHub. Hãy thử lại.');
  }
}

async function applyStudioUpdate(res, getPackage, uploadedZip) {
  if (updateInProgress || restartingStudio) {
    if (uploadedZip) removeUpdateWork(uploadedZip);
    return res.status(409).json({ success: false, error: 'Studio đang cập nhật hoặc khởi động lại.' });
  }

  updateInProgress = true;
  let work;
  try {
    recoverStudioUpdate(__dirname, TEMP_UPDATE_DIR);
    work = fs.mkdtempSync(path.join(TEMP_UPDATE_DIR, 'update-'));
    const current = installedStudioVersion(__dirname, loadUpdateConfig().version);
    const pkg = await getPackage(work, current);
    const result = installStudioUpdate({ ...pkg, current, work, appDir: __dirname, tempDir: TEMP_UPDATE_DIR });
    const message = `Đã cập nhật ${result.updatedFiles.length} tệp ứng dụng. Dữ liệu trên máy được giữ nguyên.`;
    addLog('info', message);
    return res.json({ success: true, message, ...result });
  } catch (error) {
    console.error('Lỗi cập nhật Studio:', error.message);
    return res.status(error.status || 500).json({ success: false, error: error.message });
  } finally {
    if (work) removeUpdateWork(work);
    if (uploadedZip) removeUpdateWork(uploadedZip);
    updateInProgress = false;
  }
}

app.get('/api/app/version', (req, res) => {
  const cfg = loadUpdateConfig();
  res.json({
    success: true,
    instanceId: jarSession.id,
    version: installedStudioVersion(__dirname, cfg.version),
    githubRepo: cfg.githubRepo || '',
    autoCheckOnStartup: cfg.autoCheckOnStartup !== false,
    lastCheckTime: lastGitHubCheckTime ?? cfg.lastCheckTime ?? null
  });
});

app.post('/api/app/config', (req, res) => {
  const cfg = loadUpdateConfig();
  if (typeof req.body?.githubRepo === 'string') cfg.githubRepo = req.body.githubRepo.trim();
  if (typeof req.body?.autoCheckOnStartup === 'boolean') cfg.autoCheckOnStartup = req.body.autoCheckOnStartup;
  try {
    writeUpdateConfig(UPDATE_CONFIG_FILE, cfg);
    res.json({ success: true, config: cfg });
  } catch (error) {
    console.error('Lỗi lưu cấu hình cập nhật:', error.message);
    res.status(500).json({ success: false, error: 'Không lưu được cấu hình cập nhật trên máy này.' });
  }
});

app.post('/api/app/check-github', async (req, res) => {
  const cfg = loadUpdateConfig();
  const repo = req.body?.githubRepo ?? cfg.githubRepo;
  try {
    const { release, version, asset } = await getLatestStudioRelease(typeof repo === 'string' ? repo.trim() : repo);
    const currentVersion = installedStudioVersion(__dirname, cfg.version);
    const hasUpdate = isNewerVersion(version, currentVersion);
    if (hasUpdate && !asset) throw updateError(422, `Bản phát hành chưa đính kèm gói ${UPDATE_ASSET_NAME}.`);
    lastGitHubCheckTime = new Date().toISOString();
    res.json({
      success: true,
      currentVersion,
      latestVersion: version,
      hasUpdate,
      releaseName: release.name || release.tag_name,
      releaseNotes: release.body || '',
      downloadUrl: asset?.browser_download_url,
      publishedAt: release.published_at
    });
  } catch (error) {
    res.status(error.status || 502).json({ success: false, error: error.message });
  }
});

app.post('/api/app/apply-patch', (req, res) => {
  patchUpload(req, res, error => {
    if (error) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'Gói cập nhật vượt quá 50 MB.' : 'Không tải được gói ZIP lên Studio.';
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: message });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Chưa chọn file cập nhật .zip.' });
    return applyStudioUpdate(res, () => ({ zip: req.file.path }), req.file.path);
  });
});

app.post('/api/app/apply-github', (req, res) => applyStudioUpdate(res, async (work, current) => {
  const repo = req.body?.githubRepo ?? loadUpdateConfig().githubRepo;
  const { version, asset } = await getLatestStudioRelease(typeof repo === 'string' ? repo.trim() : repo);
  if (!asset || req.body?.downloadUrl !== asset.browser_download_url || parseVersion(req.body?.newVersion) !== version) {
    throw updateError(409, 'Thông tin bản phát hành đã thay đổi. Hãy kiểm tra GitHub lại.');
  }
  if (!isNewerVersion(version, current)) throw updateError(409, 'Studio đã cài phiên bản này hoặc mới hơn.');

  const zip = path.join(work, UPDATE_ASSET_NAME);
  await downloadStudioRelease(asset, zip);
  return { zip, onlineVersion: version };
}));

// Khởi động lại Server
app.post('/api/app/restart', (req, res) => {
  if (updateInProgress || restartingStudio) {
    return res.status(409).json({ success: false, error: 'Studio đang cập nhật hoặc khởi động lại.' });
  }
  restartingStudio = true;
  addLog('info', '🔄 Đang khởi động lại máy chủ LiveEffect Studio...');
  res.json({ success: true, instanceId: jarSession.id, message: 'Studio đang khởi động lại.' });

  setTimeout(() => {
    io.disconnectSockets(true);
    httpServer.close(() => {
      const nodeBin = fs.existsSync(path.join(__dirname, 'runtime', 'node.exe'))
        ? path.join(__dirname, 'runtime', 'node.exe')
        : process.execPath;

      const child = spawn(nodeBin, ['server.js'], {
        cwd: __dirname,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('spawn', () => {
        child.unref();
        process.exit(0);
      });
      child.once('error', error => {
        console.error('Lỗi khởi động lại Studio:', error);
        restartingStudio = false;
        httpServer.listen(PORT);
      });
    });
    httpServer.closeAllConnections?.();
  }, 800);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n====================================================`);
    console.log(`⚠️  Cổng ${PORT} đã đang được chạy bởi một phiên LiveEffect Studio khác!`);
    console.log(`👉 Đang tự động mở trang Quản trị trên trình duyệt...`);
    console.log(`====================================================\n`);
    try {
      if (process.platform === 'win32') {
        execSync(`cmd /c start http://localhost:${PORT}/admin.html`);
      }
    } catch (_) {}
  } else {
    console.error('Lỗi máy chủ:', err);
  }
});

// Khởi chạy server
httpServer.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 LiveEffect Studio Server running on: http://localhost:${PORT}`);
  console.log(`👉 Trang Quản Trị (Admin Dashboard): http://localhost:${PORT}/admin.html`);
  console.log(`👉 Link nhúng OBS Video Effects: http://localhost:${PORT}/overlay.html`);
  console.log(`👉 Link nhúng OBS Hũ Quà Vật Lý (Jar): http://localhost:${PORT}/jar.html`);
  console.log(`====================================================`);

  const savedSettings = loadTikTokSettings();
  if (savedSettings.username && savedSettings.autoConnect !== false) {
    currentLiveStatus.username = savedSettings.username;
    currentLiveStatus.isWaitingLive = true;
    console.log(`📡 [AUTO-LISTEN] Đang lắng nghe kênh @${savedSettings.username}... Hệ thống sẽ tự động kết nối ngay khi Idol phát Live.`);
    addLog('info', `📡 Đang tự động lắng nghe kênh @${savedSettings.username}... Hệ thống sẽ tự động kết nối ngay khi Idol phát Live.`);
    setTimeout(checkAndAutoConnectTikTok, 2500);
  }
  // Định kỳ mỗi 10 giây kiểm tra xem Idol đã bật live chưa nếu đang ở chế độ autoConnect
  setInterval(checkAndAutoConnectTikTok, 10000);

  if (process.argv.includes('--open') || process.env.AUTO_OPEN === '1') {
    try {
      if (process.platform === 'win32') {
        execSync(`cmd /c start http://localhost:${PORT}/admin.html`);
      }
    } catch (_) {}
  }
});
