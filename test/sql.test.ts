import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqlService } from "../src/sql.ts";
import { SqlError } from "../src/statements.ts";
import type { DatabricksClient } from "../src/client.ts";

function fakeClient(warehouses: unknown[]) {
  const paths: string[] = [];
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>(path: string) => {
      paths.push(path);
      return { warehouses } as T;
    },
    post: async <T>() => ({}) as T,
  };
  return { client, paths };
}

const noDefault = { defaultWarehouseId: undefined };

test("an explicit or configured warehouse is used without listing warehouses", async () => {
  const { client, paths } = fakeClient([]);
  const sql = createSqlService(client, { defaultWarehouseId: "wh-default" });
  assert.equal(await sql.resolveWarehouse(), "wh-default");
  assert.equal(await sql.resolveWarehouse("explicit"), "explicit");
  assert.deepEqual(paths, []);
});

test("warehouse is chosen automatically when none is configured", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "classic", state: "STOPPED", cluster_size: "Small", enable_serverless_compute: false },
    { id: "w2", name: "serverless", state: "STOPPED", cluster_size: "2X-Small", enable_serverless_compute: true },
    { id: "w3", name: "running", state: "RUNNING", cluster_size: "Small", enable_serverless_compute: false },
  ]);
  const sql = createSqlService(client, noDefault);
  const listed = await sql.listWarehouses();
  assert.deepEqual(listed.map((warehouse) => [warehouse.id, warehouse.isDefault]), [["w1", false], ["w2", false], ["w3", true]]);
  assert.equal(await sql.resolveWarehouse(), "w3");
  assert.equal(await sql.resolveWarehouse("explicit"), "explicit");
});

test("the listing marks the configured warehouse as the default", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "RUNNING", cluster_size: "Small", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", cluster_size: "2X-Small", enable_serverless_compute: true },
  ]);
  const listed = await createSqlService(client, { defaultWarehouseId: "w2" }).listWarehouses();
  assert.deepEqual(listed, [
    { id: "w1", name: "a", state: "RUNNING", size: "Small", serverless: false, isDefault: false },
    { id: "w2", name: "b", state: "STOPPED", size: "2X-Small", serverless: true, isDefault: true },
  ]);
});

test("serverless is preferred over the first stopped warehouse", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
  ]);
  assert.equal(await createSqlService(client, noDefault).resolveWarehouse(), "w2");
});

test("no accessible warehouse is an actionable error", async () => {
  const { client } = fakeClient([]);
  await assert.rejects(createSqlService(client, noDefault).resolveWarehouse(), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /DATABRICKS_WAREHOUSE_ID/);
    return true;
  });
});

test("onWarehouseChosen reports the automatic choice once", async () => {
  const events: unknown[] = [];
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
  ]);
  const sql = createSqlService(client, { ...noDefault, onWarehouseChosen: (event) => events.push(event) });
  await sql.resolveWarehouse();
  await sql.resolveWarehouse();
  assert.deepEqual(events, [{ warehouseId: "w2", name: "b", reason: "serverless" }]);
});

test("onWarehouseChosen reports the running and first reasons", async () => {
  const reasonFor = async (warehouses: unknown[]) => {
    const reasons: string[] = [];
    const { client } = fakeClient(warehouses);
    await createSqlService(client, { ...noDefault, onWarehouseChosen: (event) => reasons.push(event.reason) }).resolveWarehouse();
    return reasons;
  };
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }, { id: "w2", name: "b", state: "RUNNING" }]), ["running"]);
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }]), ["first"]);
});

test("a failing onWarehouseChosen callback does not fail the request and the choice stays cached", async () => {
  let notifications = 0;
  const { client, paths } = fakeClient([{ id: "w1", name: "a", state: "RUNNING" }]);
  const sql = createSqlService(client, {
    ...noDefault,
    onWarehouseChosen: () => {
      notifications++;
      throw new Error("listener failed");
    },
  });
  assert.equal(await sql.resolveWarehouse(), "w1");
  assert.equal(await sql.resolveWarehouse(), "w1");
  assert.equal(notifications, 1);
  assert.equal(paths.length, 1);
});
