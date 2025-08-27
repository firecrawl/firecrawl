import { configDotenv } from "dotenv";
configDotenv();

import { TeamFlags } from "../../controllers/v1/types";

// =========================================
// Configuration
// =========================================

export const TEST_URL = "http://127.0.0.1:3002";

// Due to the limited resources of the CI runner, we need to set a longer timeout for the many many scrape tests
export const scrapeTimeout = 90000;
export const indexCooldown = 30000;

// =========================================
// idmux
// =========================================

export type IdmuxRequest = {
    name: string,

    concurrency?: number,
    credits?: number,
    tokens?: number,
    flags?: TeamFlags,
    teamId?: string;
}

export async function idmux(req: IdmuxRequest): Promise<Identity> {
    if (!process.env.IDMUX_URL) {
        if (!process.env.TEST_SUITE_SELF_HOSTED) {
            console.warn("IDMUX_URL is not set, using test API key and team ID");
        }
        return {
            apiKey: process.env.TEST_API_KEY!,
            teamId: process.env.TEST_TEAM_ID!,
        }
    }

    let runNumber = parseInt(process.env.GITHUB_RUN_NUMBER!);
    if (isNaN(runNumber) || runNumber === null || runNumber === undefined) {
        runNumber = 0;
    }

    const res = await fetch(process.env.IDMUX_URL + "/", {
        method: "POST",
        body: JSON.stringify({
            refName: process.env.GITHUB_REF_NAME!,
            runNumber,
            concurrency: req.concurrency ?? 100,
            ...req,
        }),
        headers: {
            "Content-Type": "application/json",
        },
    });

    if (!res.ok) {
        console.error(await res.text());
    }

    expect(res.ok).toBe(true);
    return await res.json();
}

export type Identity = {
    apiKey: string;
    teamId: string;
}