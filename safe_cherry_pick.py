import subprocess
import sys

LOCKED_FILES = [
    "scrape-worker.ts",
    "nuq.ts",
    "crawl-redis.ts",
    "queue-jobs.ts",
    "auth.ts",
    "supabase-"
]

BOUNDARY_FILES = [
    "apps/api/src/__tests__/snips/v2/document-converter.test.ts",
    "apps/api/src/lib/__tests__/html-transformer.test.ts",
    "apps/api/src/lib/engpicker.ts",
    "apps/api/src/lib/html-to-markdown.ts",
    "apps/api/src/lib/native-logging.ts",
    "apps/api/src/scraper/WebScraper/crawler.ts",
    "apps/api/src/scraper/WebScraper/sitemap.ts",
    "apps/api/src/scraper/crawler/sitemap.ts",
    "apps/api/src/scraper/scrapeURL/engines/document/index.ts",
    "apps/api/src/scraper/scrapeURL/engines/fire-engine/index.ts",
    "apps/api/src/scraper/scrapeURL/engines/pdf/index.ts",
    "apps/api/src/scraper/scrapeURL/engines/playwright/index.ts",
    "apps/api/src/scraper/scrapeURL/lib/extractAttributes.ts",
    "apps/api/src/scraper/scrapeURL/lib/extractImages.ts",
    "apps/api/src/scraper/scrapeURL/lib/extractLinks.ts",
    "apps/api/src/scraper/scrapeURL/lib/extractMetadata.ts",
    "apps/api/src/scraper/scrapeURL/lib/removeUnwantedElements.ts"
]

def run(cmd, cwd=None):
    print(f"RUNNING: {cmd}")
    res = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd)
    if res.returncode != 0:
        print(f"FAILED: {cmd}\n{res.stdout}\n{res.stderr}")
    return res

commits = sys.argv[1:]

for commit in commits:
    print(f"\n--- Processing {commit} ---")
    res = run(f"git cherry-pick {commit}")
    auto_resolved = False
    if res.returncode != 0:
        status_res = run("git diff --name-only --diff-filter=U")
        conflicted_files = status_res.stdout.strip().split('\n')
        
        if conflicted_files == ["apps/js-sdk/firecrawl/package.json"]:
            with open("apps/js-sdk/firecrawl/package.json", "r") as f:
                content = f.read()
            if content.count("<<<<<<< HEAD") == 1 and "<<<<<<< HEAD\n  \"version\":" in content:
                import re
                resolved_content = re.sub(r'<<<<<<< HEAD\n  "version": "[^"]+",\n=======\n  "version": "[^"]+",\n>>>>>>> [^\n]+\n',
                                          r'  "version": "4.25.2",\n', content)
                with open("apps/js-sdk/firecrawl/package.json", "w") as f:
                    f.write(resolved_content)
                run("git add apps/js-sdk/firecrawl/package.json")
                run("pnpm install")
                run("git add -u")
                run("git commit --no-edit")
                auto_resolved = True
                print(f"Auto-resolved: version-field-only conflict in package.json for {commit}.")
            else:
                print("Conflict is not just version field. Aborting.")
                run("git cherry-pick --abort")
                sys.exit(1)
        else:
            print(f"Conflicts in unapproved files: {conflicted_files}. Aborting.")
            run("git cherry-pick --abort")
            sys.exit(1)
        
    res = run("git diff HEAD~1..HEAD --name-only")
    files = res.stdout.strip().split('\n')
    
    # Check locked files
    dropped_for_locked = False
    for f in files:
        if dropped_for_locked: break
        for locked in LOCKED_FILES:
            if locked in f:
                print(f"LOCKED FILE VIOLATION: {f} matches {locked}. Dropping commit.")
                run("git reset --hard HEAD~1")
                dropped_for_locked = True
                break

    if dropped_for_locked:
        continue # skip to next commit
        
    # Check boundary
    touches_boundary = False
    for f in files:
        if f in BOUNDARY_FILES or f.startswith("apps/api/native/src/"):
            print(f"RUST BOUNDARY TOUCHED: {f}")
            touches_boundary = True
            
    # Check TSC
    print("Running TSC...")
    res = run("npx tsc --noEmit", cwd="apps/api")
    if res.returncode != 0:
        print("TSC FAILED. Dropping commit and halting.")
        run("git reset --hard HEAD~1")
        sys.exit(1)
        
    if touches_boundary:
        print("Running full Docker build for boundary check...")
        res = run("docker compose build api")
        if res.returncode != 0:
            print("DOCKER BUILD FAILED. Dropping commit and halting.")
            run("git reset --hard HEAD~1")
            sys.exit(1)
            
    print(f"Commit {commit} passed all checks.")

print("All commits processed successfully!")
