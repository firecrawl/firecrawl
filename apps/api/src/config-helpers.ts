import { z } from "zod";

export const emptyStringAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(value => (value === "" ? undefined : value), schema.optional());
