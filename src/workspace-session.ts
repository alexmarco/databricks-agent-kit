import type { AuthMethod, AuthProvider, FetchLike } from "./auth.ts";
import type { ClientDependencies, DatabricksClient } from "./client.ts";
import { createExecutionScope, type ExecutionScope } from "./execution-scope.ts";
import { createExportManager, type ExportManager } from "./export/manager.ts";
import type { LogService } from "./logging/service.ts";
import { createMetadataService, type MetadataService } from "./metadata.ts";
import { createStatementLifecycle, type StatementLifecycle, type StatementLifecycleOptions } from "./statements.ts";
import { createWarehouseSelection, type WarehouseSelection } from "./warehouses.ts";

/** Real or fake counterparts of everything that touches the network, the files or the Databricks CLI. */
export interface WorkspaceAdapters {
  /** Resolves credentials; `onRefresh` is called each time an OAuth token is fetched. */
  resolveAuth(onRefresh?: (method: AuthMethod) => void): Promise<AuthProvider>;
  /** Creates the REST client for the credentials; `observers` are the optional hooks of the client. */
  createClient(auth: AuthProvider, observers: Pick<ClientDependencies, "onRetry" | "onRequest">): DatabricksClient;
  /** Plain `fetch` for presigned chunk downloads. */
  fetch: FetchLike;
  /** Waits `ms`; with a `signal` it rejects when the signal aborts and releases its timer. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Limits of the statement lifecycle, which the doctor keeps smaller than the server. */
export type WorkspaceLimits = Pick<StatementLifecycleOptions, "maxRows" | "allowWrites" | "maxResultBytes" | "maxExportBytes">;

export interface ConnectOptions {
  /** Configured warehouse; the profile's warehouse is the fallback. */
  warehouseId?: string | undefined;
  limits: WorkspaceLimits;
  /** Connects the modules to the log service and gives the lifecycle `scope`; without it no hook is installed. */
  logging?: { logs: LogService; scope: ExecutionScope };
}

/** What the doctor needs: credentials, client, warehouse selection and statement lifecycle. */
export interface WorkspaceConnection {
  auth: AuthProvider;
  client: DatabricksClient;
  warehouses: WarehouseSelection;
  statements: StatementLifecycle;
}

/** Everything the server needs from Databricks. */
export interface Workspace extends WorkspaceConnection {
  metadata: MetadataService;
  exports: ExportManager;
}

export interface WorkspaceSessionOptions {
  warehouseId?: string | undefined;
  limits: WorkspaceLimits;
  logs: LogService;
  exportDir: string;
}

/** Lazily created workspace of one server process (ADR 0014). */
export interface WorkspaceSession {
  /** Resolves credentials and builds the modules on the first call; a failed resolution is retried on the next call. */
  workspace(): Promise<Workspace>;
  /** The execution scope shared by the lifecycle, the export manager and the MCP server. */
  scope: ExecutionScope;
  /** Cancels the running exports; resolves no credentials when no workspace was created. */
  close(): Promise<void>;
}

/** Resolves credentials once and builds the client, warehouse selection and statement lifecycle. */
export async function connectWorkspace(adapters: WorkspaceAdapters, options: ConnectOptions): Promise<WorkspaceConnection> {
  const { logging } = options;
  const auth = await adapters.resolveAuth(logging && ((method) => logging.logs.current().debug("Token refreshed", { method })));
  const client = adapters.createClient(
    auth,
    logging === undefined
      ? {}
      : {
          onRetry: (event) => logging.logs.current().warn("Databricks request retried", { ...event }),
          onRequest: (event) => logging.logs.current().debug("Databricks request", { ...event }),
        },
  );
  const warehouses = createWarehouseSelection(client, {
    defaultWarehouseId: options.warehouseId ?? auth.profileWarehouseId,
    ...(logging && { onWarehouseChosen: (event) => logging.logs.current().info("Warehouse chosen automatically", { ...event }) }),
  });
  logging?.logs.lifecycle.info("Databricks credentials resolved", { host: auth.host, method: auth.method });
  const statements = createStatementLifecycle(client, {
    ...options.limits,
    resolveWarehouse: warehouses.resolve,
    sleep: adapters.sleep,
    ...(logging && { scope: logging.scope }),
  });
  return { auth, client, warehouses, statements };
}

/**
 * Creates the session of the server: the workspace is built on the first `workspace()` call, so the server starts, and
 * serves its log resources, without credentials. Shutdown only touches what exists.
 */
export function createWorkspaceSession(adapters: WorkspaceAdapters, options: WorkspaceSessionOptions): WorkspaceSession {
  const scope = createExecutionScope(options.logs);
  let pending: Promise<Workspace> | undefined;
  let created: Workspace | undefined;

  const build = async (): Promise<Workspace> => {
    const connection = await connectWorkspace(adapters, { warehouseId: options.warehouseId, limits: options.limits, logging: { logs: options.logs, scope } });
    const exports = createExportManager({ statements: connection.statements, fetch: adapters.fetch, dir: options.exportDir, scope, sleep: adapters.sleep });
    created = { ...connection, metadata: createMetadataService(connection.client, connection.statements), exports };
    return created;
  };

  return {
    workspace: () => {
      pending ??= build().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    scope,
    close: async () => {
      await created?.exports.close();
    },
  };
}
