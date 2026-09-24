// Node's os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows
// (confirmed the hard way: a HOME-only override passed CI on Linux/macOS
// but silently no-opped on windows-latest, since os.homedir() ignored it
// there and every test using it saw the real runner's actual profile
// instead of the scratch dir). Set both so a test's "fresh home directory"
// is actually fresh on every OS this repo's CI runs on.

export function setScratchHome(dir) {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return () => {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
  };
}
