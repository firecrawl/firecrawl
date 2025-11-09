import { createJobCancellationWatcher } from "../job-cancellation-watcher";
import { ScrapeJobCancelledError } from "../../../scraper/scrapeURL/error";
import type { Logger } from "winston";

jest.mock("../../job-cancellation", () => ({
  isScrapeJobCancelled: jest.fn(),
  getScrapeJobCancellationReason: jest.fn(),
}));

const { isScrapeJobCancelled, getScrapeJobCancellationReason } =
  jest.requireMock("../../job-cancellation");

const baseLogger = () =>
  ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as Logger;

describe("job cancellation watcher", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts and logs when redis flag is set", async () => {
    (isScrapeJobCancelled as jest.Mock).mockResolvedValue(true);
    (getScrapeJobCancellationReason as jest.Mock).mockResolvedValue(
      "client_disconnect",
    );
    const logger = baseLogger();

    const watcher = createJobCancellationWatcher("job-1", logger, 10);

    jest.advanceTimersByTime(15);
    await Promise.resolve();
    await Promise.resolve();

    expect(watcher.abortInstance.signal.aborted).toBe(true);
    await expect(watcher.throwIfCancelled()).rejects.toBeInstanceOf(
      ScrapeJobCancelledError,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Scrape job cancellation detected",
      expect.objectContaining({ jobId: "job-1", reason: "client_disconnect" }),
    );

    watcher.stop();
  });

  it("stops polling after stop() is called", async () => {
    (isScrapeJobCancelled as jest.Mock).mockResolvedValue(false);
    const logger = baseLogger();

    const watcher = createJobCancellationWatcher("job-2", logger, 10);
    await Promise.resolve();

    const callsBeforeStop = (isScrapeJobCancelled as jest.Mock).mock.calls
      .length;
    watcher.stop();

    jest.advanceTimersByTime(50);
    expect((isScrapeJobCancelled as jest.Mock).mock.calls.length).toBe(
      callsBeforeStop,
    );
  });

  it("throws when throwIfCancelled sees redis flag", async () => {
    (isScrapeJobCancelled as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const logger = baseLogger();

    const watcher = createJobCancellationWatcher("job-3", logger, 1000);
    watcher.stop();

    await expect(watcher.throwIfCancelled()).rejects.toBeInstanceOf(
      ScrapeJobCancelledError,
    );
  });
});
