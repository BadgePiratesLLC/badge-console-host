// Explicit entry point for the Single Executable Application build. A SEA
// has no reliable argv[1]-vs-import.meta.url way to detect "am I the
// script that was run" (see server.mjs's runCli guard and the comment
// next to it), so scripts/build-sea.mjs points the SEA's main at this file
// instead, which always runs the CLI rather than trying to self-detect.
import { runCli } from './server.mjs';

runCli();
