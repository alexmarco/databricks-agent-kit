/** Export file format; it decides the result format requested from Databricks. */
export type ExportFormat = "csv" | "parquet" | "sqlite";

/** Lifecycle of an export; `SUCCEEDED`, `FAILED` and `CANCELED` are final. */
export type ExportStatus = "PENDING" | "DOWNLOADING" | "SUCCEEDED" | "FAILED" | "CANCELED";

/** Column of the result manifest, as reported by Databricks. */
export interface ManifestColumn {
  name: string;
  type_name: string;
  type_text: string;
  type_precision?: number;
  type_scale?: number;
  position: number;
}

/** Chunks, rows and bytes written so far. */
export interface ExportProgress {
  chunksDone: number;
  chunksTotal: number;
  rows: number;
  bytes: number;
}

/** State of one export as reported to the agent. */
export interface ExportState {
  id: string;
  statementId: string;
  format: ExportFormat;
  path: string;
  status: ExportStatus;
  progress?: ExportProgress;
  /** Files written once the export succeeded. */
  files?: string[];
  rows?: number;
  bytes?: number;
  /** True when Databricks cut the result at the byte limit. */
  truncated?: boolean;
  error?: string;
}

/** Destination of the downloaded chunks of one export. */
export interface ChunkSink {
  /** Called sequentially, in chunk order. */
  write(chunk: { index: number; rowCount: number; bytes: Uint8Array }): Promise<void>;
  /** Completes the output and returns the final files. */
  finish(): Promise<{ files: string[] }>;
  /** Discards partial output after a failure or cancellation. */
  abort(): Promise<void>;
}

/** What a sink needs to know about the export it writes. */
export interface SinkContext {
  id: string;
  dir: string;
  columns: ManifestColumn[];
}
