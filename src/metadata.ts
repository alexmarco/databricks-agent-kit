import type { DatabricksClient, QueryValue } from "./client.ts";
import { InvalidArgumentError, UnsupportedError } from "./errors.ts";
import { SqlError, type StatementLifecycle, type StatementResult } from "./statements.ts";

const MAX_PAGES = 50;
const DEFAULT_SAMPLE_ROWS = 10;
const MAX_SAMPLE_ROWS = 100;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const LINEAGE_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const LINEAGE_UNAVAILABLE = /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS/;

/** Catalog or schema with its comment. */
export interface NamedItem {
  name: string;
  comment: string | undefined;
}

/** Table or view in a schema listing; `type` is the Unity Catalog table type, such as `MANAGED` or `VIEW`. */
export interface TableSummary extends NamedItem {
  type: string | undefined;
}

/** Column of a described table, with its Unity Catalog tags when readable. */
export interface ColumnDescription {
  name: string;
  type: string;
  nullable: boolean | undefined;
  comment: string | undefined;
  tags?: Record<string, string>;
}

/** What an agent needs to write SQL against a table; `notes` explains parts that could not be read. */
export interface TableDescription {
  fullName: string;
  type?: string;
  format?: string;
  comment?: string;
  owner?: string;
  columns: ColumnDescription[];
  primaryKey?: string[];
  foreignKeys?: Array<{ columns: string[]; references: string; referencedColumns: string[] }>;
  clusteringColumns?: string[];
  partitionColumns?: string[];
  tags?: Record<string, string>;
  notes?: string[];
}

/** Table (`kind` = `table`, `column` null) or column whose name or comment matched the search. */
export interface SearchResult {
  kind: string | null;
  catalog: string | null;
  schema: string | null;
  table: string | null;
  column: string | null;
  comment: string | null;
}

/** Related table in the lineage system tables and when the relation was last seen. */
export interface LineageEdge {
  table: string | null;
  lastSeen: string | null;
}

/** Result of {@link MetadataService.describeTable}: the description plus the optional sample and lineage. */
export type DescribeTableResult = TableDescription & {
  sample?: StatementResult;
  lineage?: { upstream: LineageEdge[]; downstream: LineageEdge[] };
};

/** Objects found at one level of the Unity Catalog hierarchy; `truncated` is true when more matched than were returned. */
export interface ObjectListing {
  level: "catalogs" | "schemas" | "tables";
  items: Array<NamedItem | TableSummary>;
  truncated: boolean;
}

interface ApiTable {
  full_name: string;
  name?: string;
  table_type?: string;
  data_source_format?: string;
  comment?: string;
  owner?: string;
  columns?: Array<{ name: string; type_text: string; nullable?: boolean; comment?: string; partition_index?: number }>;
  table_constraints?: Array<{
    primary_key_constraint?: { child_columns: string[] };
    foreign_key_constraint?: { child_columns: string[]; parent_table: string; parent_columns: string[] };
  }>;
  properties?: Record<string, string>;
}

function splitName(fullName: string): string[] {
  const parts = fullName.split(".");
  if (parts.length > 3 || parts.some((part) => part.trim() === "")) {
    throw new InvalidArgumentError(`Invalid table name '${fullName}': use catalog.schema.table.`);
  }
  return parts;
}

/**
 * Quotes each part of a one- to three-part name with backticks, escaping embedded backticks.
 * @throws {InvalidArgumentError} When the name has more than three parts or an empty part.
 */
