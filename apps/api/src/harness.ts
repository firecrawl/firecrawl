import { exec } from "child_process";
import * as net from "net";

function waitForPort(port: number, host: string): Promise<void> {
    return new Promise((resolve) => {
        const checkPort = () => {
            const socket = new net.Socket();
            
            const onError = () => {
                socket.destroy();
                setTimeout(checkPort, 1000); // Try again in 1 second
            };

            socket.once('error', onError);
            
            socket.connect(port, host, () => {
                socket.destroy();
                resolve();
            });
        };
        
        checkPort();
    });
}

if (process.argv.length < 3) {
    console.error("Usage: pnpm harness <command...>");
    console.error()
    console.error("The harness ensures that the dependencies are up to date, everything is built, and the API and Worker are running, before running a command that would require the above.");
    console.error("It also tears down the API and Worker after the command is run.");
    process.exit(1);
}

const command = process.argv.slice(2);

function execForward(fancyName: string, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = exec(command);
        let stdoutBuffer = "";
        let stderrBuffer = "";
        child.stdout?.on("data", (data) => {
            stdoutBuffer += data;
            while(stdoutBuffer.includes("\n")) {
                const split = stdoutBuffer.split("\n");
                const line = split[0];
                stdoutBuffer = split.slice(1).join("\n");
                process.stdout.write(`[${fancyName}] ${line}\n`);
            }
        });
        child.stderr?.on("data", (data) => {
            stderrBuffer += data;
            while(stderrBuffer.includes("\n")) {
                const split = stderrBuffer.split("\n");
                const line = split[0];
                stderrBuffer = split.slice(1).join("\n");
                process.stderr.write(`[${fancyName}] ${line}\n`);
            }
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`Command ${JSON.stringify(command)} failed with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

(async () => {
    console.log("=== Installing dependencies and building all components...");
    await Promise.all([
        (async () => {
            const install = execForward("api@install", "pnpm install");
            await install;
        
            const build = execForward("api@build", "pnpm build");
            await build;
        })(),
        execForward("sharedLibs/crawler@build", "cd sharedLibs/crawler && cargo build --release"),
        execForward("sharedLibs/html-transformer@build", "cd sharedLibs/html-transformer && cargo build --release"),
        execForward("sharedLibs/pdf-parser@build", "cd sharedLibs/pdf-parser && cargo build --release"),
        (async () => {
            const install = execForward("sharedLibs/go-html-to-md@install", "cd sharedLibs/go-html-to-md && go mod tidy");
            await install;

            const build = execForward("sharedLibs/go-html-to-md@build", "cd sharedLibs/go-html-to-md && go build -o html-to-markdown.so -buildmode=c-shared html-to-markdown.go");
            await build;
        })(),
    ]);

    console.log("=== Starting API, Worker, and Index Worker...");

    const api = execForward("api", "pnpm start:production:nobuild");
    const worker = execForward("worker", "pnpm worker:production");
    const indexWorker = execForward("index-worker", "pnpm index-worker:production");

    try {
        await Promise.race([
            waitForPort(3002, "localhost"),
            new Promise((reject) => setTimeout(() => reject(new Error("API did not start in time")), 10000)),
        ]);
    
        console.log("=== Running command...");
    
        const cmd = execForward("command", command.join(" "));
    
        await Promise.race([
            cmd,
            api,
            worker,
            indexWorker,
        ]);
    } finally {
        console.log("=== Tearing down API, Worker, and Index Worker...");
        exec("pkill -f 'queue-worker.js'");
        exec("pkill -f 'index.js'");
        exec("pkill -f 'index-worker.js'");
        await Promise.all([
            api,
            worker,
            indexWorker,
        ]);
    }
    
    console.log("=== Goodbye!");
})();