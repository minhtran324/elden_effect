import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } from 'tiktok-live-connector';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync, spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

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
const DECOR_DIR = path.join(__dirname, 'public', 'uploads', 'decor');
const TEMPLATES_FILE = path.join(__dirname, 'jar_templates.json');
const TEMPLATES_DIR = path.join(__dirname, 'public', 'uploads', 'templates');
const TIKTOK_SETTINGS_FILE = path.join(__dirname, 'tiktok_settings.json');
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

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
if (!fs.existsSync(TEMP_UPDATE_DIR)) fs.mkdirSync(TEMP_UPDATE_DIR, { recursive: true });

function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Lỗi đọc update_config.json:', err);
  }
  return { version: '1.0.0', githubRepo: '', autoCheckOnStartup: true, lastCheckTime: null };
}

function saveUpdateConfig(cfg) {
  try {
    fs.writeFileSync(UPDATE_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi ghi update_config.json:', err);
  }
}

const patchStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_UPDATE_DIR),
  filename: (req, file, cb) => cb(null, `patch_${Date.now()}.zip`)
});
const patchUpload = multer({
  storage: patchStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

function loadJarTemplates() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Lỗi đọc jar_templates.json:', err);
  }
  return [];
}

function saveJarTemplates(tmpls) {
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(tmpls, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi ghi jar_templates.json:', err);
  }
}

