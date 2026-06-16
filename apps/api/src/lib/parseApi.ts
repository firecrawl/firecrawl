export function parseApi(api: string) {
  // Handle older versions of the API that don't have the fc- prefix
  if (!api.startsWith("fc-")) {
    return api;
  }

  // remove the fc- prefix
  // re add all the dashes based on the uuidv4 format
  // 3d478a29-6e59-403e-85c7-94aba81ffd2a
  const uuid = api
    .replace(/^fc-/, "")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  return uuid;
}
