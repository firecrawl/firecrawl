import axios from "axios";
import { promises as fs } from "fs";
import { v4 as uuidV4 } from "uuid";

interface Result {
  start_url: string;
  job_id?: string;
  idempotency_key?: string;
  result_data_jsonb?: any;
}

async function sendCrawl(result: Result): Promise<string | undefined> {
  const idempotencyKey = uuidV4();
  const url = result.start_url;
  try {
    const response = await axios.post(
      "https://staging-firecrawl-scraper-js.fly.dev/v0/crawl",
      {
        url: url,
        crawlerOptions: {
          limit: 75,
        },
        pageOptions: {
          includeHtml: true,
          replaceAllPathsWithAbsolutePaths: true,
          waitFor: 1000,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer `,
        },
      },
    );
    result.idempotency_key = idempotencyKey;
    return response.data.jobId;
  } catch (error) {
    console.error("Error sending crawl:", error);
    return undefined;
  }
}

async function getContent(result: Result): Promise<boolean> {
  let attempts = 0;
  while (attempts < 120) {
    // Reduce the number of attempts to speed up
    try {
      const response = await axios.get(
        `https://staging-firecrawl-scraper-js.fly.dev/v0/crawl/status/${result.job_id}`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer `,
          },
        },
      );
      if (response.data.status === "completed") {
        result.result_data_jsonb = response.data.data;
        // Job actually completed
        return true;
      }
    } catch (error) {
      console.error("Error getting content:", error);
    }
    const randomSleep = Math.floor(Math.random() * 15000) + 5000;
    await new Promise(resolve => setTimeout(resolve, randomSleep)); // Reduce sleep time to 1.5 seconds
    attempts++;
  }
  // Set result as null if timed out
  result.result_data_jsonb = null;
  return false;
}

async function processResults(results: Result[]): Promise<void> {
  let processedCount = 0;
  let starterCount = 0;
  const queue: Result[] = [];
  const processedUrls = new Set<string>();

  // Initialize the queue with the first 1000 results
  for (let i = 0; i < Math.min(100, results.length); i++) {
    queue.push(results[i]);
    processedUrls.add(results[i].start_url);
  }

  // Function to process a single result
  const processSingleResult = async (result: Result) => {
    const jobId = await sendCrawl(result);
    if (jobId) {
      console.log(`Job requested count: ${starterCount}`);
      starterCount++;
      result.job_id = jobId;
      processedCount++;
      // Save the result to the file
      try {
        // Save job id along with the start_url
        const resultWithJobId = results.map(r => ({
          start_url: r.start_url,
          job_id: r.job_id,
        }));
        await fs.writeFile(
          "results_with_job_id_4000_6000.json",
          JSON.stringify(resultWithJobId, null, 4),
        );
      } catch (error) {
        console.error("Error writing to results_with_content.json:", error);
      }

      // Add a new result to the queue if there are more results to process
      // if (processedCount < results.length) {
      //   for (let i = queue.length; i < results.length; i++) {
      //     if (!processedUrls.has(results[i].start_url)) {
      //       const nextResult = results[i];
      //       console.log("Next result:", nextResult.start_url);
      //       queue.push(nextResult);
      //       processedUrls.add(nextResult.start_url);
      //       console.log(`Queue length: ${queue.length}`);
      //       processSingleResult(nextResult);
      //       break;
      //     }
      //   }
      // }
    }
  };

  // Start processing the initial queue concurrently
  // for (let i = 0; i < queue.length; i++) {
  //   processSingleResult(queue[i]);
  //   if ((i + 1) % 500 === 0) {
  //     console.log(`Processed ${i + 1} results, waiting for 1 minute before adding the next batch...`);
  //     await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait for 1 minute
  //   }
  // }
  // Start processing the initial queue concurrently
  // await Promise.all(queue.map(result => processSingleResult(result)));
  for (let i = 0; i < results.length; i += 100) {
    const batch = results.slice(i, i + 100);
    Promise.all(batch.map(result => processSingleResult(result)))
      .then(() => {
        console.log(`Processed ${i + 100} results.`);
      })
      .catch(error => {
        console.error(`Error processing batch starting at index ${i}:`, error);
      });
    await new Promise(resolve => setTimeout(resolve, 60 * 1000)); // Wait for 1 minute
  }
}

// Example call

async function getStartUrls(): Promise<Result[]> {
  try {
    const data = await fs.readFile("starturls.json", "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading starturls.json:", error);
    return [];
  }
}

async function main() {
  const results: Result[] = (await getStartUrls()).slice(3999, 6000);
  // console.log(results.map((r) => r.start_url).slice(0, 3));

  processResults(results)
    .then(() => {
      console.log("All results processed.");
    })
    .catch(error => {
      console.error("Error processing results:", error);
    });
}

main();
