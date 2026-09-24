import { Request, Response } from "express";

export async function livenessController(req: Request, res: Response) {
  // Liveness is intentionally dependency-independent: serving this handler proves
  // the process can accept work, while readiness reports dependency health.
  res.status(200).json({ status: "ok" });
}