const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `tmpl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const templateUpload = multer({
  storage: templateStorage,
  limits: { fileSize: 30 * 1024 * 1024 }
});
const GIFTS_CACHE_FILE = path.join(__dirname, 'public', 'gifts_cache.json');

// Đảm bảo các thư mục lưu trữ tồn tại
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DECOR_DIR)) fs.mkdirSync(DECOR_DIR, { recursive: true });

// Cấu hình Hũ Quà Rơi Vật Lý (Physics Jar) mặc định
const DEFAULT_JAR_CONFIG = {
  enabled: true,
  style: 'mason', // 'mason' | 'diamond' | 'fishbowl' | 'chest' | 'custom_image'
  customJarImage: '/uploads/decor/hu-qua-live.webp', // URL ảnh hũ riêng biệt từ ảnh (có sẵn mẫu 20/10)
  hideDefaultJarOnCustom: true, // Ẩn hũ gốc khi chọn ảnh riêng để không bị trùng lặp
  decorImage: '/uploads/decor/decor_eldenmedia_badge.svg',
  decorText: '@eldenmedia',
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
  // VẬT LÝ TRÀN HŨ & TÍCH TỤ DƯỚI ĐẤT
  enableFloorAccumulation: true, // Khi đầy hũ hoặc rơi ra ngoài thì rơi xuống đất và chồng chất lên nhau quanh hũ
  giftCapacity: 300, // Số lượng quà tối đa lưu trên màn hình
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
  autoBurstOnGoal: true,
  autoResetSeconds: 5
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
    cb(null, `decor_${base}_${Date.now()}${ext}`);
  }
});
const decorUpload = multer({
  storage: decorStorage,
  limits: { fileSize: 25 * 1024 * 1024 } // Giới hạn 25MB
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const isComboGift = Boolean(giftDetails.combo || giftDetails.giftType === 1 || data.giftType === 1);
  const isComboFinished = Boolean(
    data.repeatEnd === 1 || 
    data.repeatEnd === true || 
    giftDetails.repeat_end === 1 || 
    !isComboGift
  );

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
    isComboFinished
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

// ---------- THUẬT TOÁN XỬ LÝ QUÀ & TỈ LỆ TRÚNG/XỊT ----------
function handleGift(giftData) {
  const parsed = parseGiftPayload(giftData);
  if (!parsed) return;

  const { sender, nickname, giftName, rawGiftName, localizedName, diamondCount, repeatCount, avatar, iconUrl, giftId } = parsed;
  const coins = diamondCount * repeatCount;

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

  // BẮN QUÀ VÀO HŨ QUÀ RƠI VẬT LÝ (NẾU HŨ ĐANG BẬT)
  if (jarConfig.enabled) {
    let finalIcon = iconUrl;
    if (!finalIcon && Array.isArray(liveGiftsCache)) {
      const found = (giftId ? liveGiftsCache.find(g => String(g.id) === String(giftId)) : null) ||
                    liveGiftsCache.find(g => matchGiftName(g.name, giftName));
      if (found && found.iconUrl) finalIcon = found.iconUrl;
    }

    io.emit('jar_drop_gift', {
      giftId,
      giftName: displayGiftName,
      coins,
      diamondCount,
      count: repeatCount,
      sender: nickname || sender,
      avatar,
      iconUrl: finalIcon
    });
  }

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
      roundedFps: roundedFps > 45 ? 60 : (roundedFps > 20 ? 30 : roundedFps),
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

// API Xuất video đã chỉnh sửa với FPS tùy chọn & Tên chỉ định
app.post('/api/render-export', upload.single('video'), (req, res) => {
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
  } else if (targetFps !== '60' && targetFps !== '30') {
    targetFps = '30';
  }

  // Tên file sạch đẹp giữ nguyên tên do user nhập, không thêm dãy ID
  const sanitized = customName.replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1EA0-\u1EF9]/g, '_').substring(0, 80) || 'Effect_Idol';
  const finalFilename = sanitized.toLowerCase().endsWith('.webm') ? sanitized : `${sanitized}.webm`;
  const finalPath = path.join(UPLOADS_DIR, finalFilename);

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
    execFileSync(ffmpegPath, [
      '-y',
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
      finalPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    if (fs.existsSync(req.file.path) && req.file.path !== finalPath) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
  } catch (err) {
    console.warn('FFmpeg encode warning, dùng file gốc:', err.message);
    try {
      fs.renameSync(req.file.path, finalPath);
    } catch (_) {}
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
  conn.on('gift', (data) => {
    try {
      const parsed = parseGiftPayload(data);
      if (!parsed) return;
      if (parsed.isComboGift && !parsed.isComboFinished) return;
      handleGift(parsed);
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
  res.json({ success: true, config: jarConfig });
});

// 2. Lưu cập nhật cấu hình hũ
app.post('/api/jar/config', (req, res) => {
  jarConfig = { ...jarConfig, ...req.body };
  saveJarConfig(jarConfig);
  io.emit('jar_config_updated', jarConfig);
  addLog('info', 'Đã lưu cài đặt Hũ Quà Rơi Vật Lý');
  res.json({ success: true, config: jarConfig });
});

// 3. Kích hoạt hành động tương tác (Lắc, Nứt, Lật, Nổ, Dọn, Reset)
app.post('/api/jar/action', (req, res) => {
  const { action, intensity } = req.body;
  if (!action) return res.status(400).json({ success: false, error: 'Thiếu action' });
  io.emit('jar_action', { action, intensity: Number(intensity) || 1.0 });
  addLog('info', `Kích hoạt hiệu ứng hũ: [${action.toUpperCase()}]`);
  res.json({ success: true, action });
});

// 4. Bắn test quà rơi vào hũ
app.post('/api/jar/drop', (req, res) => {
  const { giftId, giftName, coins, count, sender, avatar, iconUrl } = req.body;
  let finalIcon = iconUrl;
  if (!finalIcon && (giftId || giftName) && Array.isArray(liveGiftsCache)) {
    const f = liveGiftsCache.find(g => String(g.id) === String(giftId)) ||
              liveGiftsCache.find(g => matchGiftName(g.name, giftName));
    if (f && f.iconUrl) finalIcon = f.iconUrl;
  }

  const dropData = {
    giftId: giftId || 'custom',
    giftName: giftName || 'Quà Test',
    coins: Number(coins) || 1,
    count: Math.min(Number(count) || 1, 50),
    sender: sender || 'Đại Gia Test',
    avatar: avatar || '',
    iconUrl: finalIcon
  };

  io.emit('jar_drop_gift', dropData);
  addLog('gift', `[TEST HŨ] Đã bắn ${dropData.count}x ${dropData.giftName} (${dropData.coins} xu) vào hũ`);
  res.json({ success: true, dropped: dropData });
});

// 5. Tải lên file ảnh Decor PNG/SVG xoá phông
app.post('/api/jar/upload-decor', decorUpload.single('decor'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file decor' });
  }
  const fileUrl = `/uploads/decor/${req.file.filename}`;
  jarConfig.decorImage = fileUrl;
  saveJarConfig(jarConfig);
  io.emit('jar_config_updated', jarConfig);
  addLog('info', `Đã tải lên ảnh Decor mới cho hũ: ${req.file.originalname}`);
  res.json({ success: true, fileUrl, fileName: req.file.originalname });
});

// 6. Danh sách các file Decor có sẵn
app.get('/api/jar/decor-list', (req, res) => {
  try {
    const files = fs.readdirSync(DECOR_DIR)
      .filter(f => /\.(png|svg|webp|jpg|jpeg)$/i.test(f))
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
  const tmpls = loadJarTemplates();
  res.json({ success: true, templates: tmpls });
});

// 2. Lưu mẫu hũ mới vào thư viện
app.post('/api/jar/save-template', templateUpload.single('templateImage'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Chưa nhận được ảnh template' });
    }
    const fileUrl = `/uploads/templates/${req.file.filename}`;
    const tmpls = loadJarTemplates();

    const id = `tmpl_${Date.now()}`;
    const name = req.body.name || `Mẫu Hũ ${new Date().toLocaleDateString('vi-VN')}`;
    const aspect = req.body.aspect || 'vertical';
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
      isActive: applyNow,
      createdAt: new Date().toISOString(),
      stateData
    };

    if (applyNow) {
      tmpls.forEach(t => t.isActive = false);
    }

    tmpls.unshift(newTemplate);
    saveJarTemplates(tmpls);

    if (applyNow) {
      jarConfig.style = 'custom_image';
      jarConfig.customJarImage = fileUrl;
      jarConfig.jarAspect = aspect;
      jarConfig.jarPadding = padding;
      jarConfig.hideDefaultJarOnCustom = true;
      saveJarConfig(jarConfig);
      io.emit('jar_config_updated', jarConfig);
      addLog('info', `Đã lưu & áp dụng mẫu hũ mới: "${name}" (${aspect})`);
    } else {
      addLog('info', `Đã lưu mẫu hũ vào thư viện: "${name}"`);
    }

    res.json({ success: true, template: newTemplate });
  } catch (err) {
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

  // Xoá file ảnh nếu trong uploads/templates
  if (target.imageUrl && target.imageUrl.startsWith('/uploads/templates/')) {
    const filePath = path.join(__dirname, 'public', target.imageUrl);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }

  tmpls = tmpls.filter(t => t.id !== id);
  saveJarTemplates(tmpls);
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

  tmpls.forEach(t => t.isActive = (t.id === id));
  saveJarTemplates(tmpls);

  jarConfig.style = 'custom_image';
  jarConfig.customJarImage = target.imageUrl;
  jarConfig.jarAspect = target.aspect || 'vertical';
  jarConfig.jarPadding = target.padding || { top: 0, bottom: 0, left: 0, right: 0 };
  jarConfig.hideDefaultJarOnCustom = true;
  saveJarConfig(jarConfig);
  io.emit('jar_config_updated', jarConfig);

  addLog('info', `Đã áp dụng mẫu hũ "${target.name}" (${target.aspect}) lên OBS`);
  res.json({ success: true, config: jarConfig, template: target });
});


app.post('/api/jar/upload-jar-skin', decorUpload.single('jarSkin'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file ảnh hũ' });
  }
  const fileUrl = `/uploads/decor/${req.file.filename}`;
  jarConfig.style = 'custom_image';
  jarConfig.customJarImage = fileUrl;
  saveJarConfig(jarConfig);
  io.emit('jar_config_updated', jarConfig);
  addLog('info', `Đã tải lên và áp dụng Mẫu Hũ Mới từ ảnh: ${req.file.originalname}`);
  res.json({ success: true, fileUrl, fileName: req.file.originalname });
});

// ========================================================
// CÁC HÀM XỬ LÝ NÂNG CẤP VÀ BẢO VỆ DỮ LIỆU STREAMER
// ========================================================
function isPathProtected(relPath) {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const protectedPrefixes = [
    'rules.json',
    'jar_config.json',
    'jar_templates.json',
    'tiktok_settings.json',
    'update_config.json',
    'runtime',
    'node_modules',
    'temp_update',
    'public/uploads',
    '.git'
  ];
  return protectedPrefixes.some(p => norm === p || norm.startsWith(p + '/'));
}

function extractZip(zipFilePath, targetDir) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  try {
    execSync(`tar -xf "${zipFilePath}" -C "${targetDir}"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    const psCmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipFilePath}' -DestinationPath '${targetDir}' -Force"`;
    execSync(psCmd, { stdio: 'pipe' });
    return true;
  }
}

