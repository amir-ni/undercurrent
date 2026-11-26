/**
 * Fact ids are dot-separated and must survive being an HTML attribute token, so every segment is
 * reduced to [A-Za-z0-9_-]. GitHub logins already are; git author names ("Jane Doe") are not.
 * Shared by the fact sheet and the web UI so both sides always agree on the id.
 */
export function factSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
}

/** Contributor rows: git author names get their own namespace so they never collide with a login. */
export function contributorKey(login: string, linked: boolean): string {
  return linked ? factSegment(login) : `git_${factSegment(login)}`;
}
