import { test } from "node:test";
import assert from "node:assert/strict";
import { createWarehouseSelection } from "../src/warehouses.ts";
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

test("an explicit warehouse wins over the configured one, without listing warehouses", async () => {
  const { client, paths } = fakeClient([]);
  const warehouses = createWarehouseSelection(client, { defaultWarehouseId: "wh-default" });
  assert.equal(await warehouses.resolve("explicit"), "explicit");
  assert.deepEqual(paths, []);
});

test("the configured warehouse wins over the automatic choice, without listing warehouses", async () => {
  const { client, paths } = fakeClient([{ id: "w1", name: "a", state: "RUNNING" }]);
  const warehouses = createWarehouseSelection(client, { defaultWarehouseId: "wh-default" });
  assert.equal(await warehouses.resolve(), "wh-default");
  assert.deepEqual(paths, []);
});

test("a running warehouse is chosen automatically before a serverless one", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "classic", state: "STOPPED", cluster_size: "Small", enable_serverless_compute: false },
    { id: "w2", name: "serverless", state: "STOPPED", cluster_size: "2X-Small", enable_serverless_compute: true },
    { id: "w3", name: "running", state: "RUNNING", cluster_size: "Small", enable_serverless_compute: false },
  ]);
  const warehouses = createWarehouseSelection(client, noDefault);
  assert.equal(await warehouses.resolve(), "w3");
  assert.equal(await warehouses.resolve("explicit"), "explicit");
});

test("serverless is preferred over the first stopped warehouse", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
  ]);
  assert.equal(await createWarehouseSelection(client, noDefault).resolve(), "w2");
});

test("the first accessible warehouse is the last resort", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STARTING" },
  ]);
  assert.equal(await createWarehouseSelection(client, noDefault).resolve(), "w1");
});

test("the automatic choice is remembered across calls", async () => {
  const { client, paths } = fakeClient([{ id: "w1", name: "a", state: "RUNNING" }]);
  const warehouses = createWarehouseSelection(client, noDefault);
  assert.equal(await warehouses.resolve(), "w1");
  assert.equal(await warehouses.resolve(), "w1");
  assert.equal(paths.length, 1);
});

test("simultaneous first calls list the warehouses once and report the choice once", async () => {
  const events: unknown[] = [];
  let listings = 0;
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>() => {
      listings++;
      await new Promise((settle) => setTimeout(settle, 5));
      return { warehouses: [{ id: "w1", name: "a", state: "RUNNING" }] } as T;
    },
    post: async <T>() => ({}) as T,
  };
  const warehouses = createWarehouseSelection(client, { ...noDefault, onWarehouseChosen: (event) => events.push(event) });
  assert.deepEqual(await Promise.all([warehouses.resolve(), warehouses.resolve()]), ["w1", "w1"]);
  assert.equal(listings, 1);
  assert.deepEqual(events, [{ warehouseId: "w1", name: "a", reason: "running" }]);
});

test("simultaneous calls share a failed choice, and the next call tries again", async () => {
  let accessible: unknown[] = [];
  let listings = 0;
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>() => {
      listings++;
      await new Promise((settle) => setTimeout(settle, 5));
      return { warehouses: accessible } as T;
    },
    post: async <T>() => ({}) as T,
  };
  const warehouses = createWarehouseSelection(client, noDefault);
  const failures = await Promise.allSettled([warehouses.resolve(), warehouses.resolve()]);
  assert.deepEqual(failures.map((outcome) => outcome.status), ["rejected", "rejected"]);
  assert.equal(listings, 1);
  accessible = [{ id: "w1", name: "a", state: "RUNNING" }];
  assert.equal(await warehouses.resolve(), "w1");
  assert.equal(listings, 2);
});

test("no accessible warehouse is an actionable error", async () => {
  const { client } = fakeClient([]);
  await assert.rejects(createWarehouseSelection(client, noDefault).resolve(), (error: unknown) => {
    assert.ok(error instanceof SqlError);
    assert.match(error.message, /DATABRICKS_WAREHOUSE_ID/);
    return true;
  });
});