function findPayloadRoot(baseDir) {
  const items = fs.readdirSync(baseDir, { withFileTypes: true });
  if (items.some(i => i.name === 'server.js' || i.name === 'public')) {
    return baseDir;
  }
  const dirs = items.filter(i => i.isDirectory());
  if (dirs.length === 1) {
    const sub = path.join(baseDir, dirs[0].name);
    const subItems = fs.readdirSync(sub);
    if (subItems.includes('server.js') || subItems.includes('public')) {
      return sub;
    }
  }
  return baseDir;
}

function safeCopyRecursive(srcDir, destDir, relBase = '', updatedList = []) {
  const items = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const item of items) {
    const itemRel = relBase ? `${relBase}/${item.name}` : item.name;
    if (isPathProtected(itemRel)) {
      continue;
    }
    const srcPath = path.join(srcDir, item.name);
    const destPath = path.join(destDir, item.name);

    if (item.isDirectory()) {
      if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
      safeCopyRecursive(srcPath, destPath, itemRel, updatedList);
    } else if (item.isFile()) {
      const parent = path.dirname(destPath);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      updatedList.push(itemRel);
    }
  }
  return updatedList;
}

function cleanTempDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (_) {}
}

// ENDPOINTS CẬP NHẬT ỨNG DỤNG
app.get('/api/app/version', (req, res) => {
  const cfg = loadUpdateConfig();
  let pkgVer = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    pkgVer = pkg.version || pkgVer;
  } catch (_) {}
  res.json({
    success: true,
    version: cfg.version || pkgVer,
    githubRepo: cfg.githubRepo || '',
    autoCheckOnStartup: cfg.autoCheckOnStartup !== false,
    lastCheckTime: cfg.lastCheckTime
  });
});

