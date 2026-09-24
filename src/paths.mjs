import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.badge-console-host');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const SECRETS_DIR = path.join(HOME_DIR, 'secrets');
export const LOG_PATH = path.join(HOME_DIR, 'host-agent.log');
