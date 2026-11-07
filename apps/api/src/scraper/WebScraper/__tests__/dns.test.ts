import CacheableLookup from "cacheable-lookup";
import https from "node:https";
import axios from "axios";

describe("DNS", () => {
  it("cached dns", async () => {
    const cachedDns = new CacheableLookup();
    cachedDns.install(https.globalAgent);
    vi.spyOn(cachedDns, "lookupAsync");

    const res = await axios.get("https://example.com");
    expect(res.status).toBe(200);
    expect(cachedDns.lookupAsync).toHaveBeenCalled();
  });
});