app.post('/api/app/config', (req, res) => {
  const cfg = loadUpdateConfig();
  if (typeof req.body?.githubRepo === 'string') cfg.githubRepo = req.body.githubRepo.trim();
  if (typeof req.body?.autoCheckOnStartup === 'boolean') cfg.autoCheckOnStartup = req.body.autoCheckOnStartup;
  saveUpdateConfig(cfg);
  res.json({ success: true, config: cfg });
});

app.post('/api/app/check-github', async (req, res) => {
  const cfg = loadUpdateConfig();
  const repo = (req.body?.githubRepo || cfg.githubRepo || '').trim();
  if (!repo || !repo.includes('/')) {
    return res.status(400).json({ success: false, error: 'Chưa cấu hình GitHub Repo (định dạng: username/repository)' });
  }

  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'LiveEffect-Studio-Updater' }
    });
    if (!ghRes.ok) {
      if (ghRes.status === 404) {
        return res.status(404).json({ success: false, error: `Không tìm thấy bản Release nào trên GitHub repo: ${repo}` });
      }
      return res.status(ghRes.status).json({ success: false, error: `GitHub API trả về lỗi: ${ghRes.statusText}` });
    }

    const data = await ghRes.json();
    const latestTag = (data.tag_name || '').replace(/^v/, '');
    const currentVer = (cfg.version || '1.0.0').replace(/^v/, '');

    let downloadUrl = data.zipball_url;
    if (Array.isArray(data.assets) && data.assets.length > 0) {
      const zipAsset = data.assets.find(a => a.name.endsWith('.zip'));
      if (zipAsset) downloadUrl = zipAsset.browser_download_url;
    }

    const hasUpdate = latestTag && latestTag !== currentVer;

    cfg.lastCheckTime = new Date().toISOString();
    saveUpdateConfig(cfg);

    res.json({
      success: true,
      currentVersion: currentVer,
      latestVersion: latestTag,
      hasUpdate,
      releaseName: data.name || data.tag_name,
      releaseNotes: data.body || '',
      downloadUrl,
      publishedAt: data.published_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Lỗi kiểm tra GitHub: ' + err.message });
  }
});

