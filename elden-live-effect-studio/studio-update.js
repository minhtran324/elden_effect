import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const UPDATE_ASSET_NAME = 'eldeneffect-update.zip';
export const UPDATE_SIZE_LIMIT = 50 * 1024 * 1024;
export const RELEASE_MANIFEST = 'studio-release.json';
const JOURNAL = 'transaction.json';

const appFiles = new Set([
  'server.js', 'studio-update.js',
  'public/admin.html', 'public/editor.html', 'public/index.html',
  'public/jar-studio.html', 'public/jar.html', 'public/overlay.html',
  'public/jar-geometry.js', 'public/jar-glass-effects.js',
  'public/jar-studio-chroma.js', 'public/jar-studio-templates.js', 'public/studio-ui.css'
]);

export function isStudioUpdateFile(file) {
  return appFiles.has(file) || /^public\/(?:builtin|brand|vendor)\/(?:[\w-]+\/)*[\w.-]+\.(?:css|html|js|json|md|png|webp|jpg|svg|ico|woff2)$/.test(file);
}

export function parseVersion(value) {
  if (typeof value !== 'string' || !/^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value)) return null;
  return value.replace(/^v/, '').split('.').map(Number).join('.');
}

export function isNewerVersion(candidate, installed) {
  const current = (parseVersion(installed) || '1.0.0').split('.').map(Number);
  const next = candidate.split('.').map(Number);
  const firstChange = next.findIndex((part, index) => part !== current[index]);
  return firstChange !== -1 && next[firstChange] > current[firstChange];
}

export function removeUpdateWork(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn('Không dọn được thư mục cập nhật:', error.message);
  }
}

export function writeUpdateConfig(file, config) {
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, JSON.stringify(config, null, 2), { flag: 'wx' });
    fs.renameSync(pending, file);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function extractZip(file, destination) {
  const tarOptions = { stdio: 'pipe', windowsHide: true, timeout: 60_000 };
  try {
    execFileSync('tar', ['-xf', file, '-C', destination], tarOptions);
  } catch (error) {
    if (error.code !== 'ENOENT' || process.platform !== 'win32') throw error;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:STUDIO_UPDATE_ZIP -DestinationPath $env:STUDIO_UPDATE_STAGE -ErrorAction Stop'
    ], { ...tarOptions, env: { ...process.env, STUDIO_UPDATE_ZIP: file, STUDIO_UPDATE_STAGE: destination } });
  }
}

function collectUpdateFiles(root, relative = '') {
  const files = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory() && /^(?:public|public\/(?:builtin|brand|vendor)(?:\/[\w-]+)*)$/.test(file)) {
      files.push(...collectUpdateFiles(root, file));
    } else if (item.isFile() && isStudioUpdateFile(file)) {
      files.push(file);
    }
  }
  return files;
}

function findPayload(extracted) {
  // A release ZIP starts at the app root. Older ZIP patches may wrap it in one or two folders.
  const candidates = [extracted];
  for (const root of candidates) {
    const files = collectUpdateFiles(root);
    if (files.length) return { root, files };
    if (path.relative(extracted, root).split(path.sep).filter(Boolean).length === 2) continue;
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory());
    const app = dirs.find(item => item.name === 'elden-live-effect-studio') || (dirs.length === 1 && dirs[0]);
    if (app) candidates.push(path.join(root, app.name));
  }
  throw new Error('Gói cập nhật không chứa tệp ứng dụng hợp lệ.');
}

function readMetadata(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new Error('Tệp thông tin phiên bản không hợp lệ.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function installedStudioVersion(appDir, fallback) {
  try {
    const release = readMetadata(path.join(appDir, RELEASE_MANIFEST));
    const version = parseVersion(release?.version);
    if (version) return version;
  } catch (error) {
    console.warn('Không đọc được phiên bản Studio:', error.message);
  }
  return parseVersion(fallback) || '1.0.0';
}

function destinationFile(appDir, file) {
  const segments = file.split('/');
  let target = appDir;
  for (const directory of segments.slice(0, -1)) {
    target = path.join(target, directory);
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (info && !info.isDirectory()) throw new Error(`Đường dẫn cập nhật không hợp lệ: ${file}`);
  }
  target = path.join(target, segments.at(-1));
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new Error(`Không thể thay thế tệp: ${file}`);
  return { target, exists: Boolean(info) };
}

function replaceFile(source, target, stage) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, stage);
  fs.renameSync(stage, target);
}

