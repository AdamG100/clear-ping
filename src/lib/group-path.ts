/**
 * Groups nest by name: a target's group is a path such as `Home/Network`, and
 * the group `Home` is whatever that path, and any other starting with it,
 * implies. The paths are all that records the tree, so moving a whole branch is
 * a matter of rewriting the front of some of them. Which groups exist is kept
 * as a list of such paths, so one can be there with no target in it.
 */

export const GROUP_SEPARATOR = '/'

/** Longer than any path anyone would read, and short enough to store and show. */
export const MAX_GROUP_PATH_LENGTH = 200

/** The names along a path, outermost first. Empty for no group. */
export function splitGroupPath(group: string | null | undefined): string[] {
  return (group ?? '')
    .split(GROUP_SEPARATOR)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/**
 * A path as it is stored and compared. `Home / Network`, `Home//Network` and
 * `/Home/Network/` are all the one group, and must not become three.
 */
export function normalizeGroupPath(group: string | null | undefined): string {
  return splitGroupPath(group).join(GROUP_SEPARATOR)
}

export function joinGroupPath(parent: string, name: string): string {
  return normalizeGroupPath(`${parent}${GROUP_SEPARATOR}${name}`)
}

/** The group a group sits inside; empty for one at the top level. */
export function parentGroup(group: string): string {
  return splitGroupPath(group).slice(0, -1).join(GROUP_SEPARATOR)
}

/** A group's own name, without the groups it sits inside. */
export function groupName(group: string): string {
  return splitGroupPath(group).at(-1) ?? ''
}

/**
 * Two letters to stand for a group where there is no room for its name: the
 * first letters of its first two words, or of a single word, its first two.
 * `DNS Servers` is `DS`, `Home` is `HO`.
 */
export function groupInitials(group: string): string {
  const words = groupName(group).split(/[\s\-_.,:&()]+/).filter(Boolean)
  const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...(words[0] ?? '')].slice(0, 2).join('')
  return letters.toUpperCase()
}

export function groupDepth(group: string): number {
  return Math.max(0, splitGroupPath(group).length - 1)
}

/** How a path is shown where there is no tree around it to give it context. */
export function groupLabel(group: string): string {
  return splitGroupPath(group).join(' / ')
}

/** A group and every group it sits inside, outermost first. */
export function groupWithAncestors(group: string): string[] {
  const segments = splitGroupPath(group)
  return segments.map((_, index) => segments.slice(0, index + 1).join(GROUP_SEPARATOR))
}

/** Whether `group` is `ancestor` itself or somewhere beneath it. */
export function isWithinGroup(group: string, ancestor: string): boolean {
  return group === ancestor || group.startsWith(ancestor + GROUP_SEPARATOR)
}

/**
 * Where `group` ends up when the branch at `from` is renamed or moved to `to`.
 * Unchanged if it is not part of that branch.
 */
export function rebaseGroupPath(group: string, from: string, to: string): string {
  if (!isWithinGroup(group, from)) return group
  return normalizeGroupPath(to + group.slice(from.length))
}
