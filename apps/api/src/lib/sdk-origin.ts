export function isSdkOrigin(origin: string): boolean {
  return /^(python|js)-sdk[@.]/.test(origin);
}