export function quoteIdentifier(fullName: string): string {
  return splitName(fullName)
    .map((part) => `\`${part.replaceAll("`", "``")}\``)
    .join(".");
}

function matchesPattern(name: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern === "") return true;
  if (!/[*?]/.test(pattern)) return name.toLowerCase().includes(pattern.toLowerCase());
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${regex}$`, "i").test(name);
}

function rowsOf(result: StatementResult): Array<Array<string | null>> {
  return result.rows ?? [];
}

function parseClustering(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => (Array.isArray(entry) ? entry.join(".") : String(entry)));
  } catch {
    return undefined;
  }
  return undefined;
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.max(1, Math.min(Math.trunc(value ?? fallback), max));

/**
 * Creates the Unity Catalog metadata service: REST listings and descriptions, plus information_schema and lineage
 * queries that the server writes itself (they skip the read-only check).
 */
export function createMetadataService(client: DatabricksClient, statements: Pick<StatementLifecycle, "query">) {
  async function paginate<T>(path: string, key: string, query: Record<string, QueryValue>): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.get<Record<string, unknown>>(path, { ...query, page_token: pageToken });
      items.push(...((response[key] as T[] | undefined) ?? []));
      pageToken = response.next_page_token as string | undefined;
      if (pageToken === undefined || pageToken === "") break;
    }
    return items;
  }

  async function listCatalogs(): Promise<NamedItem[]> {
    const catalogs = await paginate<NamedItem>("/api/2.1/unity-catalog/catalogs", "catalogs", {});
    return catalogs.map((catalog) => ({ name: catalog.name, comment: catalog.comment }));
  }

  async function listSchemas(catalog: string): Promise<NamedItem[]> {
    const schemas = await paginate<NamedItem>("/api/2.1/unity-catalog/schemas", "schemas", { catalog_name: catalog });
    return schemas.map((schema) => ({ name: schema.name, comment: schema.comment }));
  }

  async function listTables(catalog: string, schema: string): Promise<TableSummary[]> {
    const tables = await paginate<ApiTable & { name: string }>("/api/2.1/unity-catalog/tables", "tables", {
      catalog_name: catalog,
      schema_name: schema,
      omit_columns: true,
    });
    return tables.map((table) => ({ name: table.name, type: table.table_type, comment: table.comment }));
  }

  /** Lists catalogs, the schemas of a catalog, or the tables of a schema; the pattern is applied before the limit. */
  async function listObjects(request: { catalog?: string | undefined; schema?: string | undefined; pattern?: string | undefined; limit?: number | undefined }): Promise<ObjectListing> {
    if (request.schema !== undefined && request.catalog === undefined) {
      throw new InvalidArgumentError("'schema' requires 'catalog': pass both to list tables.");
    }
    const limit = clamp(request.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const level = request.catalog === undefined ? "catalogs" : request.schema === undefined ? "schemas" : "tables";
    const all: Array<NamedItem | TableSummary> =
      level === "catalogs" ? await listCatalogs() : level === "schemas" ? await listSchemas(request.catalog ?? "") : await listTables(request.catalog ?? "", request.schema ?? "");
    const matching = all.filter((item) => matchesPattern(item.name, request.pattern));
    return { level, items: matching.slice(0, limit), truncated: matching.length > limit };
  }

  async function readTags(fullName: string): Promise<{ table: Record<string, string>; columns: Map<string, Record<string, string>> }> {
    const [catalog, schema, table] = splitName(fullName);
    const filter = "catalog_name = :catalog AND schema_name = :schema AND table_name = :table";
    const result = await statements.query({
      statement:
        `SELECT NULL AS column_name, tag_name, tag_value FROM system.information_schema.table_tags WHERE ${filter} ` +
        `UNION ALL SELECT column_name, tag_name, tag_value FROM system.information_schema.column_tags WHERE ${filter}`,
      parameters: [
        { name: "catalog", value: catalog ?? "" },
        { name: "schema", value: schema ?? "" },
        { name: "table", value: table ?? "" },
      ],
      rowLimit: 1000,
    });
    const tableTags: Record<string, string> = {};
    const columnTags = new Map<string, Record<string, string>>();
    for (const [column, tagName, tagValue] of rowsOf(result)) {
      if (tagName === null || tagName === undefined) continue;
      const target = column === null || column === undefined ? tableTags : (columnTags.get(column) ?? {});
      target[tagName] = tagValue ?? "";
      if (column !== null && column !== undefined) columnTags.set(column, target);
    }
    return { table: tableTags, columns: columnTags };
  }

  async function describeTable(fullName: string, options: { sampleRows?: number | undefined; lineage?: boolean | undefined } = {}): Promise<DescribeTableResult> {
    splitName(fullName);
    const table = await client.get<ApiTable>(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
    const notes: string[] = [];
    let tags: Awaited<ReturnType<typeof readTags>> | undefined;
    try {
      tags = await readTags(table.full_name);
    } catch (error) {
      notes.push(`Tags unavailable: ${(error as Error).message}`);
    }

    const columns = (table.columns ?? []).map((column): ColumnDescription => {
      const columnTags = tags?.columns.get(column.name);
      return {
        name: column.name,
        type: column.type_text,
        nullable: column.nullable,
        comment: column.comment,
        ...(columnTags === undefined ? {} : { tags: columnTags }),
      };
    });
    const primaryKey = table.table_constraints?.find((constraint) => constraint.primary_key_constraint)?.primary_key_constraint?.child_columns;
    const foreignKeys = (table.table_constraints ?? [])
      .flatMap((constraint) => (constraint.foreign_key_constraint === undefined ? [] : [constraint.foreign_key_constraint]))
      .map((foreignKey) => ({ columns: foreignKey.child_columns, references: foreignKey.parent_table, referencedColumns: foreignKey.parent_columns }));
    const clusteringColumns = parseClustering(table.properties?.clusteringColumns);
    const partitionColumns = (table.columns ?? [])
      .filter((column) => column.partition_index !== undefined)
      .sort((left, right) => (left.partition_index ?? 0) - (right.partition_index ?? 0))
      .map((column) => column.name);

    let sample: StatementResult | undefined;
    if (options.sampleRows !== undefined && options.sampleRows > 0) {
      try {
        sample = await sampleTable(table.full_name, options.sampleRows);
      } catch (error) {
        if (!(error instanceof SqlError)) throw error;
        notes.push(`Sample unavailable: ${error.message}`);
      }
    }
    let lineage: DescribeTableResult["lineage"];
    if (options.lineage === true) {
      try {
        lineage = { upstream: await lineageQuery(table.full_name, "upstream"), downstream: await lineageQuery(table.full_name, "downstream") };
      } catch (error) {
        if (error instanceof UnsupportedError) notes.push(error.message);
        else if (error instanceof SqlError) notes.push(`Lineage unavailable: ${error.message}`);
        else throw error;
      }
    }

    return {
      fullName: table.full_name,
      ...(table.table_type === undefined ? {} : { type: table.table_type }),
      ...(table.data_source_format === undefined ? {} : { format: table.data_source_format }),
      ...(table.comment === undefined ? {} : { comment: table.comment }),
      ...(table.owner === undefined ? {} : { owner: table.owner }),
      columns,
      ...(primaryKey === undefined ? {} : { primaryKey }),
      ...(foreignKeys.length === 0 ? {} : { foreignKeys }),
      ...(clusteringColumns === undefined ? {} : { clusteringColumns }),
      ...(partitionColumns.length === 0 ? {} : { partitionColumns }),
      ...(tags === undefined ? {} : { tags: tags.table }),
      ...(notes.length === 0 ? {} : { notes }),
      ...(sample === undefined ? {} : { sample }),
      ...(lineage === undefined ? {} : { lineage }),
    };
  }

  async function searchMetadata(request: { query: string; catalog?: string | undefined; limit?: number | undefined }): Promise<SearchResult[]> {
    const limit = clamp(request.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const catalogFilter = request.catalog === undefined ? "" : " AND table_catalog = :catalog";
    const statement =
      `SELECT 'table' AS kind, table_catalog, table_schema, table_name, CAST(NULL AS STRING) AS column_name, comment ` +
      `FROM system.information_schema.tables WHERE (lower(table_name) LIKE :pattern OR lower(comment) LIKE :pattern)${catalogFilter} ` +
      `UNION ALL SELECT 'column', table_catalog, table_schema, table_name, column_name, comment ` +
      `FROM system.information_schema.columns WHERE (lower(column_name) LIKE :pattern OR lower(comment) LIKE :pattern)${catalogFilter} ` +
      `LIMIT ${limit}`;
    const result = await statements.query({
      statement,
      parameters: [
        { name: "pattern", value: `%${request.query.toLowerCase()}%` },
        ...(request.catalog === undefined ? [] : [{ name: "catalog", value: request.catalog }]),
      ],
      rowLimit: limit,
    });
    return rowsOf(result).map(([kind, catalog, schema, table, column, comment]) => ({
      kind: kind ?? null,
      catalog: catalog ?? null,
      schema: schema ?? null,
      table: table ?? null,
      column: column ?? null,
      comment: comment ?? null,
    }));
  }

  async function sampleTable(fullName: string, limit?: number): Promise<StatementResult> {
    const rows = clamp(limit, DEFAULT_SAMPLE_ROWS, MAX_SAMPLE_ROWS);
    return statements.query({ statement: `SELECT * FROM ${quoteIdentifier(fullName)} LIMIT ${rows}`, rowLimit: rows });
  }

  async function lineageQuery(fullName: string, direction: "upstream" | "downstream"): Promise<LineageEdge[]> {
    const [selected, filtered] = direction === "upstream" ? ["source_table_full_name", "target_table_full_name"] : ["target_table_full_name", "source_table_full_name"];
    const statement =
      `SELECT ${selected} AS table_name, CAST(max(event_time) AS STRING) AS last_seen FROM system.access.table_lineage ` +
      `WHERE ${filtered} = :table AND ${selected} IS NOT NULL GROUP BY ${selected} ORDER BY last_seen DESC LIMIT ${LINEAGE_LIMIT}`;
    try {
      const result = await statements.query({ statement, parameters: [{ name: "table", value: fullName }], rowLimit: LINEAGE_LIMIT });
      return rowsOf(result).map(([table, lastSeen]) => ({ table: table ?? null, lastSeen: lastSeen ?? null }));
    } catch (error) {
      const message = (error as Error).message;
      if (LINEAGE_UNAVAILABLE.test(message)) {
        throw new UnsupportedError(
          `Lineage is unavailable: system.access.table_lineage cannot be read (${message}). It requires Unity Catalog system tables (system.access) to be enabled and SELECT on them.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  return { listObjects, describeTable, searchMetadata };
}

/** Methods returned by {@link createMetadataService}. */
export type MetadataService = ReturnType<typeof createMetadataService>;
