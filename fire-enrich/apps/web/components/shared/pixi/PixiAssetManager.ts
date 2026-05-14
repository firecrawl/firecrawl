import { Assets } from "pixi.js";

class PixiAssetManager {
  /**
   * Loads assets from the given sources
   * @param sources The source URLs of the assets
   * @returns A promise that resolves with the loaded asset(s)
   */
  public static load<T = any>(...sources: string[]): Promise<T> {
    if (sources.length === 0) {
      return Promise.reject(new Error("No sources provided"));
    }

    if (sources.length === 1) {
      const src = sources[0];

      return Assets.load(src) as Promise<T>;
    }

    // Handle multiple sources
    return Promise.all(
      sources.map((src) => this.load(src)),
    ) as unknown as Promise<T>;
  }
}

export default PixiAssetManager;
