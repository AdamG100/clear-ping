import { currentBuild } from '../version';

/**
 * Where a probe agent is installed from, for the snippets the dashboard shows.
 *
 * Always the latest: the Docker image as :latest and the install script from
 * the latest release, so `docker compose pull` or running the install line
 * again updates it. A pinned version would keep it on the one it was added
 * with for good.
 */

const DEFAULT_IMAGE = 'ghcr.io/adamg100/clear-ping';

export interface ProbeAgentInstall {
  /** The Docker image, without a tag. */
  image: string;
  tag: string;
  /** The install script for the standalone binary. */
  scriptUrl: string;
  /** The release the binary is downloaded from. */
  release: string;
}

export function probeAgentInstall(): ProbeAgentInstall {
  const image = (currentBuild().image ?? DEFAULT_IMAGE).toLowerCase();
  // ghcr.io/owner/repo is github.com/owner/repo.
  const repository = image.startsWith('ghcr.io/') ? image.slice('ghcr.io/'.length) : DEFAULT_IMAGE.slice('ghcr.io/'.length);

  return {
    image: `${image}-probe-agent`,
    tag: 'latest',
    scriptUrl: `https://github.com/${repository}/releases/latest/download/install-probe-agent.sh`,
    release: 'latest',
  };
}
