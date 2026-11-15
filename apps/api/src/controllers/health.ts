import { Request, Response } from "express";

export async function livenessController(req: Request, res: Response) {
  //TODO: add checks if the application is live and healthy like checking the redis connection
  res.status(200).json({ status: "ok" });
}

export async function readinessController(req: Request, res: Response) {
  // TODO: add checks when the application is ready to serve traffic
  res.status(200).json({ status: "ok" });
}
