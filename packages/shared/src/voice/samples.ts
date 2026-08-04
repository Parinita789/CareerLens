import * as fs from 'fs';
import * as path from 'path';

// Sibling of src/ and dist/ (not inside either), so this relative path resolves
// the same way whether this module runs from compiled dist/ or from src/.
const SAMPLES_DIR = path.join(__dirname, '..', '..', 'voice', 'samples');
const SUPPORTED_EXTENSIONS = ['.txt', '.md'];

// Not cached — this reads a handful of small files, negligible next to the LLM
// round trips it feeds into, and callers (e.g. a long-running API server) need
// to see samples dropped in after process start without a restart.
export function loadVoiceSamples(): string[] {
  try {
    const entries = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .filter((e) => e.name.toLowerCase() !== 'readme.md')
      .filter((e) => SUPPORTED_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
      .map((e) => {
        try {
          return fs.readFileSync(path.join(SAMPLES_DIR, e.name), 'utf-8').trim();
        } catch {
          return '';
        }
      })
      .filter((content) => content.length > 0);
  } catch {
    return [];
  }
}
