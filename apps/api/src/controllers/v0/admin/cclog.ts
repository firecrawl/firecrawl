import { redisEvictConnection } from "../../../services/redis";
import { supabase_service } from "../../../services/supabase";
import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";

async function cclog() {
    const logger = _logger.child({
        module: "cclog",
    });

    let cursor = 0;
    do {
        const result = await redisEvictConnection.scan(cursor, "MATCH", "concurrency-limiter:*", "COUNT", 100000);
        cursor = parseInt(result[0], 10);
        const usable = result[1].filter(x => !x.includes("preview_"));

        logger.info("Stepped", { cursor, usable: usable.length });

        if (usable.length > 0) {
            const entries: {
                team_id: string;
                concurrency: number;
                created_at: Date;
            }[] = [];

            for (const x of usable) {
                const at = new Date();
                const concurrency = await redisEvictConnection.zrangebyscore(x, Date.now(), Infinity);
                if (concurrency) {
                    entries.push({
                        team_id: x.split(":")[1],
                        concurrency: concurrency.length,
                        created_at: at,
                    });
                }
            }

            try {
                await supabase_service.from("concurrency_log").insert(entries);
            } catch (e) {
                logger.error("Error inserting", { error: e });
            }
        }
    } while (cursor != 0);
}

export async function cclogController(req: Request, res: Response) {
    try {
        await cclog()
        res.status(200).json({ ok: true });
    } catch (e) {
        _logger.error("Error", { module: "cclog", error: e });
        res.status(500).json({
            message: "Error",
        });
    }
}
