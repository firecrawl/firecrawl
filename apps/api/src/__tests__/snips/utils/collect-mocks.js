const path = require("path");
const fs = require("fs");

const mocksDirPath = path.join(__dirname, "../../../scraper/scrapeURL/mocks");
const files = fs.readdirSync(mocksDirPath);

const contents = files.map(x =>
  JSON.parse(fs.readFileSync(path.join(mocksDirPath, x), "utf8")),
);

fs.writeFileSync(
  path.join(__dirname, "../mocks/" + process.argv[2] + ".json"),
  JSON.stringify(contents, undefined, 4),
);
