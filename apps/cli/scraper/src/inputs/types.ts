export interface InputSource {
  read(): AsyncIterable<string>;
}
