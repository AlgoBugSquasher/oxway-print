import { physicalSheetsForJob } from "./sheets";
import type { PrintJobRecord } from "../store";

export interface StackEstimate {
  stackPosition: number;
  sheetsAhead: number;
}

export function computeStackEstimate(jobsAhead: PrintJobRecord[]): StackEstimate {
  return {
    stackPosition: jobsAhead.length + 1,
    sheetsAhead: jobsAhead.reduce((sum, job) => sum + physicalSheetsForJob(job), 0),
  };
}