function finishTransaction(pending) {
  const completed = `${pending}-${randomUUID()}`;
  fs.renameSync(pending, completed);
  removeUpdateWork(completed);
}

export function recoverStudioUpdate(appDir, tempDir) {
  const pending = path.join(tempDir, 'transaction');
  const info = fs.lstatSync(pending, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory()) throw new Error('Thư mục khôi phục bản cập nhật không hợp lệ.');
  const files = readMetadata(path.join(pending, JOURNAL));
  if (!Array.isArray(files) || files.some(({ file, exists }) =>
    (file !== RELEASE_MANIFEST && !isStudioUpdateFile(file)) || typeof exists !== 'boolean'
  )) throw new Error('Thông tin khôi phục bản cập nhật không hợp lệ.');

  for (const { file, exists } of files) {
    const { target, exists: targetExists } = destinationFile(appDir, file);
    if (exists) {
      const backup = path.join(pending, 'backup', file);
      if (targetExists && fs.readFileSync(target).equals(fs.readFileSync(backup))) continue;
      replaceFile(backup, target, path.join(pending, 'replacement'));
    } else if (targetExists) {
      fs.rmSync(target);
    }
  }
  finishTransaction(pending);
  return true;
}

export function installStudioUpdate({ zip, work, appDir, tempDir, current, onlineVersion }) {
  const extracted = path.join(work, 'extracted');
  fs.mkdirSync(extracted);
  try {
    extractZip(zip, extracted);
  } catch {
    throw new Error('Không giải nén được gói cập nhật ZIP.');
  }
  const { root, files } = findPayload(extracted);
  for (const file of ['server.js', 'studio-update.js']) {
    if (!files.includes(file)) continue;
    try {
      execFileSync(process.execPath, ['--check', '--input-type=module'], {
        input: fs.readFileSync(path.join(root, file)), stdio: 'pipe', windowsHide: true, timeout: 10_000
      });
    } catch {
      throw new Error(`Mã ứng dụng trong gói cập nhật không hợp lệ: ${file}`);
    }
  }
  const manifest = readMetadata(path.join(root, RELEASE_MANIFEST));
  const manifestVersion = parseVersion(manifest?.version);
  if (manifest && (!manifestVersion || (onlineVersion && manifestVersion !== onlineVersion))) {
    throw new Error('Phiên bản trong gói ZIP không khớp với bản phát hành.');
  }
  const packageVersion = onlineVersion || manifestVersion || parseVersion(readMetadata(path.join(root, 'package.json'))?.version);
  if (packageVersion && packageVersion !== current && !isNewerVersion(packageVersion, current)) {
    throw new Error('Gói cập nhật cũ hơn phiên bản đang cài.');
  }

  const prepared = path.join(work, 'prepared');
  const pending = path.join(tempDir, 'transaction');
  const sources = new Map();
  // Install the server last so its new application modules are already available.
  for (const file of files.filter(file => file !== 'server.js')) sources.set(file, path.join(root, file));
  if (files.includes('server.js')) sources.set('server.js', path.join(root, 'server.js'));
  if (packageVersion && packageVersion !== current) {
    const version = path.join(work, 'update-version.json');
    fs.writeFileSync(version, JSON.stringify({ version: packageVersion }, null, 2));
    sources.set(RELEASE_MANIFEST, version);
  }

  const journal = [];
  for (const file of sources.keys()) {
    const { target, exists } = destinationFile(appDir, file);
    if (exists) {
      const backup = path.join(prepared, 'backup', file);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(target, backup);
    }
    journal.push({ file, exists });
  }
  fs.mkdirSync(prepared, { recursive: true });
  fs.writeFileSync(path.join(prepared, JOURNAL), JSON.stringify(journal));
  fs.renameSync(prepared, pending);

  try {
    for (const [file, source] of sources) {
      const { target } = destinationFile(appDir, file);
      replaceFile(source, target, path.join(pending, 'replacement'));
    }
    finishTransaction(pending);
  } catch (error) {
    try {
      recoverStudioUpdate(appDir, tempDir);
    } catch (recoveryError) {
      console.error('Lỗi phục hồi cập nhật:', recoveryError);
      throw new Error('Cập nhật bị gián đoạn. Mở lại Studio để thử khôi phục phiên bản trước.');
    }
    throw error;
  }

  return { version: packageVersion || current, updatedFiles: files };
}
