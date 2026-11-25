import type { Meta } from "..";

export function hasCustomRequestContext(
  options: Pick<Meta["options"], "headers" | "actions"> & {
    profile?: unknown;
  },
): boolean {
  return (
    Object.keys(options.headers ?? {}).length > 0 ||
    (options.actions?.length ?? 0) > 0 ||
    options.profile !== undefined
  );
}
