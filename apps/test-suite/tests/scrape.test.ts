import request from "supertest";
import dotenv from "dotenv";
import { numTokensFromString } from "../utils/tokens";
import OpenAI from "openai";
import { WebsiteScrapeError } from "../utils/types";
import { logErrors } from "../utils/log";

import websitesData from "../data/scrape.json";
import "dotenv/config";

import fs from 'fs';
dotenv.config();

interface WebsiteData {
  website: string;
  prompt: string;
  expected_output: string;
}

const TEST_URL = "http://127.0.0.1:3002";

describe("Scraping Checkup (E2E)", () => {
  beforeAll(() => {
    if (!process.env.TEST_API_KEY) {
      throw new Error("TEST_API_KEY is not set");
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }
  });

  describe("Scraping website tests with a dataset", () => {
    it("Should scrape the website and prompt it against OpenAI", async () => {
      let totalTimeTaken = 0;
      let passedTests = 0;
      const batchSize = 15; // Adjusted to comply with the rate limit of 15 per minute
      const batchPromises = [];
      let totalTokens = 0;

      const startTime = new Date().getTime();
      const date = new Date();
      const logsDir = `logs/${date.getMonth() + 1}-${date.getDate()}-${date.getFullYear()}`;

      let errorLogFileName = `${logsDir}/run.log_${new Date().toTimeString().split(' ')[0]}`;
      const errorLog: WebsiteScrapeError[] = [];

      for (let i = 0; i < websitesData.length; i += batchSize) {
        // Introducing delay to respect the rate limit of 15 requests per minute
        await new Promise(resolve => setTimeout(resolve, 10000));

        const batch = websitesData.slice(i, i + batchSize);
        const batchPromise = Promise.all(
          batch.map(async (websiteData: WebsiteData) => {
            try {
              const startTime = new Date().getTime();
              const scrapedContent = await request(TEST_URL || "")
                .post("/v1/scrape")
                .set("Content-Type", "application/json")
                .set("Authorization", `Bearer ${process.env.TEST_API_KEY}`)
                .send({ url: websiteData.website });

              const endTime = new Date().getTime();
              const timeTaken = endTime - startTime;
              totalTimeTaken += timeTaken;

              if (scrapedContent.statusCode !== 200) {
                console.error(`Failed to scrape ${websiteData.website} ${scrapedContent.statusCode}`);
                errorLog.push({
                  website: websiteData.website,
                  prompt: websiteData.prompt,
                  expected_output: websiteData.expected_output,
                  actual_output: "",
                  error: `Failed to scrape website. ${scrapedContent.statusCode} ${scrapedContent.body.error}`
                });
                return null;
              }

              const openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
              });

              const prompt = `Based on this markdown extracted from a website html page, ${websiteData.prompt} Just say 'yes' or 'no' to the question.\nWebsite markdown: ${scrapedContent.body.data.markdown}\n`;

              let msg = null;
              const maxRetries = 3;
              let attempts = 0;
              while (!msg && attempts < maxRetries) {
                try {
                  msg = await openai.chat.completions.create({
                    model: "gpt-4-turbo",
                    max_tokens: 100,
                    temperature: 0,
                    messages: [
                      {
                        role: "user",
                        content: prompt
                      },
                    ],
                  });
                } catch (error) {
                  console.error(`Attempt ${attempts + 1}: Failed to prompt for ${websiteData.website}, error: ${error}`);
                  attempts++;
                  if (attempts < maxRetries) {
                    console.log(`Retrying... Attempt ${attempts + 1}`);
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds before retrying
                  }
                }
              }

              if (!msg) {
                console.error(`Failed to prompt for ${websiteData.website} after ${maxRetries} attempts`);
                errorLog.push({
                  website: websiteData.website,
                  prompt: websiteData.prompt,
                  expected_output: websiteData.expected_output,
                  actual_output: "",
                  error: "Failed to prompt... model error."
                });
                return null;
              }

              const actualOutput = (msg.choices[0].message.content ?? "").toLowerCase()
              const expectedOutput = websiteData.expected_output.toLowerCase();

              const numTokens = numTokensFromString(prompt, "gpt-4") + numTokensFromString(actualOutput, "gpt-4");

              totalTokens += numTokens;
              if (actualOutput.includes(expectedOutput)) {
                passedTests++;
              } else {
                console.error(
                  `This website failed the test: ${websiteData.website}`
                );
                console.error(`Actual output: ${actualOutput}`);
                errorLog.push({
                  website: websiteData.website,
                  prompt: websiteData.prompt,
                  expected_output: websiteData.expected_output,
                  actual_output: actualOutput,
                  error: "Output mismatch"
                });
              }

              return {
                website: websiteData.website,
                prompt: websiteData.prompt,
                expectedOutput,
                actualOutput,
              };
            } catch (error) {
              console.error(
                `Error processing ${websiteData.website}: ${error}`
              );
              errorLog.push({
                website: websiteData.website,
                prompt: websiteData.prompt,
                expected_output: websiteData.expected_output,
                actual_output: "",
                error: `Error processing ${websiteData.website}: ${error}`
              });
              return null;
            }
          })
        );
        batchPromises.push(batchPromise);
      }

      (await Promise.all(batchPromises)).flat();
      const score = (passedTests / websitesData.length) * 100;
      const endTime = new Date().getTime();
      const timeTaken = (endTime - startTime) / 1000;
      console.log(`Score: ${score}%`);
      console.log(`Total tokens: ${totalTokens}`);
      console.log(`Total time taken: ${totalTimeTaken} miliseconds`);

      await logErrors(errorLog, timeTaken, totalTokens, score, websitesData.length);

      if (process.env.ENV === "local" && errorLog.length > 0) {
        if (!fs.existsSync(logsDir)) {
          fs.mkdirSync(logsDir, { recursive: true });
        }
        fs.writeFileSync(errorLogFileName, JSON.stringify(errorLog, null, 2));
      }


      expect(score).toBeGreaterThanOrEqual(70);
    }, 350000); // 150 seconds timeout
  });
});
