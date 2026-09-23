import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { envKeys } from '../server/keys.ts';
const adb = process.env.ADB || (process.platform === 'win32' ? 'C:/adb/adb.exe' : 'adb');
const pkg = 'com.ronit.maestroradio';
function command(args: string[], input?: string) {
  const result = spawnSync(adb, args, { input, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`ADB ${args[0]} failed. Check the connected device and USB authorization.`);
  return result.stdout.trim();
}
console.log(command(['install', '-r', '-g', 'android/app/build/outputs/apk/debug/app-debug.apk']));
if (process.argv.includes('--with-keys')) {
  dotenv.config({ path: ['.env.local', '.env'], quiet: true });
  const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
  const keys = envKeys(environment);
  if (!keys.length) throw new Error('No configured keys to import.');
  command(['shell', 'run-as', pkg, 'mkdir', '-p', 'files']);
  // Pipe into the app-private sandbox. Keys never appear in command arguments, APK, or logs.
  command(['shell', '-T', `run-as ${pkg} sh -c 'cat > files/import-keys.env'`], keys.join('\n'));
  console.log(`Provisioned ${keys.length} keys for encryption by Android Keystore on first launch.`);
}
console.log(command(['shell', 'am', 'start', '-n', `${pkg}/.MainActivity`]));
