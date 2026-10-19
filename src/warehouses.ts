import type { DatabricksClient } from "./client.ts";
import { SqlError } from "./statements.ts";

/** SQL warehouse as listed to the agent. */
export interface WarehouseSummary {
  id: string;
  name: string;
  state: string;
  size: string | undefined;
  serverless: boolean;
  isDefault: boolean;
}

/** Why the automatic warehouse choice picked a warehouse. */
export interface WarehouseChosenEvent {
  warehouseId: string;
  name: string;
  reason: "running" | "serverless" | "first";
}

/** Defaults of the warehouse selection. */
export interface WarehouseSelectionOptions {
  /** Configured warehouse; otherwise a running one, then a serverless one, then the first is used. */
  defaultWarehouseId: string | undefined;
  /** Called once when a warehouse is chosen automatically (none configured, none passed). */
  onWarehouseChosen?(event: WarehouseChosenEvent): void;
}

interface ApiWarehouse {
  id: string;
  name: string;
  state: string;
  cluster_size?: string;
  enable_serverless_compute?: boolean;
}

/**
 * Creates the warehouse selection (ADR 0012): `resolve` gives the explicit, configured or automatic choice (remembered
 * once made) and `list` gives the accessible warehouses with the default marked. Statement execution lives in the
 * statement lifecycle module (ADR 0009), which receives `resolve` as an injected function.
 */
export function createWarehouseSelection(client: DatabricksClient, options: WarehouseSelectionOptions) {
  /** The automatic choice, in flight or made; a failed choice is not kept. */
  let automaticWarehouse: Promise<string> | undefined;

  async function fetchWarehouses(): Promise<ApiWarehouse[]> {
    const response = await client.get<{ warehouses?: ApiWarehouse[] }>("/api/2.0/sql/warehouses");
    return response.warehouses ?? [];
  }

  function chooseWarehouse(warehouses: ApiWarehouse[]): { warehouse: ApiWarehouse; reason: WarehouseChosenEvent["reason"] } | undefined {
    const running = warehouses.find((warehouse) => warehouse.state === "RUNNING");
    if (running !== undefined) return { warehouse: running, reason: "running" };
    const serverless = warehouses.find((warehouse) => warehouse.enable_serverless_compute === true);
    if (serverless !== undefined) return { warehouse: serverless, reason: "serverless" };
    const first = warehouses[0];
    return first === undefined ? undefined : { warehouse: first, reason: "first" };
  }

  async function chooseAutomatically(): Promise<string> {
    const chosen = chooseWarehouse(await fetchWarehouses());
    if (chosen === undefined) {
      throw new SqlError(
        "No SQL warehouse is accessible to this identity. Create one or get CAN USE on an existing one, or set DATABRICKS_WAREHOUSE_ID.",
      );
    }
    try {
      options.onWarehouseChosen?.({ warehouseId: chosen.warehouse.id, name: chosen.warehouse.name, reason: chosen.reason });
    } catch {
      // The callback only observes the choice; its failure must not fail the request.
    }
    return chosen.warehouse.id;
  }

  async function resolve(explicit?: string): Promise<string> {
    if (explicit !== undefined) return explicit;
    if (options.defaultWarehouseId !== undefined) return options.defaultWarehouseId;
    // The promise is kept while the choice is in flight, so simultaneous first calls share one listing and one event.
    automaticWarehouse ??= chooseAutomatically().catch((error: unknown) => {
      automaticWarehouse = undefined;
      throw error;
    });
    return automaticWarehouse;
  }

  async function list(): Promise<WarehouseSummary[]> {
    const warehouses = await fetchWarehouses();
    const defaultId = options.defaultWarehouseId ?? chooseWarehouse(warehouses)?.warehouse.id;
    return warehouses.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      state: warehouse.state,
      size: warehouse.cluster_size,
      serverless: warehouse.enable_serverless_compute === true,
      isDefault: warehouse.id === defaultId,
    }));
  }

  return { resolve, list };
}

/** Methods returned by {@link createWarehouseSelection}. */
export type WarehouseSelection = ReturnType<typeof createWarehouseSelection>;
