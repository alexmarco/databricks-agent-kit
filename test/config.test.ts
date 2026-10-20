import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultStorageDir, parseDatabricksConfig, resolveSettings } from "../src/config.ts";

test("parseDatabricksConfig reads sections, keys and ignores comments", () => {
  const profiles = parseDatabricksConfig(
    "; comment\n[DEFAULT]\nhost = https://a.cloud.databricks.com\ntoken=dapi123\n\n# other\n[dev]\nhost = https://b.cloud.databricks.com/\nauth_type = databricks-cli\nwarehouse_id = wh1\n",
  );
  assert.deepEqual(profiles.get("DEFAULT"), { host: "https://a.cloud.databricks.com", token: "dapi123" });
  assert.deepEqual(profiles.get("dev"), {
    host: "https://b.cloud.databricks.com/",
    auth_type: "databricks-cli",
    warehouse_id: "wh1",
  });
});

test("parseDatabricksConfig keys outside a section are ignored", () => {
  assert.equal(parseDatabricksConfig("host = x\n").size, 0);
});

const stateDir = join("C:", "state");

test("resolveSettings applies defaults", () => {
  const settings = resolveSettings({}, {}, stateDir);
  assert.deepEqual(settings, {
    profile: "DEFAULT",
    explicitProfile: false,
    warehouseId: undefined,
    allowWrites: false,
    maxRows: 1000,
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 8765,
    httpToken: undefined,
    storageDir: stateDir,
    exportDir: join(stateDir, "exports"),
    exportMaxBytes: 10 * 1024 ** 3,
    logLevel: "info",
  });
});

test("resolveSettings: export directory and size limit come from the environment", () => {
  const overridden = resolveSettings({}, { DAK_EXPORT_DIR: "/data/x", DAK_EXPORT_MAX_BYTES: "5000" }, "/state");
  assert.equal(overridden.exportDir, "/data/x");
  assert.equal(overridden.exportMaxBytes, 5000);
  assert.equal(resolveSettings({}, {}, "/state").exportDir, join("/state", "exports"));
  assert.equal(resolveSettings({}, { DAK_STORAGE_DIR: "/s" }, "/state").exportDir, join("/s", "exports"));
});

test("resolveSettings: flags override environment", () => {
  const settings = resolveSettings(
    { profile: "dev", allowWrites: true, transport: "http", host: "0.0.0.0", port: "9000" },
    {
      DATABRICKS_CONFIG_PROFILE: "prod",
      DAK_ALLOW_WRITES: "false",
      DAK_HTTP_HOST: "127.0.0.2",
      DAK_HTTP_PORT: "1234",
      DAK_HTTP_TOKEN: "secret",
      DAK_MAX_ROWS: "50",
      DAK_STORAGE_DIR: "D:/logs",
      DAK_LOG_LEVEL: "debug",
      DATABRICKS_WAREHOUSE_ID: "wh9",
    },
    stateDir,
  );
  assert.equal(settings.profile, "dev");
  assert.equal(settings.explicitProfile, true);
  assert.equal(settings.allowWrites, true);
  assert.equal(settings.transport, "http");
  assert.equal(settings.httpHost, "0.0.0.0");
  assert.equal(settings.httpPort, 9000);
  assert.equal(settings.httpToken, "secret");
  assert.equal(settings.maxRows, 50);
  assert.equal(settings.storageDir, "D:/logs");
  assert.equal(settings.logLevel, "debug");
  assert.equal(settings.warehouseId, "wh9");
});

test("resolveSettings: environment profile is not explicit", () => {
  const settings = resolveSettings({}, { DATABRICKS_CONFIG_PROFILE: "prod", DAK_ALLOW_WRITES: "1" }, stateDir);
  assert.equal(settings.profile, "prod");
  assert.equal(settings.explicitProfile, false);
  assert.equal(settings.allowWrites, true);
});

test("defaultStorageDir is a per-user state directory", () => {
  assert.equal(
    defaultStorageDir({ LOCALAPPDATA: "C:/Users/u/AppData/Local" }, "win32", "C:/Users/u"),
    join("C:/Users/u/AppData/Local", "databricks-agent-kit"),
  );
  assert.equal(defaultStorageDir({}, "linux", "/home/u"), join("/home/u", ".local", "state", "databricks-agent-kit"));
  assert.equal(
    defaultStorageDir({ XDG_STATE_HOME: "/xdg" }, "darwin", "/Users/u"),
    join("/xdg", "databricks-agent-kit"),
  );
});

test("resolveSettings rejects invalid values", () => {
  assert.throws(() => resolveSettings({}, { DAK_MAX_ROWS: "0" }, stateDir), /DAK_MAX_ROWS/);
  assert.throws(() => resolveSettings({}, { DAK_EXPORT_MAX_BYTES: "0" }, stateDir), /DAK_EXPORT_MAX_BYTES/);
  assert.throws(() => resolveSettings({ port: "abc" }, {}, stateDir), /port/i);
  assert.throws(() => resolveSettings({}, { DAK_LOG_LEVEL: "loud" }, stateDir), /DAK_LOG_LEVEL/);
});
