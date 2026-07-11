import { afterEach, expect, test, vi } from "vitest";
import {
  completePreparedNuQPgPublication,
  prepareNuQPgPublication,
  setNuQPgPublicationAdapter,
  type NuQPgPublication,
} from "./nuq-pg-publication";

const publication: NuQPgPublication = {
  id: "018f0000-0000-7000-8000-000000000001",
  ownerId: "018f0000-0000-7000-8000-000000000002",
  placement: "backlog",
};

afterEach(() => setNuQPgPublicationAdapter(null));

test("unregistered PG publication boundary fails closed", async () => {
  setNuQPgPublicationAdapter(null);
  await expect(prepareNuQPgPublication([publication])).rejects.toMatchObject({
    code: "NUQ_PG_PUBLICATION_ADAPTER_UNAVAILABLE",
    retryable: true,
  });
});

test("injectable PG publication boundary forwards prepare and complete", async () => {
  const prepare = vi.fn(async () => {});
  const complete = vi.fn(async () => {});
  setNuQPgPublicationAdapter({
    prepare,
    validateUnderPublicationLock: vi.fn(),
    complete,
    retire: vi.fn(),
  });

  const prepared = await prepareNuQPgPublication([publication]);
  setNuQPgPublicationAdapter(null);
  await completePreparedNuQPgPublication(prepared);

  expect(prepare).toHaveBeenCalledWith([publication]);
  expect(complete).toHaveBeenCalledWith([publication], "published");
});
