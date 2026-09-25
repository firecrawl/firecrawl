export function browserProfileDeletedKey(teamId: string, name: string): string {
  return `browser-profile-deleted:${JSON.stringify([teamId, name])}`;
}
