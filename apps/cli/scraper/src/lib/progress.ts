/** Progress from a preparation step, such as building whisper.cpp or starting the local API. */
export type StepEvent = { type: "step"; label: string } | { type: "log"; line: string };