test("a failed automatic choice is not remembered", async () => {
  let accessible: unknown[] = [];
  const client: DatabricksClient = {
    host: "https://ws",
    get: async <T>() => ({ warehouses: accessible }) as T,
    post: async <T>() => ({}) as T,
  };
  const warehouses = createWarehouseSelection(client, noDefault);
  await assert.rejects(warehouses.resolve(), SqlError);
  accessible = [{ id: "w1", name: "a", state: "RUNNING" }];
  assert.equal(await warehouses.resolve(), "w1");
});

test("the listing marks the configured warehouse as the default", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "RUNNING", cluster_size: "Small", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", cluster_size: "2X-Small", enable_serverless_compute: true },
  ]);
  const listed = await createWarehouseSelection(client, { defaultWarehouseId: "w2" }).list();
  assert.deepEqual(listed, [
    { id: "w1", name: "a", state: "RUNNING", size: "Small", serverless: false, isDefault: false },
    { id: "w2", name: "b", state: "STOPPED", size: "2X-Small", serverless: true, isDefault: true },
  ]);
});

test("the listing marks the automatic choice as the default when none is configured", async () => {
  const { client } = fakeClient([
    { id: "w1", name: "classic", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "serverless", state: "STOPPED", enable_serverless_compute: true },
    { id: "w3", name: "running", state: "RUNNING", enable_serverless_compute: false },
  ]);
  const listed = await createWarehouseSelection(client, noDefault).list();
  assert.deepEqual(listed.map((warehouse) => [warehouse.id, warehouse.isDefault]), [["w1", false], ["w2", false], ["w3", true]]);
});

test("onWarehouseChosen reports the automatic choice once", async () => {
  const events: unknown[] = [];
  const { client } = fakeClient([
    { id: "w1", name: "a", state: "STOPPED", enable_serverless_compute: false },
    { id: "w2", name: "b", state: "STOPPED", enable_serverless_compute: true },
  ]);
  const warehouses = createWarehouseSelection(client, { ...noDefault, onWarehouseChosen: (event) => events.push(event) });
  await warehouses.resolve();
  await warehouses.resolve();
  assert.deepEqual(events, [{ warehouseId: "w2", name: "b", reason: "serverless" }]);
});

test("onWarehouseChosen is not called for an explicit or configured warehouse, nor by the listing", async () => {
  const events: unknown[] = [];
  const { client } = fakeClient([{ id: "w1", name: "a", state: "RUNNING" }]);
  const onWarehouseChosen = (event: unknown) => events.push(event);
  const configured = createWarehouseSelection(client, { defaultWarehouseId: "wh-default", onWarehouseChosen });
  await configured.resolve();
  await configured.resolve("explicit");
  await createWarehouseSelection(client, { ...noDefault, onWarehouseChosen }).list();
  assert.deepEqual(events, []);
});

test("onWarehouseChosen reports the running and first reasons", async () => {
  const reasonFor = async (accessible: unknown[]) => {
    const reasons: string[] = [];
    const { client } = fakeClient(accessible);
    await createWarehouseSelection(client, { ...noDefault, onWarehouseChosen: (event) => reasons.push(event.reason) }).resolve();
    return reasons;
  };
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }, { id: "w2", name: "b", state: "RUNNING" }]), ["running"]);
  assert.deepEqual(await reasonFor([{ id: "w1", name: "a", state: "STOPPED" }]), ["first"]);
});

test("a failing onWarehouseChosen callback does not fail the request and the choice stays cached", async () => {
  let notifications = 0;
  const { client, paths } = fakeClient([{ id: "w1", name: "a", state: "RUNNING" }]);
  const warehouses = createWarehouseSelection(client, {
    ...noDefault,
    onWarehouseChosen: () => {
      notifications++;
      throw new Error("listener failed");
    },
  });
  assert.equal(await warehouses.resolve(), "w1");
  assert.equal(await warehouses.resolve(), "w1");
  assert.equal(notifications, 1);
  assert.equal(paths.length, 1);
});
