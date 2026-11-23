import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function fetchAllTikTokVnGifts() {
  const url = 'https://webcast.tiktok.com/webcast/gift/list/?aid=1988&app_language=vi-VN&webcast_language=vi-VN&device_platform=web_pc&region=VN';
  console.log('🔄 Đang kết nối tới TikTok Webcast API để lấy danh mục quà tặng Việt Nam...');

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const data = await res.json();
    const rawGifts = data.data?.gifts || [];
    console.log(`✅ TikTok API trả về ${rawGifts.length} quà thô.`);

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

    const cachePath = path.join(__dirname, 'public', 'gifts_cache.json');
    const jsPath = path.join(__dirname, 'public', 'gifts-data.js');

    fs.writeFileSync(cachePath, JSON.stringify(processed, null, 2), 'utf-8');
    const jsContent = `// Danh mục đầy đủ quà tặng TikTok Live Việt Nam chính thức từ TikTok Webcast API kèm icon ảnh TikTok CDN\nconst TIKTOK_GIFTS_CATALOG = ${JSON.stringify(processed, null, 2)};\n`;
    fs.writeFileSync(jsPath, jsContent, 'utf-8');

    console.log(`🎉 Thành công! Đã lưu ${processed.length} món quà kèm icon ảnh TikTok CDN vào gifts_cache.json và gifts-data.js.`);
  } catch (err) {
    console.error('❌ Lỗi tải quà:', err.message);
  }
}

fetchAllTikTokVnGifts();
