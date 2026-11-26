import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  JAR_LIBRARY_DIR, JAR_LIBRARY_MANIFEST, jarLibraryAssets, uploadedStickerUrl
} from '../../elden-live-effect-studio/studio-update.js';

const studio = fileURLToPath(new URL('../../elden-live-effect-studio/', import.meta.url));
const bundle = path.join(studio, JAR_LIBRARY_DIR);

function readStudioJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(studio, file), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

const templates = readStudioJson('jar_templates.json', []).map(({ isActive, ...template }) => template);
const savedStickers = readStudioJson('jar_stickers.json', []);
const current = readStudioJson('jar_config.json', {});
const stickers = new Map();
for (const list of [savedStickers, current.stickers, ...templates.map(template => template.stateData?.design?.stickers)]) {
  if (!Array.isArray(list)) continue;
  for (const sticker of list) {
    if (!uploadedStickerUrl.test(sticker?.url) || stickers.has(sticker.url)) continue;
    stickers.set(sticker.url, { name: sticker.name || 'Sticker', url: sticker.url });
  }
}

const library = { templates, stickers: [...stickers.values()] };
const assets = jarLibraryAssets(library);
for (const asset of assets) {
  if (!fs.statSync(path.join(studio, asset.relativeSource), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Thiếu ảnh trong thư viện hũ: ${asset.relativeSource}`);
  }
}

fs.mkdirSync(bundle, { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(studio, asset.relativeSource), path.join(bundle, asset.name));
}
const manifest = path.join(bundle, JAR_LIBRARY_MANIFEST);
const pending = `${manifest}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(pending, JSON.stringify(library, null, 2) + '\n', 'utf8');
  fs.renameSync(pending, manifest);
} finally {
  fs.rmSync(pending, { force: true });
}

const exported = new Set(assets.map(asset => asset.name));
for (const name of fs.readdirSync(bundle)) {
  if (/^[a-f0-9]{64}\.(png|jpg|svg|webp)$/.test(name) && !exported.has(name)) {
    fs.rmSync(path.join(bundle, name));
  }
}
console.log(`Đã xuất ${templates.length} mẫu hũ, ${stickers.size} sticker và ${assets.length} tệp ảnh vào ${JAR_LIBRARY_DIR}.`);