// Cập nhật bằng file patch .zip kéo thả
app.post('/api/app/apply-patch', patchUpload.single('patchFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Chưa chọn file cập nhật .zip' });
  }

  const zipPath = req.file.path;
  const extractDir = path.join(TEMP_UPDATE_DIR, `extracted_${Date.now()}`);

  try {
    extractZip(zipPath, extractDir);
    const payloadRoot = findPayloadRoot(extractDir);

    const updatedList = [];
    safeCopyRecursive(payloadRoot, __dirname, '', updatedList);

    const cfg = loadUpdateConfig();
    try {
      const patchPkgPath = path.join(payloadRoot, 'package.json');
      if (fs.existsSync(patchPkgPath)) {
        const patchPkg = JSON.parse(fs.readFileSync(patchPkgPath, 'utf8'));
        if (patchPkg.version) {
          cfg.version = patchPkg.version;
          saveUpdateConfig(cfg);
        }
      }
    } catch (_) {}

    cleanTempDir(TEMP_UPDATE_DIR);
    addLog('info', `✅ Cập nhật ứng dụng thành công: Đã cập nhật ${updatedList.length} files (Dữ liệu cũ được bảo vệ an toàn).`);
    res.json({
      success: true,
      message: `Đã cập nhật thành công ${updatedList.length} tệp tin!`,
      version: cfg.version,
      updatedFiles: updatedList
    });
  } catch (err) {
    cleanTempDir(TEMP_UPDATE_DIR);
    console.error('Lỗi áp dụng patch:', err);
    res.status(500).json({ success: false, error: 'Lỗi giải nén cập nhật: ' + err.message });
  }
});

// Cập nhật online tự động từ GitHub
app.post('/api/app/apply-github', async (req, res) => {
  const downloadUrl = req.body?.downloadUrl;
  if (!downloadUrl) {
    return res.status(400).json({ success: false, error: 'Thiếu đường dẫn tải bản cập nhật' });
  }

  const zipPath = path.join(TEMP_UPDATE_DIR, `gh_download_${Date.now()}.zip`);
  const extractDir = path.join(TEMP_UPDATE_DIR, `gh_extracted_${Date.now()}`);

  try {
    const ghRes = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'LiveEffect-Studio-Updater' }
    });
    if (!ghRes.ok) throw new Error(`Tải file thất bại: ${ghRes.statusText}`);

    const buffer = Buffer.from(await ghRes.arrayBuffer());
    fs.writeFileSync(zipPath, buffer);

    extractZip(zipPath, extractDir);
    const payloadRoot = findPayloadRoot(extractDir);

    const updatedList = [];
    safeCopyRecursive(payloadRoot, __dirname, '', updatedList);

    const cfg = loadUpdateConfig();
    if (req.body?.newVersion) {
      cfg.version = req.body.newVersion;
      saveUpdateConfig(cfg);
    } else {
      try {
        const patchPkgPath = path.join(payloadRoot, 'package.json');
        if (fs.existsSync(patchPkgPath)) {
          const patchPkg = JSON.parse(fs.readFileSync(patchPkgPath, 'utf8'));
          if (patchPkg.version) {
            cfg.version = patchPkg.version;
            saveUpdateConfig(cfg);
          }
        }
      } catch (_) {}
    }

    cleanTempDir(TEMP_UPDATE_DIR);
    addLog('info', `✅ Cập nhật online thành công từ GitHub: Đã cập nhật ${updatedList.length} files.`);
    res.json({
      success: true,
      message: `Đã cập nhật tự động thành công ${updatedList.length} tệp tin!`,
      version: cfg.version,
      updatedFiles: updatedList
    });
  } catch (err) {
    cleanTempDir(TEMP_UPDATE_DIR);
    console.error('Lỗi cập nhật online:', err);
    res.status(500).json({ success: false, error: 'Lỗi cập nhật online: ' + err.message });
  }
});

// Khởi động lại Server
app.post('/api/app/restart', (req, res) => {
  addLog('info', '🔄 Đang khởi động lại máy chủ LiveEffect Studio...');
  res.json({ success: true, message: 'Server đang khởi động lại trong 2 giây...' });

  setTimeout(() => {
    try {
      const nodeBin = fs.existsSync(path.join(__dirname, 'runtime', 'node.exe'))
        ? path.join(__dirname, 'runtime', 'node.exe')
        : process.execPath;

      const child = spawn(nodeBin, ['server.js'], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      process.exit(0);
    } catch (err) {
      console.error('Lỗi restart server:', err);
    }
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
