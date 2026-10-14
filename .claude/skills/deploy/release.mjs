#!/usr/bin/env node
// Helper for the deploy skill. No dependencies; run from the repository root.
//
//   node .claude/skills/deploy/release.mjs next
//       The version the next push to main will be published as. Fetch tags first.
//
//   node .claude/skills/deploy/release.mjs status [--url https://…]
//       What :latest on the registry is, and what the live server is running.
//
//   node .claude/skills/deploy/release.mjs wait <version> [--url https://…] [--minutes 30]
//       Wait for <version> to be published, then for the live server to run it.
//
// The numbering rule is the one in .github/workflows/docker.yml ("Number the
// build"); keep the two the same.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const IMAGE = { registry: 'ghcr.io', repository: 'adamg100/clear-ping' };
const DEFAULT_URL = process.env.CLEARPING_URL || 'https://ping.gnetworx.cloud';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = option('url', DEFAULT_URL).replace(/\/$/, '');

function nextVersion() {
  const base = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const majorMinor = base.split('.').slice(0, 2).join('.');
  const tags = execFileSync('git', ['tag', '--list', `v${majorMinor}.*`], { encoding: 'utf8' }).split(/\r?\n/);
  const patches = tags
    .map(tag => tag.slice(`v${majorMinor}.`.length))
    .filter(patch => /^\d+$/.test(patch))
    .map(Number);
  const floor = Number(base.split('.')[2]);
  const patch = patches.length ? Math.max(floor, Math.max(...patches) + 1) : floor;
  return { version: `${majorMinor}.${patch}`, base, lastTag: patches.length ? `v${majorMinor}.${Math.max(...patches)}` : null };
}

async function registryToken() {
  const response = await fetch(`https://${IMAGE.registry}/token?scope=repository:${IMAGE.repository}:pull`);
  if (!response.ok) throw new Error(`registry token: HTTP ${response.status}`);
  return (await response.json()).token;
}

async function publishedTags() {
  const token = await registryToken();
  const response = await fetch(`https://${IMAGE.registry}/v2/${IMAGE.repository}/tags/list?n=10000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`registry tags: HTTP ${response.status}`);
  return (await response.json()).tags ?? [];
}

async function live() {
  try {
    const response = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return { error: 'no /api/version (running a build from before versions were numbered)' };
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: error.message };
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const command = args[0];

if (command === 'next') {
  const { version, base, lastTag } = nextVersion();
  console.log(JSON.stringify({ next: version, packageJson: base, lastRelease: lastTag }, null, 2));
} else if (command === 'status') {
  const [tags, server] = await Promise.all([publishedTags(), live()]);
  const versions = tags.filter(tag => /^\d+\.\d+\.\d+$/.test(tag));
  console.log(JSON.stringify({
    newestPublishedVersion: versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null,
    live: server.error ? { url, error: server.error } : { url, running: server.current, updateAvailable: server.updateAvailable, latest: server.latest },
  }, null, 2));
} else if (command === 'wait') {
  const version = args[1];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: wait <MAJOR.MINOR.PATCH>');
  const deadline = Date.now() + Number(option('minutes', '30')) * 60_000;

  let published = false;
  while (!published && Date.now() < deadline) {
    published = (await publishedTags()).includes(version);
    if (!published) {
      console.log(`${new Date().toISOString()}  ${version} not published yet`);
      await sleep(30_000);
    }
  }
  if (!published) {
    console.log(`TIMEOUT: ${version} was never published. Check the Docker image workflow run on GitHub.`);
    process.exit(2);
  }
  console.log(`${new Date().toISOString()}  ${version} is published as ghcr.io/${IMAGE.repository}:${version}`);

  while (Date.now() < deadline) {
    const server = await live();
    const running = server.current?.version;
    if (running === version) {
      console.log(`DEPLOYED: ${url} is running ${version}`);
      process.exit(0);
    }
    console.log(`${new Date().toISOString()}  ${url} is running ${running ?? `? (${server.error})`}`);
    await sleep(30_000);
  }
  console.log(`PUBLISHED, NOT DEPLOYED: ${version} is out but ${url} has not picked it up. Pull it and recreate the container.`);
  process.exit(3);
} else {
  console.log('usage: release.mjs next | status [--url URL] | wait <version> [--url URL] [--minutes N]');
  process.exit(1);
}
