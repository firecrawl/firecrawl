import si from "systeminformation";
import { Mutex } from "async-mutex";
import os from "os";
import fs from "fs";
import { logger } from "../lib/logger";

const IS_KUBERNETES = process.env.IS_KUBERNETES === "true";

const MAX_CPU = process.env.MAX_CPU ? parseFloat(process.env.MAX_CPU) : 0.8;
const MAX_RAM = process.env.MAX_RAM ? parseFloat(process.env.MAX_RAM) : 0.8;
const CACHE_DURATION = process.env.SYS_INFO_MAX_CACHE_DURATION
  ? parseFloat(process.env.SYS_INFO_MAX_CACHE_DURATION)
  : 150;

class SystemMonitor {
  private static instance: SystemMonitor;
  private static instanceMutex = new Mutex();

  private cpuUsageCache: number | null = null;
  private memoryUsageCache: number | null = null;
  private lastCpuCheck: number = 0;
  private lastMemoryCheck: number = 0;

  // Variables for CPU usage calculation
  private previousCpuUsage: number = 0;
  private previousTime: number = Date.now();

  private constructor() {}

  public static async getInstance(): Promise<SystemMonitor> {
    if (SystemMonitor.instance) {
      return SystemMonitor.instance;
    }

    await this.instanceMutex.runExclusive(async () => {
      if (!SystemMonitor.instance) {
        SystemMonitor.instance = new SystemMonitor();
      }
    });

    return SystemMonitor.instance;
  }

  public async checkMemoryUsage() {
    if (IS_KUBERNETES) {
      return this._checkMemoryUsageKubernetes();
    }
    return this._checkMemoryUsage();
  }

  private readMemoryCurrent(): number {
    const data = fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8");
    return parseInt(data.trim(), 10);
  }

  private readMemoryMax(): number {
    const data = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (data === "max") {
      return Infinity;
    }
    return parseInt(data, 10);
  }
  private async _checkMemoryUsageKubernetes() {
    try {
      const currentMemoryUsage = this.readMemoryCurrent();
      const memoryLimit = this.readMemoryMax();

      let memoryUsagePercentage: number;

      if (memoryLimit === Infinity) {
        // No memory limit set; use total system memory
        const totalMemory = os.totalmem();
        memoryUsagePercentage = currentMemoryUsage / totalMemory;
      } else {
        memoryUsagePercentage = currentMemoryUsage / memoryLimit;
      }

      // console.log("Memory usage:", memoryUsagePercentage);

      return memoryUsagePercentage;
    } catch (error) {
      logger.error(`Error calculating memory usage: ${error}`);
      return 0; // Fallback to 0% usage
    }
  }

  private async _checkMemoryUsage() {
    const now = Date.now();
    if (
      this.memoryUsageCache !== null &&
      now - this.lastMemoryCheck < CACHE_DURATION
    ) {
      return this.memoryUsageCache;
    }

    const memoryData = await si.mem();
    const totalMemory = memoryData.total;
    const availableMemory = memoryData.available;
    const usedMemory = totalMemory - availableMemory;
    const usedMemoryPercentage = usedMemory / totalMemory;

    this.memoryUsageCache = usedMemoryPercentage;
    this.lastMemoryCheck = now;

    return usedMemoryPercentage;
  }

  public async checkCpuUsage() {
    if (IS_KUBERNETES) {
      return this._checkCpuUsageKubernetes();
    }
    return this._checkCpuUsage();
  }
  private readCpuUsage(): number {
    const data = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
    const match = data.match(/^usage_usec (\d+)$/m);
    if (match) {
      return parseInt(match[1], 10);
    }
    throw new Error("Could not read usage_usec from cpu.stat");
  }

  private getNumberOfCPUs(): number {
    let cpus: number[] = [];
    try {
      const cpusetPath = "/sys/fs/cgroup/cpuset.cpus.effective";
      const data = fs.readFileSync(cpusetPath, "utf8").trim();

      if (!data) {
        throw new Error(`${cpusetPath} is empty.`);
      }

      cpus = this.parseCpuList(data);

      if (cpus.length === 0) {
        throw new Error("No CPUs found in cpuset.cpus.effective");
      }
    } catch (error) {
      logger.warn(
        `Unable to read cpuset.cpus.effective, defaulting to OS CPUs: ${error}`,
      );
      cpus = os.cpus().map((cpu, index) => index);
    }
    return cpus.length;
  }

  private parseCpuList(cpuList: string): number[] {
    const ranges = cpuList.split(",");
    const cpus: number[] = [];
    ranges.forEach(range => {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr, 10);
      const end = endStr !== undefined ? parseInt(endStr, 10) : start;
      for (let i = start; i <= end; i++) {
        cpus.push(i);
      }
    });
    return cpus;
  }
  private async _checkCpuUsageKubernetes() {
    try {
      const usage = this.readCpuUsage(); // In microseconds (µs)
      const now = Date.now();

      // Check if it's the first run
      if (this.previousCpuUsage === 0) {
        // Initialize previous values
        this.previousCpuUsage = usage;
        this.previousTime = now;
        // Return 0% CPU usage on first run
        return 0;
      }

      const deltaUsage = usage - this.previousCpuUsage; // In µs
      const deltaTime = (now - this.previousTime) * 1000; // Convert ms to µs

      const numCPUs = this.getNumberOfCPUs(); // Get the number of CPUs

      // Calculate the CPU usage percentage and normalize by the number of CPUs
      const cpuUsagePercentage = deltaUsage / deltaTime / numCPUs;

      // Update previous values
      this.previousCpuUsage = usage;
      this.previousTime = now;

      // console.log("CPU usage:", cpuUsagePercentage);

      return cpuUsagePercentage;
    } catch (error) {
      logger.error(`Error calculating CPU usage: ${error}`);
      return 0; // Fallback to 0% usage
    }
  }

  private async _checkCpuUsage() {
    const now = Date.now();
    if (
      this.cpuUsageCache !== null &&
      now - this.lastCpuCheck < CACHE_DURATION
    ) {
      return this.cpuUsageCache;
    }

    const cpuData = await si.currentLoad();
    const cpuLoad = cpuData.currentLoad / 100;

    this.cpuUsageCache = cpuLoad;
    this.lastCpuCheck = now;

    return cpuLoad;
  }

  public async acceptConnection() {
    const cpuUsage = await this.checkCpuUsage();
    const memoryUsage = await this.checkMemoryUsage();

    return cpuUsage < MAX_CPU && memoryUsage < MAX_RAM;
  }

  public clearCache() {
    this.cpuUsageCache = null;
    this.memoryUsageCache = null;
    this.lastCpuCheck = 0;
    this.lastMemoryCheck = 0;
  }
}

export default SystemMonitor.getInstance();
