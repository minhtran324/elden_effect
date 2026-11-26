import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  isStudioUpdateFile, parseVersion, RELEASE_MANIFEST, UPDATE_SIZE_LIMIT
} from '../../elden-live-effect-studio/studio-update.js';

const [commit, tag, output] = process.argv.slice(2);
const version = parseVersion(tag);
if (!commit || !version || !output) throw new Error('Expected a commit, a version tag, and an output ZIP path.');

const tree = `${commit}:elden-live-effect-studio`;
const entries = execFileSync('git', ['ls-tree', '-z', '-r', tree], { encoding: 'utf8' }).split('\0');
const files = entries.flatMap(entry => {
  const match = /^100(?:644|755) blob [\da-f]+\t(.+)$/.exec(entry);
  return match && isStudioUpdateFile(match[1]) ? [match[1]] : [];
});
for (const required of [
  'server.js', 'studio-update.js', 'public/admin.html', 'public/brand/elden-media.png',
  'public/builtin/jar/iridescent_fishbowl_transparent.png',
  'public/builtin/jar/iridescent_fishbowl_front_overlay.png',
  'public/builtin/jar/jar_template_guide.svg'
]) {
  if (!files.includes(required)) throw new Error(`Missing a required Studio file: ${required}`);
}

execFileSync('git', [
  'archive', '--format=zip', `--output=${output}`,
  `--add-virtual-file=${RELEASE_MANIFEST}:${JSON.stringify({ version })}`,
  tree, ...files
], { stdio: 'inherit' });
if (fs.statSync(output).size > UPDATE_SIZE_LIMIT) throw new Error('The Studio update ZIP exceeds 50 MB.');
