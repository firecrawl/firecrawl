export interface OutputWriter {
  readonly isStdout: boolean;
  open(): Promise<void>;
  write(url: string, content: string | Buffer, ext: string): Promise<void>;
  close(): Promise<void>;
}
