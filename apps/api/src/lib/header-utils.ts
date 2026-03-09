export function getHeaderValueCaseInsensitive(
  headers: Record<string, string> | undefined,
  headerName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === headerName.toLowerCase(),
  );
  return match?.[1];
}
