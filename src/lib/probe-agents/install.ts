import { currentBuild } from '../version';

/**
 * Where a probe agent is installed from, for the snippets the dashboard shows.
 *
 * The probe agent is built and released with the dashboard, so a numbered
 * build points at the agent of the same number, which speaks the same
 * protocol; a development build points at the latest.
 */

const DEFAULT_IMAGE = 'ghcr.io/adamg100/clear-ping';

export interface ProbeAgentInstall {
  /** The Docker image, without a tag. */
  image: string;
  tag: string;
  /** The install script for the standalone binary. */
  scriptUrl: string;
  /** The release the binary is downloaded from: a version, or "latest". */
  release: string;
}

export function probeAgentInstall(): ProbeAgentInstall {
  const build = currentBuild();
  const image = (build.image ?? DEFAULT_IMAGE).toLowerCase();
  // ghcr.io/owner/repo is github.com/owner/repo.
  const repository = image.startsWith('ghcr.io/') ? image.slice('ghcr.io/'.length) : DEFAULT_IMAGE.slice('ghcr.io/'.length);
  const release = build.development ? 'latest' : `v${build.version}`;
  const download =
    release === 'latest'
      ? `https://github.com/${repository}/releases/latest/download`
      : `https://github.com/${repository}/releases/download/${release}`;

  return {
    image: `${image}-probe-agent`,
    tag: build.development ? 'latest' : build.version,
    scriptUrl: `${download}/install-probe-agent.sh`,
    release,
  };
}
