declare module "parse-diff" {
  interface NormalChange {
    type: "normal";
    normal: true;
    ln1: number;
    ln2: number;
    content: string;
  }

  interface AddChange {
    type: "add";
    add: true;
    ln: number;
    content: string;
  }

  interface DeleteChange {
    type: "del";
    del: true;
    ln: number;
    content: string;
  }

  type Change = NormalChange | AddChange | DeleteChange;

  interface Chunk {
    content: string;
    changes: Change[];
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }

  interface File {
    chunks: Chunk[];
    deletions: number;
    additions: number;
    from: string | null;
    to: string | null;
    index?: string[];
    newMode?: string;
    oldMode?: string;
    binary?: boolean;
  }

  function parseDiff(diff: string): File[];
  export = parseDiff;
}
