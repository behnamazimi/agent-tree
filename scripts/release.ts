// Usage: npm run release -- [patch|minor|major|x.y.z] [--dry]
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN = ".claude-plugin/plugin.json";
const [bump = "patch", flag] = process.argv.slice(2);
const dry = flag === "--dry";
const run = (cmd: string) => execSync(cmd, { stdio: "inherit" });

if (!dry && execSync("git status --porcelain").toString().trim()) {
  throw new Error("Working tree is not clean; commit or stash first.");
}

if (!dry) {
  const git = (cmd: string) => execSync(`git ${cmd}`).toString().trim();
  const branch = git("branch --show-current");
  if (branch !== "main") throw new Error(`Release from main, not "${branch}".`);
  git("fetch origin main");
  if (git("rev-parse HEAD") !== git("rev-parse origin/main")) {
    throw new Error("main is not in sync with origin/main; pull or push first.");
  }
}

const manifest = JSON.parse(readFileSync(PLUGIN, "utf8"));
const [major, minor, patch] = manifest.version.split(".").map(Number);
const bumps: Record<string, string> = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
};
const next = /^\d+\.\d+\.\d+$/.test(bump) ? bump : bumps[bump];
if (!next) throw new Error(`Unknown bump "${bump}": use patch, minor, major or x.y.z`);

console.log(`${manifest.name}: ${manifest.version} -> ${next}`);
if (dry) process.exit(0);

manifest.version = next;
writeFileSync(PLUGIN, `${JSON.stringify(manifest, null, 2)}\n`);
run("npx oxfmt");
run("claude plugin validate .");
run("claude plugin test .");
run(`git commit -am "Release ${next}"`);
run("git push");
run("claude plugin tag --push");
