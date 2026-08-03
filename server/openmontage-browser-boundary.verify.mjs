import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const dist = resolve(process.cwd(), process.argv[2] || 'dist');
assert.ok(existsSync(dist), `Expected browser build directory: ${dist}`);

const forbiddenMarkers = [
  'AGENT_GUIDE',
  'OpenMontage Director Skill',
  'OpenMontage Director Skills',
  'Stage Director Skills',
  'modify_motage_open',
  'pipeline_defs/',
];

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

const leaks = [];
for (const file of filesIn(dist)) {
  // Browser build files are text. Skip binary assets to avoid false positives.
  if (statSync(file).size > 20 * 1024 * 1024) continue;
  const content = readFileSync(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) leaks.push(`${relative(dist, file)} contains ${JSON.stringify(marker)}`);
  }
}

assert.deepEqual(leaks, [], `OpenMontage server prompts leaked into browser build:\n${leaks.join('\n')}`);
console.log(`Browser boundary verified: ${relative(process.cwd(), dist)} contains no OpenMontage prompt markers.`);
