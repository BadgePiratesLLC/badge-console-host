// A file-backed log, independent of whatever the OS service manager does
// with stdout/stderr. launchd redirects both to LOG_PATH for us (see
// autostart.mjs), but Windows Task Scheduler and the non-systemd Linux
// XDG-autostart fallback don't capture anything — without this, a buyer
// running as a background service on those platforms would have zero
// record of a feed failure or a crash. Best-effort: a log write failure
// (disk full, permissions) must never take down the poll loop it's meant
// to explain.

import fs from 'node:fs';
import { HOME_DIR, LOG_PATH } from './paths.mjs';

function write(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_PATH, line + '\n', { mode: 0o600 });
  } catch {
    // stdout/stderr above already carries this line — losing the file copy
    // isn't worth failing whatever operation triggered the log call.
  }
}

export const log = {
  info: (message) => write('INFO', message),
  error: (message) => write('ERROR', message),
};
