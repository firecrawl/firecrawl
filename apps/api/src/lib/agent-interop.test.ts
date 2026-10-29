vi.mock("../config", () => ({
  config: { AGENT_INTEROP_SECRET: "agent-secret" },
}));

import {
  AGENT_INTEROP_HEADER,
  agentInteropStatus,
  isTrustedAgentInteropRequest,
} from "./agent-interop";

const GOOD = "agent-secret";
const BAD = "not-the-secret";

type Place = typeof GOOD | typeof BAD | undefined;

function req(body: Place, header: Place) {
  return {
    body:
      body === undefined
        ? {}
        : { __agentInterop: { auth: body, requestId: "r", shouldBill: true } },
    headers: header === undefined ? {} : { [AGENT_INTEROP_HEADER]: header },
  };
}

describe("agentInteropStatus", () => {
  it.each([
    ["nothing sent", "none", undefined, undefined],
    ["valid body only", "trusted", GOOD, undefined],
    ["valid header only", "trusted", undefined, GOOD],
    ["both valid", "trusted", GOOD, GOOD],
    ["wrong body only", "invalid", BAD, undefined],
    ["wrong header only", "invalid", undefined, BAD],
    ["valid header, wrong body", "invalid", BAD, GOOD],
    ["wrong header, valid body", "invalid", GOOD, BAD],
    ["both wrong", "invalid", BAD, BAD],
  ] as const)("%s is %s", (_name, expected, body, header) => {
    expect(agentInteropStatus(req(body, header))).toBe(expected);
    expect(isTrustedAgentInteropRequest(req(body, header))).toBe(
      expected === "trusted",
    );
  });

  it("treats a block without auth as a wrong secret", () => {
    expect(agentInteropStatus({ body: { __agentInterop: {} } })).toBe(
      "invalid",
    );
  });

  it("treats a repeated header as a wrong secret", () => {
    expect(
      agentInteropStatus({ headers: { [AGENT_INTEROP_HEADER]: [GOOD] } }),
    ).toBe("invalid");
  });

  it("treats a missing body or headers as nothing sent", () => {
    expect(agentInteropStatus({})).toBe("none");
  });
});
